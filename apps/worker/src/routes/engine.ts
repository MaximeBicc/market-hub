import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import type { CanonicalOrderEvent } from "@hub/engine";
import { commandLog, inventory, product, shop } from "../db/schema.js";
import type { Env } from "../env.js";
import { authenticate } from "../lib/session.js";
import { buildEngine } from "../engine/module.js";

/**
 * API de l'orchestrateur.
 *
 * Une commande générale, plusieurs cibles, un résultat par cible. L'appelant
 * ne sait pas si la cible est eBay ou Vinted : il reçoit un statut qui dit ce
 * qui s'est réellement passé, y compris « une action manuelle est nécessaire ».
 */

export const engine = new Hono<{ Bindings: Env }>();

engine.use("*", async (c, next) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  await next();
});


/** Ce que chaque compte sait faire — sert à griser les actions dans l'interface. */
engine.get("/capabilities", async (c) => {
  const db = drizzle(c.env.DB);
  const accounts = await db.select({ id: shop.id }).from(shop);
  const mod = buildEngine(c.env);
  const caps = await mod.orchestrator.capabilitiesFor(accounts.map((a) => a.id));
  return c.json({ accounts: caps });
});

/** Adaptateurs enregistrés, indépendamment des comptes connectés. */
engine.get("/adapters", async (c) => {
  const mod = buildEngine(c.env);
  const out = [];
  for (const a of mod.registry.list()) {
    out.push({
      id: a.id,
      capabilities: await a.capabilities({
        account: {
          id: "probe",
          marketplace: a.id,
          slug: "probe",
          displayName: "probe",
          enabled: true,
        },
      }),
    });
  }
  return c.json({ adapters: out });
});

/* ------------------------------------------------------------------ */
/* Commandes générales                                                 */
/* ------------------------------------------------------------------ */

engine.post("/listing", async (c) => {
  const body = await c.req.json<{
    productId: string;
    accountIds: string[];
    idempotencyKey?: string;
  }>();
  const key = body.idempotencyKey ?? crypto.randomUUID();

  const mod = buildEngine(c.env);
  const outcome = await mod.orchestrator.createListing({
    productId: body.productId,
    accountIds: body.accountIds,
    idempotencyKey: key,
  });

  return c.json({ ...outcome, idempotencyKey: key });
});

engine.post("/price", async (c) => {
  const body = await c.req.json<{
    productId: string;
    accountIds: string[];
    amount: number;
    currency?: string;
    idempotencyKey?: string;
  }>();
  const key = body.idempotencyKey ?? crypto.randomUUID();

  const mod = buildEngine(c.env);
  const outcome = await mod.orchestrator.setPrice({
    productId: body.productId,
    accountIds: body.accountIds,
    price: { amount: body.amount, currency: body.currency ?? "EUR" },
    idempotencyKey: key,
  });

  return c.json({ ...outcome, idempotencyKey: key });
});

engine.post("/stock", async (c) => {
  const body = await c.req.json<{
    productId: string;
    accountIds: string[];
    stock: number;
    idempotencyKey?: string;
  }>();
  const key = body.idempotencyKey ?? crypto.randomUUID();

  const mod = buildEngine(c.env);
  const outcome = await mod.orchestrator.setStock({
    productId: body.productId,
    accountIds: body.accountIds,
    stock: body.stock,
    idempotencyKey: key,
  });

  return c.json({ ...outcome, idempotencyKey: key });
});

engine.post("/active", async (c) => {
  const body = await c.req.json<{
    productId: string;
    accountIds: string[];
    active: boolean;
    idempotencyKey?: string;
  }>();
  const key = body.idempotencyKey ?? crypto.randomUUID();

  const mod = buildEngine(c.env);
  const outcome = await mod.orchestrator.setActive({
    productId: body.productId,
    accountIds: body.accountIds,
    active: body.active,
    idempotencyKey: key,
  });

  return c.json({ ...outcome, idempotencyKey: key });
});

/* ------------------------------------------------------------------ */
/* Ventes entrantes                                                    */
/* ------------------------------------------------------------------ */

/**
 * Point d'entrée unique des ventes.
 *
 * Webhook Shopify, relevé Etsy, notification eBay : toutes les sources
 * convergent ici sous forme d'événement canonique. La déduplication et la
 * propagation de stock vers les autres canaux sont donc écrites une seule
 * fois, pas une fois par plateforme.
 *
 * Exposé en route authentifiée : c'est aussi ce qui permet de rejouer une
 * vente à la main, ou de valider le flux complet avant de brancher une
 * plateforme réelle.
 */
engine.post("/sale", async (c) => {
  const event = await c.req.json<CanonicalOrderEvent>();

  if (!event?.accountId || !event?.eventId || !Array.isArray(event.lines)) {
    return c.json({ error: "Événement incomplet" }, 400);
  }

  const mod = buildEngine(c.env);
  const result = await mod.salesSync.ingest(event);
  return c.json(result);
});

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/** Stock central : le physique, le réservé, et ce qui est réellement vendable. */
engine.get("/inventory", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      productId: inventory.productId,
      sku: product.sku,
      title: product.title,
      onHand: inventory.onHand,
      reserved: inventory.reserved,
      version: inventory.version,
      updatedAt: inventory.updatedAt,
    })
    .from(inventory)
    .innerJoin(product, eq(product.id, inventory.productId));

  return c.json({
    items: rows.map((r) => ({
      ...r,
      available: Math.max(0, r.onHand - r.reserved),
    })),
  });
});

/** Journal des commandes, du plus récent au plus ancien. */
engine.get("/log", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(commandLog)
    .orderBy(desc(commandLog.at))
    .limit(Math.min(Number(c.req.query("limit") ?? 100), 300));
  return c.json({ entries: rows });
});
