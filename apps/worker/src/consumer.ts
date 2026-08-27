import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { getConnector } from "@hub/connectors";
import { ConnectorError } from "@hub/core";
import { NoFreeModelError } from "@hub/ai";
import type { QueueTask, SyncTask, UnifiedListing, UnifiedOrder } from "@hub/core";
import {
  aiJob,
  eventLog,
  listing,
  order,
  orderLine,
  shop,
  syncJob,
} from "./db/schema.js";
import { buildAi } from "./ai/module.js";
import type { Env } from "./env.js";
import { contentHash, randomId } from "./lib/crypto.js";
import { createHttp, SubrequestBudgetExceeded } from "./lib/http.js";
import { getValidAccessToken } from "./lib/tokens.js";
import { evaluateAlerts } from "./lib/alerts.js";
import { runEngineSync } from "./engine/sync.js";
import { buildEngine } from "./engine/module.js";
import type { CanonicalOrderEvent } from "@hub/engine";
import { appliquerDisponibilite } from "./lib/disponibilite.js";
import type { RateLimiter } from "./do/rate-limiter.js";

/**
 * CONSOMMATEUR DE QUEUE — c'est ici, et seulement ici, que le travail réel a lieu.
 *
 * Chaque invocation reçoit au plus 5 messages (max_batch_size dans
 * wrangler.jsonc) et dispose de son propre budget de 50 sous-requêtes. Le
 * compteur `counter` est partagé par le lot : dès qu'on approche de 40, on
 * arrête proprement et on remet le reste en queue. Aucune tâche n'est perdue.
 *
 * Pourquoi 1 message = 1 PAGE et non 1 boutique entière : une boutique de
 * 2 000 annonces demanderait 20 pages, soit bien plus que 50 sous-requêtes.
 * En découpant, chaque page repart avec un budget neuf.
 */

/** Garde-fou contre une pagination qui ne se termine jamais. */
const MAX_PAGE_DEPTH = 40;

export async function handleQueue(
  batch: MessageBatch<QueueTask>,
  env: Env,
): Promise<void> {
  const counter = { used: 0 };

  for (const msg of batch.messages) {
    try {
      if (counter.used >= 30) {
        // Il reste trop peu de budget pour une tâche complète : on la reporte.
        msg.retry({ delaySeconds: 5 });
        continue;
      }
      await handleTask(env, msg.body, counter);
      msg.ack();
    } catch (err) {
      await onTaskError(env, msg, err);
    }
  }
}

async function handleTask(
  env: Env,
  task: QueueTask,
  counter: { used: number },
): Promise<void> {
  switch (task.kind) {
    case "sync":
      return runSync(env, task, counter);
    case "webhook":
      return runWebhook(env, task, counter);
    case "write":
      return runWrite(env, task, counter);
    case "ai":
      return runAi(env, task, counter);
  }
}

/** Le stub du Durable Object qui régule cette boutique. */
function limiterFor(env: Env, shopId: string): DurableObjectStub<RateLimiter> {
  const id = env.RATE_LIMITER.idFromName(shopId);
  return env.RATE_LIMITER.get(id) as DurableObjectStub<RateLimiter>;
}

/* ------------------------------------------------------------------ */
/* Synchronisation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Synchronisation — déléguée au moteur.
 *
 * L'ancienne implémentation lisait la plateforme et écrivait en base, sans
 * plus. Le moteur, lui, fait entrer chaque vente par le point d'entrée
 * canonique : elle est dédupliquée, elle décrémente le stock central, et
 * elle est PROPAGÉE aux autres canaux. C'est toute la différence entre un
 * tableau de bord et un outil qui empêche de survendre.
 */
async function runSync(
  env: Env,
  task: SyncTask,
  counter: { used: number },
): Promise<void> {
  return runEngineSync(env, task, counter);
}

/* ------------------------------------------------------------------ */
/* Écriture en base — le diff par empreinte                            */
/* ------------------------------------------------------------------ */

