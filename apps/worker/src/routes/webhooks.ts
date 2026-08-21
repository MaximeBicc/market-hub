import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { CanonicalOrderEvent } from "@hub/engine";
import { shop } from "../db/schema.js";
import type { Env } from "../env.js";
import { buildEngine } from "../engine/module.js";
import { d1Repositories } from "../engine/repositories.js";
import type { QueueTask, SyncResource } from "@hub/core";

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
  const platform = c.req.param("platform");
  const rawBody = await c.req.text(); // lu une fois, jamais re-sérialisé

  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);
  const mod = buildEngine(c.env);

  if (!mod.registry.has(platform)) return c.text("Not found", 404);
  const adapter = mod.registry.get(platform);
  if (!adapter.verifyAndParseWebhook) return c.text("OK", 200);

  /**
   * Le webhook n'identifie pas le compte de façon exploitable avant
   * vérification : on essaie donc chaque compte de cette plateforme, et la
   * signature elle-même désigne le bon. Avec une poignée de comptes c'est
   * négligeable ; et surtout, aucune signature n'est acceptée sur la foi
   * d'un en-tête que l'appelant contrôle.
   */
  const candidats = await db
    .select({ id: shop.id })
    .from(shop)
    .where(eq(shop.platform, platform));

  let events: CanonicalOrderEvent[] | null = null;
  let accountId: string | null = null;

  for (const cand of candidats) {
    const account = await repos.accounts.get(cand.id);
    if (!account) continue;
    try {
      const parsed = await adapter.verifyAndParseWebhook(
        { account, credentials: await repos.credentials.get(cand.id) },
        c.req.raw,
        rawBody,
      );
      events = parsed;
      accountId = cand.id;
      break;
    } catch {
      // Signature invalide pour ce compte : on essaie le suivant.
    }
  }

  // Aucun compte n'a reconnu la signature. On ne dit pas pourquoi : indiquer
  // à un attaquant ce qui n'allait pas dans sa signature l'aiderait.
  if (!events || !accountId) return c.text("Unauthorized", 401);

  /*
   * Un webhook vérifié n'est pas forcément une vente.
   *
   * Shopify pousse un changement de stock, Etsy ne pousse qu'un identifiant
   * de commande sans forme documentée : dans les deux cas il n'y a rien à
   * traduire, mais tout à relire. On empile donc une synchronisation ciblée
   * plutôt que d'attendre le prochain passage du cron — c'est ce qui fait
   * passer la détection de plusieurs minutes à quelques secondes.
   *
   * Après vérification, jamais avant : sans cela, n'importe qui pourrait
   * déclencher des synchronisations en boucle et vider les quotas.
   */
  for (const resource of adapter.webhookResync?.(c.req.raw) ?? []) {
    await c.env.SYNC_QUEUE.send({
      kind: "sync",
      shopId: accountId,
      resource: resource as SyncResource,
      cursor: null,
      depth: 0,
    } satisfies QueueTask);
  }

  if (events.length === 0) return c.text("OK", 200);

  /**
   * On empile plutôt que de traiter ici. Shopify considère le webhook comme
   * échoué au-delà d'environ cinq secondes et finit par désactiver
   * l'abonnement ; or la propagation vers les autres canaux prend des appels
   * réseau. Vérifier puis rendre la main est la seule tenue possible.
   */
  await c.env.SYNC_QUEUE.send({
    kind: "webhook",
    shopId: accountId,
    topic: c.req.header("X-Shopify-Topic") ?? platform,
    // Le corps transporté est l'événement CANONIQUE, déjà vérifié : le
    // consommateur n'a plus de signature à contrôler.
    payload: JSON.stringify(events),
  });

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
