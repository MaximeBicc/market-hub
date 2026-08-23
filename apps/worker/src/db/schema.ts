import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  primaryKey,
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
    platform: text("platform").notNull(), // shopify | etsy | ebay | allegro | tiktok_shop | vinted
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    /** Identifiant lisible, ex. « ebay_electronique ». Sert aux journaux et à l'URL. */
    slug: text("slug"),
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
    costPrice: integer("cost_price"), // centimes, prix d'achat fournisseur
    /** Prix de vente de référence, dont héritent les annonces créées. */
    priceAmount: integer("price_amount").notNull().default(0),
    priceCurrency: text("price_currency").notNull().default("EUR"),
    /** Stock de référence à la création d'une annonce. Le stock VIVANT est dans `inventory`. */
    stock: integer("stock").notNull().default(0),
    minAlert: integer("min_alert").notNull().default(3),
    /** Emplacement physique en atelier / entrepôt (ex. « Étagère A2 »). */
    location: text("location"),
    /** Poids unitaire en grammes pour le calcul d'affranchissement. */
    weightGrams: integer("weight_grams"),
    /**
     * Déclarations exigées à la création d'une annonce.
     *
     * `condition` : eBay déclasse une annonce dont l'état ne correspond pas à
     * sa catégorie. `whoMade`/`whenMade` : Etsy suspend une boutique qui
     * déclare « fait main par le vendeur » sur de la revente. Nullables — un
     * produit importé n'en a pas — et leur absence bloque la publication.
     */
    condition: text("condition"),
    whoMade: text("who_made"),
    whenMade: text("when_made"),
    /** Les axes de variation : [{name, values[]}]. Vide = pas de déclinaison. */
    options: text("options").notNull().default("[]"),
    variantCount: integer("variant_count").notNull().default(1),
    /** Format d'emballage / consommable recommandé par défaut. */
    defaultConsumableId: text("default_consumable_id"),
    /** Couleur(s) du produit (ex. « Noir », « Doré », « Bleu nuit / Argent »). */
    color: text("color"),
    /** Matière / Matériau de confection (ex. « Céramique émaillée », « Coton bio »). */
    material: text("material"),
    images: text("images"), // JSON: string[]
    tags: text("tags"), // JSON: string[]
    marketplaceData: text("marketplace_data"), // JSON, champs propres à une plateforme
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
    /** L'unité vendable visée. Null tant que le rapprochement n'a pas eu lieu. */
    variantId: text("variant_id").references(() => variant.id),
    /** Le parent chez la plateforme. */
    groupId: text("group_id").references(() => listingGroup.id),
    /** Ce que la plateforme dit des déclinaisons de cette unité. JSON. */
    optionValues: text("option_values"),
    /** Champs propres à la plateforme (offerId eBay, variantId Shopify...). JSON. */
    marketplaceData: text("marketplace_data"),
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
    index("listing_variant_idx").on(t.variantId),
    index("listing_group_idx").on(t.groupId),
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
    shippingCarrier: text("shipping_carrier"),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    /** URL ou payload de l'étiquette d'expédition (PDF ou image). */
    shippingLabelUrl: text("shipping_label_url"),
    /** Origine de l'étiquette : 'scraped' (récupérée de la marketplace) | 'uploaded' (fournie par l'utilisateur) | 'generated'. */
    shippingLabelType: text("shipping_label_type"),
    placedAt: integer("placed_at").notNull(),
    shippedAt: integer("shipped_at"),
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
/* Consommables d'emballage & préparation de commande                  */
/* ------------------------------------------------------------------ */

