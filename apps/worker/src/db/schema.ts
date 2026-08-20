import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/* ------------------------------------------------------------------ */
/* Authentification — un seul utilisateur, mais modélisé proprement    */
/* ------------------------------------------------------------------ */

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  /** Identifiant de connexion, ex. « MXB_Market-hub ». Comparé sans casse. */
  username: text("username").notNull().unique(),
  /** Nom affiché dans l'interface. */
  displayName: text("display_name").notNull(),
  email: text("email"),

  /* --- Mot de passe : PBKDF2-HMAC-SHA256, voir lib/password.ts --- */
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  /**
   * Stocké par utilisateur, et non en constante : permet d'augmenter le
   * coût du hachage plus tard sans invalider les comptes existants.
   */
  passwordIterations: integer("password_iterations").notNull(),
  passwordChangedAt: integer("password_changed_at"),

  createdAt: integer("created_at").notNull(),
  lastLoginAt: integer("last_login_at"),
});

/** Clés d'accès WebAuthn (Face ID / Touch ID / Windows Hello). Pas de mot de passe. */
export const passkey = sqliteTable(
  "passkey",
  {
    id: text("id").primaryKey(), // credentialID, base64url
    userId: text("user_id").notNull().references(() => user.id),
    publicKey: text("public_key").notNull(), // base64url, COSE
    counter: integer("counter").notNull().default(0),
    transports: text("transports"), // JSON
    label: text("label"), // "iPhone de Maxime"
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [index("passkey_user_idx").on(t.userId)],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("session_expires_idx").on(t.expiresAt)],
);

/* ------------------------------------------------------------------ */
/* Boutiques connectées et secrets OAuth                               */
/* ------------------------------------------------------------------ */

export const shop = sqliteTable(
  "shop",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(), // shopify | etsy | ebay | alibaba
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"),
    /** Réglages propres à la plateforme (région eBay, version d'API...). JSON. */
    config: text("config").notNull().default("{}"),
    connectedAt: integer("connected_at").notNull(),
  },
  (t) => [uniqueIndex("shop_platform_ext_idx").on(t.platform, t.externalId)],
);

/**
 * Jetons OAuth. Le contenu est CHIFFRÉ (AES-GCM 256) avant d'atteindre cette table :
 * une fuite de la base seule ne donne accès à aucune boutique.
 * Voir apps/worker/src/lib/crypto.ts
 */
