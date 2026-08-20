import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { getConnector } from "@hub/connectors";
import { PLATFORMS, type Platform, type QueueTask } from "@hub/core";
import { shop, webhookReceipt } from "../db/schema.js";
import { credentialsFor, type Env } from "../env.js";
import { contentHash } from "../lib/crypto.js";

/**
 * Réception des webhooks — les seules routes PUBLIQUES de l'application.
 *
 * Elles ne sont pas protégées par la session (les plateformes n'en ont pas),
 * mais par la signature cryptographique du corps de la requête. Trois règles
 * s'appliquent sans exception :
 *
 * 1. LIRE LE CORPS BRUT UNE SEULE FOIS, et vérifier la signature dessus.
 *    Un JSON.parse suivi d'un JSON.stringify réordonne les clés et change les
 *    espaces : le HMAC ne correspond plus. C'est l'erreur classique.
 *
 * 2. RÉPONDRE VITE. Shopify considère le webhook comme échoué au-delà de
 *    ~5 secondes et finit par désactiver l'abonnement. On se contente donc de
 *    vérifier, dédupliquer, empiler dans la Queue, et rendre la main.
 *
 * 3. DÉDUPLIQUER. Les plateformes garantissent « au moins une fois », pas
 *    « exactement une fois ». Sans déduplication, un même paiement peut
 *    déclencher deux notifications et deux écritures.
 *
 * Un webhook mal signé reçoit 401 sans plus d'explication : ne jamais indiquer
 * à un attaquant ce qui n'allait pas dans sa signature.
 */

export const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post("/:platform", async (c) => {
  const platform = c.req.param("platform") as Platform;
  if (!PLATFORMS.includes(platform)) return c.text("Not found", 404);

  const connector = getConnector(platform);
  const rawBody = await c.req.text(); // lu une fois, jamais re-sérialisé
  const creds = credentialsFor(c.env, platform);

  const valid = await connector.verifyWebhook({
    creds,
    headers: c.req.raw.headers,
    rawBody,
  });
  if (!valid) return c.text("Unauthorized", 401);

  const event = connector.parseWebhook({
    headers: c.req.raw.headers,
    rawBody,
  });
  if (!event) return c.text("OK", 200); // sujet non géré : on acquitte quand même

  const db = drizzle(c.env.DB);

  const found = await db
    .select({ id: shop.id })
    .from(shop)
    .where(
      and(eq(shop.platform, platform), eq(shop.externalId, event.externalShopId)),
    )
    .limit(1);

  const shopRow = found[0];
  if (!shopRow) return c.text("OK", 200); // boutique déconnectée : on ignore

  // Déduplication : la clé primaire fait le travail, un doublon lève un conflit.
  const receiptId = await contentHash({ p: platform, e: event.eventId });
  try {
    await db.insert(webhookReceipt).values({
      id: receiptId,
      shopId: shopRow.id,
      topic: event.topic,
      receivedAt: Math.floor(Date.now() / 1000),
    });
  } catch {
    return c.text("OK", 200); // déjà traité
  }

  await c.env.SYNC_QUEUE.send({
    kind: "webhook",
    shopId: shopRow.id,
    topic: event.topic,
    payload: rawBody,
  } satisfies QueueTask);

  return c.text("OK", 200);
});

/**
 * eBay impose une vérification du endpoint : il envoie un `challenge_code` en
 * GET et attend le SHA-256 de (challenge_code + verificationToken + endpoint).
 */
webhooks.get("/ebay", async (c) => {
  const challenge = c.req.query("challenge_code");
  if (!challenge) return c.text("Not found", 404);

  const endpoint = `${c.env.APP_URL}/api/webhooks/ebay`;
  const token = c.env.EBAY_CLIENT_SECRET; // à remplacer par le verification token dédié
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(challenge + token + endpoint),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return c.json({ challengeResponse: hex });
});