/**
 * N'écrit que ce qui a réellement changé.
 *
 * C'est la mesure qui décide si le projet tient dans le quota gratuit de D1
 * (100 000 lignes écrites par jour). Sans ce diff, resynchroniser 2 000
 * annonces toutes les 15 minutes coûterait 192 000 écritures quotidiennes —
 * on serait coupé avant midi. Avec, on n'écrit que les quelques annonces
 * dont le prix ou le stock a bougé.
 */
async function upsertListings(
  env: Env,
  shopId: string,
  items: UnifiedListing[],
): Promise<UnifiedListing[]> {
  if (items.length === 0) return [];
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select({ externalId: listing.externalId, contentHash: listing.contentHash })
    .from(listing)
    .where(eq(listing.shopId, shopId));
  const known = new Map(existing.map((r) => [r.externalId, r.contentHash]));

  const changed: UnifiedListing[] = [];
  const writes = [];

  for (const it of items) {
    const hash = await contentHash({
      p: it.price.amount,
      c: it.price.currency,
      q: it.quantity,
      s: it.status,
      t: it.title,
    });
    if (known.get(it.externalId) === hash) continue; // inchangé → aucune écriture

    changed.push(it);
    writes.push(
      db
        .insert(listing)
        .values({
          id: randomId(),
          shopId,
          productId: null,
          externalId: it.externalId,
          sku: it.sku,
          title: it.title,
          priceAmount: it.price.amount,
          priceCurrency: it.price.currency,
          quantity: it.quantity,
          status: it.status,
          url: it.url,
          imageUrl: it.imageUrl,
          contentHash: hash,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: [listing.shopId, listing.externalId],
          set: {
            sku: it.sku,
            title: it.title,
            priceAmount: it.price.amount,
            priceCurrency: it.price.currency,
            quantity: it.quantity,
            status: it.status,
            url: it.url,
            imageUrl: it.imageUrl,
            contentHash: hash,
            syncedAt: now,
          },
        }),
    );
  }

  // db.batch = une seule requête D1, donc une seule sous-requête.
  if (writes.length) await db.batch(writes as never);
  return changed;
}

async function upsertOrders(
  env: Env,
  shopId: string,
  items: UnifiedOrder[],
): Promise<UnifiedOrder[]> {
  if (items.length === 0) return [];
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select({ externalId: order.externalId, contentHash: order.contentHash })
    .from(order)
    .where(eq(order.shopId, shopId));
  const known = new Map(existing.map((r) => [r.externalId, r.contentHash]));

  const changed: UnifiedOrder[] = [];
  const writes = [];

  for (const o of items) {
    const hash = await contentHash({
      s: o.status,
      t: o.total.amount,
      n: o.lines.length,
    });
    if (known.get(o.externalId) === hash) continue;

    changed.push(o);
    const orderId = randomId();
    writes.push(
      db
        .insert(order)
        .values({
          id: orderId,
          shopId,
          externalId: o.externalId,
          status: o.status,
          totalAmount: o.total.amount,
          totalCurrency: o.total.currency,
          buyerName: o.buyerName,
          placedAt: o.placedAt,
          contentHash: hash,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: [order.shopId, order.externalId],
          set: {
            status: o.status,
            totalAmount: o.total.amount,
            contentHash: hash,
            syncedAt: now,
          },
        }),
    );
    // Les lignes ne sont écrites qu'à la création : elles ne changent jamais.
    if (!known.has(o.externalId)) {
      for (const l of o.lines) {
        writes.push(
          db.insert(orderLine).values({
            id: randomId(),
            orderId,
            sku: l.sku,
            listingExternalId: l.listingExternalId,
            title: l.title,
            quantity: l.quantity,
            unitPriceAmount: l.unitPrice.amount,
            unitPriceCurrency: l.unitPrice.currency,
          }),
        );
      }
    }
  }

  if (writes.length) await db.batch(writes as never);
  return changed;
}

/* ------------------------------------------------------------------ */
/* Webhooks et écritures sortantes                                     */
/* ------------------------------------------------------------------ */

