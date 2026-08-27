import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { getConnector } from "@hub/connectors";
/*
 * LE MÊME PLANIFICATEUR QUE PARTOUT AILLEURS.
 *
 * Ce fichier avait le sien, aveugle aux capacités : il créait trois
 * relevés pour TOUTE plateforme connectée. Alibaba, qui ne vend rien et
 * déclare toutes ses capacités à faux, s'est donc retrouvé avec un relevé
 * de commandes, un d'inventaire et un de catalogue — actifs, exécutés, et
 * consommant du quota pour un adaptateur qui n'a rien à relever.
 *
 * Le planificateur du moteur lit les capacités et désactive ce qui n'a pas
 * lieu d'être. Deux fonctions du même nom faisant presque la même chose,
 * c'est celle qui tourne à la connexion qui gagnait.
 */
import { ensureSyncJobs } from "../engine/sync.js";
import { activerTempsReel } from "../lib/temps-reel.js";
import { PLATFORMS, type Platform } from "@hub/core";
import { shop, syncJob } from "../db/schema.js";
import { credentialsFor, type Env } from "../env.js";
import { makePkce, randomId, timingSafeEqual } from "../lib/crypto.js";
import { storeTokens } from "../lib/tokens.js";
import { authenticate } from "../lib/session.js";

/**
 * Connexion d'une boutique (OAuth 2.0, code d'autorisation).
 *
 * Deux protections obligatoires, toutes deux stockées dans KV avec une durée
 * de vie de 10 minutes :
 *
 *   `state`         — jeton anti-CSRF. Sans lui, un attaquant peut vous faire
 *                     connecter SA boutique à VOTRE compte, et lire ensuite
 *                     tout ce que vous y écrivez.
 *   `code_verifier` — PKCE. Empêche l'interception du code d'autorisation.
 *                     Etsy l'exige ; on l'applique partout par principe.
 *
 * Le démarrage exige une session valide. Le retour, lui, ne peut pas l'exiger
 * de façon fiable (redirection depuis un domaine tiers) : c'est `state` qui
 * porte la preuve, et il est lié à l'identifiant utilisateur.
 */

export const oauth = new Hono<{ Bindings: Env }>();

interface PendingAuth {
  userId: string;
  platform: Platform;
  verifier: string;
  /**
   * Shopify seulement : le domaine boutique saisi par l'utilisateur.
   * `| undefined` explicite car `exactOptionalPropertyTypes` distingue
   * « clé absente » de « clé présente valant undefined », et les deux
   * arrivent ici selon que le paramètre de requête existe ou non.
   */
  shopDomain?: string | undefined;
}

oauth.get("/:platform/start", async (c) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.text("Unauthorized", 401);

  const platform = c.req.param("platform") as Platform;
  if (!PLATFORMS.includes(platform)) return c.text("Not found", 404);

  const state = randomId(24);
  const { verifier, challenge } = await makePkce();
  const shopDomain = c.req.query("shop") ?? undefined;

  await c.env.CACHE.put(
    `oauth:${state}`,
    JSON.stringify({ userId: me.id, platform, verifier, shopDomain } satisfies PendingAuth),
    { expirationTtl: 600 },
  );

  const redirectUri = buildRedirectUri(c.env, platform, shopDomain);
  const url = getConnector(platform).buildAuthUrl({
    creds: credentialsFor(c.env, platform),
    state,
    redirectUri,
    codeChallenge: challenge,
  });

  return c.redirect(url, 302);
});

oauth.get("/:platform/callback", async (c) => {
  const platform = c.req.param("platform") as Platform;
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Requête invalide", 400);

  const stored = await c.env.CACHE.get(`oauth:${state}`);
  if (!stored) return c.text("État expiré ou inconnu — recommencez", 400);
  await c.env.CACHE.delete(`oauth:${state}`); // usage unique

  const pending = JSON.parse(stored) as PendingAuth;
  if (!timingSafeEqual(pending.platform, platform)) {
    return c.text("Incohérence de plateforme", 400);
  }

  const redirectUri = buildRedirectUri(c.env, platform, pending.shopDomain);
  const { tokens, externalId, displayName } = await getConnector(
    platform,
  ).exchangeCode({
    creds: credentialsFor(c.env, platform),
    code,
    redirectUri,
    codeVerifier: pending.verifier,
  });

  const db = drizzle(c.env.DB);
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select({ id: shop.id })
    .from(shop)
    .where(eq(shop.externalId, externalId))
    .limit(1);

  const shopId = existing[0]?.id ?? randomId();

  await db
    .insert(shop)
    .values({
      id: shopId,
      platform,
      externalId,
      displayName,
      status: "active",
      config: JSON.stringify({}),
      connectedAt: now,
    })
    .onConflictDoUpdate({
      target: [shop.platform, shop.externalId],
      set: { displayName, status: "active" },
    });

  await storeTokens(c.env, shopId, tokens);
  await ensureSyncJobs(c.env, shopId);

  /*
   * LE TEMPS RÉEL S'ACTIVE TOUT DE SUITE, PAS À UN CLIC PRÈS.
   *
   * Une boutique Shopify connectée sans abonnement reste relevée toutes les
   * deux minutes : sept fois plus de tâches, pour une fraîcheur sept fois
   * pire. L'abonnement échoue en silence si la portée `write_webhooks`
   * manque — la boutique fonctionne alors comme avant, en relevé, et le
   * rattrapage horaire réessaiera.
   */
  if (platform === "shopify") {
    try {
      await activerTempsReel(c.env, shopId);
    } catch {
      // Rien à dire ici : la connexion a réussi, c'est l'essentiel.
    }
  }

  return c.redirect("/settings/shops?connected=1", 302);
});

/** Déconnexion d'une boutique : on efface les jetons, on garde l'historique. */
oauth.post("/:platform/disconnect/:shopId", async (c) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.text("Unauthorized", 401);

  const db = drizzle(c.env.DB);
  const shopId = c.req.param("shopId");
  await db.update(shop).set({ status: "paused" }).where(eq(shop.id, shopId));
  await db.update(syncJob).set({ enabled: 0 }).where(eq(syncJob.shopId, shopId));
  return c.json({ ok: true });
});

function buildRedirectUri(
  env: Env,
  platform: Platform,
  shopDomain?: string,
): string {
  const base = `${env.APP_URL}/api/oauth/${platform}/callback`;
  // Shopify a besoin de savoir sur quel domaine boutique porte l'échange.
  return shopDomain ? `${base}?shop=${encodeURIComponent(shopDomain)}` : base;
}