export const oauthToken = sqliteTable(
  "oauth_token",
  {
    shopId: text("shop_id").primaryKey().references(() => shop.id),
    /** base64(iv) + ":" + base64(chiffré) — contient {accessToken, refreshToken, scope}. */
    ciphertext: text("ciphertext").notNull(),
    /** Version de la clé maître, pour permettre une rotation sans interruption. */
    keyVersion: integer("key_version").notNull().default(1),
    accessExpiresAt: integer("access_expires_at"),
    /** Etsy : 90 jours. Passé ce délai sans usage, il faut TOUT réautoriser à la main. */
    refreshExpiresAt: integer("refresh_expires_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("token_access_exp_idx").on(t.accessExpiresAt)],
);

/* ------------------------------------------------------------------ */
/* Catalogue unifié                                                    */
/* ------------------------------------------------------------------ */

/** Le produit « maître », indépendant des plateformes. Clé de rapprochement : le SKU. */
export const product = sqliteTable(
  "product",
  {
    id: text("id").primaryKey(),
    sku: text("sku").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    costPrice: integer("cost_price"), // centimes, prix d'achat (Alibaba)
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("product_sku_idx").on(t.sku)],
);

/** La présence d'un produit sur une boutique donnée. C'est ici que vit le vrai état. */
export const listing = sqliteTable(
  "listing",
  {
    id: text("id").primaryKey(),
    shopId: text("shop_id").notNull().references(() => shop.id),
    productId: text("product_id").references(() => product.id),
    externalId: text("external_id").notNull(),
    sku: text("sku"),
    title: text("title").notNull(),
    priceAmount: integer("price_amount").notNull(),
    priceCurrency: text("price_currency").notNull(),
    quantity: integer("quantity").notNull().default(0),
    status: text("status").notNull(),
    url: text("url"),
    imageUrl: text("image_url"),
    /**
     * Empreinte SHA-256 du payload normalisé.
     * Sert à n'écrire QUE ce qui a réellement changé : c'est ce qui garde
     * la consommation sous les 100 000 lignes écrites/jour de D1.
     */
    contentHash: text("content_hash").notNull(),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [
    uniqueIndex("listing_shop_ext_idx").on(t.shopId, t.externalId),
    index("listing_sku_idx").on(t.sku),
    index("listing_product_idx").on(t.productId),
  ],
);

/* ------------------------------------------------------------------ */
/* Commandes                                                           */
/* ------------------------------------------------------------------ */

export const order = sqliteTable(
  "order",
  {
    id: text("id").primaryKey(),
    shopId: text("shop_id").notNull().references(() => shop.id),
    externalId: text("external_id").notNull(),
    status: text("status").notNull(),
    totalAmount: integer("total_amount").notNull(),
    totalCurrency: text("total_currency").notNull(),
    buyerName: text("buyer_name"),
    placedAt: integer("placed_at").notNull(),
    contentHash: text("content_hash").notNull(),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [
    uniqueIndex("order_shop_ext_idx").on(t.shopId, t.externalId),
    index("order_placed_idx").on(t.placedAt),
    index("order_status_idx").on(t.status),
  ],
);

export const orderLine = sqliteTable(
  "order_line",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => order.id),
    sku: text("sku"),
    listingExternalId: text("listing_external_id"),
    title: text("title").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceAmount: integer("unit_price_amount").notNull(),
    unitPriceCurrency: text("unit_price_currency").notNull(),
  },
  (t) => [index("order_line_order_idx").on(t.orderId)],
);

/* ------------------------------------------------------------------ */
/* Orchestration de la synchronisation                                 */
/* ------------------------------------------------------------------ */

/**
 * Une ligne par (boutique, ressource). C'est l'état que le cron consulte
 * pour décider quoi empiler. Aucune logique de planification ailleurs.
 */
export const syncJob = sqliteTable(
  "sync_job",
  {
    id: text("id").primaryKey(),
    shopId: text("shop_id").notNull().references(() => shop.id),
    resource: text("resource").notNull(), // orders | listings | inventory
    /** Intervalle souhaité, en secondes. */
    intervalSec: integer("interval_sec").notNull().default(600),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunAt: integer("last_run_at"),
    lastOkAt: integer("last_ok_at"),
    cursor: text("cursor"),
    /** Repli exponentiel après échec : 0 = sain. */
    failureCount: integer("failure_count").notNull().default(0),
    lastError: text("last_error"),
    enabled: integer("enabled").notNull().default(1),
  },
  (t) => [
    uniqueIndex("sync_job_shop_res_idx").on(t.shopId, t.resource),
    index("sync_job_due_idx").on(t.enabled, t.nextRunAt),
  ],
);

/** Idempotence des webhooks : une plateforme peut livrer deux fois le même événement. */
export const webhookReceipt = sqliteTable(
  "webhook_receipt",
  {
    /** Hash(plateforme + identifiant d'événement fourni par la plateforme). */
    id: text("id").primaryKey(),
    shopId: text("shop_id").notNull(),
    topic: text("topic").notNull(),
    receivedAt: integer("received_at").notNull(),
  },
  (t) => [index("webhook_received_idx").on(t.receivedAt)],
);

/** Journal append-only : le seul endroit où comprendre ce qui s'est passé à 3 h du matin. */
export const eventLog = sqliteTable(
  "event_log",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    level: text("level").notNull(), // debug | info | warn | error
    scope: text("scope").notNull(), // "sync:etsy", "webhook:shopify", "auth"
    shopId: text("shop_id"),
    message: text("message").notNull(),
    data: text("data"), // JSON
  },
  (t) => [index("event_at_idx").on(t.at), index("event_level_idx").on(t.level)],
);

/* ------------------------------------------------------------------ */
/* Notifications push                                                  */
/* ------------------------------------------------------------------ */

export const pushSubscription = sqliteTable(
  "push_subscription",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull(),
    /** Nettoyé automatiquement quand le service de push renvoie 404/410. */
    failedAt: integer("failed_at"),
  },
  (t) => [index("push_user_idx").on(t.userId)],
);

/** Règles d'alerte : « stock < 3 », « commande > 200 € », « aucune vente depuis 48 h ». */
export const alertRule = sqliteTable("alert_rule", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // low_stock | new_order | big_order | sync_failure | no_sales
  /** Paramètres de la règle. JSON, validé par un schéma zod côté worker. */
  params: text("params").notNull().default("{}"),
  shopId: text("shop_id"), // null = toutes les boutiques
  enabled: integer("enabled").notNull().default(1),
  /** Anti-spam : pas deux fois la même alerte dans cette fenêtre. */
  cooldownSec: integer("cooldown_sec").notNull().default(3600),
  lastFiredAt: integer("last_fired_at"),
});
