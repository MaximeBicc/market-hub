import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { getConnector } from "@hub/connectors";
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
  await ensureSyncJobs(c.env, shopId, platform);

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

/**
 * Cadence de synchronisation par plateforme.
 *
 * Elle n'est pas identique partout, et ce n'est pas arbitraire :
 * Shopify et eBay poussent des webhooks, on peut donc y sonder rarement.
 * Etsy ne pousse rien : c'est le polling ou rien.
 */
async function ensureSyncJobs(
  env: Env,
  shopId: string,
  platform: Platform,
): Promise<void> {
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const pushes = getConnector(platform).supportsWebhooks;

  const plan = [
    { resource: "orders", intervalSec: pushes ? 1800 : 600 },
    { resource: "inventory", intervalSec: 900 },
    { resource: "listings", intervalSec: 86400 },
  ];

  for (const p of plan) {
    await db
      .insert(syncJob)
      .values({
        id: randomId(),
        shopId,
        resource: p.resource,
        intervalSec: p.intervalSec,
        nextRunAt: now,
        enabled: 1,
        failureCount: 0,
      })
      .onConflictDoUpdate({
        target: [syncJob.shopId, syncJob.resource],
        set: { enabled: 1, failureCount: 0, nextRunAt: now },
      });
  }
}
