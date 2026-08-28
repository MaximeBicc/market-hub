import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import type { CanonicalOrderEvent } from "@hub/engine";
import { COMMANDES, etatCommande } from "@hub/engine";
import { commandLog, inventory, product, shop, variant } from "../db/schema.js";
import type { Env } from "../env.js";
import { authenticate } from "../lib/session.js";
import { buildEngine } from "../engine/module.js";
import { d1Repositories } from "../engine/repositories.js";

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
/**
 * Le catalogue des commandes, boutique par boutique.
 *
 * AUCUN APPEL RÉSEAU : `capabilities()` est pure sur les trois adaptateurs
 * réels — elle lit les identifiants déjà déchiffrés et renvoie des booléens.
 * La page peut donc s'ouvrir sans consommer un seul quota de plateforme.
 *
 * Ce qui distingue cette route de `/capabilities` : elle ne renvoie pas des
 * booléens bruts mais des COMMANDES, avec leur état et, quand une commande
 * est fermée, ce qui manque pour l'ouvrir. « eBay ne gère pas listingCreate »
 * est vrai et inutile ; « il manque une adresse d'expédition et trois
 * politiques, voici où les créer » est actionnable.
 */
engine.get("/catalogue", async (c) => {
  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);
  const mod = buildEngine(c.env);

  const lignes = await db.select().from(shop).orderBy(shop.platform);
  const boutiques = [];

  for (const s of lignes) {
    const account = await repos.accounts.get(s.id);
    if (!account) continue;
    const credentials = await repos.credentials.get(s.id);
    const capacites = await mod.registry
      .get(account.marketplace)
      .capabilities({ account, credentials });

    boutiques.push({
      id: s.id,
      plateforme: s.platform,
      nom: s.displayName,
      statut: s.status,
      ventesEntrantes: capacites.inboundSales,
      commandes: COMMANDES.map((cmd) => ({
        id: cmd.id,
        libelle: cmd.libelle,
        ecrit: cmd.ecrit,
        portee: cmd.portee,
        ...etatCommande(cmd, account.marketplace, capacites, credentials),
      })),
    });
  }

  return c.json({ boutiques });
});

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
    /** Publie immédiatement après la création au lieu de laisser un brouillon. */
    publish?: boolean;
    idempotencyKey?: string;
  }>();
  const key = body.idempotencyKey ?? crypto.randomUUID();

  // Compteur partagé : une diffusion vers trois comptes peut coûter une
  // dizaine de sous-requêtes, et le plan gratuit en autorise 50.
  const mod = buildEngine(c.env, { used: 0 });
  // Dédoublonnage : `{"accountIds":["a","a"]}` créait DEUX annonces en un
  // seul appel — le garde-fou d'idempotence est construit avant la boucle et
  // ne voit donc pas la première création de la même passe.
  const comptes = [...new Set(body.accountIds ?? [])].filter(Boolean);
  if (comptes.length === 0) {
    return c.json({ error: "Aucune boutique cible" }, 400);
  }

  const creation = await mod.orchestrator.createListing({
    productId: body.productId,
    accountIds: comptes,
    idempotencyKey: key,
  });

  if (!body.publish) {
    return c.json({ ...creation, idempotencyKey: key });
  }

  // Une création est volontairement transactionnelle en deux temps chez les
  // trois plateformes : objet complet, puis mise en ligne. On ne publie que
  // les objets effectivement créés (ou un brouillon local déjà connu).
  const aActiver = creation.results
    .filter(
      (r) =>
        r.status === "success" &&
        r.marketplaceData?.["alreadyActive"] !== true,
    )
    .map((r) => r.accountId);

  if (aActiver.length === 0) {
    return c.json({ ...creation, idempotencyKey: key });
  }

  const activation = await mod.orchestrator.setActive({
    productId: body.productId,
    accountIds: aActiver,
    active: true,
    idempotencyKey: `${key}:publish`,
  });
  const parCompte = new Map(activation.results.map((r) => [r.accountId, r]));
  const results = creation.results.map((cree) => {
    const active = parCompte.get(cree.accountId);
    if (!active) return cree;
    if (active.status === "success") {
      return {
        ...cree,
        ...active,
        remoteId: active.remoteId ?? cree.remoteId,
        marketplaceData: {
          ...(cree.marketplaceData ?? {}),
          ...(active.marketplaceData ?? {}),
        },
        message: active.message ?? "Annonce publiée et visible.",
      };
    }
    return {
      ...active,
      // « unsupported » est normal pour une commande optionnelle. Ici, après
      // création d'un brouillon, cela signifie bien que l'objectif demandé —
      // une annonce en ligne — n'a pas été atteint.
      status: active.status === "unsupported" ? "failed" as const : active.status,
      remoteId: active.remoteId ?? cree.remoteId,
      message: `Le brouillon a été créé, mais sa mise en ligne a échoué : ${active.message ?? "raison inconnue"}`,
    };
  });
  const outcome = {
    results,
    anySuccess: results.some((r) => r.status === "success"),
    anyManual: results.some((r) => r.status === "manual_required"),
  };

  return c.json({ ...outcome, idempotencyKey: key });
});

