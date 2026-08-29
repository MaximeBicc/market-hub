import { describe, expect, it } from "vitest";
import { createMarketplaceModule } from "../core/module.js";
import { memoryRepositories } from "../testing/memory-repositories.js";
import type { MarketplaceAdapter } from "../ports/marketplace.js";
import type { CapabilitySet, Listing, Product, Variant } from "../domain/types.js";

/**
 * CE QUE LES TESTS D'ADAPTATEUR NE PROUVENT PAS.
 *
 * Deux défauts vécus le même jour ont vécu ICI, entre le noyau et le module,
 * là où aucun test ne regardait : l'activation recevait une fiche SANS ses
 * variantes, puis une fiche SANS leur stock. Les tests d'eBay passaient au
 * vert — ils prouvaient que la réparation FONCTIONNE, jamais qu'elle reçoit
 * de quoi travailler.
 *
 * Ces tests-là vérifient le contrat de passage, et rien d'autre.
 */

const CAPACITES: CapabilitySet = {
  listingCreate: true,
  listingUpdate: true,
  listingActivate: true,
  listingDeactivate: true,
  listingDelete: true,
  stockRead: true,
  stockWrite: true,
  priceRead: true,
  priceWrite: true,
  ordersRead: true,
  ordersFulfill: false,
  trackingWrite: false,
  inboundSales: "poll",
  pousseActive: false,
};

/** Un module qui ne fait qu'enregistrer la fiche qu'on lui confie. */
function adaptateurTemoin(recu: { product?: Product | undefined }[]) {
  return {
    id: "temoin",
    capabilities: () => CAPACITES,
    testConnection: async () => {},
    createListing: async () => ({
      accountId: "a1",
      marketplace: "temoin",
      status: "success" as const,
    }),
    updatePrice: async () => ({
      accountId: "a1",
      marketplace: "temoin",
      status: "success" as const,
    }),
    updateStock: async () => ({
      accountId: "a1",
      marketplace: "temoin",
      status: "success" as const,
    }),
    activateListing: async (
      _ctx: unknown,
      _listing: Listing,
      _cle: string,
      product?: Product,
    ) => {
      recu.push({ product });
      return {
        accountId: "a1",
        marketplace: "temoin",
        status: "success" as const,
      };
    },
    deactivateListing: async () => ({
      accountId: "a1",
      marketplace: "temoin",
      status: "success" as const,
    }),
    deleteListing: async () => ({
      accountId: "a1",
      marketplace: "temoin",
      status: "success" as const,
    }),
    fetchListings: async () => ({ items: [] }),
    fetchOrders: async () => ({ items: [] }),
  } as unknown as MarketplaceAdapter;
}

async function decor() {
  const repos = memoryRepositories();
  await repos.accounts.put({
    id: "a1",
    marketplace: "temoin",
    slug: "temoin",
    displayName: "Témoin",
    enabled: true,
  });

  const produit: Product = {
    id: "p1",
    sku: "CLIP",
    title: "Clip",
    price: { amount: 599, currency: "EUR" },
    stock: 39,
    options: [{ name: "Couleur", values: ["Noir", "Blanc"] }],
  };
  await repos.products.put(produit);

  const faire = async (id: string, cle: string, valeurs: string[], stock: number) => {
    const v: Variant = {
      id,
      productId: "p1",
      sku: `CLIP-${id}`,
      optionValues: valeurs,
      optionKey: cle,
      price: { amount: 599, currency: "EUR" },
      position: 0,
      status: "active",
    };
    await repos.variants.put(v);
    await repos.inventory.put({
      variantId: id,
      onHand: stock,
      reserved: 0,
      version: 1,
    });
  };
  await faire("v-noir", "couleur=noir", ["Noir"], 20);
  await faire("v-blanc", "couleur=blanc", ["Blanc"], 19);

  await repos.listings.put({
    id: "l1",
    productId: "p1",
    accountId: "a1",
    remoteId: "GRP",
    status: "inactive",
    price: { amount: 599, currency: "EUR" },
    stock: 0,
  });

  return repos;
}

describe("ce que l'activation reçoit", () => {
  it("transmet la fiche AVEC ses variantes et leur stock", async () => {
    /*
     * Les deux défauts en un seul test, parce qu'ils se sont produits l'un
     * après l'autre au même endroit :
     *
     *   sans les VARIANTES, réécrire un groupe eBay remplacerait sa liste de
     *   déclinaisons par rien ;
     *
     *   sans leur STOCK, la remise en vente republie ce que la plateforme
     *   détient — c'est-à-dire zéro pour une annonce couchée pour rupture.
     *   L'annonce revient « en rupture de stock », marchandise en main.
     */
    const recu: { product?: Product | undefined }[] = [];
    const repos = await decor();
    const mod = createMarketplaceModule({
      ...repos,
      adapters: [adaptateurTemoin(recu)],
    });

    const r = await mod.orchestrator.setActive({
      productId: "p1",
      accountIds: ["a1"],
      active: true,
      idempotencyKey: "k",
    });

    expect(r.anySuccess).toBe(true);
    expect(recu).toHaveLength(1);

    const fiche = recu[0]?.product;
    expect(fiche, "la fiche doit accompagner l'activation").toBeDefined();

    const variantes = fiche?.variants ?? [];
    expect(variantes).toHaveLength(2);

    const stocks = variantes
      .map((v) => v.marketplaceData?.["stock"])
      .sort((a, b) => Number(a) - Number(b));
    expect(stocks).toEqual([19, 20]);
  });

  it("ne transmet rien lors d'un RETRAIT — il n'y a rien à réparer", async () => {
    // Le retrait ne réécrit ni déclinaisons ni quantités : joindre la fiche
    // coûterait une lecture de la table d'inventaire pour rien, sur un
    // chemin déclenché automatiquement à chaque passage à zéro.
    const recu: { product?: Product | undefined }[] = [];
    const repos = await decor();
    const mod = createMarketplaceModule({
      ...repos,
      adapters: [adaptateurTemoin(recu)],
    });

    await mod.orchestrator.setActive({
      productId: "p1",
      accountIds: ["a1"],
      active: false,
      idempotencyKey: "k",
    });

    expect(recu).toHaveLength(0);
  });
});
