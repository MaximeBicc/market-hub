import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { inventory, listing, product, salesEvent, shop } from "../db/schema.js";
import type { Env } from "../env.js";
import { authenticate } from "../lib/session.js";
import { contentHash, randomId } from "../lib/crypto.js";
import { buildEngine } from "../engine/module.js";
import { ebayConsentUrl, ebayExchangeCode } from "@hub/engine";
import { d1Repositories } from "../engine/repositories.js";
import { ensureSyncJobs } from "../engine/sync.js";

/**
 * Connexion des comptes marchands.
 *
 * TROIS RÈGLES QUI NE SE NÉGOCIENT PAS :
 *
 * 1. Le jeton n'est JAMAIS renvoyé. Une fois enregistré, il est chiffré et
 *    ne ressort plus, même pour l'utilisateur qui l'a saisi. Un secret qu'on
 *    peut relire est un secret qui finit dans un presse-papier, un journal
 *    ou une capture d'écran.
 *
 * 2. La connexion est TESTÉE avant d'être enregistrée. Sauvegarder un jeton
 *    invalide crée une boutique qui a l'air connectée et ne synchronise
 *    rien — exactement le mode de panne silencieux qu'on cherche à éviter.
 *
 * 3. Le domaine est VALIDÉ. L'adaptateur construit son URL à partir de cette
 *    valeur ; accepter n'importe quel domaine reviendrait à laisser envoyer
 *    le jeton vers un serveur choisi par l'appelant.
 */

export const accounts = new Hono<{ Bindings: Env }>();

accounts.use("*", async (c, next) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  await next();
});

interface ShopifyConnectBody {
  shopDomain?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  displayName?: string;
  /** Applications créées avant 2026 : jeton permanent « shpat_ ». */
  accessToken?: string;
}

/** Seuls les domaines Shopify sont acceptés, et sans schéma ni chemin. */
const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function normalizeShopDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  // On tolère un copier-coller depuis la barre d'adresse.
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return SHOPIFY_DOMAIN.test(d) ? d : null;
}

/** Liste des comptes. Aucun secret n'apparaît ici, par construction. */
accounts.get("/", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      id: shop.id,
      marketplace: shop.platform,
      slug: shop.slug,
      displayName: shop.displayName,
      externalId: shop.externalId,
      status: shop.status,
      connectedAt: shop.connectedAt,
    })
    .from(shop);
  return c.json({ accounts: rows });
});

/**
 * Connecte une boutique Shopify avec un jeton d'application personnalisée.
 *
 * Pour une boutique que l'on possède, ce jeton est permanent : il n'y a ni
 * cycle OAuth ni rafraîchissement à maintenir.
 */