engine.post("/price", async (c) => {
  const body = await c.req.json<{
    productId: string;
    /** La déclinaison visée. Obligatoire dès que le produit en a plusieurs. */
    variantId?: string;
    accountIds: string[];
    amount: number;
    currency?: string;
    idempotencyKey?: string;
  }>();
  const key = body.idempotencyKey ?? crypto.randomUUID();

  const mod = buildEngine(c.env);
  const outcome = await mod.orchestrator.setPrice({
    productId: body.productId,
    ...(body.variantId ? { variantId: body.variantId } : {}),
    accountIds: body.accountIds,
    price: { amount: body.amount, currency: body.currency ?? "EUR" },
    idempotencyKey: key,
  });

  return c.json({ ...outcome, idempotencyKey: key });
});

engine.post("/stock", async (c) => {
  const body = await c.req.json<{
    productId: string;
    /** La déclinaison visée. Obligatoire dès que le produit en a plusieurs. */
    variantId?: string;
    accountIds: string[];
    stock: number;
    idempotencyKey?: string;
  }>();
  const key = body.idempotencyKey ?? crypto.randomUUID();

  const mod = buildEngine(c.env);
  const outcome = await mod.orchestrator.setStock({
    productId: body.productId,
    ...(body.variantId ? { variantId: body.variantId } : {}),
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

/**
 * Marque une commande expédiée, avec éventuellement un numéro de suivi.
 *
 * Cible unique : une commande n'existe que sur la plateforme où elle a été
 * passée. La diffuser vers plusieurs comptes n'aurait aucun sens.
 */
engine.post("/fulfill", async (c) => {
  const body = await c.req.json<{
    accountId: string;
    remoteOrderId: string;
    trackingNumber?: string;
    carrier?: string;
    trackingUrl?: string;
    notifyBuyer?: boolean;
    idempotencyKey?: string;
  }>();

  if (!body?.accountId || !body?.remoteOrderId) {
    return c.json({ error: "accountId et remoteOrderId requis" }, 400);
  }
  const key = body.idempotencyKey ?? crypto.randomUUID();

  const mod = buildEngine(c.env);
  const outcome = await mod.orchestrator.fulfillOrder({
    accountId: body.accountId,
    fulfillment: {
      remoteOrderId: body.remoteOrderId,
      trackingNumber: body.trackingNumber,
      carrier: body.carrier,
      trackingUrl: body.trackingUrl,
      notifyBuyer: body.notifyBuyer,
    },
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
      variantId: inventory.variantId,
      productId: variant.productId,
      sku: product.sku,
      title: product.title,
      onHand: inventory.onHand,
      reserved: inventory.reserved,
      version: inventory.version,
      updatedAt: inventory.updatedAt,
    })
    .from(inventory)
    // Deux jointures désormais : le stock pend à la variante, la variante au
    // produit. C'est le prix — modeste — d'un stock qui sait distinguer le
    // coloris violet du noir.
    .innerJoin(variant, eq(variant.id, inventory.variantId))
    .innerJoin(product, eq(product.id, variant.productId));

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
