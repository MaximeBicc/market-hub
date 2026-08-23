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
import type {
  AccountRepository,
  CredentialRepository,
  InventoryRepository,
  ListingRepository,
  ProductRepository,
  VariantRepository,
  SalesEventRepository,
} from "../ports/repositories.js";

/**
 * Dépôts en mémoire — le harnais de test du moteur.
 *
 * Ils permettent d'exercer l'orchestrateur, la propagation de stock et la
 * déduplication sans base de données, sans réseau et sans compte marchand.
 * Un test complet du flux de vente tourne ainsi en quelques millisecondes.
 *
 * Ce n'est pas du code jetable : c'est ce qui rend possible de valider une
 * modification du socle avant de l'exposer à une plateforme réelle.
 */

export class MemoryAccountRepository implements AccountRepository {
  readonly items = new Map<AccountId, MarketplaceAccount>();
  async get(id: AccountId) {
    return this.items.get(id);
  }
  async listEnabled() {
    return [...this.items.values()].filter((a) => a.enabled);
  }
  async put(account: MarketplaceAccount) {
    this.items.set(account.id, account);
  }
}

export class MemoryProductRepository implements ProductRepository {
  readonly items = new Map<ProductId, Product>();
  async get(id: ProductId) {
    return this.items.get(id);
  }
  async findBySku(sku: string) {
    return [...this.items.values()].find((p) => p.sku === sku);
  }
  async put(product: Product) {
    this.items.set(product.id, product);
  }
}

export class MemoryListingRepository implements ListingRepository {
  readonly items = new Map<string, Listing>();
  async findByProductAndAccount(productId: ProductId, accountId: AccountId) {
    return [...this.items.values()].find(
      (l) => l.productId === productId && l.accountId === accountId,
    );
  }
  async findByRemoteId(accountId: AccountId, remoteId: string) {
    return [...this.items.values()].find(
      (l) => l.accountId === accountId && l.remoteId === remoteId,
    );
  }
  async put(listing: Listing) {
    this.items.set(listing.id, listing);
  }
  async listByProduct(productId: ProductId) {
    return [...this.items.values()].filter((l) => l.productId === productId);
  }
}

export class MemoryVariantRepository implements VariantRepository {
  readonly items = new Map<VariantId, Variant>();
  async get(id: VariantId) {
    const v = this.items.get(id);
    return v ? { ...v } : undefined;
  }
  async findBySku(sku: string) {
    for (const v of this.items.values()) if (v.sku === sku) return { ...v };
    return undefined;
  }
  async findByOptionKey(productId: ProductId, optionKey: string) {
    for (const v of this.items.values()) {
      if (v.productId === productId && v.optionKey === optionKey) return { ...v };
    }
    return undefined;
  }
  async listByProduct(productId: ProductId) {
    return [...this.items.values()]
      .filter((v) => v.productId === productId)
      .map((v) => ({ ...v }));
  }
  async put(v: Variant) {
    this.items.set(v.id, { ...v });
  }
}

export class MemoryInventoryRepository implements InventoryRepository {
  readonly items = new Map<VariantId, InventoryItem>();
  async get(variantId: VariantId) {
    const v = this.items.get(variantId);
    return v ? { ...v } : undefined;
  }
  /** Reproduit fidèlement le verrouillage optimiste de la base réelle. */
  async compareAndSet(next: InventoryItem, expectedVersion: number) {
    const cur = this.items.get(next.variantId);
    if (!cur || cur.version !== expectedVersion) return false;
    this.items.set(next.variantId, { ...next });
    return true;
  }
  async put(item: InventoryItem) {
    this.items.set(item.variantId, { ...item });
  }
}

export class MemorySalesEventRepository implements SalesEventRepository {
  readonly seen = new Set<string>();
  private key(accountId: AccountId, eventId: string) {
    return `${accountId}::${eventId}`;
  }
  async has(accountId: AccountId, eventId: string) {
    return this.seen.has(this.key(accountId, eventId));
  }
  async mark(event: CanonicalOrderEvent) {
    this.seen.add(this.key(event.accountId, event.eventId));
  }
}

export class MemoryCredentialRepository implements CredentialRepository {
  readonly items = new Map<AccountId, Record<string, string>>();
  async get(accountId: AccountId) {
    return this.items.get(accountId);
  }
  async put(accountId: AccountId, credentials: Record<string, string>) {
    this.items.set(accountId, credentials);
  }
}

/** Un jeu complet de dépôts vides, prêt pour un test. */
export function memoryRepositories() {
  return {
    accounts: new MemoryAccountRepository(),
    products: new MemoryProductRepository(),
    listings: new MemoryListingRepository(),
    variants: new MemoryVariantRepository(),
    inventory: new MemoryInventoryRepository(),
    salesEvents: new MemorySalesEventRepository(),
    credentials: new MemoryCredentialRepository(),
  };
}
