import {
  createMarketplaceModule,
  MockAdapter,
  VintedSafeAdapter,
  type MarketplaceAdapter,
  type MarketplaceModule,
} from "@hub/engine";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.js";
import { commandLog } from "../db/schema.js";
import { randomId } from "../lib/crypto.js";
import { d1Repositories } from "./repositories.js";
import { createHttp } from "../lib/http.js";
import type { RateLimiter } from "../do/rate-limiter.js";

/**
 * Assemble le moteur pour une requête donnée.
 *
 * ADAPTATEURS ENREGISTRÉS À CE JOUR :
 *
 *   mock         — outil de test. Permet d'exercer l'orchestrateur, la
 *                  propagation de stock et la déduplication sans toucher à
 *                  une plateforme réelle, donc sans consommer de quota ni
 *                  risquer un bannissement.
 *   vinted       — mode sûr. Déclare ne rien savoir faire et renvoie
 *                  `manual_required` : Vinted n'a pas d'API publique, et
 *                  l'API « Vinted Pro Integrations » est sur liste blanche.
 *
 * À VENIR, un par un, chacun validé en interne puis en direct :
 *   shopify, etsy, ebay, allegro, tiktok_shop
 *
 * Ajouter une plateforme se fait ici et dans son fichier d'adaptateur.
 * Aucun autre fichier n'a besoin de changer — c'est tout l'intérêt du contrat.
 */

/** Débits déclarés par plateforme, en attendant les adaptateurs réels. */
const LIMITS: Record<string, { qps: number; burst: number; qpd: number }> = {
  shopify: { qps: 2, burst: 10, qpd: 0 },
  etsy: { qps: 5, burst: 10, qpd: 8000 },
  ebay: { qps: 3, burst: 10, qpd: 5000 },
  allegro: { qps: 5, burst: 10, qpd: 0 },
  tiktok_shop: { qps: 3, burst: 10, qpd: 0 },
  vinted: { qps: 1, burst: 2, qpd: 100 },
  mock: { qps: 100, burst: 100, qpd: 0 },
};

export function buildEngine(
  env: Env,
  /**
   * Compteur de sous-requêtes partagé par toute l'invocation. Le plan gratuit
   * en autorise 50 : sans compteur commun, une commande diffusée vers cinq
   * comptes le dépasserait sans prévenir.
   */
  counter: { used: number } = { used: 0 },
  extraAdapters: MarketplaceAdapter[] = [],
): MarketplaceModule {
  const repos = d1Repositories(env.DB, env.MASTER_KEY);

  return createMarketplaceModule({
    ...repos,

    /**
     * Journalisation de TOUTES les commandes, y compris celles que le moteur
     * déclenche lui-même. La propagation de stock après une vente n'est
     * rattachée à aucune requête HTTP : journaliser côté route la laisserait
     * invisible, alors que c'est l'action la plus importante du système.
     */
    onOutcome: async (command, key, productId, outcome) => {
      if (outcome.results.length === 0) return;
      const at = Math.floor(Date.now() / 1000);
      await drizzle(env.DB)
        .insert(commandLog)
        .values(
          outcome.results.map((r) => ({
            id: randomId(),
            idempotencyKey: key,
            command,
            productId,
            accountId: r.accountId,
            marketplace: r.marketplace,
            status: r.status,
            message: r.message ?? null,
            remoteId: r.remoteId ?? null,
            at,
          })),
        );
    },

    adapters: [new MockAdapter(), new VintedSafeAdapter(), ...extraAdapters],

    // Chaque adaptateur reçoit un fetch déjà régulé par le Durable Object de
    // son compte. C'est ce qui protège des bannissements : aucune plateforme
    // ne voit jamais un débit supérieur à ce qu'elle autorise, même si
    // plusieurs synchronisations tournent en parallèle.
    httpFor: (account) => {
      const limits = LIMITS[account.marketplace];
      if (!limits) return undefined;
      const id = env.RATE_LIMITER.idFromName(account.id);
      const limiter = env.RATE_LIMITER.get(id) as DurableObjectStub<RateLimiter>;
      return createHttp({
        limiter,
        limits,
        counter,
        platform: account.marketplace,
      });
    },
  });
}