/**
 * Webhook déjà vérifié et traduit par la route.
 *
 * Le corps transporte des événements canoniques, pas la charge utile brute :
 * la signature a été contrôlée au moment de la réception, sur le corps
 * original. La refaire ici serait impossible — re-sérialiser le JSON casse le
 * HMAC — et inutile.
 */
async function runWebhook(
  env: Env,
  task: Extract<QueueTask, { kind: "webhook" }>,
  _counter: { used: number },
): Promise<void> {
  const events = JSON.parse(task.payload) as CanonicalOrderEvent[];
  const mod = buildEngine(env);

  /*
   * LA VENTE QUI VIDE UN ARTICLE DOIT LE RETIRER DE LA VENTE.
   *
   * `ingest` décrémente le stock et propage la nouvelle valeur aux autres
   * boutiques, mais une quantité à zéro laisse l'annonce en ligne : chez
   * Shopify elle affiche « épuisé », chez eBay et Etsy elle se masque — et
   * rien ne garantit qu'un acheteur ne passe pas entre les deux.
   *
   * Les produits touchés sont dédoublonnés : une commande de trois coloris du
   * même article ne doit déclencher qu'une seule bascule.
   */
  const touches = new Set<string>();
  for (const event of events) {
    const r = await mod.salesSync.ingest(event);
    for (const p of r.changed) touches.add(p);
  }
  for (const productId of touches) {
    await appliquerDisponibilite(env, productId, _counter);
  }
}

async function runWrite(
  env: Env,
  task: Extract<QueueTask, { kind: "write" }>,
  counter: { used: number },
): Promise<void> {
  const limiter = limiterFor(env, task.shopId);
  const resolved = await getValidAccessToken(env, task.shopId, limiter);
  const connector = getConnector(resolved.platform);
  const ctx = {
    shopId: resolved.id,
    externalId: resolved.externalId,
    accessToken: resolved.accessToken,
    config: resolved.config,
    http: createHttp({
      limiter,
      limits: connector.limits,
      counter,
      platform: resolved.platform,
    }),
  };

  if (task.op === "update_stock") {
    await connector.updateStock(ctx, task.listingExternalId, task.value);
  } else {
    await connector.updatePrice(ctx, task.listingExternalId, {
      amount: task.value,
      currency: "EUR",
    });
  }
}

/* ------------------------------------------------------------------ */
/* Analyses différées du panel d'IA                                    */
/* ------------------------------------------------------------------ */

/**
 * Exécute une analyse empilée par `/api/ai/jobs`.
 *
 * Le message ne porte qu'un identifiant : la skill et ses paramètres sont
 * relus en base ici, au moment où le travail commence réellement.
 *
 * Un job déjà terminé est ignoré sans bruit. Les files garantissent « au moins
 * une fois », jamais « exactement une fois » : sans ce garde, un message
 * livré deux fois consommerait deux fois l'allocation gratuite pour produire
 * exactement le même résultat.
 */
