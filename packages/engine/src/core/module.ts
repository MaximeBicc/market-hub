import { MarketplaceRegistry } from "./registry.js";
import {
  MarketplaceOrchestrator,
  type OutcomeHook,
} from "../services/orchestrator.js";
import { InventoryService } from "../services/inventory-service.js";
import { SalesSyncService } from "../services/sales-sync-service.js";
import type { MarketplaceAdapter } from "../ports/marketplace.js";
import type { AccountId } from "../domain/types.js";
import type {
  AccountRepository,
  CredentialRepository,
  InventoryRepository,
  ListingRepository,
  ProductRepository,
  SalesEventRepository,
  VariantRepository,
} from "../ports/repositories.js";

export interface ModuleDeps {
  accounts: AccountRepository;
  credentials: CredentialRepository;
  products: ProductRepository;
  listings: ListingRepository;
  variants: VariantRepository;
  inventory: InventoryRepository;
  salesEvents: SalesEventRepository;
  adapters: MarketplaceAdapter[];
  httpFor?:
    | ((account: {
        id: AccountId;
        marketplace: string;
      }) => ((input: string, init?: RequestInit) => Promise<Response>) | undefined)
    | undefined;
  /** Appelé après chaque commande, y compris les propagations automatiques. */
  onOutcome?: OutcomeHook | undefined;
}

/**
 * Assemble le moteur.
 *
 * Le câblage notable est la boucle de rétroaction : le service de ventes
 * appelle l'orchestrateur pour propager le nouveau stock, tandis que
 * l'orchestrateur ignore tout du service de ventes. La dépendance ne va que
 * dans un sens, ce qui permet de tester chacun isolément.
 *
 * La propagation exclut volontairement le compte d'origine : la plateforme où
 * la vente a eu lieu a déjà décrémenté son propre stock. Le lui réécrire
 * provoquerait un aller-retour inutile, et un conflit sur certaines API.
 */
export function createMarketplaceModule(d: ModuleDeps) {
  const registry = new MarketplaceRegistry();
  for (const a of d.adapters) registry.register(a);

  const inventoryService = new InventoryService(d.inventory);

  const orchestrator = new MarketplaceOrchestrator(
    registry,
    d.accounts,
    d.credentials,
    d.products,
    d.variants,
    d.inventory,
    d.listings,
    d.httpFor,
    d.onOutcome,
  );

  const salesSync = new SalesSyncService(
    d.salesEvents,
    d.products,
    d.listings,
    d.variants,
    inventoryService,
    async (productId, variantId, stock, sourceAccountId, eventId) => {
      /*
       * La propagation vise un CANAL ET UNE UNITÉ.
       *
       * Filtrer sur le seul produit enverrait le stock du coloris violet à
       * l'annonce du coloris noir : sur un support téléphone à dix-sept
       * déclinaisons, seize écritures fausses par vente. On ne retient donc
       * que les annonces qui portent EXACTEMENT cette variante.
       */
      const listings = await d.listings.listByProduct(productId);
      const cibles = listings.filter(
        (x) => x.accountId !== sourceAccountId && x.variantId === variantId,
      );
      if (cibles.length === 0) return;
      await orchestrator.setStock({
        productId,
        variantId,
        accountIds: cibles.map((x) => x.accountId),
        stock,
        idempotencyKey: `sale:${eventId}:${variantId}`,
      });
    },
  );

  return { registry, orchestrator, inventoryService, salesSync };
}

export type MarketplaceModule = ReturnType<typeof createMarketplaceModule>;
