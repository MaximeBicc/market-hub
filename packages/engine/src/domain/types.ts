/**
 * Modèle canonique multi-marketplace.
 *
 * Repris du paquet `@variety/marketplace-engine` v0.1, qui posait déjà les
 * bonnes abstractions. Rien au-dessus de cette couche ne connaît eBay, Etsy,
 * Vinted ou TikTok : les adaptateurs traduisent vers ces types, et seulement
 * vers eux.
 */

export const MARKETPLACES = [
  "shopify",
  "etsy",
  "ebay",
  "allegro",
  "tiktok_shop",
  "vinted",
  "mock",
] as const;

export type MarketplaceId = (typeof MARKETPLACES)[number] | (string & {});

export type AccountId = string;
export type ProductId = string;
export type ListingId = string;

/** Montants en entiers (centimes) : jamais de flottant pour de l'argent. */
export type Money = { amount: number; currency: string };

/**
 * Un COMPTE sur une marketplace, pas une marketplace.
 *
 * La distinction est structurante : on peut tenir deux boutiques eBay
 * (`ebay_electronique`, `ebay_vintage`) avec des identifiants et des règles
 * différentes. Le `slug` est lisible par un humain et sert dans les journaux ;
 * l'`id` est immuable et ne doit jamais servir d'affichage.
 */
export interface MarketplaceAccount {
  id: AccountId;
  marketplace: MarketplaceId;
  slug: string;
  displayName: string;
  enabled: boolean;
  externalAccountId?: string | undefined;
}

/** Le produit « maître », indépendant des plateformes. Clé de rapprochement : le SKU. */
export interface Product {
  id: ProductId;
  sku: string;
  title: string;
  description?: string | undefined;
  price: Money;
  stock: number;
  images?: string[] | undefined;
  tags?: string[] | undefined;
  /** Champs spécifiques à une plateforme (catégorie eBay, taxonomie Etsy…). */
  marketplaceData?: Record<string, unknown> | undefined;
}

/** La présence d'un produit sur un compte donné. */
export interface Listing {
  id: ListingId;
  productId: ProductId;
  accountId: AccountId;
  remoteId?: string | undefined;
  status: "draft" | "active" | "inactive" | "sold" | "error";
  price: Money;
  stock: number;
  marketplaceData?: Record<string, unknown> | undefined;
}

/**
 * Stock central.
 *
 * `reserved` couvre le laps de temps entre une vente constatée et son
 * expédition : la marchandise est encore physiquement là, mais elle n'est plus
 * disponible. `version` permet un verrouillage optimiste — deux ventes
 * simultanées sur deux plateformes ne doivent pas se perdre l'une l'autre.
 */
export interface InventoryItem {
  productId: ProductId;
  onHand: number;
  reserved: number;
  version: number;
}

export interface CanonicalOrderLine {
  productId?: ProductId | undefined;
  sku?: string | undefined;
  quantity: number;
  remoteListingId?: string | undefined;
}

/**
 * Événement de vente normalisé.
 *
 * Toute source — webhook Shopify, relevé Etsy, notification eBay — doit être
 * traduite dans cette forme avant d'entrer dans le système. C'est ce qui
 * permet à la déduplication et à la propagation de stock d'être écrites une
 * seule fois plutôt qu'une fois par plateforme.
 */
export interface CanonicalOrderEvent {
  marketplace: MarketplaceId;
  accountId: AccountId;
  remoteOrderId: string;
  /** Identifiant fourni par la plateforme. Sert de clé de déduplication. */
  eventId: string;
  kind: "paid" | "cancelled" | "returned";
  occurredAt: string;
  lines: CanonicalOrderLine[];
  raw?: unknown;
}

/**
 * Ce qu'un adaptateur sait réellement faire.
 *
 * C'est la pièce qui rend l'orchestrateur honnête. Sans elle, on suppose que
 * toute plateforme sait tout faire — ce qui est faux : Vinted ne permet aucune
 * écriture automatique sans accès Pro, et plusieurs API sont en lecture seule
 * sur certains objets. Déclarer les capacités permet à l'interface de griser
 * une action au lieu de la proposer puis d'échouer.
 */
export interface CapabilitySet {
  listingCreate: boolean;
  listingUpdate: boolean;
  listingActivate: boolean;
  listingDeactivate: boolean;
  stockRead: boolean;
  stockWrite: boolean;
  priceRead: boolean;
  priceWrite: boolean;
  ordersRead: boolean;
  /** Comment les ventes entrantes arrivent, si elles arrivent. */
  inboundSales: "webhook" | "poll" | "both" | "manual" | "none";
  messagesRead?: boolean | undefined;
  messagesSend?: boolean | undefined;
  reviewsRead?: boolean | undefined;
  reviewsReply?: boolean | undefined;
}

/**
 * Résultat d'une commande sur une cible.
 *
 * `manual_required` est le statut qui fait la différence : il dit « cette
 * plateforme ne peut pas le faire automatiquement, quelqu'un doit s'en
 * charger ». Le confondre avec `failed` ferait apparaître une opération
 * normale comme une panne, et déclencherait des alertes pour rien.
 */
export type TargetStatus =
  | "success"
  | "pending_remote"
  | "manual_required"
  | "unsupported"
  | "failed";

export type TargetResult = {
  accountId: AccountId;
  marketplace: MarketplaceId;
  status: TargetStatus;
  remoteId?: string | undefined;
  message?: string | undefined;
};
