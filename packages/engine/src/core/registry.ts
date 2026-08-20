import type { MarketplaceAdapter } from "../ports/marketplace.js";
import type { MarketplaceId } from "../domain/types.js";

/** Registre des adaptateurs : le SEUL point d'entrée vers une plateforme. */
export class MarketplaceRegistry {
  private readonly adapters = new Map<string, MarketplaceAdapter>();

  register(adapter: MarketplaceAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: MarketplaceId): MarketplaceAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Aucun adaptateur enregistré pour « ${id} »`);
    return a;
  }

  has(id: MarketplaceId): boolean {
    return this.adapters.has(id);
  }

  list(): MarketplaceAdapter[] {
    return [...this.adapters.values()];
  }
}
