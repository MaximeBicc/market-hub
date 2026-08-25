import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gte, gt, sql, lte, inArray } from "drizzle-orm";
import type { QueueTask } from "@hub/core";
import {
  consumable,
  eventLog,
  inventory,
  listing,
  order,
  orderConsumable,
  orderLine,
  product,
  pushSubscription,
  shop,
  syncJob,
  variant,
  listingGroup,
} from "../db/schema.js";
import type { Env } from "../env.js";
import { randomId } from "../lib/crypto.js";
import { normaliserValeur, varianteUnique } from "../lib/variantes.js";
import { ficheProduit, idDepuisLien } from "../lib/alibaba.js";
import { recalculerStockProduit } from "../lib/stock-produit.js";
import { authenticate, type AuthedUser } from "../lib/session.js";
import { sendPushToUser } from "../lib/push.js";
import { buildEngine } from "../engine/module.js";

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
        /*
         * L'INTERVALLE FAIT PARTIE DE LA SANTÉ.
         *
         * Sans lui, l'interface ne peut juger un retard que sur un seuil fixe,
         * le même pour toutes les ressources. Or « listings » ne tourne qu'une
         * fois par jour : mesuré à deux heures, il se déclarait en retard
         * vingt-deux heures sur vingt-quatre. Une alerte permanente n'alerte
         * plus de rien — elle apprend à ignorer le bandeau.
         */
        intervalSec: syncJob.intervalSec,
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
      shippingCarrier: order.shippingCarrier,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      placedAt: order.placedAt,
      shippedAt: order.shippedAt,
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

/** Détail complet d'une commande avec ses articles et consommables associés. */
api.get("/orders/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const orderId = c.req.param("id");

  const [orderRow] = await db
    .select({
      id: order.id,
      externalId: order.externalId,
      status: order.status,
      amount: order.totalAmount,
      currency: order.totalCurrency,
      buyer: order.buyerName,
      shippingCarrier: order.shippingCarrier,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      shippingLabelUrl: order.shippingLabelUrl,
      shippingLabelType: order.shippingLabelType,
      placedAt: order.placedAt,
      shippedAt: order.shippedAt,
      shopId: order.shopId,
      shopName: shop.displayName,
      platform: shop.platform,
    })
    .from(order)
    .innerJoin(shop, eq(shop.id, order.shopId))
    .where(eq(order.id, orderId))
    .limit(1);

  if (!orderRow) {
    return c.json({ error: "order_not_found" }, 404);
  }

  const lines = await db
    .select()
    .from(orderLine)
    .where(eq(orderLine.orderId, orderId));

  // Récupérer les images et stocks actuels pour chaque article de commande
  const linesWithMeta = await Promise.all(
    lines.map(async (l) => {
      let imageUrl: string | null = null;
      let currentStock: number | null = null;
      let location: string | null = null;
      let weightGrams: number | null = null;
      let defaultConsumableId: string | null = null;
      let color: string | null = null;
      let material: string | null = null;

      if (l.sku) {
        const [prod] = await db
          .select()
          .from(product)
          .where(eq(product.sku, l.sku))
          .limit(1);
        if (prod) {
          currentStock = prod.stock;
          location = prod.location;
          weightGrams = prod.weightGrams;
          defaultConsumableId = prod.defaultConsumableId;
          color = prod.color;
          material = prod.material;
          if (prod.images) {
            try {
              const parsed = JSON.parse(prod.images);
              if (Array.isArray(parsed) && parsed.length > 0) imageUrl = parsed[0];
            } catch {}
          }
        }
      }
      if (!imageUrl && l.listingExternalId) {
        const [list] = await db
          .select({ imageUrl: listing.imageUrl, quantity: listing.quantity })
          .from(listing)
          .where(eq(listing.externalId, l.listingExternalId))
          .limit(1);
        if (list) {
          imageUrl = list.imageUrl;
          if (currentStock === null) currentStock = list.quantity;
        }
      }
      return {
        ...l,
        imageUrl,
        currentStock,
        location,
        weightGrams,
        defaultConsumableId,
        color,
        material,
      };
    }),
  );

  const usedConsumables = await db
    .select({
      id: orderConsumable.id,
      consumableId: orderConsumable.consumableId,
      name: consumable.name,
      category: consumable.category,
      quantity: orderConsumable.quantity,
      usedAt: orderConsumable.usedAt,
    })
    .from(orderConsumable)
    .innerJoin(consumable, eq(consumable.id, orderConsumable.consumableId))
    .where(eq(orderConsumable.orderId, orderId));

  return c.json({
    order: orderRow,
    lines: linesWithMeta,
    consumablesUsed: usedConsumables,
  });
});

