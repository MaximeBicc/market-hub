import type {
  CanonicalOrderEvent,
  ProductId,
  VariantId,
} from "../domain/types.js";
import type {
  ListingRepository,
  ProductRepository,
  SalesEventRepository,
  VariantRepository,
} from "../ports/repositories.js";
import type { InventoryService } from "./inventory-service.js";

export type StockPropagation = (
  productId: ProductId,
  /** L'unité vendue. La propagation vise un coloris, pas « le produit ». */
  variantId: VariantId,
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
    private readonly variants: VariantRepository,
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
      /*
       * CE QU'ON CHERCHE, C'EST LA VARIANTE — l'unité réellement vendue.
       *
       * Chercher le produit ne suffit plus : un support téléphone existe en
       * dix-sept coloris, et décrémenter « le produit » reviendrait à choisir
       * un coloris au hasard. Trois voies, de la plus fiable à la moins :
       *
       *   1. l'identifiant direct, quand la plateforme le donne
       *   2. le SKU — porté par la ligne de commande, mais absent chez Shopify
       *      sur la majorité des variantes
       *   3. l'annonce distante, qui connaît sa variante depuis le groupement
       *
       * La troisième voie est celle qui a débloqué les vingt-six variantes
       * sans SKU : leur vente ne décrémentait rien du tout.
       */
      let variantId = line.variantId;
      if (!variantId && line.sku) {
        variantId = (await this.variants.findBySku(line.sku))?.id;
      }
      if (!variantId && line.remoteListingId) {
        variantId = (
          await this.listings.findByRemoteId(
            event.accountId,
            line.remoteListingId,
          )
        )?.variantId;
      }

      const productId =
        line.productId ??
        (variantId ? (await this.variants.get(variantId))?.productId : undefined);

      if (!variantId || !productId) {
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

      const next = await this.inventory.applyDelta(variantId, delta);
      await this.propagate(
        productId,
        variantId,
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
