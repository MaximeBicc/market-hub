import type {
  CapabilitySet,
  Listing,
  Money,
  Product,
  TargetResult,
} from "../domain/types.js";
import type {
  MarketplaceAdapter,
  MarketplaceContext,
} from "../ports/marketplace.js";

/**
 * Adaptateur factice — l'outil de test du socle.
 *
 * Il permet de valider l'orchestrateur, la propagation de stock et la
 * déduplication SANS toucher à une plateforme réelle, donc sans consommer de
 * quota ni risquer le moindre bannissement. C'est lui qui rend possible le
 * « test en interne » avant tout passage en direct.
 *
 * Il enregistre tous les appels reçus, ce qui permet à un test d'affirmer
 * « le stock a bien été propagé vers ce compte-là, avec cette valeur-là ».
 */
export interface MockCall {
  op: "createListing" | "updatePrice" | "updateStock" | "activate" | "deactivate";
  accountId: string;
  idempotencyKey: string;
  value?: number | Money;
}

export class MockAdapter implements MarketplaceAdapter {
  readonly id = "mock";

  /** Journal des appels reçus, dans l'ordre. */
  readonly calls: MockCall[] = [];

  /** Permet à un test de simuler une plateforme en panne. */
  failNext = false;

  constructor(private readonly caps: Partial<CapabilitySet> = {}) {}

  capabilities(): CapabilitySet {
    return {
      listingCreate: true,
      listingUpdate: true,
      listingActivate: true,
      listingDeactivate: true,
      stockRead: true,
      stockWrite: true,
      priceRead: true,
      priceWrite: true,
      ordersRead: true,
      inboundSales: "both",
      ...this.caps,
    };
  }

  async testConnection(): Promise<void> {}

  private ok(ctx: MarketplaceContext, remoteId?: string): TargetResult {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Panne simulée de la plateforme");
    }
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "success",
      ...(remoteId ? { remoteId } : {}),
    };
  }

  async createListing(
    ctx: MarketplaceContext,
    product: Product,
    idempotencyKey: string,
  ): Promise<TargetResult> {
    this.calls.push({
      op: "createListing",
      accountId: ctx.account.id,
      idempotencyKey,
    });
    return this.ok(ctx, `mock-${product.sku}-${ctx.account.id}`);
  }

  async updatePrice(
    ctx: MarketplaceContext,
    _listing: Listing,
    price: Money,
    idempotencyKey: string,
  ): Promise<TargetResult> {
    this.calls.push({
      op: "updatePrice",
      accountId: ctx.account.id,
      idempotencyKey,
      value: price,
    });
    return this.ok(ctx);
  }

  async updateStock(
    ctx: MarketplaceContext,
    _listing: Listing,
    stock: number,
    idempotencyKey: string,
  ): Promise<TargetResult> {
    this.calls.push({
      op: "updateStock",
      accountId: ctx.account.id,
      idempotencyKey,
      value: stock,
    });
    return this.ok(ctx);
  }

  async activateListing(
    ctx: MarketplaceContext,
    _listing: Listing,
    idempotencyKey: string,
  ): Promise<TargetResult> {
    this.calls.push({ op: "activate", accountId: ctx.account.id, idempotencyKey });
    return this.ok(ctx);
  }

  async deactivateListing(
    ctx: MarketplaceContext,
    _listing: Listing,
    idempotencyKey: string,
  ): Promise<TargetResult> {
    this.calls.push({
      op: "deactivate",
      accountId: ctx.account.id,
      idempotencyKey,
    });
    return this.ok(ctx);
  }
}
