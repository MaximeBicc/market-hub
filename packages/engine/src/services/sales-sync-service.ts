import type { CanonicalOrderEvent, ProductId } from "../domain/types.js";
import type {
  ListingRepository,
  ProductRepository,
  SalesEventRepository,
} from "../ports/repositories.js";
import type { InventoryService } from "./inventory-service.js";

export type StockPropagation = (
  productId: ProductId,
  stock: number,
  sourceAccountId: string,
  eventId: string,
) => Promise<void>;

/**
 * VENTES ENTRANTES — le point d'entrée unique.
 *
 * Webhook Shopify, relevé Etsy, notification eBay : toutes les sources
 * convergent ici, sous forme d'événement canonique. La déduplication et la
 * propagation de stock sont donc écrites une seule fois, pas une fois par
 * plateforme.
 *
 * DÉDUPLICATION : les plateformes garantissent « au moins une fois », jamais
 * « exactement une fois ». Sans ce garde-fou, une même vente livrée deux fois
 * décrémenterait le stock deux fois.
 *
 * PROPAGATION : c'est la raison d'être de l'outil. Vendre le dernier
 * exemplaire sur eBay doit le retirer d'Etsy et de Vinted dans la foulée,
 * sans quoi on vend un article qu'on n'a plus.
 */
export class SalesSyncService {
  constructor(
    private readonly events: SalesEventRepository,
    private readonly products: ProductRepository,
    private readonly listings: ListingRepository,
    private readonly inventory: InventoryService,
    private readonly propagate: StockPropagation,
  ) {}

  async ingest(event: CanonicalOrderEvent): Promise<{
    duplicate: boolean;
    changed: ProductId[];
    unmatched: number;
  }> {
    if (await this.events.has(event.accountId, event.eventId)) {
      return { duplicate: true, changed: [], unmatched: 0 };
    }

    const changed: ProductId[] = [];
    let unmatched = 0;

    for (const line of event.lines) {
      // Trois façons de retrouver le produit, de la plus fiable à la moins :
      // identifiant direct, puis SKU, puis correspondance par annonce distante.
      let productId = line.productId;
      if (!productId && line.sku) {
        productId = (await this.products.findBySku(line.sku))?.id;
      }
      if (!productId && line.remoteListingId) {
        productId = (
          await this.listings.findByRemoteId(
            event.accountId,
            line.remoteListingId,
          )
        )?.productId;
      }
      if (!productId) {
        // Vente d'un article inconnu du catalogue : on ne devine pas. Le
        // compteur remonte à l'appelant, qui peut le signaler plutôt que de
        // laisser la ligne disparaître en silence.
        unmatched++;
        continue;
      }

      const qty = Math.abs(line.quantity);
      const delta =
        event.kind === "paid"
          ? -qty
          : event.kind === "cancelled" || event.kind === "returned"
            ? qty
            : 0;
      if (delta === 0) continue;

      const next = await this.inventory.applyDelta(productId, delta);
      await this.propagate(
        productId,
        this.inventory.available(next),
        event.accountId,
        event.eventId,
      );
      changed.push(productId);
    }

    // Marqué APRÈS traitement : si l'on plantait au milieu, l'événement doit
    // pouvoir être rejoué plutôt que disparaître.
    await this.events.mark(event);
    return { duplicate: false, changed, unmatched };
  }
}
