import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import {
  commandLog,
  eventLog,
  inventory,
  listing,
  oauthToken,
  order,
  orderLine,
  product,
  salesEvent,
  shop,
  syncJob,
  webhookReceipt,
} from "../db/schema.js";
import type { Env } from "../env.js";
import { authenticate } from "../lib/session.js";
import { contentHash, randomId } from "../lib/crypto.js";
import { buildEngine } from "../engine/module.js";
import {
  shopifyEnsureWebhooks,
  type ShopifyAdapter,
  ebayConsentUrl,
  ebayExchangeCode,
  etsyConsentUrl,
  etsyExchangeCode,
  etsyFindShop,
  etsyPkce,
} from "@hub/engine";
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

/*
 * LES RAPPELS OAUTH SONT PUBLICS, ET C'EST VOLONTAIRE.
 *
 * Un rappel OAuth revient d'un AUTRE site. Le faire dépendre du cookie de
 * session paraît prudent et ne l'est pas : le cookie est en `SameSite=Lax`,
 * qui survit à une navigation de premier niveau simple — mais pas à la chaîne
 * de redirections d'eBay, qui part d'une soumission de formulaire chez lui.
 * Constaté en production : le rappel eBay recevait 401 sans que le
 * gestionnaire tourne une seule fois, donc sans laisser la moindre trace.
 *
 * Ce qui autorise réellement l'opération n'est pas le cookie mais le `state` :
 * 24 caractères aléatoires, rangés en KV à l'ouverture du parcours, à USAGE
 * UNIQUE et périmés en dix minutes. Or ce parcours ne s'ouvre que depuis une
 * route protégée. Nul ne peut donc fabriquer un `state` valable sans être déjà
 * authentifié, et personne ne peut en rejouer un.
 *
 * C'est le rôle que le `state` a dans OAuth depuis le début. S'appuyer sur lui
 * plutôt que sur un cookie rend aussi le retour indifférent au navigateur —
 * Safari, iOS et la navigation privée traitent les cookies tiers autrement.
 */
const RAPPELS_PUBLICS = new Set([
  "/api/engine/accounts/ebay/callback",
  "/api/engine/accounts/etsy/callback",
]);

accounts.use("*", async (c, next) => {
  if (c.req.method === "GET" && RAPPELS_PUBLICS.has(c.req.path)) {
    return next();
  }
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
        Object.assign(credentials, patch);
        await repos.credentials.put(accountId, credentials);
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
    const current = { ...(await repos.credentials.get(id)) };
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
      environment?: string;
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
      environment: body.environment === "sandbox" ? "sandbox" : "production",
      displayName: body.displayName ?? "eBay",
    }),
    { expirationTtl: 600 },
  );

  return c.json({
    url: ebayConsentUrl({
      clientId,
      ruName,
      state,
      environment: body.environment,
    }),
  });
});

/**
 * Voie directe : coller un jeton de rafraîchissement obtenu ailleurs.
 *
 * Le portail développeur eBay sait générer lui-même un couple de jetons
 * (« Get a Token from eBay via Your Application »). Dans ce cas, le RuName
 * n'a pas besoin de pointer vers nous : eBay gère le retour de bout en bout.
 *
 * C'est le chemin le plus court, et surtout le plus robuste : il ne dépend
 * pas de la configuration exacte des URL d'acceptation du RuName, qui est
 * l'endroit où l'on se trompe le plus souvent.
 *
 * Une fois le jeton de rafraîchissement en base, l'adaptateur renouvelle
 * l'accès tout seul pendant dix-huit mois.
 */