export const consumable = sqliteTable("consumable", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(), // envelope | box | card | label | protection | other
  stock: integer("stock").notNull().default(0),
  minAlert: integer("min_alert").notNull().default(5),
  unitCost: integer("unit_cost").default(0),
  imageUrl: text("image_url"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const orderConsumable = sqliteTable(
  "order_consumable",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => order.id),
    consumableId: text("consumable_id").notNull().references(() => consumable.id),
    quantity: integer("quantity").notNull().default(1),
    usedAt: integer("used_at").notNull(),
  },
  (t) => [index("order_consumable_order_idx").on(t.orderId)],
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

/* ------------------------------------------------------------------ */
/* Moteur multi-marketplace                                            */
/* ------------------------------------------------------------------ */

/**
 * Stock central, source de vérité unique.
 *
 * `reserved` couvre le laps entre vente constatée et expédition : la
 * marchandise est encore physiquement là mais n'est plus vendable.
 * `version` porte le verrouillage optimiste — deux ventes simultanées sur
 * deux plateformes ne doivent pas se perdre l'une l'autre.
 */
/**
 * Une unité réellement vendable : un coloris, une taille.
 *
 * Le SKU est NULLABLE, et c'est le fait central : la majorité des variantes
 * lues chez Shopify n'en ont pas, et Shopify n'en impose pas. `optionKey` —
 * « couleur=violet », normalisé — sert alors d'identité de repli, sans quoi
 * une variante serait recréée à chaque passage de synchronisation.
 */
export const variant = sqliteTable(
  "variant",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull().references(() => product.id),
    sku: text("sku"),
    optionKey: text("option_key").notNull().default(""),
    optionValues: text("option_values").notNull().default("[]"), // JSON: string[]
    priceAmount: integer("price_amount").notNull().default(0),
    priceCurrency: text("price_currency").notNull().default("EUR"),
    barcode: text("barcode"),
    weightGrams: integer("weight_grams"),
    imageUrl: text("image_url"),
    position: integer("position").notNull().default(0),
    /** `archived` : la plateforme ne la renvoie plus. Son stock cesse de compter. */
    status: text("status").notNull().default("active"),
    marketplaceData: text("marketplace_data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("variant_product_optkey_idx").on(t.productId, t.optionKey),
    index("variant_product_idx").on(t.productId),
  ],
);

/**
 * L'objet PARENT chez la plateforme : produit Shopify, inventory_item_group
 * eBay, annonce Etsy. Il existe parce que le statut, l'URL et la catégorie y
 * vivent — pas sur la variante. Chez Etsy c'est structurant : une annonce a UN
 * état, et « désactiver le coloris violet » n'existe pas.
 */
export const listingGroup = sqliteTable(
  "listing_group",
  {
    id: text("id").primaryKey(),
    shopId: text("shop_id").notNull().references(() => shop.id),
    productId: text("product_id").references(() => product.id),
    remoteGroupId: text("remote_group_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    url: text("url"),
    imageUrl: text("image_url"),
    publishedAxes: text("published_axes").notNull().default("[]"),
    marketplaceData: text("marketplace_data").notNull().default("{}"),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => [
    uniqueIndex("listing_group_shop_remote_idx").on(t.shopId, t.remoteGroupId),
    index("listing_group_product_idx").on(t.productId),
  ],
);

/**
 * Stock central, compté PAR VARIANTE.
 *
 * Deux coloris du même produit ont des quantités indépendantes, et refléter ce
 * nombre est tout l'objet de l'outil. Une somme au niveau du produit ne se
 * repousserait pas : « mettre le stock à 12 » n'a aucun sens pour un parent à
 * dix-sept coloris.
 */
export const inventory = sqliteTable("inventory", {
  variantId: text("variant_id").primaryKey().references(() => variant.id),
  onHand: integer("on_hand").notNull().default(0),
  reserved: integer("reserved").notNull().default(0),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Déduplication des ventes entrantes.
 * Les plateformes garantissent « au moins une fois », jamais « exactement
 * une fois » : sans cette table, une vente livrée deux fois décrémenterait
 * le stock deux fois.
 */
export const salesEvent = sqliteTable(
  "sales_event",
  {
    id: text("id").primaryKey(), // hash(account_id + event_id)
    accountId: text("account_id").notNull(),
    eventId: text("event_id").notNull(),
    marketplace: text("marketplace").notNull(),
    remoteOrderId: text("remote_order_id").notNull(),
    kind: text("kind").notNull(), // paid | cancelled | returned
    occurredAt: text("occurred_at").notNull(),
    receivedAt: integer("received_at").notNull(),
    /** Lignes vendues qu'on n'a pas su rattacher à un produit. */
    unmatchedLines: integer("unmatched_lines").notNull().default(0),
  },
  (t) => [
    uniqueIndex("sales_event_account_evt_idx").on(t.accountId, t.eventId),
    index("sales_event_received_idx").on(t.receivedAt),
  ],
);

/**
 * Journal des commandes de l'orchestrateur, une ligne par cible.
 *
 * Sans trace, une commande partie vers cinq plateformes devient indébogable :
 * on ne sait plus laquelle a réussi, laquelle demande une action manuelle,
 * laquelle a échoué et pourquoi.
 */
export const commandLog = sqliteTable(
  "command_log",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    command: text("command").notNull(),
    productId: text("product_id"),
    accountId: text("account_id").notNull(),
    marketplace: text("marketplace").notNull(),
    status: text("status").notNull(),
    message: text("message"),
    remoteId: text("remote_id"),
    at: integer("at").notNull(),
  },
  (t) => [
    index("command_log_at_idx").on(t.at),
    index("command_log_key_idx").on(t.idempotencyKey),
  ],
);

/* ------------------------------------------------------------------ */
/* Panel d'IA                                                          */
/* ------------------------------------------------------------------ */

/**
 * Consommation quotidienne par modèle.
 *
 * `neurons` est la colonne qui rend le « zéro euro » vérifiable plutôt que
 * déclaratif : Cloudflare offre 10 000 neurones par jour, et sans compteur on
 * ne sait ni ce qu'il en reste, ni qu'une comparaison d'images en coûte dix
 * fois plus qu'une classification.
 */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    /** AAAA-MM-JJ UTC — la journée telle que Cloudflare la remet à zéro. */
    day: text("day").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Fractionnaire : Workers AI facture 7,0213 neurones, pas 7. */
    neurons: real("neurons").notNull().default(0),
    searchRequests: integer("search_requests").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.provider, t.model] })],
);

