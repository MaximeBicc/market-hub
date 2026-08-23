import { describe, expect, it } from "vitest";
import { createMarketplaceModule } from "./core/module.js";
import { MockAdapter } from "./adapters/mock.js";
import { VintedSafeAdapter } from "./adapters/vinted-safe.js";
import { memoryRepositories } from "./testing/memory-repositories.js";
import type { CanonicalOrderEvent, MarketplaceAccount } from "./domain/types.js";

/**
 * Tests du socle.
 *
 * Ils valident l'orchestrateur, les capacités, l'isolation des erreurs, la
 * déduplication et la propagation de stock — sans toucher à une seule
 * plateforme réelle. C'est la validation « en interne » qui doit passer avant
 * qu'un adaptateur ne soit branché en direct.
 */

const EUR = (amount: number) => ({ amount, currency: "EUR" });

function account(
  id: string,
  marketplace: string,
  enabled = true,
): MarketplaceAccount {
  return {
    id,
    marketplace,
    slug: `${marketplace}_${id}`,
    displayName: `${marketplace} ${id}`,
    enabled,
  };
}

/** Monte un système complet : 2 comptes « mock » + 1 compte Vinted. */
async function setup() {
  const repos = memoryRepositories();
  const mock = new MockAdapter();
  const vinted = new VintedSafeAdapter();

  await repos.accounts.put(account("a1", "mock"));
  await repos.accounts.put(account("a2", "mock"));
  await repos.accounts.put(account("v1", "vinted"));

  await repos.products.put({
    id: "p1",
    sku: "SAC-01",
    title: "Sac besace",
    price: EUR(14900),
    stock: 5,
  });

  /*
   * TOUT PRODUIT A AU MOINS UNE VARIANTE.
   *
   * C'est elle qui porte le stock depuis que le modèle sait qu'un article
   * existe en plusieurs coloris. Un produit sans déclinaison en a une seule,
   * à `optionKey` vide — pas de « variante optionnelle », donc pas deux
   * chemins de code dont un seul serait testé.
   */
  await repos.variants.put({
    id: "v1",
    productId: "p1",
    sku: "SAC-01",
    optionValues: [],
    optionKey: "",
    price: EUR(14900),
    position: 0,
    status: "active",
  });

  const module = createMarketplaceModule({ ...repos, adapters: [mock, vinted] });
  await module.inventoryService.ensure("v1", 5);

  return { repos, mock, vinted, module };
}

describe("orchestrateur", () => {
  it("diffuse une commande sur plusieurs comptes", async () => {
    const { module, mock } = await setup();

    const out = await module.orchestrator.createListing({
      productId: "p1",
      accountIds: ["a1", "a2"],
      idempotencyKey: "k1",
    });

    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.status === "success")).toBe(true);
    expect(mock.calls.filter((c) => c.op === "createListing")).toHaveLength(2);
  });

  it("décline la clé d'idempotence par compte", async () => {
    const { module, mock } = await setup();
    await module.orchestrator.createListing({
      productId: "p1",
      accountIds: ["a1", "a2"],
      idempotencyKey: "k1",
    });
    const keys = mock.calls.map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain("k1:a1");
  });

  it("renvoie manual_required pour Vinted au lieu d'échouer", async () => {
    const { module } = await setup();

    const out = await module.orchestrator.createListing({
      productId: "p1",
      accountIds: ["v1"],
      idempotencyKey: "k2",
    });

    // Vinted déclare ne pas savoir créer d'annonce : la capacité est refusée
    // AVANT tout appel réseau. C'est « unsupported », pas une panne.
    expect(out.results[0]?.status).toBe("unsupported");
    expect(out.anySuccess).toBe(false);
  });

  it("isole l'échec d'une plateforme des autres", async () => {
    const { module, mock } = await setup();
    mock.failNext = true;

    const out = await module.orchestrator.createListing({
      productId: "p1",
      accountIds: ["a1", "a2"],
      idempotencyKey: "k3",
    });

    // Le premier compte plante, le second doit quand même passer.
    expect(out.results).toHaveLength(2);
    expect(out.results.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(out.results.filter((r) => r.status === "success")).toHaveLength(1);
  });

  it("écarte un compte désactivé sans appeler l'adaptateur", async () => {
    const { module, mock, repos } = await setup();
    await repos.accounts.put(account("a1", "mock", false));

    const out = await module.orchestrator.createListing({
      productId: "p1",
      accountIds: ["a1"],
      idempotencyKey: "k4",
    });

    expect(out.results[0]?.status).toBe("unsupported");
    expect(mock.calls).toHaveLength(0);
  });

  it("expose les capacités de chaque compte", async () => {
    const { module } = await setup();
    const caps = await module.orchestrator.capabilitiesFor(["a1", "v1"]);

    expect(caps.find((c) => c.accountId === "a1")?.capabilities?.stockWrite).toBe(true);
    expect(caps.find((c) => c.accountId === "v1")?.capabilities?.stockWrite).toBe(false);
    expect(caps.find((c) => c.accountId === "v1")?.capabilities?.inboundSales).toBe("manual");
  });
});