accounts.post("/shopify", async (c) => {
  // Le repli est typé : sans cela, `catch(() => ({}))` élargit le type et
  // toutes les lectures de champ deviennent des erreurs de compilation.
  const body = await c.req
    .json<ShopifyConnectBody>()
    .catch((): ShopifyConnectBody => ({}));

  const domain = normalizeShopDomain(body.shopDomain ?? "");
  const clientId = (body.clientId ?? "").trim();
  const clientSecret = (body.clientSecret ?? "").trim();
  const legacyToken = (body.accessToken ?? "").trim();

  if (!domain) {
    return c.json(
      {
        error:
          "Domaine invalide. Attendu : maboutique.myshopify.com (et non votre domaine personnalisé).",
      },
      400,
    );
  }

  /**
   * Deux chemins d'authentification, selon l'âge de l'application.
   *
   * Depuis le 1er janvier 2026, Shopify ne délivre plus de jeton permanent :
   * le Dev Dashboard fournit un ID client et un secret, échangés contre un
   * jeton de 24 heures. Les applications créées avant gardent leur jeton
   * « shpat_ », qu'on accepte toujours plutôt que de casser une connexion
   * qui fonctionne.
   */
  if (!clientId && !legacyToken) {
    return c.json(
      {
        error:
          "Renseignez l'ID client et le secret, visibles dans le Dev Dashboard sous Paramètres → Identifiants.",
      },
      400,
    );
  }
  if (clientId && !clientSecret) {
    return c.json({ error: "Le secret client est requis avec l'ID client." }, 400);
  }

  const db = drizzle(c.env.DB);
  const existing = await db
    .select({ id: shop.id })
    .from(shop)
    .where(eq(shop.externalId, domain))
    .limit(1);

  const accountId = existing[0]?.id ?? randomId();
  const displayName = body.displayName?.trim() || domain.replace(".myshopify.com", "");
  const slug = `shopify_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

  const credentials: Record<string, string> = {
    shopDomain: domain,
    ...(clientId ? { clientId, clientSecret } : {}),
    ...(legacyToken ? { accessToken: legacyToken } : {}),
    ...(body.webhookSecret?.trim()
      ? { webhookSecret: body.webhookSecret.trim() }
      : {}),
  };

  /**
   * On écrit les identifiants AVANT le test : l'adaptateur les lit depuis le
   * dépôt, il n'y a pas de chemin pour les lui passer directement. En
   * contrepartie, le compte n'est marqué « actif » que si le test réussit —
   * un échec le laisse en erreur, jamais en état trompeur.
   */
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);

  await db
    .insert(shop)
    .values({
      id: accountId,
      platform: "shopify",
      externalId: domain,
      displayName,
      slug,
      status: "connecting",
      config: "{}",
      connectedAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoUpdate({
      target: shop.id,
      set: { displayName, slug, status: "connecting" },
    });

  await repos.credentials.put(accountId, credentials);

  try {
    const mod = buildEngine(c.env);
    const adapter = mod.registry.get("shopify");
    const account = await repos.accounts.get(accountId);
    if (!account) throw new Error("Compte introuvable après création");

    await adapter.testConnection({
      account: { ...account, enabled: true },
      credentials,
      // Le jeton dérivé de l'échange est mémorisé dès le test : sans cela, la
      // première commande réelle devrait le redemander inutilement.
      saveCredentials: async (patch) => {
        await repos.credentials.put(accountId, { ...credentials, ...patch });
      },
    });
  } catch (err) {
    await db
      .update(shop)
      .set({ status: "error" })
      .where(eq(shop.id, accountId));

    // Le message de la plateforme est renvoyé tel quel : « 401 Unauthorized »
    // ou « scope manquant » dit précisément quoi corriger, là où un message
    // générique obligerait à deviner.
    return c.json(
      {
        error: `Shopify a refusé la connexion : ${
          err instanceof Error ? err.message : String(err)
        }`,
        accountId,
      },
      400,
    );
  }

  await db.update(shop).set({ status: "active" }).where(eq(shop.id, accountId));

  // Les tâches périodiques sont créées ici et pas ailleurs : une boutique
  // connectée mais absente de l'ordonnanceur ne se synchronise jamais, sans
  // que rien ne le signale. Leur cadence dépend des capacités déclarées.
  await ensureSyncJobs(c.env, accountId);

  // Le jeton ne figure PAS dans la réponse. Il est entré, il ne ressort plus.
  return c.json({
    ok: true,
    account: { id: accountId, marketplace: "shopify", slug, displayName, domain },
  });
});

/** Retente la connexion d'un compte existant, sans ressaisir le jeton. */
accounts.post("/:id/test", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);

  const account = await repos.accounts.get(id);
  if (!account) return c.json({ error: "Compte inconnu" }, 404);

  try {
    const mod = buildEngine(c.env);
    const adapter = mod.registry.get(account.marketplace);
    const current = await repos.credentials.get(id);
    await adapter.testConnection({
      account: { ...account, enabled: true },
      credentials: current,
      saveCredentials: async (patch) => {
        await repos.credentials.put(id, { ...current, ...patch });
      },
    });
  } catch (err) {
    await db.update(shop).set({ status: "error" }).where(eq(shop.id, id));
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }

  await db.update(shop).set({ status: "active" }).where(eq(shop.id, id));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* eBay — parcours d'autorisation                                      */
/* ------------------------------------------------------------------ */

/**
 * eBay n'a pas d'équivalent au jeton d'application de Shopify.
 *
 * Les API vendeur exigent un jeton UTILISATEUR, obtenu après consentement
 * dans un navigateur. Le parcours est donc en deux temps : on mémorise les
 * identifiants, on renvoie vers eBay, et eBay nous rappelle avec un code.
 *
 * Le `state` protège du CSRF : sans lui, un tiers pourrait vous faire relier
 * SON compte eBay au vôtre, et lire ensuite tout ce qui y transite. Il est à
 * usage unique et vit dix minutes.
 */
accounts.post("/ebay/start", async (c) => {
  const body = await c.req
    .json<{
      clientId?: string;
      clientSecret?: string;
      ruName?: string;
      marketplaceId?: string;
      displayName?: string;
    }>()
    .catch(() => ({}) as Record<string, string>);

  const clientId = (body.clientId ?? "").trim();
  const clientSecret = (body.clientSecret ?? "").trim();
  const ruName = (body.ruName ?? "").trim();

  if (!clientId || !clientSecret || !ruName) {
    return c.json(
      {
        error:
          "ID client, secret et RuName sont requis. Le RuName se crée dans le portail développeur eBay ; ce n'est pas une URL.",
      },
      400,
    );
  }
  // Un RuName ressemble à « Prenom-Nom-appnam-abcdef » : si l'on y trouve un
  // schéma d'URL, c'est l'erreur classique, et eBay renverra un message
  // parfaitement obscur.
  if (/^https?:\/\//i.test(ruName)) {
    return c.json(
      {
        error:
          "Le RuName n'est pas une URL. Copiez la valeur affichée sous « RuName » dans le portail eBay.",
      },
      400,
    );
  }

  const state = randomId(24);
  await c.env.CACHE.put(
    `ebay:${state}`,
    JSON.stringify({
      clientId,
      clientSecret,
      ruName,
      marketplaceId: body.marketplaceId ?? "EBAY_FR",
      displayName: body.displayName ?? "eBay",
    }),
    { expirationTtl: 600 },
  );

  return c.json({ url: ebayConsentUrl({ clientId, ruName, state }) });
});

/**
 * Retour d'eBay après consentement.
 *
 * Atteint par une navigation du navigateur, donc le cookie de session est
 * présent (`SameSite=Lax` autorise les navigations de premier niveau en GET).
 * La garde d'authentification du routeur s'applique normalement.
 */
accounts.get("/ebay/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.redirect("/shops?erreur=parametres", 302);

  const pending = await c.env.CACHE.get(`ebay:${state}`);
  if (!pending) return c.redirect("/shops?erreur=expire", 302);
  await c.env.CACHE.delete(`ebay:${state}`); // usage unique

  const p = JSON.parse(pending) as {
    clientId: string;
    clientSecret: string;
    ruName: string;
    marketplaceId: string;
    displayName: string;
  };

  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);

  try {
    const tokens = await ebayExchangeCode({
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      ruName: p.ruName,
      // eBay renvoie le code déjà encodé dans l'URL : Hono le décode, on le
      // transmet tel quel. Le ré-encoder produirait un code invalide.
      code,
    });

    const existing = await db
      .select({ id: shop.id })
      .from(shop)
      .where(and(eq(shop.platform, "ebay"), eq(shop.externalId, p.marketplaceId)))
      .limit(1);
    const accountId = existing[0]?.id ?? randomId();

    await db
      .insert(shop)
      .values({
        id: accountId,
        platform: "ebay",
        externalId: p.marketplaceId,
        displayName: p.displayName,
        slug: `ebay_${p.marketplaceId.toLowerCase()}`,
        status: "active",
        config: "{}",
        connectedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: shop.id,
        set: { displayName: p.displayName, status: "active" },
      });

    await repos.credentials.put(accountId, {
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      ruName: p.ruName,
      marketplaceId: p.marketplaceId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: String(tokens.accessExpiresAt),
      refreshTokenExpiresAt: String(tokens.refreshExpiresAt),
    });

    await ensureSyncJobs(c.env, accountId);
    return c.redirect("/shops?relie=ebay", 302);
  } catch (err) {
    // Le message d'eBay est conservé dans le journal : l'utilisateur, lui,
    // est renvoyé vers l'interface plutôt que sur une page blanche.
    console.error("eBay callback", err);
    return c.redirect("/shops?erreur=ebay", 302);
  }
});

/**
 * SONDE — lit réellement la boutique, sans rien y écrire.
 *
 * C'est l'étape de validation en direct : elle prouve que les identifiants,
 * les portées accordées et la traduction des données fonctionnent contre le
 * vrai compte, avant qu'une seule commande d'écriture ne soit envoyée.
 *
 * Strictement en lecture. Aucune annonce n'est créée, aucun prix modifié,
 * aucun stock touché — on peut donc la lancer sans risque sur une boutique
 * en activité.
 */
accounts.get("/:id/probe", async (c) => {
  const id = c.req.param("id");
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);

  const account = await repos.accounts.get(id);
  if (!account) return c.json({ error: "Compte inconnu" }, 404);

  const mod = buildEngine(c.env);
  const adapter = mod.registry.get(account.marketplace);
  const current = await repos.credentials.get(id);

  const ctx = {
    account,
    credentials: current,
    saveCredentials: async (patch: Record<string, string>) => {
      await repos.credentials.put(id, { ...current, ...patch });
    },
  };

  const report: Record<string, unknown> = {
    account: { id, marketplace: account.marketplace, name: account.displayName },
    capabilities: await adapter.capabilities(ctx),
  };

  // Chaque lecture est isolée : une portée manquante sur les commandes ne doit
  // pas masquer le fait que le catalogue, lui, se lit parfaitement.
  try {
    const page = await adapter.fetchListings?.(ctx);
    report["catalogue"] = page
      ? {
          ok: true,
          lus: page.items.length,
          autresPages: Boolean(page.cursor),
          sansSku: page.items.filter((i) => !i.sku).length,
          exemples: page.items.slice(0, 5).map((i) => ({
            sku: i.sku,
            titre: i.title,
            prix: i.price.amount / 100,
            stock: i.stock,
            statut: i.status,
          })),
        }
      : { ok: false, raison: "lecture de catalogue non gérée par l'adaptateur" };
  } catch (err) {
    report["catalogue"] = {
      ok: false,
      erreur: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const page = await adapter.pollOrderEvents?.(ctx);
    report["ventes"] = page
      ? {
          ok: true,
          lues: page.events.length,
          autresPages: Boolean(page.cursor),
          exemples: page.events.slice(0, 3).map((e) => ({
            commande: e.remoteOrderId,
            type: e.kind,
            date: e.occurredAt,
            lignes: e.lines.length,
          })),
        }
      : { ok: false, raison: "relevé des ventes non géré par l'adaptateur" };
  } catch (err) {
    report["ventes"] = {
      ok: false,
      erreur: err instanceof Error ? err.message : String(err),
    };
  }

  return c.json(report);
});

/**
 * IMPORT INITIAL d'une boutique déjà garnie.
 *
 * Trois opérations, dans cet ordre :
 *
 * 1. CATALOGUE. Chaque annonce distante devient une annonce locale, reliée à
 *    un produit maître retrouvé ou créé par SKU. C'est ce rapprochement qui
 *    permettra plus tard de reconnaître le même article sur eBay et Etsy.
 *
 * 2. STOCK CENTRAL. Initialisé à la valeur constatée chez la plateforme, mais
 *    UNIQUEMENT s'il n'existe pas déjà : réimporter ne doit jamais écraser un
 *    stock que d'autres canaux ont fait évoluer depuis.
 *
 * 3. VENTES PASSÉES — et c'est le point délicat. On les enregistre comme DÉJÀ
 *    TRAITÉES, sans toucher au stock. Le stock lu chez la plateforme tient
 *    déjà compte de ces ventes : les rejouer le décrémenterait une seconde
 *    fois. Les marquer permet en revanche qu'un webhook livré plus tard pour
 *    la même commande soit reconnu comme un doublon et ignoré.
 */
accounts.post("/:id/import", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);

  const account = await repos.accounts.get(id);
  if (!account) return c.json({ error: "Compte inconnu" }, 404);

  const mod = buildEngine(c.env);
  const adapter = mod.registry.get(account.marketplace);
  if (!adapter.fetchListings) {
    return c.json(
      { error: `${account.marketplace} ne permet pas de lire un catalogue.` },
      400,
    );
  }

  const current = await repos.credentials.get(id);
  const ctx = {
    account,
    credentials: current,
    saveCredentials: async (patch: Record<string, string>) => {
      await repos.credentials.put(id, { ...current, ...patch });
    },
  };

  const now = Math.floor(Date.now() / 1000);
  let produitsCrees = 0;
  let produitsExistants = 0;
  let annonces = 0;
  let stockInitialise = 0;
  let sansSku = 0;

  // Pagination bornée : chaque page coûte un appel réseau plus des écritures,
  // et une invocation ne dispose que de 50 sous-requêtes. Au-delà, on rend la
  // main avec un curseur plutôt que de se faire couper au milieu.
  const MAX_PAGES = 6;
  let cursor: string | undefined = c.req.query("cursor") ?? undefined;
  let pages = 0;

  while (pages < MAX_PAGES) {
    const page = await adapter.fetchListings(ctx, cursor);
    pages++;

    for (const item of page.items) {
      if (!item.sku) {
        // Sans SKU, aucun rapprochement entre plateformes n'est possible.
        // On l'importe quand même mais on le signale : c'est une action à
        // mener côté boutique, pas un défaut de l'outil.
        sansSku++;
      }

      let productId: string;
      const existing = item.sku
        ? await db
            .select({ id: product.id })
            .from(product)
            .where(eq(product.sku, item.sku))
            .limit(1)
        : [];

      if (existing[0]) {
        productId = existing[0].id;
        produitsExistants++;
      } else {
        productId = randomId();
        await db.insert(product).values({
          id: productId,
          sku: item.sku ?? `${account.marketplace}-${item.remoteId}`,
          title: item.title,
          description: null,
          priceAmount: item.price.amount,
          priceCurrency: item.price.currency,
          stock: item.stock,
          images: JSON.stringify(item.imageUrl ? [item.imageUrl] : []),
          tags: "[]",
          marketplaceData: "{}",
          createdAt: now,
          updatedAt: now,
        });
        produitsCrees++;
      }

      const hash = await contentHash({
        p: item.price.amount,
        q: item.stock,
        s: item.status,
      });

      await db
        .insert(listing)
        .values({
          id: randomId(),
          shopId: id,
          productId,
          externalId: item.remoteId,
          sku: item.sku,
          title: item.title,
          priceAmount: item.price.amount,
          priceCurrency: item.price.currency,
          quantity: item.stock,
          status: item.status,
          url: item.url ?? null,
          imageUrl: item.imageUrl ?? null,
          marketplaceData: JSON.stringify(item.marketplaceData ?? {}),
          contentHash: hash,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: [listing.shopId, listing.externalId],
          set: {
            productId,
            sku: item.sku,
            title: item.title,
            priceAmount: item.price.amount,
            priceCurrency: item.price.currency,
            quantity: item.stock,
            status: item.status,
            imageUrl: item.imageUrl ?? null,
            marketplaceData: JSON.stringify(item.marketplaceData ?? {}),
            contentHash: hash,
            syncedAt: now,
          },
        });
      annonces++;

      // `ensure` ne crée que si le stock n'existe pas : un réimport ne doit
      // pas effacer une valeur que d'autres canaux ont fait évoluer.
      const before = await repos.inventory.get(productId);
      await mod.inventoryService.ensure(productId, item.stock);
      if (!before) stockInitialise++;
    }

    cursor = page.cursor;
    if (!cursor) break;
  }

  /* --- Ventes passées : mémorisées, jamais rejouées --- */
  let ventesMarquees = 0;
  try {
    const sales = await adapter.pollOrderEvents?.(ctx);
    for (const e of sales?.events ?? []) {
      const eid = await contentHash({ a: e.accountId, e: e.eventId });
      const seen = await db
        .select({ id: salesEvent.id })
        .from(salesEvent)
        .where(
          and(
            eq(salesEvent.accountId, e.accountId),
            eq(salesEvent.eventId, e.eventId),
          ),
        )
        .limit(1);
      if (seen[0]) continue;

      await db.insert(salesEvent).values({
        id: eid,
        accountId: e.accountId,
        eventId: e.eventId,
        marketplace: e.marketplace,
        remoteOrderId: e.remoteOrderId,
        kind: e.kind,
        occurredAt: e.occurredAt,
        receivedAt: now,
        unmatchedLines: 0,
      });
      ventesMarquees++;
    }
  } catch {
    // Une portée manquante sur les commandes ne doit pas annuler l'import
    // du catalogue, qui lui a réussi.
  }

  // Après un import, la synchronisation doit prendre le relais.
  await ensureSyncJobs(c.env, id);

  return c.json({
    ok: true,
    produitsCrees,
    produitsExistants,
    annonces,
    stockInitialise,
    sansSku,
    ventesMarquees,
    // Un curseur non nul signifie qu'il reste des pages : l'appelant relance.
    curseurSuivant: cursor ?? null,
  });
});

/**
 * Met un compte en pause.
 *
 * On ne supprime rien : l'historique des commandes et des annonces reste
 * lisible. Un compte en pause est simplement écarté par l'orchestrateur.
 */
accounts.post("/:id/pause", async (c) => {
  await drizzle(c.env.DB)
    .update(shop)
    .set({ status: "paused" })
    .where(eq(shop.id, c.req.param("id")));
  return c.json({ ok: true });
});

accounts.post("/:id/resume", async (c) => {
  await drizzle(c.env.DB)
    .update(shop)
    .set({ status: "active" })
    .where(eq(shop.id, c.req.param("id")));
  return c.json({ ok: true });
});