accounts.post("/ebay/token", async (c) => {
  const body = await c.req
    .json<{
      clientId?: string;
      clientSecret?: string;
      refreshToken?: string;
      marketplaceId?: string;
      environment?: string;
      displayName?: string;
    }>()
    .catch(() => ({}) as Record<string, string>);

  const clientId = (body.clientId ?? "").trim();
  const clientSecret = (body.clientSecret ?? "").trim();
  const refreshToken = (body.refreshToken ?? "").trim();
  const marketplaceId = body.marketplaceId ?? "EBAY_FR";
  const environment = body.environment === "sandbox" ? "sandbox" : "production";
  // Le bac à sable et la production sont deux comptes distincts : les
  // distinguer dans l'identifiant permet de relier les deux en parallèle,
  // ce qui est justement l'intérêt d'avoir un bac à sable.
  const externalId = `${marketplaceId}${environment === "sandbox" ? ":sandbox" : ""}`;

  if (!clientId || !clientSecret || !refreshToken) {
    return c.json(
      { error: "ID client, secret et jeton de rafraîchissement sont requis." },
      400,
    );
  }
  // Un jeton d'application (« Application Token ») commence pareil mais ne
  // donne accès qu'aux API d'achat : l'utiliser mènerait à des 403 obscurs
  // sur toutes les routes vendeur.
  if (!refreshToken.startsWith("v^1.1")) {
    return c.json(
      {
        error:
          "Ce jeton ne ressemble pas à un jeton de rafraîchissement eBay (il commence par « v^1.1 »). Vérifiez que vous avez copié le refresh token, et non le jeton d'accès.",
      },
      400,
    );
  }

  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);

  const existing = await db
    .select({ id: shop.id })
    .from(shop)
    .where(and(eq(shop.platform, "ebay"), eq(shop.externalId, externalId)))
    .limit(1);
  const accountId = existing[0]?.id ?? randomId();
  const displayName =
    body.displayName?.trim() ||
    `eBay ${marketplaceId.replace("EBAY_", "")}${environment === "sandbox" ? " (bac à sable)" : ""}`;

  const credentials: Record<string, string> = {
    clientId,
    clientSecret,
    refreshToken,
    marketplaceId,
    environment,
  };

  await db
    .insert(shop)
    .values({
      id: accountId,
      platform: "ebay",
      externalId,
      displayName,
      slug: `ebay_${externalId.toLowerCase().replace(":", "_")}`,
      status: "connecting",
      config: "{}",
      connectedAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoUpdate({
      target: shop.id,
      set: { displayName, status: "connecting" },
    });

  await repos.credentials.put(accountId, credentials);

  // On éprouve les identifiants avant de déclarer le compte actif : un jeton
  // invalide laisserait sinon une boutique qui a l'air reliée et ne
  // synchronise rien.
  try {
    const mod = buildEngine(c.env);
    const account = await repos.accounts.get(accountId);
    if (!account) throw new Error("Compte introuvable après création");

    await mod.registry.get("ebay").testConnection({
      account: { ...account, enabled: true },
      credentials,
      saveCredentials: async (patch) => {
        Object.assign(credentials, patch);
        await repos.credentials.put(accountId, credentials);
      },
    });
  } catch (err) {
    await db.update(shop).set({ status: "error" }).where(eq(shop.id, accountId));
    return c.json(
      {
        error: `eBay a refusé la connexion : ${err instanceof Error ? err.message : String(err)}`,
        accountId,
      },
      400,
    );
  }

  await db.update(shop).set({ status: "active" }).where(eq(shop.id, accountId));
  await ensureSyncJobs(c.env, accountId);

  return c.json({ ok: true, account: { id: accountId, marketplace: "ebay", displayName } });
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
    environment: string;
    displayName: string;
  };

  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);

  try {
    const tokens = await ebayExchangeCode({
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      ruName: p.ruName,
      environment: p.environment,
      // eBay renvoie le code déjà encodé dans l'URL : Hono le décode, on le
      // transmet tel quel. Le ré-encoder produirait un code invalide.
      code,
    });

    const existing = await db
      .select({ id: shop.id })
      .from(shop)
      .where(
        and(
          eq(shop.platform, "ebay"),
          eq(
            shop.externalId,
            `${p.marketplaceId}${p.environment === "sandbox" ? ":sandbox" : ""}`,
          ),
        ),
      )
      .limit(1);
    const accountId = existing[0]?.id ?? randomId();
    const externalId = `${p.marketplaceId}${p.environment === "sandbox" ? ":sandbox" : ""}`;

    await db
      .insert(shop)
      .values({
        id: accountId,
        platform: "ebay",
        externalId,
        displayName: p.displayName,
        slug: `ebay_${externalId.toLowerCase().replace(":", "_")}`,
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
      environment: p.environment,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: String(tokens.accessExpiresAt),
      refreshTokenExpiresAt: String(tokens.refreshExpiresAt),
    });

    await ensureSyncJobs(c.env, accountId);
    return c.redirect("/shops?relie=ebay", 302);
  } catch (err) {
    // Ce commentaire promettait « conservé dans le journal » pendant que le
    // code écrivait dans la console. Maintenant, c'est vrai.
    const message = err instanceof Error ? err.message : String(err);
    await drizzle(c.env.DB).insert(eventLog).values({
      id: randomId(),
      at: Math.floor(Date.now() / 1000),
      level: "error",
      scope: "auth:ebay",
      shopId: null,
      message: "Connexion eBay refusée",
      data: JSON.stringify({ message: message.slice(0, 500) }),
    });
    return c.redirect(
      `/shops?erreur=ebay&detail=${encodeURIComponent(message.slice(0, 280))}`,
      302,
    );
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
  const current = { ...(await repos.credentials.get(id)) };

  const ctx = {
    account,
    credentials: current,
    saveCredentials: async (patch: Record<string, string>) => {
      Object.assign(current, patch);
      await repos.credentials.put(id, current);
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

  const current = { ...(await repos.credentials.get(id)) };
  const ctx = {
    account,
    credentials: current,
    saveCredentials: async (patch: Record<string, string>) => {
      Object.assign(current, patch);
      await repos.credentials.put(id, current);
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

/* ------------------------------------------------------------------ */
/* Etsy                                                                */
/* ------------------------------------------------------------------ */

/**
 * L'URL de retour, telle qu'Etsy l'exige.
 *
 * Etsy compare cette valeur CARACTÈRE POUR CARACTÈRE avec celle déclarée
 * dans les réglages de l'application. Une barre oblique finale en trop, ou
 * http au lieu de https, et l'échange de code est refusé avec un message qui
 * ne dit pas lequel des deux ne correspond pas.
 */
function etsyRedirectUri(env: Env): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/api/engine/accounts/etsy/callback`;
}

accounts.post("/etsy/start", async (c) => {
  const body = await c.req
    .json<{ clientId?: string; sharedSecret?: string; displayName?: string }>()
    .catch(() => ({}) as Record<string, string>);

  const clientId = (body.clientId ?? "").trim();
  const sharedSecret = (body.sharedSecret ?? "").trim();

  if (!clientId) {
    return c.json(
      {
        error:
          "La keystring est requise. Elle se trouve dans « Your Apps » sur le portail développeur Etsy.",
      },
      400,
    );
  }
  // Obligatoire depuis le 9 février 2026 : sans lui, l'autorisation réussit
  // puis CHAQUE appel d'API échoue en 403 — le pire des deux mondes.
  if (!sharedSecret) {
    return c.json(
      {
        error:
          "Le secret partagé (shared secret) est requis : Etsy l'exige sur chaque appel depuis février 2026. Il est affiché sous « See API Key Details », à côté de la keystring.",
      },
      400,
    );
  }

  // PKCE : le vérificateur est produit maintenant et doit survivre jusqu'au
  // retour d'Etsy. Il est rangé avec l'état, dans le même enregistrement à
  // usage unique — sans lui, l'échange de code est irrémédiablement perdu et
  // il faut recommencer tout le parcours.
  const { verifier, challenge } = await etsyPkce();
  const state = randomId(24);

  await c.env.CACHE.put(
    `etsy:${state}`,
    JSON.stringify({
      clientId,
      sharedSecret,
      verifier,
      displayName: body.displayName ?? "Etsy",
    }),
    { expirationTtl: 600 },
  );

  return c.json({
    url: etsyConsentUrl({
      clientId,
      redirectUri: etsyRedirectUri(c.env),
      state,
      codeChallenge: challenge,
    }),
    redirectUri: etsyRedirectUri(c.env),
  });
});

accounts.get("/etsy/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.redirect("/shops?erreur=parametres", 302);

  const pending = await c.env.CACHE.get(`etsy:${state}`);
  if (!pending) return c.redirect("/shops?erreur=expire", 302);
  await c.env.CACHE.delete(`etsy:${state}`); // usage unique

  const p = JSON.parse(pending) as {
    clientId: string;
    sharedSecret?: string;
    verifier: string;
    displayName: string;
  };

  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);

  try {
    const tokens = await etsyExchangeCode({
      clientId: p.clientId,
      redirectUri: etsyRedirectUri(c.env),
      code,
      codeVerifier: p.verifier,
    });

    // Le compte relié peut ne pas avoir de boutique — Etsy distingue un
    // acheteur d'un vendeur. Mieux vaut l'apprendre ici, avant d'enregistrer
    // une boutique qui ne synchroniserait jamais rien.
    const shopInfo = await etsyFindShop({
      clientId: p.clientId,
      sharedSecret: p.sharedSecret,
      accessToken: tokens.accessToken,
      userId: tokens.userId,
    });

    const existing = await db
      .select({ id: shop.id })
      .from(shop)
      .where(and(eq(shop.platform, "etsy"), eq(shop.externalId, shopInfo.shopId)))
      .limit(1);
    const accountId = existing[0]?.id ?? randomId();
    const displayName = p.displayName?.trim() || shopInfo.shopName;

    await db
      .insert(shop)
      .values({
        id: accountId,
        platform: "etsy",
        externalId: shopInfo.shopId,
        displayName,
        slug: `etsy_${shopInfo.shopId}`,
        status: "active",
        config: "{}",
        connectedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: shop.id,
        set: { displayName, status: "active" },
      });

    await repos.credentials.put(accountId, {
      clientId: p.clientId,
      ...(p.sharedSecret ? { clientSecret: p.sharedSecret } : {}),
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: String(tokens.expiresAt),
      // Le jeton de rafraîchissement Etsy vit 90 jours à compter de MAINTENANT.
      // La date est conservée pour pouvoir alerter avant l'échéance : passé le
      // délai, seul un nouveau passage par le navigateur peut débloquer.
      refreshTokenObtainedAt: String(Math.floor(Date.now() / 1000)),
      shopId: shopInfo.shopId,
      currency: shopInfo.currency,
    });

    await ensureSyncJobs(c.env, accountId);
    return c.redirect("/shops?relie=etsy", 302);
  } catch (err) {
    /*
     * L'adaptateur produit des messages qui NOMMENT la cause — identifiants
     * refusés avec la réponse d'Etsy, compte sans boutique, application non
     * validée. Les laisser dans la console transformait chaque échec en
     * devinette : le bandeau récitait des hypothèses pendant que la réponse
     * exacte dormait dans un journal que personne ne lit.
     */
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(eventLog).values({
      id: randomId(),
      at: Math.floor(Date.now() / 1000),
      level: "error",
      scope: "auth:etsy",
      shopId: null,
      message: "Connexion Etsy refusée",
      data: JSON.stringify({ message: message.slice(0, 500) }),
    });
    return c.redirect(
      `/shops?erreur=etsy&detail=${encodeURIComponent(message.slice(0, 280))}`,
      302,
    );
  }
});

/**
 * Complète une boutique Etsy avec ce qu'exige la création d'annonces.
 *
 * Ces trois valeurs décrivent la BOUTIQUE, pas un article : Etsy les impose
 * sur tout objet physique et ne les devine pas. Tant qu'elles manquent,
 * l'adaptateur annonce `listingCreate: false` et le reste fonctionne — la
 * lecture, le stock, les prix, les ventes.
 */
accounts.post("/:id/etsy/profils", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{
      shippingProfileId?: string;
      readinessStateId?: string;
      taxonomyId?: string;
      webhookSecret?: string;
    }>()
    .catch(() => ({}) as Record<string, string>);

  const patch: Record<string, string> = {};
  for (const k of [
    "shippingProfileId",
    "readinessStateId",
    "taxonomyId",
    // Donné par le portail Webhooks d'Etsy à la création du point d'entrée,
    // sous la forme « whsec_… ». Sans lui, aucune notification n'est acceptée.
    "webhookSecret",
  ] as const) {
    const v = (body[k] ?? "").trim();
    if (v) patch[k] = v;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "Aucune valeur fournie" }, 400);
  }

  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);
  const current = (await repos.credentials.get(id)) ?? {};
  // Fusion et non remplacement : la keystring et les jetons doivent survivre.
  await repos.credentials.put(id, { ...current, ...patch });

  return c.json({ ok: true, renseignes: Object.keys(patch) });
});

/**
 * Supprime une boutique et tout ce qui n'a de sens que par elle.
 *
 * POURQUOI CETTE ROUTE EXISTE : une connexion ratée laisse une boutique en
 * erreur, avec un jeton chiffré inutilisable, qui reste indéfiniment dans la
 * liste. « Mettre en pause » ne l'enlève pas — c'est fait pour une boutique
 * saine qu'on veut suspendre. Il fallait pouvoir effacer.
 *
 * CE QUI EST EFFACÉ : le jeton, les annonces, les commandes et leurs lignes,
 * les tâches de synchronisation, les ventes constatées, le journal des
 * commandes, les accusés de webhook et les événements de cette boutique.
 *
 * CE QUI SURVIT : les produits maîtres et le stock central. Ils sont partagés
 * entre plateformes — les supprimer avec une boutique effacerait le stock
 * d'articles encore en vente ailleurs. La réponse indique combien de produits
 * se retrouvent sans aucune annonce, pour que le ménage reste un choix.
 *
 * L'ordre des suppressions suit les clés étrangères : les lignes de commande
 * avant les commandes, tout le reste avant la boutique elle-même. Le tout en
 * un seul lot, donc en une seule transaction : une suppression à moitié faite
 * laisserait des lignes orphelines impossibles à retrouver depuis l'interface.
 */
accounts.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const existe = await drizzle(c.env.DB)
    .select({ id: shop.id, nom: shop.displayName, plateforme: shop.platform })
    .from(shop)
    .where(eq(shop.id, id))
    .limit(1);
  const cible = existe[0];
  if (!cible) return c.json({ error: "Boutique inconnue" }, 404);

  const db = drizzle(c.env.DB);

  const commandes = await db
    .select({ id: order.id })
    .from(order)
    .where(eq(order.shopId, id));
  const idsCommandes = commandes.map((o) => o.id);

  const lot = [
    ...(idsCommandes.length > 0
      ? [db.delete(orderLine).where(inArray(orderLine.orderId, idsCommandes))]
      : []),
    db.delete(order).where(eq(order.shopId, id)),
    db.delete(listing).where(eq(listing.shopId, id)),
    db.delete(syncJob).where(eq(syncJob.shopId, id)),
    db.delete(oauthToken).where(eq(oauthToken.shopId, id)),
    db.delete(salesEvent).where(eq(salesEvent.accountId, id)),
    db.delete(commandLog).where(eq(commandLog.accountId, id)),
    db.delete(webhookReceipt).where(eq(webhookReceipt.shopId, id)),
    db.delete(eventLog).where(eq(eventLog.shopId, id)),
    db.delete(shop).where(eq(shop.id, id)),
  ];
  await db.batch(lot as never);

  // Produits devenus orphelins : signalés, jamais supprimés d'office.
  const orphelins = await c.env.DB.prepare(
    "SELECT count(*) AS n FROM product WHERE id NOT IN (SELECT product_id FROM listing WHERE product_id IS NOT NULL)",
  ).first<{ n: number }>();

  await db.insert(eventLog).values({
    id: randomId(),
    at: Math.floor(Date.now() / 1000),
    level: "warn",
    scope: "compte",
    shopId: null,
    message: `Boutique supprimée : ${cible.nom} (${cible.plateforme})`,
    data: JSON.stringify({ commandes: idsCommandes.length }),
  });

  return c.json({
    ok: true,
    supprime: cible.nom,
    commandes: idsCommandes.length,
    produitsSansAnnonce: orphelins?.n ?? 0,
  });
});

/**
 * Active le temps réel sur une boutique.
 *
 * ACTION SORTANTE : cette route écrit dans les réglages de la boutique
 * distante — elle y crée des abonnements aux webhooks. C'est pour cela
 * qu'elle est déclenchée par un clic explicite et jamais automatiquement à la
 * connexion : personne ne devrait découvrir après coup que son compte
 * marchand a été modifié.
 *
 * Rien n'est supprimé chez la plateforme. Un abonnement déjà présent est
 * laissé tel quel, et un abonnement pointant ailleurs — appartenant peut-être
 * à une autre application installée sur la même boutique — n'est pas touché.
 *
 * Une fois les abonnements en place, le relevé périodique se relâche de deux
 * minutes à quinze : il n'est plus la voie principale mais le filet, pour le
 * jour où un webhook se perd ou qu'un abonnement est désactivé.
 */
accounts.post("/:id/temps-reel", async (c) => {
  const id = c.req.param("id");
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);
  const account = await repos.accounts.get(id);
  if (!account) return c.json({ error: "Boutique inconnue" }, 404);

  if (account.marketplace !== "shopify") {
    return c.json(
      {
        error:
          account.marketplace === "etsy"
            ? "Etsy ne permet pas de créer un abonnement par l'API : il se crée dans le portail Webhooks d'Etsy, puis son secret se colle ici."
            : `${account.marketplace} n'expose pas d'abonnement aux webhooks. Le relevé reste la voie, toutes les deux minutes.`,
      },
      400,
    );
  }

  const credentials = { ...(await repos.credentials.get(id)) };
  const mod = buildEngine(c.env);
  const adaptateur = mod.registry.get("shopify") as ShopifyAdapter;

  const rappel = `${c.env.APP_URL.replace(/\/+$/, "")}/api/webhooks/shopify`;

  try {
    const rapport = await shopifyEnsureWebhooks(
      adaptateur,
      {
        account,
        credentials,
        http: mod.httpFor(account),
        saveCredentials: async (patch) => {
          Object.assign(credentials, patch);
          await repos.credentials.put(id, credentials);
        },
      },
      rappel,
    );

    const poses = rapport.crees.length + rapport.dejaLa.length;
    if (poses > 0) {
      const frais = await repos.credentials.get(id);
      await repos.credentials.put(id, { ...frais, webhooksActifs: "1" });
      // Recalcule les cadences : le relevé devient un filet.
      await ensureSyncJobs(c.env, id);
    }

    return c.json({
      ok: rapport.echecs.length === 0,
      rappel,
      crees: rapport.crees,
      dejaLa: rapport.dejaLa,
      echecs: rapport.echecs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        error: /access denied|scope/i.test(message)
          ? "Shopify refuse : l'application n'a pas la portée « write_webhooks ». Ajoutez-la dans le Dev Dashboard, réinstallez l'app, puis réessayez."
          : message,
      },
      400,
    );
  }
});
