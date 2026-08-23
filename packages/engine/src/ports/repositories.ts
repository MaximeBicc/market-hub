import type {
  AccountId,
  CanonicalOrderEvent,
  InventoryItem,
  Listing,
  MarketplaceAccount,
  Product,
  ProductId,
  Variant,
  VariantId,
} from "../domain/types.js";

/**
 * Ports de persistance.
 *
 * Le moteur ne connaît ni D1, ni Drizzle, ni SQL. C'est ce qui permet de le
 * tester entièrement en mémoire, sans base : les tests du flux de vente
 * tournent en millisecondes et n'ont besoin d'aucune infrastructure.
 */

export interface AccountRepository {
  get(id: AccountId): Promise<MarketplaceAccount | undefined>;
  listEnabled(): Promise<MarketplaceAccount[]>;
  put(account: MarketplaceAccount): Promise<void>;
}

export interface ProductRepository {
  get(id: ProductId): Promise<Product | undefined>;
  findBySku(sku: string): Promise<Product | undefined>;
  put(product: Product): Promise<void>;
}

export interface ListingRepository {
  findByProductAndAccount(
    productId: ProductId,
    accountId: AccountId,
  ): Promise<Listing | undefined>;
  findByRemoteId(
    accountId: AccountId,
    remoteId: string,
  ): Promise<Listing | undefined>;
  put(listing: Listing): Promise<void>;
  listByProduct(productId: ProductId): Promise<Listing[]>;
}

/**
 * Les variantes d'un produit.
 *
 * `findByOptionKey` existe parce que le SKU manque sur la majorité des
 * variantes lues chez Shopify : sans clé de repli dérivée des déclinaisons,
 * une variante serait recréée à chaque passage de synchronisation.
 */
export interface VariantRepository {
  get(id: VariantId): Promise<Variant | undefined>;
  findBySku(sku: string): Promise<Variant | undefined>;
  findByOptionKey(
    productId: ProductId,
    optionKey: string,
  ): Promise<Variant | undefined>;
  listByProduct(productId: ProductId): Promise<Variant[]>;
  put(variant: Variant): Promise<void>;
}

export interface InventoryRepository {
  get(variantId: VariantId): Promise<InventoryItem | undefined>;
  /** Écrit seulement si la version en base est encore `expectedVersion`. */
  compareAndSet(next: InventoryItem, expectedVersion: number): Promise<boolean>;
  put(item: InventoryItem): Promise<void>;
}

export interface SalesEventRepository {
  has(accountId: AccountId, eventId: string): Promise<boolean>;
  mark(event: CanonicalOrderEvent): Promise<void>;
}

export interface CredentialRepository {
  get(accountId: AccountId): Promise<Record<string, string> | undefined>;
  put(accountId: AccountId, credentials: Record<string, string>): Promise<void>;
}