/** Consommables d'emballage disponibles et gestion de leur stock. */
api.get("/consumables", async (c) => {
  const db = drizzle(c.env.DB);
  let rows = await db.select().from(consumable).orderBy(consumable.category, consumable.name);

  // Initialisation automatique par défaut si la table est vide
  if (rows.length === 0) {
    const now = Math.floor(Date.now() / 1000);
    const defaults = [
      { id: "c_env_bubble_s", name: "Enveloppe Bulle S (15x21 cm)", category: "envelope", stock: 50, minAlert: 10, unitCost: 18 },
      { id: "c_env_bubble_m", name: "Enveloppe Bulle M (18x26 cm)", category: "envelope", stock: 45, minAlert: 10, unitCost: 24 },
      { id: "c_env_bubble_l", name: "Enveloppe Bulle L (24x33 cm)", category: "envelope", stock: 30, minAlert: 8, unitCost: 38 },
      { id: "c_box_colissimo_s", name: "Carton Colissimo S (25x18x10 cm)", category: "box", stock: 25, minAlert: 5, unitCost: 65 },
      { id: "c_box_colissimo_m", name: "Carton Colissimo M (32x23x15 cm)", category: "box", stock: 20, minAlert: 5, unitCost: 95 },
      { id: "c_label_thermal", name: "Étiquette thermique d'expédition (10x15 cm)", category: "label", stock: 200, minAlert: 30, unitCost: 4 },
      { id: "c_card_thanks", name: "Carte de remerciement & fidélité", category: "card", stock: 150, minAlert: 25, unitCost: 8 },
      { id: "c_paper_kraft", name: "Papier de calage & protection kraft", category: "protection", stock: 80, minAlert: 15, unitCost: 12 },
      { id: "c_tape_fragile", name: "Ruban adhésif renforcé", category: "protection", stock: 15, minAlert: 3, unitCost: 120 },
    ];

    for (const item of defaults) {
      await db.insert(consumable).values({
        ...item,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
    }
    rows = await db.select().from(consumable).orderBy(consumable.category, consumable.name);
  }

  return c.json({ consumables: rows });
});

/** Ajouter ou mettre à jour un consommable. */
api.post("/consumables", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    id?: string;
    name: string;
    category: string;
    stock: number;
    minAlert?: number;
    unitCost?: number;
  }>();

  if (!body.name || !body.category) {
    return c.json({ error: "Nom et catégorie requis" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const id = body.id || `c_${randomId()}`;

  await db
    .insert(consumable)
    .values({
      id,
      name: body.name,
      category: body.category,
      stock: Math.max(0, body.stock ?? 0),
      minAlert: body.minAlert ?? 5,
      unitCost: body.unitCost ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: consumable.id,
      set: {
        name: body.name,
        category: body.category,
        stock: Math.max(0, body.stock ?? 0),
        minAlert: body.minAlert ?? 5,
        unitCost: body.unitCost ?? 0,
        updatedAt: now,
      },
    });

  return c.json({ ok: true, id });
});

/** Ajustement rapide du stock d'un consommable. */
api.post("/consumables/:id/stock", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{ stock?: number; delta?: number }>();
  const now = Math.floor(Date.now() / 1000);

  const [existing] = await db.select().from(consumable).where(eq(consumable.id, id)).limit(1);
  if (!existing) return c.json({ error: "consumable_not_found" }, 404);

  let newStock = existing.stock;
  if (typeof body.stock === "number") {
    newStock = Math.max(0, body.stock);
  } else if (typeof body.delta === "number") {
    newStock = Math.max(0, existing.stock + body.delta);
  }

  await db
    .update(consumable)
    .set({ stock: newStock, updatedAt: now })
    .where(eq(consumable.id, id));

  return c.json({ ok: true, id, stock: newStock });
});

/**
 * EXÉCUTION / EXPÉDITION DE COMMANDE EN 5 ÉTAPES.
 *
 * Décrémente les stocks produits & consommables, met à jour le statut,
 * renseigne le suivi et propage l'exécution.
 */
api.post("/orders/:id/fulfill", async (c) => {
  const db = drizzle(c.env.DB);
  const orderId = c.req.param("id");
  const body = await c.req.json<{
    carrier?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    notifyBuyer?: boolean;
    decrementProductStock?: boolean;
    consumables?: Array<{ id: string; quantity: number }>;
    giftProductId?: string;
  }>();

  const [ord] = await db.select().from(order).where(eq(order.id, orderId)).limit(1);
  if (!ord) return c.json({ error: "order_not_found" }, 404);

  const now = Math.floor(Date.now() / 1000);

  // 1. Mise à jour de la commande en statut "shipped"
  await db
    .update(order)
    .set({
      status: "shipped",
      shippingCarrier: body.carrier || ord.shippingCarrier || "La Poste",
      trackingNumber: body.trackingNumber || ord.trackingNumber,
      trackingUrl: body.trackingUrl || ord.trackingUrl,
      shippedAt: now,
      syncedAt: now,
    })
    .where(eq(order.id, orderId));

  // 2. Décrémentation et enregistrement des consommables utilisés
  const usedConsumablesSummary: Array<{ id: string; name: string; quantity: number; remaining: number }> = [];
  if (Array.isArray(body.consumables)) {
    for (const item of body.consumables) {
      if (!item.id || item.quantity <= 0) continue;
      const [cons] = await db.select().from(consumable).where(eq(consumable.id, item.id)).limit(1);
      if (cons) {
        const nextStock = Math.max(0, cons.stock - item.quantity);
        await db
          .update(consumable)
          .set({ stock: nextStock, updatedAt: now })
          .where(eq(consumable.id, item.id));

        await db.insert(orderConsumable).values({
          id: randomId(),
          orderId,
          consumableId: item.id,
          quantity: item.quantity,
          usedAt: now,
        });

        usedConsumablesSummary.push({
          id: cons.id,
          name: cons.name,
          quantity: item.quantity,
          remaining: nextStock,
        });
      }
    }
  }

  // 3. Décrémentation du stock des produits de la commande
  const decrementedProductsSummary: Array<{
    sku?: string | undefined;
    title: string;
    quantity: number;
    remainingStock: number | null;
  }> = [];
  if (body.decrementProductStock !== false) {
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));

    for (const line of lines) {
      let remaining: number | null = null;
      if (line.sku) {
        // Décrémente le catalogue maître `product`
        const [prod] = await db.select().from(product).where(eq(product.sku, line.sku)).limit(1);
        if (prod) {
          remaining = Math.max(0, prod.stock - line.quantity);
          await db
            .update(product)
            .set({ stock: remaining, updatedAt: now })
            .where(eq(product.id, prod.id));

          // Décrémente le stock central `inventory`
          const varId = await varianteUnique(db, prod.id);
          const [inv] = varId
            ? await db.select().from(inventory).where(eq(inventory.variantId, varId)).limit(1)
            : [];
          if (inv) {
            await db
              .update(inventory)
              .set({
                onHand: Math.max(0, inv.onHand - line.quantity),
                reserved: Math.max(0, inv.reserved - line.quantity),
                version: inv.version + 1,
                updatedAt: now,
              })
              .where(eq(inventory.variantId, varId!));
          }
        }

        // Décrémente les annonces `listing` avec ce SKU
        await db
          .update(listing)
          .set({
            quantity: sql`max(0, ${listing.quantity} - ${line.quantity})`,
            syncedAt: now,
          })
          .where(eq(listing.sku, line.sku));
      } else if (line.listingExternalId) {
        await db
          .update(listing)
          .set({
            quantity: sql`max(0, ${listing.quantity} - ${line.quantity})`,
            syncedAt: now,
          })
          .where(eq(listing.externalId, line.listingExternalId));
      }

      decrementedProductsSummary.push({
        sku: line.sku ?? undefined,
        title: line.title,
        quantity: line.quantity,
        remainingStock: remaining,
      });
    }
  }

  // 3b. Décrémentation du cadeau offert si sélectionné
  let decrementedGift: { id: string; title: string; sku?: string; remainingStock: number } | null = null;
  if (body.giftProductId) {
    const [giftProd] = await db
      .select()
      .from(product)
      .where(eq(product.id, body.giftProductId))
      .limit(1);

    if (giftProd) {
      const remaining = Math.max(0, giftProd.stock - 1);
      await db
        .update(product)
        .set({ stock: remaining, updatedAt: now })
        .where(eq(product.id, giftProd.id));

      await db
        .update(inventory)
        .set({
          onHand: sql`max(0, ${inventory.onHand} - 1)`,
          updatedAt: now,
        })
        .where(eq(inventory.variantId, (await varianteUnique(db, giftProd.id))!));

      if (giftProd.sku) {
        await db
          .update(listing)
          .set({
            quantity: sql`max(0, ${listing.quantity} - 1)`,
            syncedAt: now,
          })
          .where(eq(listing.sku, giftProd.sku));
      }

      decrementedGift = {
        id: giftProd.id,
        title: giftProd.title,
        sku: giftProd.sku,
        remainingStock: remaining,
      };
    }
  }

  // 4. Transmission à la plateforme marketplace si possible via le moteur
  try {
    const mod = buildEngine(c.env);
    await mod.orchestrator.fulfillOrder({
      accountId: ord.shopId,
      fulfillment: {
        remoteOrderId: ord.externalId,
        trackingNumber: body.trackingNumber,
        carrier: body.carrier,
        trackingUrl: body.trackingUrl,
        notifyBuyer: body.notifyBuyer ?? true,
      },
      idempotencyKey: `fulfill:${orderId}:${now}`,
    });
  } catch (e) {
    // Si la boutique est locale ou déconnectée, on ne bloque pas la finalisation locale
  }

  // 5. Journalisation de l'événement
  await db.insert(eventLog).values({
    id: randomId(),
    at: now,
    level: "info",
    scope: "order:fulfill",
    shopId: ord.shopId,
    message: `Commande #${ord.externalId} exécutée (${body.carrier || "Standard"} - Suivi: ${body.trackingNumber || "Sans suivi"})`,
    data: JSON.stringify({
      orderId,
      carrier: body.carrier,
      trackingNumber: body.trackingNumber,
      consumables: usedConsumablesSummary,
      products: decrementedProductsSummary,
      gift: decrementedGift,
    }),
  });

  return c.json({
    ok: true,
    orderId,
    status: "shipped",
    shippedAt: now,
    consumables: usedConsumablesSummary,
    products: decrementedProductsSummary,
    gift: decrementedGift,
  });
});

/** Téléverser ou associer une étiquette d'expédition à une commande (PDF ou image). */
api.post("/orders/:id/shipping-label", async (c) => {
  const db = drizzle(c.env.DB);
  const orderId = c.req.param("id");
  const body = await c.req.json<{
    shippingLabelUrl: string;
    shippingLabelType?: "scraped" | "uploaded" | "generated";
    trackingNumber?: string;
    carrier?: string;
  }>();

  const [ord] = await db.select().from(order).where(eq(order.id, orderId)).limit(1);
  if (!ord) return c.json({ error: "order_not_found" }, 404);

  const updates: Record<string, any> = {
    shippingLabelUrl: body.shippingLabelUrl,
    shippingLabelType: body.shippingLabelType || "uploaded",
  };

  if (body.trackingNumber) {
    updates.trackingNumber = body.trackingNumber.trim();
  }
  if (body.carrier) {
    updates.shippingCarrier = body.carrier.trim();
  }

  await db.update(order).set(updates).where(eq(order.id, orderId));

  return c.json({ ok: true, orderId, ...updates });
});

