import type { AIProvider, Catalogue, ProviderId } from "../domain/types.js";
import type { ResultCache, RunJournal, UsageLedger } from "../ports/repositories.js";
import { CloudflareProvider, type WorkersAIBinding } from "../providers/cloudflare.js";
import { GeminiProvider } from "../providers/gemini.js";
import { groqProvider, openRouterProvider } from "../providers/openai-compatible.js";
import { modelCatalogue, type ModelEnv } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { defaultSkills, type SkillRegistry } from "./registry.js";
import { runSkill, type SkillRunRequest, type SkillRunResult } from "./runtime.js";
import { FREE_LIMITS, neuronsToUsd, type FreeLimits } from "./budget.js";
import { ResearchEngine } from "../research/engine.js";
import { SourceRegistry } from "../research/ports.js";
import type { FxRates } from "../research/fx.js";

export interface AiModuleDeps {
  /** Liaison Workers AI. Le seul fournisseur qui ne demande aucune clé. */
  ai: WorkersAIBinding;
  ledger: UsageLedger;
  cache: ResultCache;
  journal: RunJournal;
  catalogue: Catalogue;
  /** Clés et identifiants de modèles, lus depuis les secrets du Worker. */
  env: ModelEnv;
  /** Sert d'attribution pour OpenRouter. */
  appUrl: string;
  limits?: FreeLimits | undefined;
  now?: (() => number) | undefined;
  newId?: (() => string) | undefined;
  skills?: SkillRegistry | undefined;
  /**
   * Sources externes supplémentaires.
   *
   * Vide par défaut, et ce n'est pas un oubli : la couche interne est intégrée
   * au moteur de recherche, et les couches marketplace et fournisseur
   * attendent que le moteur marketplace expose une recherche publique. Le jour
   * où il le fera, ses adaptateurs s'enregistrent ici sans que rien d'autre
   * bouge.
   */
  sources?: SourceRegistry | undefined;
  /**
   * Source des taux de change. Par défaut, le flux quotidien de la BCE.
   *
   * Surchargeable pour que la suite de tests n'ait jamais à joindre un service
   * extérieur — c'est ce qui permet d'affirmer que ce paquet se teste sans
   * clé et sans réseau.
   */
  fxRates?: (() => Promise<FxRates>) | undefined;
}

/**
 * Assemble le panel.
 *
 * Un fournisseur sans clé n'est pas une erreur : son modèle n'entre tout
 * simplement pas au catalogue, et le routeur ne le proposera jamais. C'est ce
 * qui permet de démarrer avec Cloudflare seul et d'ajouter Gemini plus tard
 * sans toucher une ligne de code — il suffit d'inscrire le secret.
 */
export function createAiModule(deps: AiModuleDeps) {
  const models = modelCatalogue(deps.env);

  const providers = new Map<ProviderId, AIProvider>([
    ["cloudflare", new CloudflareProvider(deps.ai)],
    ["gemini", new GeminiProvider(deps.env.GEMINI_API_KEY)],
    ["groq", groqProvider(deps.env.GROQ_API_KEY)],
    ["openrouter", openRouterProvider(deps.env.OPENROUTER_API_KEY, deps.appUrl)],
  ]);

  const limits = deps.limits ?? FREE_LIMITS;
  const orchestrator = new Orchestrator(models, providers, deps.ledger, limits);
  const registry = deps.skills ?? defaultSkills();

  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const research = new ResearchEngine({
    sources: deps.sources ?? new SourceRegistry(),
    orchestrator,
    cache: deps.cache,
    now,
    ...(deps.fxRates === undefined ? {} : { rates: deps.fxRates }),
  });

  return {
    registry,
    orchestrator,

    run(request: SkillRunRequest): Promise<SkillRunResult> {
      return runSkill(
        {
          registry,
          orchestrator,
          cache: deps.cache,
          journal: deps.journal,
          catalogue: deps.catalogue,
          research,
          now,
          newId,
        },
        request,
      );
    },

    /**
     * État du panel pour l'écran de réglages.
     *
     * Aucune clé n'en sort, jamais : seulement le fait qu'elle soit présente
     * ou non. Une clé partiellement affichée reste une clé divulguée.
     */
    async health() {
      const usage = await deps.ledger.today();
      const breakdown = await deps.ledger.breakdown();

      return {
        fournisseurs: (["cloudflare", "gemini", "groq", "openrouter"] as const).map((id) => ({
          id,
          configure: providers.get(id)?.configured() ?? false,
          modeles: models.filter((m) => m.provider === id).map((m) => m.model),
          appelsAujourdhui: usage.requests[id] ?? 0,
          plafond: Number.isFinite(limits.requests[id]) ? limits.requests[id] : null,
        })),
        neurones: {
          consommes: usage.neurons,
          alloues: limits.neurons,
          restants: Math.max(0, limits.neurons - usage.neurons),
          // Valeur indicative : ces dollars ne sont jamais facturés sur un
          // compte Workers Free. Ils donnent l'ordre de grandeur de ce que
          // l'allocation gratuite représente.
          equivalentUsd: Math.round(neuronsToUsd(usage.neurons) * 10000) / 10000,
        },
        rechercheWeb: {
          consommees: usage.searchRequests,
          plafond: limits.searchRequests,
          reserveManuelle: limits.searchManualReserve,
        },
        detail: breakdown,
      };
    },

    /** Catalogue public : ni clé, ni prix, ni note interne de routage. */
    catalogue() {
      return models.map((m) => ({
        fournisseur: m.provider,
        modele: m.model,
        capacites: m.capabilities,
        confidentialite: m.privacy,
        note: m.note,
      }));
    },
  };
}

export type AiModule = ReturnType<typeof createAiModule>;
