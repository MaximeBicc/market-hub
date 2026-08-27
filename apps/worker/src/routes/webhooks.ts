import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { appliquerStockDistant } from "../lib/stock-distant.js";
import { jetonVerificationValide, reponseDefiEbay } from "@hub/engine";
import { eq } from "drizzle-orm";
import type { CanonicalOrderEvent } from "@hub/engine";
import { eventLog, shop } from "../db/schema.js";
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
   * AUCUNE SIGNATURE N'EST ACCEPTÉE SUR LA FOI D'UN EN-TÊTE.
   *
   * C'est la règle, et elle ne bouge pas : la notification ne prouve rien
   * avant vérification cryptographique, et l'appelant contrôle entièrement ce
   * qu'il envoie. On essaie donc les comptes de la plateforme jusqu'à ce
   * qu'une signature soit valide — c'est elle qui désigne le bon.
   *
   * Ce qui change : l'ORDRE dans lequel on les essaie. Shopify nomme la
   * boutique dans un en-tête, Etsy dans son corps. Cette valeur ne prouve
   * rien, mais elle indique qui essayer D'ABORD. Avec quatre boutiques c'est
   * invisible ; avec deux cents, c'est une vérification au lieu de deux
   * cents, et la même garantie exactement.
   */
  const candidats = await db
    .select({ id: shop.id, externalId: shop.externalId })
    .from(shop)
    .where(eq(shop.platform, platform));

  const indice = adapter.indiceCompte?.(c.req.raw, rawBody) ?? null;
  if (indice) {
    const rang = (x: { externalId: string | null }) =>
      x.externalId === indice ? 0 : 1;
    candidats.sort((a, b) => rang(a) - rang(b));
  }

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
  for (const signal of adapter.webhookSignaux?.(c.req.raw, rawBody) ?? []) {
    /*
     * UN SIGNAL PRÉCIS SE TRAITE ICI, PAS DANS UNE FILE.
     *
     * Shopify nomme l'article d'inventaire et sa nouvelle quantité : il n'y a
     * rien à relire, et donc rien à empiler. Écrire directement économise
     * trois opérations de file ET la lecture du catalogue entier — mille
     * variantes pour une qui a bougé de deux unités.
     *
     * C'est aussi plus rapide : le stock est à jour avant même que Shopify
     * n'ait fini d'attendre notre réponse.
     */
    if (signal.type === "stock") {
      const applique = await appliquerStockDistant(
        c.env,
        accountId,
        signal.refDistante,
        signal.disponible,
      );
      if (applique) continue;
      /*
       * Faute de correspondance — une variante créée chez Shopify que nous
       * n'avons pas encore vue — on retombe sur la relecture. Perdre le
       * signal laisserait un stock faux jusqu'au filet horaire.
       */
    }

    const resource =
      signal.type === "relire" ? signal.resource : ("inventory" as const);
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

  /*
   * Le hachage porte sur l'ADRESSE EXACTE que eBay appelle : la chaîne saisie
   * dans son formulaire doit être identique caractère pour caractère à
   * celle-ci, barre oblique finale comprise. Un écart et la réponse au défi
   * est fausse sans qu'aucun des deux côtés ne dise pourquoi.
   */
  const endpoint = `${c.env.APP_URL.replace(/\/+$/, "")}/api/webhooks/ebay`;
  const token = c.env.EBAY_VERIFICATION_TOKEN ?? "";
  if (!token) return c.text("Not found", 404); // pas de jeton, pas de poignée de main

  /*
   * eBay impose au jeton une forme précise : de trente-deux à quatre-vingts
   * caractères, lettres, chiffres, tiret et souligné. Un jeton trop court
   * fait échouer l'enregistrement de la destination avec un message qui ne
   * dit PAS que c'est la longueur — et cette route répondrait pendant ce
   * temps un condensé parfaitement calculé que rien n'accepterait jamais.
   *
   * On le signale plutôt que de laisser chercher.
   */
  if (!jetonVerificationValide(token)) {
    await drizzle(c.env.DB)
      .insert(eventLog)
      .values({
        id: crypto.randomUUID(),
        at: Math.floor(Date.now() / 1000),
        level: "error",
        scope: "webhook",
        message:
          "EBAY_VERIFICATION_TOKEN hors format : 32 à 80 caractères parmi [A-Za-z0-9_-]. eBay refusera la destination sans dire que c'est la longueur.",
      });
  }

  return c.json({
    challengeResponse: await reponseDefiEbay(challenge, token, endpoint),
  });
});