/** Calcul des suggestions de cadeaux offerts (coût unitaire <= 2.5% du CA de la commande) et affinité de tags */
api.get("/orders/:id/gift-suggestions", async (c) => {
  const db = drizzle(c.env.DB);
  const orderId = c.req.param("id");
  const [ord] = await db.select().from(order).where(eq(order.id, orderId)).limit(1);
  if (!ord) return c.json({ error: "order_not_found" }, 404);

  // Budget max cadeau = 2.5% du montant de la commande
  const maxGiftBudget = Math.max(0, Math.floor(ord.totalAmount * 0.025)); // en centimes

  // Récupérer les articles de la commande pour extraire tous leurs tags et matières
  const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
  const orderTags = new Set<string>();
  const orderMaterials = new Set<string>();

  for (const line of lines) {
    if (line.sku) {
      const [p] = await db
        .select({ tags: product.tags, material: product.material })
        .from(product)
        .where(eq(product.sku, line.sku))
        .limit(1);
      if (p?.tags) {
        try {
          const parsed = JSON.parse(p.tags);
          if (Array.isArray(parsed)) {
            parsed.forEach((t) => orderTags.add(String(t).toLowerCase().trim()));
          }
        } catch {}
      }
      if (p?.material) {
        const words = p.material.toLowerCase().split(/[\s,/-]+/).filter((w) => w.length > 2);
        words.forEach((w) => orderMaterials.add(w));
      }
    }
  }

  // Récupérer tous les produits en stock
  const allProducts = await db.select().from(product).where(gt(product.stock, 0));

  const candidates: Array<{
    product: {
      id: string;
      sku: string;
      title: string;
      costPrice: number | null;
      priceAmount: number;
      stock: number;
      color: string | null;
      material: string | null;
      images: string[];
      tags: string[];
    };
    costPrice: number;
    percentOfOrder: number;
    commonTags: string[];
    materialMatch: boolean;
    matchingMaterial: string | null;
    score: number;
  }> = [];

  for (const p of allProducts) {
    let images: string[] = [];
    let tags: string[] = [];
    if (p.images) {
      try {
        const parsed = JSON.parse(p.images);
        if (Array.isArray(parsed)) images = parsed;
      } catch {}
    }
    if (p.tags) {
      try {
        const parsed = JSON.parse(p.tags);
        if (Array.isArray(parsed)) tags = parsed;
      } catch {}
    }

    // Le produit doit avoir un coût défini et être inférieur ou égal à 2.5% du total commande
    const cost = p.costPrice !== null && p.costPrice !== undefined ? p.costPrice : Math.round(p.priceAmount * 0.3);
    if (cost > maxGiftBudget && maxGiftBudget > 0) continue;

    // Calcul de l'affinité des tags (critère principal)
    const commonTags = tags.filter((t) => orderTags.has(t.toLowerCase().trim()));
    const isExplicitGoodie = tags.some((t) =>
      ["cadeau", "goodie", "gift", "sticker", "badge", "carte", "freebie"].includes(t.toLowerCase().trim()),
    );

    // Calcul de l'affinité de matière (critère secondaire)
    let materialMatch = false;
    let matchingMaterial: string | null = null;
    if (p.material && orderMaterials.size > 0) {
      const candidateWords = p.material.toLowerCase().split(/[\s,/-]+/).filter((w) => w.length > 2);
      const matchedWord = candidateWords.find((w) => orderMaterials.has(w));
      if (matchedWord) {
        materialMatch = true;
        matchingMaterial = p.material;
      }
    }

    // Calcul du score global : Tags (+15/tag) + Goodie (+10) + Matière (+8) + Qualité/Budget (+5 max)
    let score = commonTags.length * 15 + (isExplicitGoodie ? 10 : 0) + (materialMatch ? 8 : 0);
    if (maxGiftBudget > 0) {
      score += (cost / maxGiftBudget) * 5;
    }

    const percentOfOrder = ord.totalAmount > 0 ? Number(((cost / ord.totalAmount) * 100).toFixed(2)) : 0;

    candidates.push({
      product: {
        id: p.id,
        sku: p.sku,
        title: p.title,
        costPrice: p.costPrice,
        priceAmount: p.priceAmount,
        stock: p.stock,
        color: p.color,
        material: p.material,
        images,
        tags,
      },
      costPrice: cost,
      percentOfOrder,
      commonTags,
      materialMatch,
      matchingMaterial,
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  return c.json({
    orderTotal: ord.totalAmount,
    maxBudget: maxGiftBudget,
    orderTags: Array.from(orderTags),
    orderMaterials: Array.from(orderMaterials),
    suggestions: candidates,
  });
});

/** Liste de tous les tags existants dans le catalogue avec fréquence */
api.get("/products/tags", async (c) => {
  const db = drizzle(c.env.DB);
  const products = await db.select({ tags: product.tags }).from(product);

  const counts = new Map<string, number>();
  for (const p of products) {
    if (!p.tags) continue;
    try {
      const parsed = JSON.parse(p.tags);
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          const clean = String(t).trim();
          if (clean) {
            counts.set(clean, (counts.get(clean) ?? 0) + 1);
          }
        }
      }
    } catch {}
  }

  const tagList = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return c.json({ tags: tagList });
});

/** Créer une commande de test liée aux vrais produits du stock */
api.post("/orders/sample", async (c) => {
  const db = drizzle(c.env.DB);
  const now = Math.floor(Date.now() / 1000);
  const body = (await c.req.json<{ productId?: string }>().catch(() => ({}))) as {
    productId?: string;
  };

  // 1. Trouver ou créer une boutique de test
  let [testShop] = await db.select().from(shop).limit(1);
  if (!testShop) {
    testShop = {
      id: "shop_demo",
      platform: "shopify",
      externalId: "demo-store.myshopify.com",
      displayName: "Boutique Démo (Shopify)",
      slug: "boutique_demo",
      status: "active",
      config: "{}",
      connectedAt: now,
    };
    await db.insert(shop).values(testShop).onConflictDoNothing();
  }

  // 2. Récupérer les produits existants dans le catalogue maître
  let existingProducts = await db.select().from(product).limit(10);

  // Si le catalogue est vide, créer automatiquement 2 produits réalistes
  if (existingProducts.length === 0) {
    const defaults = [
      {
        id: "prod_mug_demo",
        sku: "ACC-MUG-01",
        title: "Mug Céramique Artisanal 350ml",
        description: "Mug tourné à la main, émaillage mat résistant.",
        priceAmount: 2490, // 24.90 €
        priceCurrency: "EUR",
        costPrice: 850, // 8.50 €
        stock: 12,
        minAlert: 3,
        location: "Étagère A-03 (Bac 2)",
        weightGrams: 340,
        defaultConsumableId: "c_box_colissimo_s",
        images: JSON.stringify(["https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=400"]),
        tags: JSON.stringify(["Céramique", "Mug", "Artisanat"]),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "prod_carnet_demo",
        sku: "ACC-CARNET-02",
        title: "Carnet Cuir Végane A5 (Pages recyclées)",
        description: "Couverture souple recyclée, 160 pages lignées.",
        priceAmount: 2500, // 25.00 €
        priceCurrency: "EUR",
        costPrice: 900, // 9.00 €
        stock: 18,
        minAlert: 4,
        location: "Rayon B-01 (Casier 5)",
        weightGrams: 190,
        defaultConsumableId: "c_env_bubble_m",
        images: JSON.stringify(["https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=400"]),
        tags: JSON.stringify(["Papeterie", "Carnet", "Éco", "Artisanat"]),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "prod_sticker_demo",
        sku: "ACC-STICKER-01",
        title: "Sticker Holographique Chat & Étoiles",
        description: "Vinyle résistant à l'eau, reflets holographiques.",
        priceAmount: 200, // 2.00 €
        priceCurrency: "EUR",
        costPrice: 35, // 0.35 € (éligible cadeau dès 14 € de commande)
        stock: 50,
        minAlert: 10,
        location: "Tiroir Goodies G-01",
        weightGrams: 5,
        defaultConsumableId: "c_env_bubble_s",
        images: JSON.stringify(["https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=400"]),
        tags: JSON.stringify(["Chat", "Papeterie", "Artisanat", "Goodie", "Sticker", "Éco"]),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "prod_badge_demo",
        sku: "ACC-BADGE-02",
        title: "Badge Émaillé Feuille Botanique",
        description: "Finition dorée brillante et émail vert forêt.",
        priceAmount: 350, // 3.50 €
        priceCurrency: "EUR",
        costPrice: 60, // 0.60 € (éligible cadeau dès 24 € de commande)
        stock: 35,
        minAlert: 8,
        location: "Tiroir Goodies G-02",
        weightGrams: 15,
        defaultConsumableId: "c_env_bubble_s",
        images: JSON.stringify(["https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400"]),
        tags: JSON.stringify(["Artisanat", "Éco", "Goodie", "Badge", "Céramique"]),
        createdAt: now,
        updatedAt: now,
      },
    ];

    for (const p of defaults) {
      await db.insert(product).values(p).onConflictDoNothing();
      // Tout produit a AU MOINS une variante : c'est elle qui porte le stock.
      // Un produit sans déclinaison en a une seule, à `optionKey` vide.
      const varId = `var_${p.id}`;
      await db
        .insert(variant)
        .values({
          id: varId,
          productId: p.id,
          sku: p.sku,
          optionKey: "",
          optionValues: "[]",
          priceAmount: p.priceAmount,
          priceCurrency: p.priceCurrency ?? "EUR",
          position: 0,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      await db
        .insert(inventory)
        .values({
          variantId: varId,
          onHand: p.stock,
          reserved: 0,
          version: 1,
          updatedAt: now,
        })
        .onConflictDoNothing();

      await db
        .insert(listing)
        .values({
          id: `list_${p.sku.toLowerCase()}`,
          shopId: testShop.id,
          productId: p.id,
          externalId: `ext_${p.sku.toLowerCase()}`,
          sku: p.sku,
          title: p.title,
          priceAmount: p.priceAmount,
          priceCurrency: p.priceCurrency,
          quantity: p.stock,
          status: "active",
          imageUrl: p.images ? JSON.parse(p.images)[0] : null,
          contentHash: `hash_${p.sku.toLowerCase()}`,
          syncedAt: now,
        })
        .onConflictDoNothing();
    }

    existingProducts = await db.select().from(product).limit(10);
  }

  // 3. Sélectionner les produits pour la commande
  let chosenProducts: typeof existingProducts = [];
  if (body.productId) {
    const specific = existingProducts.find((p) => p.id === body.productId);
    if (specific) chosenProducts = [specific];
  }

  if (chosenProducts.length === 0) {
    // Prendre en priorité 1 ou 2 produits ayant du stock
    const inStock = existingProducts.filter((p) => p.stock > 0);
    chosenProducts = inStock.length > 0 ? inStock.slice(0, Math.min(2, inStock.length)) : existingProducts.slice(0, 1);
  }

  const orderNum = Math.floor(1000 + Math.random() * 9000);
  const orderId = `ord_${randomId()}`;
  const externalId = `#${orderNum}`;

  const buyers = [
    "Camille Dupont",
    "Alexandre Martin",
    "Élodie Bernard",
    "Thomas Petit",
    "Léa Robert",
    "Lucas Richard",
  ];
  const buyerName = buyers[Math.floor(Math.random() * buyers.length)];

  let totalAmount = 0;
  const orderLinesToInsert = chosenProducts.map((p) => {
    const qty = 1;
    totalAmount += p.priceAmount * qty;
    return {
      id: randomId(),
      orderId,
      sku: p.sku,
      listingExternalId: `ext_${p.sku.toLowerCase()}`,
      title: p.title,
      quantity: qty,
      unitPriceAmount: p.priceAmount,
      unitPriceCurrency: p.priceCurrency || "EUR",
    };
  });

  const sampleTracking = `6A${Math.floor(100000000000 + Math.random() * 900000000000)}`;

  await db.insert(order).values({
    id: orderId,
    shopId: testShop.id,
    externalId,
    status: "paid",
    totalAmount,
    totalCurrency: "EUR",
    buyerName,
    shippingCarrier: "La Poste - Colissimo",
    trackingNumber: sampleTracking,
    trackingUrl: `https://www.laposte.fr/outils/suivre-vos-envois?code=${sampleTracking}`,
    shippingLabelType: "scraped",
    placedAt: now - Math.floor(Math.random() * 7200 + 300),
    shippedAt: null,
    contentHash: `hash_${orderId}`,
    syncedAt: now,
  });

  await db.insert(orderLine).values(orderLinesToInsert);

  return c.json({
    ok: true,
    orderId,
    externalId,
    buyerName,
    productsCount: orderLinesToInsert.length,
    totalAmount,
  });
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

/* ------------------------------------------------------------------ */
/* Gestion des Produits du Catalogue Maître                            */
/* ------------------------------------------------------------------ */

/** Liste de tous les produits du catalogue maître avec leurs annonces associées. */

/**
 * LES VIGNETTES ALIBABA, SERVIES PAR NOUS.
 *
 * Les adresses du CDN d'Alibaba fonctionnent en direct — vérifié en ligne de
 * commande — mais pas dans le navigateur de l'application. Entre les deux il y
 * a la politique de sécurité de la page, le service worker qui intercepte les
 * requêtes, et le référent envoyé par le navigateur : trois causes possibles,
 * qu'on ne départage pas depuis un poste de développement.
 *
 * Passer par le Worker les supprime toutes à la fois. L'image devient une
 * ressource de MÊME ORIGINE, et plus rien ne peut s'interposer.
 *
 * LE GARDE-FOU QUI COMPTE : sans liste blanche, cette route serait un relais
 * ouvert. N'importe qui pourrait s'en servir pour faire émettre des requêtes
 * par notre Worker vers n'importe quelle adresse — y compris des services
 * internes joignables depuis lui et non depuis l'extérieur. Seuls les hôtes
 * d'Alibaba sont donc acceptés, et rien d'autre.
 */
api.get("/alibaba/image", async (c) => {
  const brut = c.req.query("u") ?? "";
  let cible: URL;
  try {
    cible = new URL(brut);
  } catch {
    return c.text("Adresse invalide", 400);
  }

  const hote = cible.hostname.toLowerCase();
  const autorise =
    cible.protocol === "https:" &&
    (hote === "alicdn.com" ||
      hote.endsWith(".alicdn.com") ||
      hote.endsWith(".alibaba.com"));
  if (!autorise) return c.text("Hôte non autorisé", 403);

  const amont = await fetch(cible.toString(), {
    // Le CDN sert la même image avec ou sans référent ; ne rien envoyer
    // évite de lui apprendre où nos écrans se trouvent.
    headers: { Accept: "image/*" },
  });
  if (!amont.ok) {
    return c.text(`Image indisponible (${amont.status})`, 502);
  }

  const type = amont.headers.get("content-type") ?? "";
  // Une réponse qui n'est pas une image n'a rien à faire ici, quel que soit
  // l'hôte : on ne relaie pas du HTML ni du JSON sous couvert de vignette.
  if (!type.startsWith("image/")) {
    return c.text("Ce n'est pas une image", 415);
  }

  return new Response(amont.body, {
    headers: {
      "Content-Type": type,
      // Ces fichiers ne changent jamais : leur nom porte une empreinte.
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
});

/**
 * LIRE UNE FICHE ALIBABA, SANS RIEN ENREGISTRER.
 *
 * Deux temps volontairement séparés : on regarde d'abord, on décide ensuite.
 * Écrire le produit dès la lecture remplirait le catalogue de fiches ouvertes
 * par curiosité, et il faudrait les supprimer une à une.
 */
api.get("/alibaba/fiche", async (c) => {
  const productId = idDepuisLien(c.req.query("url") ?? c.req.query("id") ?? "");
  if (!productId) {
    return c.json(
      {
        error:
          "Collez l'adresse de la page produit Alibaba, ou son identifiant.",
      },
      400,
    );
  }

  try {
    return c.json({ fiche: await ficheProduit(c.env, productId) });
  } catch (err) {
    /*
     * L'identifiant LU accompagne l'erreur.
     *
     * Sans lui, un lien mal découpé produit un refus incompréhensible :
     * Alibaba dit vrai — il ne connaît pas ce produit — mais on ne voit pas
     * que le tort vient de l'adresse, pas du catalogue. Le montrer rend la
     * cause évidente d'un coup d'œil.
     */
    return c.json(
      {
        error: `Produit ${productId} : ${err instanceof Error ? err.message : String(err)}`,
        productId,
      },
      502,
    );
  }
});

/**
 * IMPORTER LA FICHE DANS LE STOCK.
 *
 * Le client renvoie ce qu'il a décidé — photos retenues, prix de vente,
 * stock par déclinaison — et cette route l'écrit. Elle ne rappelle PAS
 * Alibaba : ce qui a été montré à l'écran est ce qui sera enregistré, sans
 * qu'un changement de prix survenu entre-temps ne se glisse en douce.
 */
api.post("/alibaba/importer", async (c) => {
  const db = drizzle(c.env.DB);
  type Corps = {
    productId?: string;
    titre?: string;
    description?: string;
    categorie?: string | null;
    lien?: string | null;
    images?: string[];
    /** Prix de vente commun, en centimes. */
    prixVente?: number;
    coutDebarque?: number | null;
    axes?: string[];
    declinaisons?: Array<{
      skuId?: string;
      nom?: string;
      optionKey?: string;
      optionValues?: string[];
      image?: string | null;
      prixVente?: number;
      stock?: number;
      coutDebarque?: number | null;
    }>;
  };
  const body = await c.req.json<Corps>().catch(() => ({}) as Corps);

  const productId = (body.productId ?? "").trim();
  const titre = (body.titre ?? "").trim();
  if (!productId || !titre) {
    return c.json({ error: "Identifiant Alibaba et titre requis" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const prixCommun = Math.max(0, Math.round(Number(body.prixVente ?? 0)));

  /*
   * LE SKU DÉRIVE DE L'IDENTIFIANT ALIBABA.
   *
   * Il doit être stable et unique : c'est lui qui fera reconnaître le produit
   * si on réimporte la même fiche, plutôt que d'en créer un jumeau. Le
   * préfixe rend l'origine lisible d'un coup d'œil dans la liste du stock.
   */
  const sku = `ALI-${productId}`;

  const [existant] = await db
    .select({ id: product.id })
    .from(product)
    .where(eq(product.sku, sku))
    .limit(1);
  const id = existant?.id ?? `prod_${randomId()}`;

  const champs = {
    sku,
    title: titre.slice(0, 200),
    description: (body.description ?? "").slice(0, 5000) || null,
    priceAmount: prixCommun,
    priceCurrency: "EUR",
    costPrice:
      typeof body.coutDebarque === "number" && body.coutDebarque >= 0
        ? Math.round(body.coutDebarque)
        : null,
    images: JSON.stringify((body.images ?? []).filter(Boolean).slice(0, 25)),
    options: JSON.stringify(
      (body.axes ?? []).map((nom, i) => ({
        name: nom,
        values: [
          ...new Set(
            (body.declinaisons ?? [])
              .map((d) => d.optionValues?.[i] ?? "")
              .filter(Boolean),
          ),
        ],
      })),
    ),
    minAlert: 3,
    updatedAt: now,
  };

  if (existant) {
    await db.update(product).set(champs).where(eq(product.id, id));
  } else {
    await db
      .insert(product)
      .values({ id, ...champs, stock: 0, createdAt: now });
  }

  const mod = buildEngine(c.env, { used: 0 });
  const gardees = new Set<string>();
  let ecrites = 0;

  const lignes = (body.declinaisons ?? []).filter((d) => d.optionKey != null);
  for (let i = 0; i < lignes.length; i++) {
    const d = lignes[i]!;
    const cle = String(d.optionKey);
    // Deux déclinaisons sur la même clé s'écraseraient l'une l'autre, stock
    // compris. On garde la première et on ignore le doublon.
    if (gardees.has(cle)) continue;
    gardees.add(cle);

    const [deja] = await db
      .select({ id: variant.id })
      .from(variant)
      .where(and(eq(variant.productId, id), eq(variant.optionKey, cle)))
      .limit(1);
    const variantId = deja?.id ?? `var_${randomId()}`;

    // Le SKU de la déclinaison porte celui d'Alibaba : c'est ce qui permettra
    // plus tard de rapprocher une ligne de commande d'achat de la bonne
    // variante, sans deviner par le nom du coloris.
    const skuVariante = d.skuId ? `${sku}-${d.skuId}` : null;
    const prix =
      typeof d.prixVente === "number" && d.prixVente >= 0
        ? Math.round(d.prixVente)
        : prixCommun;

    await db
      .insert(variant)
      .values({
        id: variantId,
        productId: id,
        sku: skuVariante,
        optionKey: cle,
        optionValues: JSON.stringify(d.optionValues ?? []),
        priceAmount: prix,
        priceCurrency: "EUR",
        imageUrl: d.image ?? null,
        position: i,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [variant.productId, variant.optionKey],
        set: {
          sku: skuVariante,
          optionValues: JSON.stringify(d.optionValues ?? []),
          priceAmount: prix,
          imageUrl: d.image ?? null,
          position: i,
          status: "active",
          updatedAt: now,
        },
      });

    await mod.inventoryService.ensure(variantId, 0);
    await mod.inventoryService.set(variantId, Math.max(0, Math.round(Number(d.stock ?? 0)) || 0));
    ecrites++;
  }

  /*
   * Ce qui n'est plus dans la fiche passe en archivé — jamais supprimé. Une
   * annonce en ligne pointe sur l'identifiant de variante ; l'effacer la
   * laisserait sans stock rattachable jusqu'à la prochaine vente.
   */
  const toutes = await db
    .select({ id: variant.id, optionKey: variant.optionKey, status: variant.status })
    .from(variant)
    .where(eq(variant.productId, id));
  let archivees = 0;
  for (const v of toutes) {
    if (gardees.has(v.optionKey) || v.status !== "active") continue;
    await db
      .update(variant)
      .set({ status: "archived", updatedAt: now })
      .where(eq(variant.id, v.id));
    archivees++;
  }

  await recalculerStockProduit(db, id);

  return c.json({
    ok: true,
    id,
    sku,
    declinaisons: ecrites,
    archivees,
    remplace: Boolean(existant),
  });
});

api.get("/products", async (c) => {
  const db = drizzle(c.env.DB);
  const products = await db.select().from(product).orderBy(desc(product.updatedAt));
  const listings = await db
    .select({
      id: listing.id,
      productId: listing.productId,
      sku: listing.sku,
      title: listing.title,
      price: listing.priceAmount,
      currency: listing.priceCurrency,
      quantity: listing.quantity,
      status: listing.status,
      shopId: listing.shopId,
      shopName: shop.displayName,
      platform: shop.platform,
    })
    .from(listing)
    .innerJoin(shop, eq(shop.id, listing.shopId));

  // Rattachement des annonces à chaque produit par SKU ou productId
  const listingsBySku = new Map<string, typeof listings>();
  const listingsByPid = new Map<string, typeof listings>();
  for (const l of listings) {
    if (l.sku) {
      const arr = listingsBySku.get(l.sku) ?? [];
      arr.push(l);
      listingsBySku.set(l.sku, arr);
    }
    if (l.productId) {
      const arr = listingsByPid.get(l.productId) ?? [];
      arr.push(l);
      listingsByPid.set(l.productId, arr);
    }
  }

  const items = products.map((p) => {
    const matched = listingsByPid.get(p.id) || (p.sku ? listingsBySku.get(p.sku) : []) || [];
    let images: string[] = [];
    let tags: string[] = [];
    if (p.images) {
      try {
        images = JSON.parse(p.images);
      } catch {}
    }
    if (p.tags) {
      try {
        tags = JSON.parse(p.tags);
      } catch {}
    }
    return {
      ...p,
      images,
      tags,
      listings: matched,
    };
  });

  return c.json({ products: items });
});

/** Ajouter ou modifier un produit maître. */
api.post("/products", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    id?: string;
    sku: string;
    title: string;
    description?: string;
    costPrice?: number;
    priceAmount?: number;
    priceCurrency?: string;
    stock?: number;
    minAlert?: number;
    location?: string;
    weightGrams?: number;
    defaultConsumableId?: string;
    color?: string;
    material?: string;
    images?: string[];
    tags?: string[];
    /** Déclarations exigées par les places de marché. Voir la migration 0008. */
    condition?: string;
    whoMade?: string;
    whenMade?: string;
  }>();

  const sku = (body.sku ?? "").trim().toUpperCase();
  const title = (body.title ?? "").trim();

  if (!sku || !title) {
    return c.json({ error: "SKU et Titre requis" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const stock = Math.max(0, Number(body.stock ?? 0));

  /*
   * Vocabulaire fermé, validé ici plutôt qu'au moment de publier.
   *
   * Une valeur libre traverserait la base sans bruit et se ferait refuser par
   * la plateforme des semaines plus tard, sur une annonce qu'on croyait
   * partie. Une valeur inconnue est donc ramenée à « absente » — ce qui
   * bloque la publication en la nommant, au lieu de la faire échouer au loin.
   */
  const ETATS = new Set([
    "new", "new_other", "used_excellent", "used_good", "used_acceptable", "for_parts",
  ]);
  const QUI = new Set(["i_did", "collective", "someone_else"]);
  // Vocabulaire relevé sur la spécification OpenAPI d'Etsy. Trois valeurs
  // qui figuraient ici n'existaient pas et provoquaient un 400 à la création.
  const QUAND = new Set([
    "made_to_order", "2020_2026", "2010_2019", "2007_2009", "2000_2006", "before_2007", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700",
  ]);
  const dans = (v: string | undefined, ens: Set<string>) =>
    v && ens.has(v) ? v : null;

  const condition = dans(body.condition, ETATS);
  const whoMade = dans(body.whoMade, QUI);
  const whenMade = dans(body.whenMade, QUAND);

  // Chercher si le produit existe déjà (par ID ou par SKU)
  let existing = null;
  if (body.id) {
    [existing] = await db.select().from(product).where(eq(product.id, body.id)).limit(1);
  }
  if (!existing) {
    [existing] = await db.select().from(product).where(eq(product.sku, sku)).limit(1);
  }

  const id = existing ? existing.id : (body.id || `prod_${randomId()}`);

  if (existing) {
    await db
      .update(product)
      .set({
        sku,
        title,
        description: body.description ?? null,
        costPrice: body.costPrice !== undefined && body.costPrice !== null ? Math.max(0, Math.round(body.costPrice)) : null,
        priceAmount: Math.max(0, Math.round(body.priceAmount ?? 0)),
        priceCurrency: body.priceCurrency ?? "EUR",
        stock,
        minAlert: body.minAlert ? Math.max(1, body.minAlert) : 3,
        location: body.location?.trim() || null,
        weightGrams: body.weightGrams ? Math.max(0, body.weightGrams) : null,
        defaultConsumableId: body.defaultConsumableId || null,
        color: body.color?.trim() || null,
        condition,
        whoMade,
        whenMade,
        material: body.material?.trim() || null,
        images: body.images ? JSON.stringify(body.images) : null,
        tags: body.tags ? JSON.stringify(body.tags) : null,
        updatedAt: now,
      })
      .where(eq(product.id, id));
  } else {
    await db.insert(product).values({
      id,
      sku,
      title,
      description: body.description ?? null,
      costPrice: body.costPrice !== undefined && body.costPrice !== null ? Math.max(0, Math.round(body.costPrice)) : null,
      priceAmount: Math.max(0, Math.round(body.priceAmount ?? 0)),
      priceCurrency: body.priceCurrency ?? "EUR",
      stock,
      minAlert: body.minAlert ? Math.max(1, body.minAlert) : 3,
      location: body.location?.trim() || null,
      weightGrams: body.weightGrams ? Math.max(0, body.weightGrams) : null,
      defaultConsumableId: body.defaultConsumableId || null,
      color: body.color?.trim() || null,
      material: body.material?.trim() || null,
      condition,
      whoMade,
      whenMade,
      images: body.images ? JSON.stringify(body.images) : null,
      tags: body.tags ? JSON.stringify(body.tags) : null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /*
   * LA VARIANTE PAR DÉFAUT.
   *
   * Un produit saisi à la main n'a pas de déclinaison — mais il a quand même
   * une variante, parce que c'est elle qui porte le stock. Sans ce niveau,
   * « stock 12 » n'aurait nulle part où aller.
   *
   * `optionKey` vide identifie précisément cette variante-là : on la retrouve
   * d'un enregistrement à l'autre sans dépendre du SKU, que Shopify n'impose
   * pas et que la moitié du catalogue n'a pas.
   */
  const dejaLa = await db
    .select({ id: variant.id })
    .from(variant)
    .where(and(eq(variant.productId, id), eq(variant.optionKey, "")))
    .limit(1);

  const variantId = dejaLa[0]?.id ?? `var_${randomId()}`;
  await db
    .insert(variant)
    .values({
      id: variantId,
      productId: id,
      sku,
      optionKey: "",
      optionValues: "[]",
      priceAmount: Math.max(0, Math.round(body.priceAmount ?? 0)),
      priceCurrency: body.priceCurrency ?? "EUR",
      position: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [variant.productId, variant.optionKey],
      set: {
        sku,
        priceAmount: Math.max(0, Math.round(body.priceAmount ?? 0)),
        updatedAt: now,
      },
    });

  // Maintenir la table de stock central `inventory` synchronisée
  await db
    .insert(inventory)
    .values({
      variantId,
      onHand: stock,
      reserved: 0,
      version: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: inventory.variantId,
      set: {
        onHand: stock,
        updatedAt: now,
      },
    });

  // Lier automatiquement les annonces orphelines ayant ce SKU
  await db
    .update(listing)
    .set({ productId: id, syncedAt: now })
    .where(and(eq(listing.sku, sku)));

  return c.json({ ok: true, id, sku });
});

/** Ajustement rapide du stock d'un produit. */
api.post("/products/:id/stock", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{ stock?: number; delta?: number }>();
  const now = Math.floor(Date.now() / 1000);

  const [existing] = await db.select().from(product).where(eq(product.id, id)).limit(1);
  if (!existing) return c.json({ error: "product_not_found" }, 404);

  /*
   * SUR UN PRODUIT DÉCLINÉ, « le » stock n'existe pas.
   *
   * La route écrivait `product.stock` puis tentait la variante unique — qui
   * n'existe pas ici. L'écriture du stock ne touchait donc rien, mais le
   * résumé affiché changeait : le bouton « +1 » semblait marcher et le
   * chiffre revenait à sa valeur d'origine au passage suivant.
   */
  const seule = await varianteUnique(db, id);
  if (!seule) {
    return c.json(
      {
        error:
          "Ce produit a plusieurs déclinaisons : le stock se règle coloris par coloris, dans la fiche produit.",
      },
      409,
    );
  }

  let newStock = existing.stock;
  if (typeof body.stock === "number") {
    newStock = Math.max(0, body.stock);
  } else if (typeof body.delta === "number") {
    newStock = Math.max(0, existing.stock + body.delta);
  }

  await db
    .update(product)
    .set({ stock: newStock, updatedAt: now })
    .where(eq(product.id, id));

  await db
    .update(inventory)
    .set({ onHand: newStock, updatedAt: now })
    .where(eq(inventory.variantId, seule));

  // Met à jour les listings synchronisés avec ce SKU
  if (existing.sku) {
    await db
      .update(listing)
      .set({ quantity: newStock, syncedAt: now })
      .where(eq(listing.sku, existing.sku));
  }

  return c.json({ ok: true, id, stock: newStock });
});

/** Supprimer un produit maître. */
api.delete("/products/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  /*
   * CINQ RÉFÉRENCES POINTENT VERS CE PRODUIT ET SES VARIANTES.
   *
   * D1 fait respecter les clés étrangères. Il faut donc les détacher TOUTES
   * avant d'effacer quoi que ce soit, dans l'ordre inverse des dépendances —
   * sinon la base refuse, et l'écran affiche « 500 » sans rien expliquer.
   *
   *   listing.product_id       → le produit
   *   listing.variant_id       → ses variantes      ← oublié, cause du 500
   *   listing_group.product_id → le produit          ← oublié aussi
   *   inventory.variant_id     → ses variantes
   *   variant.product_id       → le produit
   *
   * Les annonces, elles, SURVIVENT : elles existent chez la plateforme et
   * continueront d'être relevées par la synchronisation. Les supprimer ici
   * les ferait réapparaître au passage suivant, orphelines et sans stock.
   */
  const siennes = await db
    .select({ id: variant.id })
    .from(variant)
    .where(eq(variant.productId, id));

  await db
    .update(listing)
    .set({ productId: null })
    .where(eq(listing.productId, id));

  for (const v of siennes) {
    // Une annonce en ligne peut pointer sur une variante de ce produit. La
    // laisser accrochée bloquerait la suppression ; la détacher la laisse
    // vivre, rattachable plus tard par son SKU.
    await db
      .update(listing)
      .set({ variantId: null })
      .where(eq(listing.variantId, v.id));
    await db.delete(inventory).where(eq(inventory.variantId, v.id));
  }

  await db
    .update(listingGroup)
    .set({ productId: null })
    .where(eq(listingGroup.productId, id));

  await db.delete(variant).where(eq(variant.productId, id));
  await db.delete(product).where(eq(product.id, id));

  return c.json({ ok: true, id, variantesSupprimees: siennes.length });
});

/** Supprimer un consommable d'emballage. */
api.delete("/consumables/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  await db.delete(consumable).where(eq(consumable.id, id));
  return c.json({ ok: true, id });
});

/* ------------------------------------------------------------------ */
/* Vue d'ensemble du Stock (Produits + Consommables + Multi-canaux)    */
/* ------------------------------------------------------------------ */

api.get("/inventory", async (c) => {
  const db = drizzle(c.env.DB);
  const [productRows, consumableRows, listingRows] = await Promise.all([
    db.select().from(product).orderBy(desc(product.updatedAt)),
    db.select().from(consumable).orderBy(consumable.category, consumable.name),
    db
      .select({
        id: listing.id,
        productId: listing.productId,
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
      .limit(500),
  ]);

  // Si pas de consommables, initialiser par défaut
  let consumables = consumableRows;
  if (consumables.length === 0) {
    const now = Math.floor(Date.now() / 1000);
    const defaults = [
      { id: "c_env_bubble_s", name: "Enveloppe Bulle S (15x21 cm)", category: "envelope", stock: 50, minAlert: 10, unitCost: 18 },
      { id: "c_env_bubble_m", name: "Enveloppe Bulle M (18x26 cm)", category: "envelope", stock: 45, minAlert: 10, unitCost: 24 },
      { id: "c_env_bubble_l", name: "Enveloppe Bulle L (24x33 cm)", category: "envelope", stock: 30, minAlert: 8, unitCost: 38 },
      { id: "c_box_colissimo_s", name: "Carton Colissimo S (25x18x10 cm)", category: "box", stock: 25, minAlert: 5, unitCost: 65 },
      { id: "c_box_colissimo_m", name: "Carton Colissimo M (32x23x15 cm)", category: "box", stock: 20, minAlert: 5, unitCost: 95 },
      { id: "c_label_thermal", name: "Étiquette thermique d'expédition (10x15 cm)", category: "label", stock: 200, minAlert: 30, unitCost: 4 },
      { id: "c_card_thanks", name: "Carte de remerciement & fidélité", category: "card", stock: 150, minAlert: 25, unitCost: 8 },
      { id: "c_paper_kraft", name: "Papier de calage & protection kraft", category: "protection", stock: 80, minAlert: 15, unitCost: 12 },
      { id: "c_tape_fragile", name: "Ruban adhésif renforcé", category: "protection", stock: 15, minAlert: 3, unitCost: 120 },
    ];
    for (const item of defaults) {
      await db.insert(consumable).values({ ...item, createdAt: now, updatedAt: now }).onConflictDoNothing();
    }
    consumables = await db.select().from(consumable).orderBy(consumable.category, consumable.name);
  }

  // Regroupement par SKU
  const bySku = new Map<string, typeof listingRows>();
  for (const r of listingRows) {
    if (!r.sku) continue;
    const arr = bySku.get(r.sku) ?? [];
    arr.push(r);
    bySku.set(r.sku, arr);
  }
  const multiChannel = [...bySku.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([sku, v]) => ({ sku, listings: v }));

  const mappedProducts = productRows.map((p) => {
    let images: string[] = [];
    let tags: string[] = [];
    if (p.images) {
      try {
        const parsed = JSON.parse(p.images);
        if (Array.isArray(parsed)) images = parsed;
      } catch {}
    }
    if (p.tags) {
      try {
        const parsed = JSON.parse(p.tags);
        if (Array.isArray(parsed)) tags = parsed;
      } catch {}
    }
    return {
      ...p,
      images,
      tags,
    };
  });

  // Statistiques globales
  const totalStockUnits = productRows.reduce((s, p) => s + p.stock, 0);
  const totalStockValue = productRows.reduce((s, p) => s + (p.stock * p.priceAmount), 0);
  const lowStockProductsCount = productRows.filter((p) => p.stock <= p.minAlert).length;
  const lowStockConsumablesCount = consumables.filter((c) => c.stock <= c.minAlert).length;

  return c.json({
    products: mappedProducts,
    consumables,
    listings: listingRows,
    multiChannel,
    stats: {
      totalProducts: productRows.length,
      totalStockUnits,
      totalStockValue,
      lowStockProductsCount,
      lowStockConsumablesCount,
    },
  });
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

/**
 * Complète un produit avec ce qu'exigent les places de marché.
 *
 * Route SÉPARÉE de `POST /products`, volontairement. Celle-là fait un
 * remplacement complet : l'appeler pour ne changer que l'état de l'article
 * écraserait au passage le prix, le stock et l'emplacement avec ce que le
 * formulaire d'en face avait en mémoire. Ici on ne touche QUE ce qui est
 * fourni, et rien d'autre.
 *
 * Le vocabulaire est fermé et validé ici plutôt qu'au moment de publier : une
 * valeur libre traverserait la base sans bruit et se ferait refuser par la
 * plateforme bien plus tard, sur une annonce qu'on croyait partie.
 */
api.patch("/products/:id/diffusion", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req
    .json<{
      condition?: string | null;
      whoMade?: string | null;
      whenMade?: string | null;
      images?: string[];
      ebayCategoryId?: string | null;
      etsyTaxonomyId?: string | null;
    }>()
    .catch(() => ({}) as Record<string, never>);

  const rows = await db.select().from(product).where(eq(product.id, id)).limit(1);
  const existant = rows[0];
  if (!existant) return c.json({ error: "Produit inconnu" }, 404);

  const ETATS = new Set([
    "new", "new_other", "used_excellent", "used_good", "used_acceptable", "for_parts",
  ]);
  const QUI = new Set(["i_did", "collective", "someone_else"]);
  // Vocabulaire relevé sur la spécification OpenAPI d'Etsy. Trois valeurs
  // qui figuraient ici n'existaient pas et provoquaient un 400 à la création.
  const QUAND = new Set([
    "made_to_order", "2020_2026", "2010_2019", "2007_2009", "2000_2006", "before_2007", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700",
  ]);

  /** Non fourni = on ne touche pas. Fourni mais vide ou invalide = on efface. */
  const choisir = (v: string | null | undefined, ens: Set<string>) =>
    v === undefined ? undefined : v && ens.has(v) ? v : null;

  // Les photos doivent être en HTTPS : eBay rejette tout le reste, et une
  // annonce publiée sans image est invendable sans qu'aucune erreur ne le dise.
  const images = body.images
    ? body.images
        .map((u) => u.trim())
        .filter((u) => /^https:\/\//i.test(u))
        .slice(0, 20)
    : undefined;

  const donnees = JSON.parse(existant.marketplaceData ?? "{}") as Record<string, unknown>;
  if (body.ebayCategoryId !== undefined) {
    donnees["ebayCategoryId"] = body.ebayCategoryId?.trim() || undefined;
  }
  if (body.etsyTaxonomyId !== undefined) {
    donnees["etsyTaxonomyId"] = body.etsyTaxonomyId?.trim() || undefined;
  }

  const condition = choisir(body.condition, ETATS);
  const whoMade = choisir(body.whoMade, QUI);
  const whenMade = choisir(body.whenMade, QUAND);

  await db
    .update(product)
    .set({
      ...(condition !== undefined ? { condition } : {}),
      ...(whoMade !== undefined ? { whoMade } : {}),
      ...(whenMade !== undefined ? { whenMade } : {}),
      ...(images !== undefined ? { images: JSON.stringify(images) } : {}),
      marketplaceData: JSON.stringify(donnees),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(product.id, id));

  const rejetees = (body.images?.length ?? 0) - (images?.length ?? 0);
  return c.json({
    ok: true,
    photos: images?.length ?? null,
    ...(rejetees > 0
      ? { avertissement: `${rejetees} adresse(s) ignorée(s) : seules les URL en HTTPS sont acceptées.` }
      : {}),
  });
});

/**
 * Les variantes d'un produit, avec le stock de chacune.
 *
 * POURQUOI UNE ROUTE À PART. L'écran de diffusion montrait le stock du
 * PARENT — un nombre qui n'existe pas vraiment pour un produit à dix-sept
 * coloris. On ne pouvait donc pas vérifier ce qui allait réellement partir,
 * ni repérer un coloris sans stock avant de le publier à zéro.
 *
 * La liste complète n'est pas jointe à `GET /products` : elle coûterait une
 * requête par produit sur un écran qui les affiche tous.
 */
api.get("/products/:id/variantes", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const lignes = await db
    .select({
      id: variant.id,
      sku: variant.sku,
      optionValues: variant.optionValues,
      optionKey: variant.optionKey,
      priceAmount: variant.priceAmount,
      priceCurrency: variant.priceCurrency,
      status: variant.status,
      position: variant.position,
      onHand: inventory.onHand,
      reserved: inventory.reserved,
    })
    .from(variant)
    .leftJoin(inventory, eq(inventory.variantId, variant.id))
    .where(eq(variant.productId, id))
    .orderBy(variant.position);

  const [p] = await db
    .select({ options: product.options, title: product.title })
    .from(product)
    .where(eq(product.id, id))
    .limit(1);

  return c.json({
    axes: JSON.parse(p?.options ?? "[]"),
    variantes: lignes.map((v) => ({
      ...v,
      optionValues: JSON.parse(v.optionValues || "[]") as string[],
      // `null` et `0` ne veulent pas dire la même chose : l'un est « on ne
      // sait pas », l'autre « épuisé ». L'écran doit pouvoir les distinguer.
      onHand: v.onHand,
    })),
  });
});

/**
 * Fixe le stock de plusieurs déclinaisons d'un coup.
 *
 * EN LOT, et non une requête par coloris : un support téléphone en a
 * dix-sept, et dix-sept allers-retours pour un seul geste de saisie
 * consommeraient le budget de sous-requêtes d'un trait.
 *
 * Ce qui est écrit ici est le stock CENTRAL. Il ne s'agit pas d'une quantité
 * de publication à part : la version est incrémentée, donc le rapprochement
 * poussera cette valeur vers les plateformes au lieu de la voir écrasée. Une
 * seule source de vérité, celle-ci.
 */
/**
 * Déclarer à la main les déclinaisons d'un produit.
 *
 * Le stock réel viendra un jour des commandes Alibaba, par l'API. En
 * attendant, il faut pouvoir dire « ce porte-clés existe en noir, blanc et
 * rouge, et j'en ai douze, huit et zéro » sans passer par une boutique.
 *
 * Les variantes retirées sont ARCHIVÉES, jamais supprimées : une annonce en
 * ligne pointe sur l'identifiant de variante, et l'effacer laisserait cette
 * annonce sans stock rattachable — sans erreur, jusqu'à la prochaine vente.
 */
api.put("/products/:id/declinaisons", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  type CorpsDeclinaisons = {
    axe?: string;
    lignes?: Array<{
      valeur?: string;
      sku?: string | null;
      prixCentimes?: number | null;
      stock?: number;
    }>;
  };
  const body = await c.req
    .json<CorpsDeclinaisons>()
    .catch(() => ({}) as CorpsDeclinaisons);

  const [p] = await db
    .select({
      id: product.id,
      sku: product.sku,
      priceAmount: product.priceAmount,
      priceCurrency: product.priceCurrency,
    })
    .from(product)
    .where(eq(product.id, id))
    .limit(1);
  if (!p) return c.json({ error: "product_not_found" }, 404);

  /*
   * UN PRODUIT SYNCHRONISÉ NE SE MODIFIE PAS ICI.
   *
   * Les déclinaisons d'un produit venu de Shopify sont réécrites à chaque
   * passage de la synchronisation, toutes les cinq minutes. Les éditer ici
   * serait sans effet durable — et, entre-temps, archiverait des variantes
   * sur lesquelles des annonces en ligne s'appuient. On refuse en le disant.
   */
  const [rattachee] = await db
    .select({ id: listing.id })
    .from(listing)
    .where(eq(listing.productId, id))
    .limit(1);
  if (rattachee) {
    return c.json(
      {
        error:
          "Ce produit vient d'une boutique connectée : ses déclinaisons sont réécrites à chaque synchronisation. Modifiez-les chez la plateforme.",
      },
      409,
    );
  }

  const axe = (body.axe ?? "").trim() || "Couleur";
  const lignes = (body.lignes ?? [])
    .map((l) => ({
      valeur: (l.valeur ?? "").trim(),
      sku: (l.sku ?? "")?.trim() || null,
      prixCentimes:
        typeof l.prixCentimes === "number" && l.prixCentimes >= 0
          ? Math.round(l.prixCentimes)
          : null,
      stock: Math.max(0, Math.round(Number(l.stock ?? 0)) || 0),
    }))
    .filter((l) => l.valeur.length > 0);

  if (lignes.length === 0) {
    return c.json({ error: "Aucune déclinaison à enregistrer" }, 400);
  }

  /*
   * La clé d'identité, au format « couleur=noir ».
   *
   * C'est celui qu'écrit la synchronisation. S'en écarter ferait qu'un
   * coloris saisi ici et le même coloris relevé chez la boutique
   * deviendraient deux variantes distinctes, chacune avec la moitié du stock.
   *
   * Deux « Noir » se replieraient sur la même clé et l'un écraserait l'autre
   * en silence : mieux vaut le refuser à la saisie.
   */
  const cles = lignes.map(
    (l) => `${normaliserValeur(axe)}=${normaliserValeur(l.valeur)}`,
  );
  if (new Set(cles).size !== cles.length) {
    return c.json({ error: "Deux déclinaisons portent le même nom" }, 400);
  }

  /*
   * LES SKU AUSSI DOIVENT ÊTRE UNIQUES.
   *
   * `variant.sku` porte un index unique en base. Deux lignes au même SKU
   * feraient échouer l'écriture à mi-parcours : les premières déclinaisons
   * enregistrées, les suivantes non, et une erreur 500 sans nom pour
   * l'expliquer. Le dire avant d'écrire coûte une boucle.
   *
   * Le SKU du produit compte parmi les pris : la variante par défaut le porte
   * déjà, et l'archiver ne le libère pas — l'index ignore le statut.
   */
  const skus = lignes.map((l) => l.sku).filter((v): v is string => Boolean(v));
  const doublon = skus.find((v, i) => skus.indexOf(v) !== i);
  if (doublon) {
    return c.json(
      { error: `Deux déclinaisons portent le SKU « ${doublon} »` },
      400,
    );
  }

  const prisAilleurs = skus.length
    ? await db
        .select({ sku: variant.sku, productId: variant.productId })
        .from(variant)
        .where(inArray(variant.sku, skus))
    : [];
  const vole = prisAilleurs.find((v) => v.productId !== id);
  if (vole) {
    return c.json(
      { error: `Le SKU « ${vole.sku} » appartient déjà à un autre produit` },
      409,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const mod = buildEngine(c.env, { used: 0 });
  const gardees = new Set<string>();

  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i]!;
    const cle = cles[i]!;
    gardees.add(cle);

    const [existante] = await db
      .select({ id: variant.id })
      .from(variant)
      .where(and(eq(variant.productId, id), eq(variant.optionKey, cle)))
      .limit(1);

    const variantId = existante?.id ?? `var_${randomId()}`;
    await db
      .insert(variant)
      .values({
        id: variantId,
        productId: id,
        sku: l.sku,
        optionKey: cle,
        optionValues: JSON.stringify([l.valeur]),
        priceAmount: l.prixCentimes ?? p.priceAmount,
        priceCurrency: p.priceCurrency ?? "EUR",
        position: i,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [variant.productId, variant.optionKey],
        set: {
          sku: l.sku,
          optionValues: JSON.stringify([l.valeur]),
          priceAmount: l.prixCentimes ?? p.priceAmount,
          position: i,
          status: "active",
          updatedAt: now,
        },
      });

    await mod.inventoryService.ensure(variantId, 0);
    await mod.inventoryService.set(variantId, l.stock);
  }

  /*
   * Ce qui n'est plus déclaré passe en archivé — y compris la variante par
   * défaut, celle à `optionKey` vide, créée avec le produit. La laisser
   * active ferait compter son stock une seconde fois dans le total.
   */
  const toutes = await db
    .select({ id: variant.id, optionKey: variant.optionKey, status: variant.status })
    .from(variant)
    .where(eq(variant.productId, id));

  let archivees = 0;
  for (const v of toutes) {
    if (gardees.has(v.optionKey) || v.status !== "active") continue;
    await db
      .update(variant)
      .set({ status: "archived", updatedAt: now })
      .where(eq(variant.id, v.id));
    archivees++;
  }

  await db
    .update(product)
    .set({
      options: JSON.stringify([{ name: axe, values: lignes.map((l) => l.valeur) }]),
      updatedAt: now,
    })
    .where(eq(product.id, id));

  await recalculerStockProduit(db, id);

  return c.json({ ok: true, declinaisons: lignes.length, archivees });
});

api.patch("/products/:id/stock-variantes", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req
    .json<Record<string, number>>()
    .catch(() => ({}) as Record<string, number>);

  // Les variantes de CE produit, et elles seules : sans ce filtre, la route
  // permettrait d'écrire le stock de n'importe quel article du catalogue.
  const siennes = new Set(
    (
      await db
        .select({ id: variant.id })
        .from(variant)
        .where(eq(variant.productId, id))
    ).map((v) => v.id),
  );

  const mod = buildEngine(c.env, { used: 0 });
  const faits: string[] = [];
  const refuses: string[] = [];

  for (const [variantId, valeur] of Object.entries(body)) {
    if (!siennes.has(variantId)) {
      refuses.push(variantId);
      continue;
    }
    const n = Number(valeur);
    if (!Number.isFinite(n) || n < 0) {
      refuses.push(variantId);
      continue;
    }
    await mod.inventoryService.ensure(variantId, 0);
    await mod.inventoryService.set(variantId, n);
    faits.push(variantId);
  }

  if (faits.length === 0) {
    return c.json({ error: "Aucun stock valide à enregistrer" }, 400);
  }

  // Le résumé au niveau du produit suit, sinon les écrans qui l'affichent
  // continueraient de montrer l'ancienne valeur.
  await recalculerStockProduit(db, id);

  return c.json({ ok: true, enregistres: faits.length, refuses: refuses.length });
});
