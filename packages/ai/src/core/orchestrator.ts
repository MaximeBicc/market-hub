import type {
  AIProvider,
  ExecutionRequest,
  ExecutionResult,
  ModelDescriptor,
  ProviderId,
} from "../domain/types.js";
import type { UsageLedger } from "../ports/repositories.js";
import { allows, neuronsFor, type DailyUsage, type FreeLimits, FREE_LIMITS } from "./budget.js";
import { route } from "./router.js";
import { usageOfFailure } from "../domain/errors.js";
import { parseModelJson } from "../lib/json.js";
import { sanitizeMessages } from "../lib/privacy.js";

/**
 * Aucun modèle gratuit n'a pu répondre.
 *
 * Erreur de première classe et non message générique : l'interface doit
 * pouvoir dire « quota gratuit épuisé, réessayez demain » plutôt que
 * « erreur ». C'est la seule issue prévue quand la journée est consommée — il
 * n'existe pas de repli payant vers lequel basculer.
 */
export class NoFreeModelError extends Error {
  constructor(readonly trace: string[]) {
    super("Aucun modèle gratuit disponible");
    this.name = "NoFreeModelError";
  }
}

/**
 * Une erreur de quota ou de débit : on passe au fournisseur suivant.
 *
 * Le 403 a été RETIRÉ de cette liste, et c'est le fruit d'une méprise réelle.
 * Il y figurait au motif qu'un 403 accompagne parfois un dépassement ; en
 * pratique, chez Gemini, il signale presque toujours une API non activée ou
 * une clé restreinte. Classé en quota, il produisait le message « quota
 * gratuit épuisé » alors qu'aucune requête n'avait jamais été passée — et
 * envoyait attendre minuit pour un problème de configuration.
 */
function isQuotaError(error: unknown): boolean {
  return /429|5035|3036|3040|quota|rate.?limit|RESOURCE_EXHAUSTED|exceeded/i.test(
    String(error),
  );
}

/**
 * Une erreur de configuration : réessayer ne sert à rien tant qu'un humain
 * n'a pas agi. Clé absente, invalide, restreinte, ou service non activé chez
 * le fournisseur.
 */
function isConfigurationError(error: unknown): boolean {
  return /401|403|invalid.?api.?key|API_KEY_INVALID|unauthenti|PERMISSION_DENIED|SERVICE_DISABLED|has not been used|is disabled|PROVIDER_NOT_CONFIGURED/i.test(
    String(error),
  );
}

export class Orchestrator {
  constructor(
    private readonly catalogue: ModelDescriptor[],
    private readonly providers: Map<ProviderId, AIProvider>,
    private readonly ledger: UsageLedger,
    private readonly limits: FreeLimits = FREE_LIMITS,
  ) {}

  /**
   * Existe-t-il seulement une route de recherche web ?
   *
   * Question posée AVANT de tenter quoi que ce soit, parce que la réponse
   * change le message montré à l'utilisateur. « Aucun modèle disponible » et
   * « vous n'avez pas encore créé de clé Gemini » sont deux situations
   * différentes : la première invite à chercher une panne, la seconde à
   * suivre trois étapes. Les confondre fait perdre une soirée.
   */
  canWebSearch(): boolean {
    return this.catalogue.some(
      (m) =>
        m.capabilities.includes("web_search") &&
        (this.providers.get(m.provider)?.configured() ?? false),
    );
  }

  /**
   * Exécute une demande sur le meilleur modèle encore autorisé.
   *
   * La consommation du jour est lue UNE seule fois, puis tenue à jour en
   * mémoire pendant les replis : relire la base entre deux tentatives
   * coûterait une lecture par échec sans rien apprendre de neuf, l'écriture
   * venant d'être faite par nous.
   */
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const usage = await this.ledger.today();
    const decision = route(this.catalogue, request, usage, this.limits);
    const trace = [...decision.rejected];

    /**
     * Fournisseurs écartés pour le reste de CETTE exécution.
     *
     * Cloudflare porte quatre modèles : sans cette liste, un refus de quota au
     * premier en déclencherait trois autres identiques, chacun consommant un
     * aller-retour réseau pour recevoir la même erreur. Rien n'est écrit en
     * base — un 429 est passager, et la prochaine requête doit pouvoir
     * retenter.
     */
    const ecartes = new Set<ProviderId>();