/** Cache des résultats de skills. En base et non en KV : voir migration 0003. */
export const aiCache = sqliteTable(
  "ai_cache",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("ai_cache_expires_idx").on(t.expiresAt)],
);

/** Une ligne par analyse réellement calculée. Le cache n'en crée aucune. */
export const aiRun = sqliteTable(
  "ai_run",
  {
    id: text("id").primaryKey(),
    skill: text("skill").notNull(),
    skillVersion: text("skill_version").notNull(),
    status: text("status").notNull(), // running | success | failed
    dataClass: text("data_class").notNull(),
    impact: text("impact").notNull(),
    automatic: integer("automatic").notNull().default(0),
    inputHash: text("input_hash").notNull(),
    provider: text("provider"),
    model: text("model"),
    confidence: real("confidence"),
    neurons: real("neurons").notNull().default(0),
    sourceCount: integer("source_count").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("ai_run_started_idx").on(t.startedAt),
    index("ai_run_skill_idx").on(t.skill, t.startedAt),
  ],
);

/** D'où vient un prix montré à l'utilisateur. Sans URL ni date, il ne s'affiche pas. */
export const aiEvidence = sqliteTable(
  "ai_evidence",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => aiRun.id),
    url: text("url").notNull(),
    title: text("title"),
    kind: text("kind").notNull(),
    observedAt: text("observed_at").notNull(),
    snippet: text("snippet"),
    price: integer("price"), // centimes
    currency: text("currency"),
    reliability: real("reliability"),
  },
  (t) => [index("ai_evidence_run_idx").on(t.runId)],
);

/** Analyses différées, empilées dans la file existante. */
export const aiJob = sqliteTable(
  "ai_job",
  {
    id: text("id").primaryKey(),
    skill: text("skill").notNull(),
    status: text("status").notNull(), // queued | running | success | failed
    automatic: integer("automatic").notNull().default(0),
    input: text("input").notNull(), // JSON
    result: text("result"), // JSON
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("ai_job_status_idx").on(t.status, t.createdAt)],
);

/**
 * Retour de l'utilisateur sur une analyse.
 * Seule mesure de qualité qui ne vienne pas du modèle lui-même.
 */
export const aiFeedback = sqliteTable(
  "ai_feedback",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => aiRun.id),
    verdict: text("verdict").notNull(), // utile | partiel | inutile
    reason: text("reason"),
    at: integer("at").notNull(),
  },
  (t) => [index("ai_feedback_run_idx").on(t.runId)],
);
