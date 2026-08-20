/**
 * Modèle de domaine unifié.
 *
 * Règle d'or : rien au-dessus de cette couche ne connaît eBay, Etsy, Shopify ou
 * Alibaba. Les connecteurs traduisent vers ces types, et seulement vers eux.
 * Ajouter une 5e place de marché ne doit toucher aucun fichier hors connectors/.
 */

export const PLATFORMS = ["shopify", "etsy", "ebay", "alibaba"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Montants en entiers (centimes) : jamais de float pour de l'argent. */
export interface Money {
  /** Valeur en plus petite unité monétaire (centimes pour EUR/USD). */
  amount: number;
  /** Code ISO 4217. */
  currency: string;
}

export interface Shop {
  id: string;
  platform: Platform;
  /** Identifiant chez la plateforme (shop domain, shop_id Etsy, marketplace eBay...). */
  externalId: string;
  displayName: string;
  status: "active" | "reauth_required" | "paused" | "error";
  connectedAt: number;
}

export interface UnifiedListing {
  /** Identifiant de l'annonce chez la plateforme. */
  externalId: string;
  sku: string | null;
  title: string;
  price: Money;
  quantity: number;
  status: "active" | "draft" | "sold_out" | "ended";
  url: string | null;
  imageUrl: string | null;
  updatedAt: number;
}

export type OrderStatus =
  | "pending"
  | "paid"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded";

export interface UnifiedOrderLine {
  sku: string | null;
  listingExternalId: string | null;
  title: string;
  quantity: number;
  unitPrice: Money;
}

export interface UnifiedOrder {
  externalId: string;
  status: OrderStatus;
  total: Money;
  buyerName: string | null;
  placedAt: number;
  lines: UnifiedOrderLine[];
  /** Charge utile brute, conservée pour rejouer un mapping sans re-télécharger. */
  raw: unknown;
}

/** Pagination opaque : chaque connecteur encode ce qu'il veut dedans. */
export interface Page<T> {
  items: T[];
  /** `null` = fin de la pagination. */
  nextCursor: string | null;
}

export type SyncResource = "orders" | "listings" | "inventory";

/** Une unité de travail = un message de Queue. Doit tenir dans ~10 sous-requêtes. */
export interface SyncTask {
  kind: "sync";
  shopId: string;
  resource: SyncResource;
  cursor: string | null;
  /** Numéro de page, borné, pour éviter une pagination infinie sur données corrompues. */
  depth: number;
}

export interface WebhookTask {
  kind: "webhook";
  shopId: string;
  topic: string;
  /** Corps brut déjà vérifié par HMAC au moment de la réception. */
  payload: string;
}

export interface WriteTask {
  kind: "write";
  shopId: string;
  op: "update_stock" | "update_price";
  listingExternalId: string;
  value: number;
}

/**
 * Analyse différée par le panel d'IA.
 *
 * Le message ne transporte QUE l'identifiant du travail. Tout le reste — la
 * skill, ses paramètres — est relu en base au moment de l'exécution : un
 * message de file peut être livré deux fois et rejoué plusieurs minutes plus
 * tard, et une charge utile figée finirait par contredire l'état réel.
 */
export interface AiTask {
  kind: "ai";
  jobId: string;
}

export type QueueTask = SyncTask | WebhookTask | WriteTask | AiTask;

/** Erreur métier qui distingue « réessayable » de « définitivement cassé ». */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limited" | "auth_expired" | "transient" | "permanent",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