    for (const model of decision.candidates) {
      const id = `${model.provider}/${model.model}`;
      const provider = this.providers.get(model.provider);

      if (ecartes.has(model.provider)) continue;

      if (!provider?.configured()) {
        trace.push(`${id} : fournisseur non configuré`);
        ecartes.add(model.provider);
        continue;
      }

      // Le budget a pu changer depuis le classement, si un repli précédent a
      // déjà consommé. On revérifie avant de dépenser.
      const verdict = allows(model, usage, {
        limits: this.limits,
        ...(request.webSearch === undefined ? {} : { webSearch: request.webSearch }),
        ...(request.automatic === undefined ? {} : { automatic: request.automatic }),
        estimatedNeurons: 0,
      });
      if (!verdict.ok) {
        trace.push(`${id} : ${verdict.reason}`);
        continue;
      }

      // Nos chiffres ne partent chez un tiers qu'après nettoyage. Le contenu
      // client, lui, n'arrive jamais ici : le routeur ne lui a proposé que des
      // modèles hébergés chez nous.
      const messages =
        request.dataClass === "internal" && model.privacy === "sanitized_only"
          ? sanitizeMessages(request.messages)
          : request.messages;

      try {
        const response = await provider.generate(model, {
          messages,
          ...(request.json === undefined ? {} : { json: request.json }),
          ...(request.webSearch === undefined ? {} : { webSearch: request.webSearch }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
        });

        // Le fournisseur fait foi quand il annonce son coût — c'est le chiffre
        // qui décrémente réellement l'allocation. Notre conversion ne sert
        // qu'aux fournisseurs qui ne le donnent pas, où elle reste de toute
        // façon indicative.
        const neurons = response.neurons ?? neuronsFor(model, response);
        await this.ledger.record({
          provider: model.provider,
          model: model.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          neurons,
          webSearch: Boolean(request.webSearch),
        });
        applyLocally(usage, model.provider, neurons, Boolean(request.webSearch));

        trace.push(`${id} : ${neurons} neurones`);
        return {
          text: response.text,
          parsed: request.json ? parseModelJson(response.text) : undefined,
          provider: model.provider,
          model: model.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          neurons,
          sources: response.sources ?? [],
          trace,
        };
      } catch (error) {
        trace.push(`${id} : échec — ${String(error).slice(0, 160)}`);

        // Un appel raté peut avoir coûté. Cloudflare facture le raisonnement
        // d'un modèle qui n'a jamais rien écrit ; ne pas l'inscrire ferait
        // afficher un solde plus large que la réalité, et le routeur
        // continuerait à proposer des modèles qui n'ont plus de place.
        const facture = usageOfFailure(error);
        if (facture) {
          const neurons = facture.neurons ?? neuronsFor(model, facture);
          await this.ledger.record({
            provider: model.provider,
            model: model.model,
            inputTokens: facture.inputTokens,
            outputTokens: facture.outputTokens,
            neurons,
            webSearch: Boolean(request.webSearch),
          });
          applyLocally(usage, model.provider, neurons, Boolean(request.webSearch));
          trace.push(`${id} : ${Math.round(neurons)} neurones consommés malgré l'échec`);
        }

        // Quota atteint ou clé invalide : le problème est au niveau du
        // fournisseur, pas du modèle. Insister sur ses autres modèles ne
        // ferait que répéter la même erreur.
        if (isQuotaError(error) || isConfigurationError(error)) {
          ecartes.add(model.provider);
          continue;
        }
        // Erreur inattendue : on tente le modèle suivant, la panne peut être
        // propre à celui-ci.
      }
    }

    throw new NoFreeModelError(trace);
  }
}

/**
 * Répercute une consommation sur la copie locale du registre.
 *
 * Nécessaire parce qu'un repli doit voir ce que la tentative précédente a
 * dépensé : sans cela, le second candidat serait évalué contre un budget déjà
 * périmé, et pourrait passer alors que l'allocation vient d'être épuisée.
 */
function applyLocally(
  usage: DailyUsage,
  provider: ProviderId,
  neurons: number,
  webSearch: boolean,
): void {
  usage.requests[provider] = (usage.requests[provider] ?? 0) + 1;
  if (provider === "cloudflare") usage.neurons += neurons;
  if (webSearch) usage.searchRequests += 1;
}
