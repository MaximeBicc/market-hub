import type { AIProvider, Catalogue, ExecutionRequest, ProviderId } from "../domain/types.js";
import type { ResultCache, RunJournal, UsageLedger } from "../ports/repositories.js";
import { CloudflareProvider, type WorkersAIBinding } from "../providers/cloudflare.js";
import { GeminiProvider } from "../providers/gemini.js";
import { groqProvider, openRouterProvider } from "../providers/openai-compatible.js";
import { modelCatalogue, type ModelEnv } from "./models.js";
import { NoFreeModelError, Orchestrator } from "./orchestrator.js";
import { route } from "./router.js";
import { defaultSkills, type SkillRegistry } from "./registry.js";
import { runSkill, type SkillRunRequest, type SkillRunResult } from "./runtime.js";
import { FREE_LIMITS, neuronsToUsd, type FreeLimits } from "./budget.js";
import { ResearchEngine } from "../research/engine.js";
import { SourceRegistry } from "../research/ports.js";
import type { FxRates } from "../research/fx.js";
import type { PageMeta } from "../research/page-meta.js";

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
  /** Lecture des metadonnees de page. Surchargeable pour les tests. */
  pageMeta?: ((url: string) => Promise<PageMeta>) | undefined;
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

  const sources = deps.sources ?? new SourceRegistry();

  const research = new ResearchEngine({
    sources,
    orchestrator,
    cache: deps.cache,
    now,
    ...(deps.fxRates === undefined ? {} : { rates: deps.fxRates }),
    ...(deps.pageMeta === undefined ? {} : { meta: deps.pageMeta }),
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
        // Les moteurs de recherche branches. L'ecran doit savoir si une
        // recherche web est possible AVANT que l'utilisateur clique : lui
        // annoncer apres coup qu'elle ne l'etait pas est une perte de temps.
        sourcesDeRecherche: await Promise.all(
          sources.all().map(async (src) => ({
            id: src.id,
            disponible: await Promise.resolve(src.available()).catch(() => false),
          })),
        ),
        rechercheWeb: {
          // Le plafond se compte au mois : c'est la forme du quota Google, pas
          // un choix. Le chiffre du jour reste affiche pour situer l'usage.
          consommeesCeMois: usage.searchRequestsThisMonth,
          consommeesAujourdhui: usage.searchRequests,
          plafondMensuel: limits.searchRequestsPerMonth,
          reserveManuelle: limits.searchManualReserve,
        },
        detail: breakdown,
      };
    },

    /**
     * AUTODIAGNOSTIC — pourquoi le panel refuse ce qu'il refuse.
     *
     * Né d'une soirée entière passée à deviner. Une recherche marché ne
     * trouvait rien ; les compteurs affichaient zéro partout ; le message
     * annonçait un quota épuisé. Impossible de trancher sans voir ce que le
     * routeur voyait, et chaque hypothèse coûtait un déploiement et un
     * aller-retour avec l'utilisateur.
     *
     * Cette fonction rend visible l'état exact sur lequel les décisions se
     * prennent : le catalogue tel que le Worker le construit, les compteurs
     * tels que la base les rend, et la décision de routage AVEC son motif de
     * refus pour chaque modèle écarté.
     *
     * `probe` déclenche en plus un vrai appel au fournisseur de recherche web
     * et rapporte sa réponse brute — la seule façon de distinguer un modèle
     * retiré d'une clé refusée d'un quota réellement atteint.
     *
     * AUCUNE CLÉ N'EN SORT, dans aucun cas.
     */
    async diagnostic(options: { probe?: boolean; probeAll?: boolean } = {}) {
      const usage = await deps.ledger.today();

      const demandeRecherche: ExecutionRequest = {
        capabilities: ["web_search", "structured", "reasoning"],
        dataClass: "public",
        hint: "research",
        webSearch: true,
        maxOutputTokens: 2_000,
        messages: [{ role: "user", content: "diagnostic" }],
      };

      const decision = route(models, demandeRecherche, usage, limits);

      const rapport = {
        compteurs: {
          neurones: usage.neurons,
          appelsParFournisseur: usage.requests,
          rechercheWebAujourdhui: usage.searchRequests,
          rechercheWebCeMois: usage.searchRequestsThisMonth,
        },
        plafonds: {
          neurones: limits.neurons,
          appels: limits.requests,
          rechercheWebParMois: limits.searchRequestsPerMonth,
          reserveManuelle: limits.searchManualReserve,
        },
        catalogue: models.map((m) => ({
          fournisseur: m.provider,
          modele: m.model,
          capacites: m.capabilities,
          confidentialite: m.privacy,
          fournisseurConfigure: providers.get(m.provider)?.configured() ?? false,
        })),
        // Les moteurs de recherche enregistres, et s'ils repondent encore ce
        // mois-ci. Sans cette ligne, impossible de verifier qu'une cle
        // fraichement posee a bien ete prise en compte.
        sourcesDeRecherche: await Promise.all(
          sources.all().map(async (src) => ({
            id: src.id,
            couche: src.layer,
            // `available` peut rendre un booleen ou une promesse selon la
            // source : `Promise.resolve` normalise, et une source en panne ne
            // doit pas faire echouer tout le diagnostic.
            disponible: await Promise.resolve(src.available()).catch(() => false),
          })),
        ),
        rechercheWeb: {
          uneRouteExiste: orchestrator.canWebSearch(),
          modelesRetenus: decision.candidates.map((m) => `${m.provider}/${m.model}`),
          // Le cœur du diagnostic : pourquoi chaque modèle a été écarté.
          modelesEcartes: decision.rejected,
        },
        appelReel: null as null | { ok: boolean; modele?: string; detail: string },
        epreuveParModele: null as null | Array<{ modele: string; ok: boolean; detail: string }>,
      };

      /**
       * Épreuve modèle par modèle, en contournant le routeur.
       *
       * Le routeur s'arrête au premier succès : il ne dit donc jamais ce que
       * les AUTRES modèles auraient répondu. Or c'est la seule question qui
       * compte pour savoir de quoi ce compte est réellement capable — un
       * modèle listé dans la documentation de Google peut très bien renvoyer
       * un quota à zéro sur un projet donné, et rien ne le laisse deviner de
       * l'extérieur.
       *
       * Chaque appel est minuscule et volontairement inutile : on ne cherche
       * pas une réponse, on cherche à savoir qui répond.
       */
      if (options.probeAll) {
        rapport.epreuveParModele = [];
        for (const m of models) {
          const provider = providers.get(m.provider);
          if (!provider?.configured()) {
            rapport.epreuveParModele.push({
              modele: `${m.provider}/${m.model}`,
              ok: false,
              detail: "fournisseur non configuré",
            });
            continue;
          }
          try {
            const r = await provider.generate(m, {
              messages: [{ role: "user", content: "Réponds : ok" }],
              // 800 pour tous : mesure faite le 21 aout 2026, TOUS les modeles du
              // catalogue raisonnent avant de repondre, y compris ceux qui ne
              // declarent pas la capacite. Une sonde trop serree fait echouer un
              // modele parfaitement sain, et le diagnostic accuse a tort.
              maxOutputTokens: 800,
              temperature: 0,
              ...(m.capabilities.includes("web_search") ? { webSearch: true } : {}),
            });
            rapport.epreuveParModele.push({
              modele: `${m.provider}/${m.model}`,
              ok: true,
              detail: `${r.outputTokens} jetons — ${r.text.trim().slice(0, 60) || "(vide)"}`,
            });
          } catch (e) {
            rapport.epreuveParModele.push({
              modele: `${m.provider}/${m.model}`,
              ok: false,
              detail: String(e).slice(0, 300),
            });
          }
        }
      }

      if (options.probe) {
        try {
          const r = await orchestrator.run({
            ...demandeRecherche,
            json: true,
            maxOutputTokens: 300,
            messages: [
              {
                role: "user",
                content: 'Réponds exactement {"ok":true} et rien d\'autre.',
              },
            ],
          });
          rapport.appelReel = {
            ok: true,
            modele: `${r.provider}/${r.model}`,
            detail: r.text.slice(0, 200),
          };
        } catch (e) {
          rapport.appelReel = {
            ok: false,
            detail:
              e instanceof NoFreeModelError
                ? e.trace.join("\n")
                : String(e).slice(0, 800),
          };
        }
      }

      return rapport;
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
