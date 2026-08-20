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
  product,
  shop,
  syncJob,
} from "./db/schema.js";
import { buildAi } from "./ai/module.js";
import type { Env } from "./env.js";
import { contentHash, randomId } from "./lib/crypto.js";
import { createHttp, SubrequestBudgetExceeded } from "./lib/http.js";
import { getValidAccessToken } from "./lib/tokens.js";
import { evaluateAlerts } from "./lib/alerts.js";
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

async function runSync(
  env: Env,
  task: SyncTask,
  counter: { used: number },
): Promise<void> {
  const db = drizzle(env.DB);
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

  let nextCursor: string | null = null;

  if (task.resource === "orders") {
    const page = await connector.fetchOrders(ctx, task.cursor);
    const changed = await upsertOrders(env, task.shopId, page.items);
    if (changed.length) await evaluateAlerts(env, task.shopId, { orders: changed });
    nextCursor = page.nextCursor;
  } else {
    // "listings" et "inventory" partagent la même lecture ; seule la fréquence
    // et la profondeur de pagination changent.
    const page = await connector.fetchListings(ctx, task.cursor);
    const changed = await upsertListings(env, task.shopId, page.items);
    if (changed.length) await evaluateAlerts(env, task.shopId, { listings: changed });
    nextCursor = task.resource === "inventory" ? null : page.nextCursor;
  }

  const now = Math.floor(Date.now() / 1000);

  // Page suivante : nouveau message, budget neuf.
  if (nextCursor && task.depth < MAX_PAGE_DEPTH) {
    await env.SYNC_QUEUE.send({ ...task, cursor: nextCursor, depth: task.depth + 1 });
    await db
      .update(syncJob)
      .set({ cursor: nextCursor, lastRunAt: now })
      .where(and(eq(syncJob.shopId, task.shopId), eq(syncJob.resource, task.resource)));
    return;
  }

  // Fin du parcours : on repart du début au prochain cycle et on efface l'échec.
  await db
    .update(syncJob)
    .set({ cursor: null, lastOkAt: now, failureCount: 0, lastError: null })
    .where(and(eq(syncJob.shopId, task.shopId), eq(syncJob.resource, task.resource)));
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

  /**
   * Rattachement au produit central, par SKU.
   *
   * Sans lui, une annonce synchronisée reste orpheline : le produit ne connaît
   * pas ses annonces, et tout ce qui raisonne sur « le même article vendu à
   * deux prix » — l'analyse comme la recommandation de prix — ne voit rien.
   *
   * Une seule requête pour toute la page, et le SKU est déjà l'identifiant
   * commun retenu par le reste du système. Une annonce sans SKU, ou dont le
   * SKU ne correspond à aucun produit, reste simplement non rattachée.
   */
  const products = await db.select({ id: product.id, sku: product.sku }).from(product);
  const productBySku = new Map(products.map((p) => [p.sku, p.id]));

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
          productId: it.sku ? (productBySku.get(it.sku) ?? null) : null,
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
            // Rattaché aussi à la mise à jour : un produit créé APRÈS la
            // première synchronisation doit récupérer ses annonces existantes.
            productId: it.sku ? (productBySku.get(it.sku) ?? null) : null,
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

async function runWebhook(
  env: Env,
  task: Extract<QueueTask, { kind: "webhook" }>,
  counter: { used: number },
): Promise<void> {
  const limiter = limiterFor(env, task.shopId);
  const resolved = await getValidAccessToken(env, task.shopId, limiter);
  const connector = getConnector(resolved.platform);

  const result = await connector.applyWebhook(
    {
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
    },
    task.topic,
    task.payload,
  );

  if (result.orders?.length) {
    const changed = await upsertOrders(env, task.shopId, result.orders);
    if (changed.length) await evaluateAlerts(env, task.shopId, { orders: changed });
  }
  if (result.listings?.length) {
    const changed = await upsertListings(env, task.shopId, result.listings);
    if (changed.length) await evaluateAlerts(env, task.shopId, { listings: changed });
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