async function runAi(
  env: Env,
  task: Extract<QueueTask, { kind: "ai" }>,
  counter: { used: number },
): Promise<void> {
  const db = drizzle(env.DB);
  const [job] = await db.select().from(aiJob).where(eq(aiJob.id, task.jobId)).limit(1);

  // Un travail déjà classé n'est jamais rejoué, qu'il ait réussi ou échoué.
  // Les files garantissent « au moins une fois », jamais « exactement une
  // fois » : sans ce garde, un message livré deux fois consommerait deux fois
  // l'allocation gratuite pour produire exactement le même résultat.
  if (!job || job.status === "success" || job.status === "failed") return;

  // Réservation prudente : l'appel au modèle et un éventuel ancrage web
  // comptent dans le budget de 50 sous-requêtes de cette invocation.
  counter.used += 3;

  const now = Math.floor(Date.now() / 1000);
  await db
    .update(aiJob)
    .set({ status: "running", startedAt: now })
    .where(eq(aiJob.id, task.jobId));

  try {
    const outcome = await buildAi(env).run({
      skill: job.skill,
      input: JSON.parse(job.input) as unknown,
      automatic: job.automatic === 1,
    });

    await db
      .update(aiJob)
      .set({
        status: "success",
        result: JSON.stringify(outcome),
        finishedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(aiJob.id, task.jobId));
  } catch (err) {
    /**
     * ON N'INSISTE JAMAIS, et c'est délibéré.
     *
     * Le réflexe habituel — laisser la file réessayer trois fois — coûterait
     * ici de l'argent sans rien apporter. Quand cette erreur remonte,
     * l'orchestrateur a déjà tenté tous les modèles autorisés, chacun ayant pu
     * consommer des neurones au passage. Un réessai rejouerait la même
     * cascade : jusqu'à quatre appels de plus, pour la même issue.
     *
     * Quota épuisé, en particulier, n'est pas une panne : il n'existe aucun
     * repli payant à déclencher, et rien ne changera avant minuit UTC.
     *
     * On classe donc le travail et on acquitte le message. L'interface montre
     * l'échec, et c'est à l'utilisateur de relancer s'il le souhaite.
     */
    await db
      .update(aiJob)
      .set({
        status: "failed",
        error: (err instanceof NoFreeModelError ? "quota_gratuit_epuise" : String(err)).slice(
          0,
          500,
        ),
        finishedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(aiJob.id, task.jobId));
  }
}

/* ------------------------------------------------------------------ */
/* Gestion d'erreur : la partie qui fait la différence à 3 h du matin  */
/* ------------------------------------------------------------------ */

async function onTaskError(
  env: Env,
  msg: Message<QueueTask>,
  err: unknown,
): Promise<void> {
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const shopId = "shopId" in msg.body ? msg.body.shopId : null;

  // Budget épuisé : ce n'est pas une erreur, juste une pause.
  if (err instanceof SubrequestBudgetExceeded) {
    msg.retry({ delaySeconds: 5 });
    return;
  }

  if (err instanceof ConnectorError) {
    switch (err.kind) {
      case "rate_limited":
        // Le Durable Object nous dit exactement combien attendre.
        msg.retry({ delaySeconds: Math.ceil((err.retryAfterMs ?? 60_000) / 1000) });
        return;

      case "auth_expired":
        // Inutile de réessayer : il faut une action humaine. On coupe la
        // boutique pour ne pas brûler le quota de queue, et on prévient.
        if (shopId) {
          await db
            .update(shop)
            .set({ status: "reauth_required" })
            .where(eq(shop.id, shopId));
        }
        await log(env, "error", "auth", shopId, err.message);
        msg.ack(); // consommé : le réessayer ne servirait à rien
        return;

      case "transient":
        msg.retry({ delaySeconds: Math.ceil((err.retryAfterMs ?? 30_000) / 1000) });
        return;

      case "permanent":
        await log(env, "error", "sync", shopId, err.message);
        await bumpFailure(env, msg.body);
        msg.ack(); // part en file de rebut après max_retries
        return;
    }
  }

  await log(env, "error", "sync", shopId, String(err));
  await bumpFailure(env, msg.body);
  msg.retry();
}

async function bumpFailure(env: Env, task: QueueTask): Promise<void> {
  if (task.kind !== "sync") return;
  const db = drizzle(env.DB);
  await db
    .update(syncJob)
    .set({ failureCount: sql`${syncJob.failureCount} + 1` })
    .where(and(eq(syncJob.shopId, task.shopId), eq(syncJob.resource, task.resource)));
}

async function log(
  env: Env,
  level: string,
  scope: string,
  shopId: string | null,
  message: string,
): Promise<void> {
  await drizzle(env.DB)
    .insert(eventLog)
    .values({
      id: randomId(),
      at: Math.floor(Date.now() / 1000),
      level,
      scope,
      shopId,
      message: message.slice(0, 1000),
      data: null,
    });
}
