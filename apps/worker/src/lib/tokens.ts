import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { getConnector } from "@hub/connectors";
import type { TokenSet } from "@hub/connectors";
import type { Platform } from "@hub/core";
import { ConnectorError } from "@hub/core";
import { oauthToken, shop } from "../db/schema.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { credentialsFor, type Env } from "../env.js";
import type { RateLimiter } from "../do/rate-limiter.js";

/**
 * Cycle de vie des jetons OAuth.
 *
 * Chaque plateforme a sa propre horloge, et c'est ici — et nulle part ailleurs —
 * qu'on en tient compte :
 *
 *   Shopify   jeton « offline » : n'expire jamais. Rien à faire.
 *   eBay      accès 2 h, rafraîchissement 18 mois.
 *   Etsy      accès 1 h, rafraîchissement 90 JOURS glissants.
 *             ⚠️ Non utilisé pendant 90 jours → réautorisation manuelle.
 *   Alibaba   variable selon le programme ; traité comme eBay.
 */

/** Marge de sécurité : on rafraîchit avant l'expiration réelle. */
const REFRESH_SKEW_SEC = 300;

export interface ResolvedShop {
  id: string;
  platform: Platform;
  externalId: string;
  displayName: string;
  config: Record<string, unknown>;
  accessToken: string;
}

/**
 * Renvoie un jeton d'accès valide, en le rafraîchissant si nécessaire.
 * Le rafraîchissement est sérialisé par le Durable Object de la boutique :
 * deux tâches concurrentes ne peuvent pas se marcher dessus.
 */
export async function getValidAccessToken(
  env: Env,
  shopId: string,
  limiter: DurableObjectStub<RateLimiter>,
): Promise<ResolvedShop> {
  const db = drizzle(env.DB);

  const rows = await db
    .select()
    .from(shop)
    .innerJoin(oauthToken, eq(oauthToken.shopId, shop.id))
    .where(eq(shop.id, shopId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new ConnectorError(`Boutique ${shopId} introuvable`, "permanent");

  const s = row.shop;
  const t = row.oauth_token;
  const platform = s.platform as Platform;
  const now = Math.floor(Date.now() / 1000);

  let tokens = await decryptJson<TokenSet>(env.MASTER_KEY, t.ciphertext);

  const needsRefresh =
    t.accessExpiresAt !== null && t.accessExpiresAt - REFRESH_SKEW_SEC <= now;

  if (needsRefresh) {
    if (!tokens.refreshToken) {
      throw new ConnectorError(
        `${platform} : jeton expiré et aucun rafraîchissement possible`,
        "auth_expired",
      );
    }

    // Le verrou évite deux rafraîchissements simultanés, qui s'invalideraient.
    tokens = await limiter.withRefreshLock(async () => {
      const fresh = await getConnector(platform).refresh({
        creds: credentialsFor(env, platform),
        refreshToken: tokens.refreshToken!,
      });
      // eBay ne renvoie pas de nouvelle date de rafraîchissement : on garde la nôtre.
      const merged: TokenSet = {
        ...fresh,
        refreshToken: fresh.refreshToken ?? tokens.refreshToken,
        refreshExpiresAt: fresh.refreshExpiresAt ?? t.refreshExpiresAt,
      };
      await db
        .update(oauthToken)
        .set({
          ciphertext: await encryptJson(env.MASTER_KEY, merged),
          accessExpiresAt: merged.accessExpiresAt,
          refreshExpiresAt: merged.refreshExpiresAt,
          updatedAt: now,
        })
        .where(eq(oauthToken.shopId, shopId));
      return merged;
    });
  }

  return {
    id: s.id,
    platform,
    externalId: s.externalId,
    displayName: s.displayName,
    config: {
      ...(JSON.parse(s.config) as Record<string, unknown>),
      // Etsy exige le client_id en en-tête x-api-key à chaque appel ;
      // Alibaba a besoin du couple clé/secret pour signer.
      ...credentialsFor(env, platform),
    },
    accessToken: tokens.accessToken,
  };
}

/** Écrit un jeu de jetons tout neuf (fin du flux OAuth). */
export async function storeTokens(
  env: Env,
  shopId: string,
  tokens: TokenSet,
): Promise<void> {
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);

  /*
   * ══ RECONNECTER NE DOIT PAS TOUT EFFACER ══
   *
   * Ce coffre ne contient pas que des jetons. Il porte aussi tout ce qu'une
   * boutique a fallu configurer à la main :
   *
   *   eBay     l'adresse d'expédition et les trois politiques, sans
   *            lesquelles aucune annonce ne peut être publiée
   *   Etsy     le profil de livraison, le délai de préparation, et le SECRET
   *            de webhook — celui qu'on ne peut obtenir qu'une fois, dans le
   *            portail d'Etsy
   *   Shopify  l'emplacement d'inventaire
   *
   * L'ancienne écriture chiffrait `tokens` SEUL et remplaçait le coffre
   * entier. Une reconnexion — le geste même qu'on demande quand un jeton
   * expire — effaçait donc silencieusement tous ces réglages. On les
   * redécouvrait à la première publication refusée, sans lien évident avec
   * la reconnexion faite la veille.
   *
   * On relit donc, on fusionne, on réécrit. Les jetons neufs l'emportent —
   * c'est le but de l'appel — et le reste survit.
   */
  const [existant] = await db
    .select({ ciphertext: oauthToken.ciphertext })
    .from(oauthToken)
    .where(eq(oauthToken.shopId, shopId))
    .limit(1);

  let anciens: Record<string, unknown> = {};
  if (existant?.ciphertext) {
    try {
      anciens = await decryptJson<Record<string, unknown>>(
        env.MASTER_KEY,
        existant.ciphertext,
      );
    } catch {
      /*
       * Coffre illisible — clé maîtresse changée, donnée corrompue. On repart
       * des seuls jetons plutôt que d'échouer : sans ça, la reconnexion
       * elle-même deviendrait impossible, et c'est précisément le geste qui
       * répare.
       */
    }
  }

  const ciphertext = await encryptJson(env.MASTER_KEY, {
    ...anciens,
    ...tokens,
  });

  await db
    .insert(oauthToken)
    .values({
      shopId,
      ciphertext,
      keyVersion: 1,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: oauthToken.shopId,
      set: {
        ciphertext,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        updatedAt: now,
      },
    });
}

/** Combien de jours avant que le rafraîchissement ne devienne impossible. */
export function daysUntilReauth(refreshExpiresAt: number | null): number | null {
  if (refreshExpiresAt === null) return null;
  return Math.floor((refreshExpiresAt - Date.now() / 1000) / 86400);
}