describe("ventes entrantes", () => {
  const sale = (over: Partial<CanonicalOrderEvent> = {}): CanonicalOrderEvent => ({
    marketplace: "mock",
    accountId: "a1",
    remoteOrderId: "ord-1",
    eventId: "evt-1",
    kind: "paid",
    occurredAt: "2026-08-20T10:00:00Z",
    lines: [{ sku: "SAC-01", quantity: 2 }],
    ...over,
  });

  it("décrémente le stock central", async () => {
    const { module, repos } = await setup();
    const r = await module.salesSync.ingest(sale());

    expect(r.duplicate).toBe(false);
    expect(r.changed).toEqual(["p1"]);
    expect((await repos.inventory.get("v1"))?.onHand).toBe(3);
  });

  it("ignore un événement déjà traité", async () => {
    const { module, repos } = await setup();
    await module.salesSync.ingest(sale());
    const second = await module.salesSync.ingest(sale());

    expect(second.duplicate).toBe(true);
    // Le stock ne doit pas bouger une seconde fois.
    expect((await repos.inventory.get("v1"))?.onHand).toBe(3);
  });

  it("propage le nouveau stock aux AUTRES comptes, pas à la source", async () => {
    const { module, mock, repos } = await setup();

    await repos.listings.put({
      id: "l1",
      productId: "p1",
      variantId: "v1",
      accountId: "a1",
      remoteId: "r1",
      status: "active",
      price: EUR(14900),
      stock: 5,
    });
    await repos.listings.put({
      id: "l2",
      productId: "p1",
      variantId: "v1",
      accountId: "a2",
      remoteId: "r2",
      status: "active",
      price: EUR(14900),
      stock: 5,
    });

    await module.salesSync.ingest(sale());

    const stockCalls = mock.calls.filter((c) => c.op === "updateStock");
    expect(stockCalls).toHaveLength(1);
    expect(stockCalls[0]?.accountId).toBe("a2"); // pas a1, la source
    expect(stockCalls[0]?.value).toBe(3);
  });

  it("restitue le stock sur une annulation", async () => {
    const { module, repos } = await setup();
    await module.salesSync.ingest(sale());
    await module.salesSync.ingest(
      sale({ eventId: "evt-2", kind: "cancelled" }),
    );
    expect((await repos.inventory.get("v1"))?.onHand).toBe(5);
  });

  it("compte les lignes non rattachées au lieu de les perdre", async () => {
    const { module } = await setup();
    const r = await module.salesSync.ingest(
      sale({ lines: [{ sku: "SKU-INCONNU", quantity: 1 }] }),
    );
    expect(r.unmatched).toBe(1);
    expect(r.changed).toEqual([]);
  });

  it("retrouve le produit par annonce distante quand le SKU manque", async () => {
    const { module, repos } = await setup();
    await repos.listings.put({
      id: "l1",
      productId: "p1",
      variantId: "v1",
      accountId: "a1",
      remoteId: "remote-42",
      status: "active",
      price: EUR(14900),
      stock: 5,
    });

    const r = await module.salesSync.ingest(
      sale({ lines: [{ remoteListingId: "remote-42", quantity: 1 }] }),
    );
    expect(r.changed).toEqual(["p1"]);
  });
});

describe("stock central", () => {
  it("résiste à deux ventes simultanées", async () => {
    const { module, repos } = await setup();

    // Deux décrémentations lancées en parallèle : le verrouillage optimiste
    // doit garantir que les DEUX sont comptées. Sans lui, l'une écrase l'autre
    // et l'on vend un article que l'on n'a plus.
    await Promise.all([
      module.inventoryService.applyDelta("v1", -1),
      module.inventoryService.applyDelta("v1", -1),
    ]);

    expect((await repos.inventory.get("v1"))?.onHand).toBe(3);
  });

  it("distingue le physique du disponible", async () => {
    const { module } = await setup();
    const item = await module.inventoryService.reserve("v1", 2);
    expect(item.onHand).toBe(5);
    expect(module.inventoryService.available(item)).toBe(3);
  });
});
