import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gte, sql, lte } from "drizzle-orm";
import type { QueueTask } from "@hub/core";
import {
  eventLog,
  listing,
  order,
  pushSubscription,
  shop,
  syncJob,
} from "../db/schema.js";
import type { Env } from "../env.js";
import { randomId } from "../lib/crypto.js";
import { authenticate, type AuthedUser } from "../lib/session.js";
import { sendPushToUser } from "../lib/push.js";

/**
 * API du tableau de bord. Tout est derrière la session — c'est un outil privé.
 *
 * L'interface web ne calcule rien : elle affiche ce que ces routes renvoient.
 * Les agrégations tournent en SQL dans D1, où elles coûtent quelques
 * millisecondes, plutôt que dans le navigateur du téléphone.
 */

type Vars = { user: AuthedUser };
export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// Garde d'authentification appliquée à TOUTES les routes de ce routeur.
api.use("*", async (c, next) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  c.set("user", me);
  await next();
});

/** Vue d'ensemble : la page d'accueil de la PWA. */
api.get("/overview", async (c) => {
  const db = drizzle(c.env.DB);
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAgo = now - 7 * 86400;

  const [shops, today, week, lowStock, health] = await Promise.all([
    db
      .select({
        id: shop.id,
        platform: shop.platform,
        name: shop.displayName,
        status: shop.status,
      })
      .from(shop),

    db
      .select({
        count: sql<number>`count(*)`,
        total: sql<number>`coalesce(sum(${order.totalAmount}), 0)`,
      })
      .from(order)
      .where(gte(order.placedAt, dayAgo)),

    db
      .select({
        count: sql<number>`count(*)`,
        total: sql<number>`coalesce(sum(${order.totalAmount}), 0)`,
      })
      .from(order)
      .where(gte(order.placedAt, weekAgo)),

    db
      .select({ count: sql<number>`count(*)` })
      .from(listing)
      .where(and(eq(listing.status, "active"), lte(listing.quantity, 3))),

    db
      .select({
        resource: syncJob.resource,
        shopId: syncJob.shopId,
        lastOkAt: syncJob.lastOkAt,
        failureCount: syncJob.failureCount,
        lastError: syncJob.lastError,
      })
      .from(syncJob)
      .where(eq(syncJob.enabled, 1)),
  ]);

  return c.json({
    shops,
    today: today[0] ?? { count: 0, total: 0 },
    week: week[0] ?? { count: 0, total: 0 },
    lowStockCount: lowStock[0]?.count ?? 0,
    health,
    // Un badge rouge dans l'interface vaut mieux qu'une panne découverte 3 jours plus tard.
    needsAttention: shops.filter((s) => s.status !== "active"),
  });
});

api.get("/orders", async (c) => {
  const db = drizzle(c.env.DB);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const rows = await db
    .select({
      id: order.id,
      externalId: order.externalId,
      status: order.status,
      amount: order.totalAmount,
      currency: order.totalCurrency,
      buyer: order.buyerName,
      placedAt: order.placedAt,
      shopName: shop.displayName,
      platform: shop.platform,
    })
    .from(order)
    .innerJoin(shop, eq(shop.id, order.shopId))
    .orderBy(desc(order.placedAt))
    .limit(limit);
  return c.json({ orders: rows });
});

api.get("/inventory", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      id: listing.id,
      externalId: listing.externalId,
      sku: listing.sku,
      title: listing.title,
      price: listing.priceAmount,
      currency: listing.priceCurrency,
      quantity: listing.quantity,
      status: listing.status,
      imageUrl: listing.imageUrl,
      shopId: listing.shopId,
      shopName: shop.displayName,
      platform: shop.platform,
    })
    .from(listing)
    .innerJoin(shop, eq(shop.id, listing.shopId))
    .orderBy(listing.quantity)
    .limit(500);

  // Regroupement par SKU : c'est LA valeur du multi-boutiques — voir d'un coup
  // d'œil que le même article est à 24 € sur Etsy et 29 € sur eBay.
  const bySku = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.sku) continue;
    const arr = bySku.get(r.sku) ?? [];
    arr.push(r);
    bySku.set(r.sku, arr);
  }
  const multiChannel = [...bySku.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([sku, v]) => ({ sku, listings: v }));

  return c.json({ listings: rows, multiChannel });
});

/** Écriture vers une plateforme : passe par la Queue, jamais en direct. */
api.post("/listings/:shopId/:externalId/stock", async (c) => {
  const quantity = Number((await c.req.json<{ quantity: number }>()).quantity);
  if (!Number.isInteger(quantity) || quantity < 0) {
    return c.json({ error: "quantité invalide" }, 400);
  }
  await c.env.SYNC_QUEUE.send({
    kind: "write",
    shopId: c.req.param("shopId"),
    op: "update_stock",
    listingExternalId: c.req.param("externalId"),
    value: quantity,
  } satisfies QueueTask);
  return c.json({ ok: true, queued: true });
});

/** Forcer une synchronisation immédiate depuis l'interface. */
api.post("/sync/:shopId", async (c) => {
  const shopId = c.req.param("shopId");
  await c.env.SYNC_QUEUE.sendBatch(
    (["orders", "inventory"] as const).map((resource) => ({
      body: { kind: "sync", shopId, resource, cursor: null, depth: 0 } satisfies QueueTask,
    })),
  );
  return c.json({ ok: true });
});

api.get("/logs", async (c) => {
  const rows = await drizzle(c.env.DB)
    .select()
    .from(eventLog)
    .orderBy(desc(eventLog.at))
    .limit(200);
  return c.json({ logs: rows });
});

/* ---------------------------- Push ---------------------------- */

/** Clé publique VAPID — la seule valeur cryptographique exposée au navigateur. */
api.get("/push/key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY }));

api.post("/push/subscribe", async (c) => {
  const sub = await c.req.json<{
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }>();
  const me = c.get("user");

  await drizzle(c.env.DB)
    .insert(pushSubscription)
    .values({
      id: randomId(),
      userId: me.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: c.req.header("User-Agent") ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoUpdate({
      target: pushSubscription.endpoint,
      set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, failedAt: null },
    });

  return c.json({ ok: true });
});

/** Bouton « tester » dans les réglages : indispensable pour diagnostiquer iOS. */
api.post("/push/test", async (c) => {
  const r = await sendPushToUser(c.env, {
    title: "MarketHub",
    body: "Les notifications fonctionnent.",
    url: "/",
    tag: "test",
  });
  return c.json(r);
});
