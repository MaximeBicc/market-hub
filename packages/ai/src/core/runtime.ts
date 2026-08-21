import type {
  Catalogue,
  Evidence,
  ExecutionRequest,
  ProviderId,
  SkillContext,
} from "../domain/types.js";
import type { ResultCache, RunJournal } from "../ports/repositories.js";
import type { SkillRegistry } from "./registry.js";
import type { Orchestrator } from "./orchestrator.js";
import type { ResearchEngine } from "../research/engine.js";
import { fingerprint } from "../lib/hash.js";

export interface SkillRunRequest {
  skill: string;
  input: unknown;
  /** Force le recalcul. Réservé à un geste explicite de l'utilisateur. */
  bypassCache?: boolean | undefined;
  /** Vrai quand la demande vient du cron : budget réduit, réserve manuelle protégée. */
  automatic?: boolean | undefined;
}

export interface SkillRunResult {
  runId: string;
  skill: string;
  version: string;
  cached: boolean;
  /** Coût réel de cette exécution. Zéro sur un résultat mis en cache. */
  neurons: number;
  provider: ProviderId | null;
  model: string | null;
  /**
   * Chaque tentative de routage, dans l'ordre.
   *
   * Utile bien au-delà du débogage : quand une skill se rabat silencieusement
   * du modèle économe vers le modèle lourd, la facture en neurones double sans
   * que rien ne le dise. La trace est le seul endroit où cela se voit.
   */
  trace: string[];
  result: unknown;
}

export class UnknownSkillError extends Error {
  constructor(name: string) {
    super(`Skill inconnue : ${name}`);
    this.name = "UnknownSkillError";
  }
}

/**
 * Exécution d'une skill, du cache au journal.
 *
 * L'ordre est celui du moindre coût : on regarde d'abord si la réponse existe
 * déjà, on n'ouvre un run que si elle n'existe pas, et on n'appelle un modèle
 * que si la skill le décide. Une skill peut parfaitement répondre sans aucun
 * appel — c'est le cas de la détection d'anomalies quand il n'y a rien à voir.
 */
export async function runSkill(
  deps: {
    registry: SkillRegistry;
    orchestrator: Orchestrator;
    cache: ResultCache;
    journal: RunJournal;
    catalogue: Catalogue;
    research: ResearchEngine;
    now: () => number;
    newId: () => string;
  },
  request: SkillRunRequest,
): Promise<SkillRunResult> {
  const skill = deps.registry.get(request.skill);
  if (!skill) throw new UnknownSkillError(request.skill);

  const inputHash = await fingerprint(request.input);
  // La version fait partie de la clé : corriger une skill doit invalider ses
  // anciennes réponses, sinon la correction reste invisible pendant des heures.
  const cacheKey = `${skill.name}:${skill.version}:${inputHash}`;

  if (!request.bypassCache && skill.cacheTtl > 0) {
    const hit = await deps.cache.get(cacheKey);
    if (hit !== undefined) {
      return {
        runId: "cache",
        skill: skill.name,
        version: skill.version,
        cached: true,
        neurons: 0,
        provider: null,
        model: null,
        trace: [],
        result: hit,
      };
    }
  }

  const runId = deps.newId();
  await deps.journal.start({
    id: runId,
    skill: skill.name,
    skillVersion: skill.version,
    dataClass: skill.dataClass,
    impact: skill.impact,
    inputHash,
    automatic: Boolean(request.automatic),
  });

  // Une skill peut passer plusieurs appels ; on retient le coût total et le
  // dernier modèle utilisé, qui est celui qui a produit la conclusion.
  let neurons = 0;
  let provider: ProviderId | null = null;
  let model: string | null = null;
  const sources: Evidence[] = [];
  const trace: string[] = [];

  const ctx: SkillContext = {
    catalogue: deps.catalogue,
    now: deps.now,
    research: (demande) =>
      deps.research.research({
        ...demande,
        ...(request.automatic === undefined ? {} : { automatic: request.automatic }),
      }),
    run: async (execution: ExecutionRequest) => {
      const result = await deps.orchestrator.run({
        ...execution,
        ...(request.automatic === undefined ? {} : { automatic: request.automatic }),
      });
      neurons += result.neurons;
      provider = result.provider;
      model = result.model;
      sources.push(...result.sources);
      trace.push(...result.trace);
      return result;
    },
  };

  try {
    const result = await skill.execute(request.input as never, ctx);

    await deps.journal.succeed({
      id: runId,
      provider,
      model,
      confidence: extractConfidence(result),
      neurons,
      evidence: sources,
    });

    // La skill peut raccourcir la durée selon ce qu'elle a réellement trouvé :
    // un résultat vide faute de configuration ne doit pas survivre à sa
    // correction.
    const ttl = skill.cacheTtlFor?.(result as never) ?? skill.cacheTtl;
    if (ttl > 0) await deps.cache.put(cacheKey, result, ttl);

    return {
      runId,
      skill: skill.name,
      version: skill.version,
      cached: false,
      neurons,
      provider,
      model,
      trace,
      result,
    };
  } catch (error) {
    await deps.journal.fail(runId, String(error).slice(0, 500));
    throw error;
  }
}

/**
 * Retrouve la confiance quelle que soit la forme de la réponse.
 *
 * Chaque skill place sa confiance là où elle a du sens pour elle — sous
 * `analyse`, sous `recommandation`, sous `explication`. Plutôt que d'imposer
 * une clé de surface qui n'aurait de sens nulle part, on la cherche à un
 * niveau de profondeur. Le journal peut ainsi classer les runs par fiabilité
 * sans que les skills se ressemblent artificiellement.
 */
function extractConfidence(result: unknown): number | null {
  if (typeof result !== "object" || result === null) return null;

  const record = result as Record<string, unknown>;
  if (typeof record["confidence"] === "number") return record["confidence"];

  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null) {
      const nested = (value as Record<string, unknown>)["confidence"];
      if (typeof nested === "number") return nested;
    }
  }
  return null;
}
