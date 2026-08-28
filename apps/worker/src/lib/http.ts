import { ConnectorError } from "@hub/core";
import type { PlatformLimits } from "@hub/connectors";
import type { RateLimiter } from "../do/rate-limiter.js";

/**
 * fetch instrumenté remis à chaque connecteur.
 *
 * Il fait quatre choses que les connecteurs ne doivent pas refaire :
 *
 *  1. COMPTE LES SOUS-REQUÊTES. Le plan gratuit en autorise 50 par invocation ;
 *     la 51e échoue brutalement au milieu d'une synchronisation. On s'arrête
 *     nous-mêmes à 40 avec une erreur propre, la tâche reprend au message suivant.
 *
 *  2. PASSE PAR LE TOKEN BUCKET du Durable Object avant chaque appel réseau.
 *
 *  3. TRADUIT LES CODES HTTP en ConnectorError typée, pour que le consommateur
 *     sache distinguer « réessaie dans 30 s » de « réautorise la boutique ».
 *
 *  4. BORNE LA CONCURRENCE implicitement : les appels sont séquentiels. Le plan
 *     gratuit ne tolère que 6 connexions sortantes simultanées ; un
 *     Promise.all de 20 fetch échoue de façon non déterministe.
 */

export const SUBREQUEST_BUDGET = 40; // sur 50 autorisées, marge pour D1 et la queue

export class SubrequestBudgetExceeded extends Error {
  constructor() {
    super("Budget de sous-requêtes épuisé pour cette invocation");
    this.name = "SubrequestBudgetExceeded";
  }
}

export interface HttpFactoryArgs {
  limiter: DurableObjectStub<RateLimiter>;
  limits: PlatformLimits;
  /** Compteur partagé par toutes les tâches d'un même lot de queue. */
  counter: { used: number };
  platform: string;
}

export function createHttp({
  limiter,
  limits,
  counter,
  platform,
}: HttpFactoryArgs) {
  return async function http(
    input: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (counter.used >= SUBREQUEST_BUDGET) {
      throw new SubrequestBudgetExceeded();
    }

    const permit = await limiter.acquire(1, limits.qps, limits.burst, limits.qpd);
    if (!permit.ok) {
      throw new ConnectorError(
        `Débit ${platform} saturé (${permit.reason})`,
        "rate_limited",
        permit.waitMs,
      );
    }

    /*
     * DEUX, et non une.
     *
     * Cloudflare compte comme sous-requête TOUT appel sortant, y compris vers
     * ses propres services — le Durable Object de limitation juste au-dessus
     * en est une. Ne compter que le `fetch` sous-estimait la consommation d'un
     * facteur deux : le garde-fou se déclenchait bien après que Cloudflare ait
     * tué l'invocation, et c'est cette mort brutale en plein milieu d'une
     * diffusion qui laissait des annonces créées chez la plateforme et
     * inconnues de la base.
     */
    counter.used += 2;
    const res = await fetch(input, init);

    if (res.status === 401 || res.status === 403) {
      /*
       * NOMMER L'APPEL REFUSÉ, PAS SEULEMENT LE CODE.
       *
       * « eBay a refusé le jeton (403) » ne dit pas SUR QUOI. Or une séquence
       * en enchaîne plusieurs, et un 403 sur la configuration d'alerte n'a
       * pas la même cause qu'un 403 sur un abonnement : le premier tient au
       * type de jeton, le second à une portée manquante. Sans le chemin, on
       * cherche au hasard.
       *
       * eBay explique souvent la vraie raison dans son corps de réponse ; on
       * le rapporte, tronqué, plutôt que de le jeter.
       */
      const chemin = new URL(
        typeof input === "string" ? input : String(input),
      ).pathname;
      const detail = await res.text().catch(() => "");
      throw new ConnectorError(
        `${platform} a refusé le jeton (${res.status}) sur ${chemin}${
          detail ? ` — ${detail.slice(0, 180)}` : ""
        }`,
        "auth_expired",
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "60");
      throw new ConnectorError(
        `${platform} a renvoyé 429`,
        "rate_limited",
        retryAfter * 1000,
      );
    }
    if (res.status >= 500) {
      throw new ConnectorError(
        `${platform} indisponible (${res.status})`,
        "transient",
        30_000,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConnectorError(
        `${platform} ${res.status} : ${body.slice(0, 300)}`,
        "permanent",
      );
    }

    return res;
  };
}
