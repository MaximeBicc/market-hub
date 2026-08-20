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
      shopId: order.shopId,
      shopName: shop.displayName,
      platform: shop.platform,
    })
    .from(order)
    .innerJoin(shop, eq(shop.id, order.shopId))
    .orderBy(desc(order.placedAt))
    .limit(limit);
  return c.json({ orders: rows });
});

/**
 * Séries pour la page Croissance.
 *
 * L'agrégation par jour se fait en SQL, dans D1 : y regrouper quelques
 * milliers de lignes coûte des millisecondes, alors que renvoyer toutes les
 * commandes au téléphone pour qu'il les additionne coûterait de la bande
 * passante et du budget CPU sur un appareil bien plus lent.
 */
api.get("/growth", async (c) => {
  const db = drizzle(c.env.DB);
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 7), 90);
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;
  const prevFrom = from - days * 86400;

  // Les statuts annulés et remboursés sont exclus : ils ne sont pas du
  // chiffre d'affaires, et les inclure gonflerait artificiellement la courbe.
  const realised = sql`${order.status} NOT IN ('cancelled', 'refunded')`;

  const [daily, previous, byShop] = await Promise.all([
    db
      .select({
        date: sql<string>`date(${order.placedAt}, 'unixepoch')`,
        total: sql<number>`coalesce(sum(${order.totalAmount}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(order)
      .where(and(gte(order.placedAt, from), realised))
      .groupBy(sql`date(${order.placedAt}, 'unixepoch')`),

    db
      .select({ total: sql<number>`coalesce(sum(${order.totalAmount}), 0)` })
      .from(order)
      .where(
        and(gte(order.placedAt, prevFrom), lte(order.placedAt, from), realised),
      ),

    db
      .select({
        shopId: order.shopId,
        name: shop.displayName,
        platform: shop.platform,
        total: sql<number>`coalesce(sum(${order.totalAmount}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(order)
      .innerJoin(shop, eq(shop.id, order.shopId))
      .where(and(gte(order.placedAt, from), realised))
      .groupBy(order.shopId)
      .orderBy(desc(sql`sum(${order.totalAmount})`)),
  ]);

  // La série est complétée jour par jour : SQL ne renvoie que les journées
  // ayant au moins une commande, or un graphique avec des jours manquants
  // ment sur la régularité des ventes.
  const map = new Map(daily.map((d) => [d.date, d]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date((now - i * 86400) * 1000);
    const key = d.toISOString().slice(0, 10);
    const hit = map.get(key);
    series.push({
      date: key,
      label: new Intl.DateTimeFormat("fr-FR", {
        day: "numeric",
        month: "short",
      }).format(d),
      total: hit?.total ?? 0,
      count: hit?.count ?? 0,
    });
  }

  return c.json({
    days: series,
    total: series.reduce((s, d) => s + d.total, 0),
    count: series.reduce((s, d) => s + d.count, 0),
    previousTotal: previous[0]?.total ?? 0,
    byShop,
  });
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
