import { describe, expect, it } from "vitest";
import { ShopifyAdapter } from "./shopify.js";
import type { MarketplaceContext } from "../ports/marketplace.js";
import type { Listing } from "../domain/types.js";

/**
 * Tests de l'adaptateur Shopify, sur un `fetch` simulé.
 *
 * Ils valident la forme des requêtes envoyées, la lecture des `userErrors`,
 * la vérification HMAC et la traduction vers le modèle canonique — sans
 * toucher à une boutique réelle, donc sans créer de produit fantôme ni
 * consommer de quota.
 *
 * Ce qu'ils NE prouvent pas : que Shopify accepte réellement ces mutations.
 * Seul un essai sur une boutique de développement le montrera. Ils attrapent
 * en revanche toutes les erreurs de notre côté, qui sont la majorité.
 */

/** File de réponses simulées, consommée dans l'ordre. */
function fakeHttp(responses: unknown[]) {
  const sent: Array<{ url: string; body: any; headers: any }> = [];
  let i = 0;
  const http = async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: init?.headers,
    });
    const payload = responses[i++] ?? { data: {} };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { http, sent };
}

function ctxWith(http: MarketplaceContext["http"]): MarketplaceContext {
  return {
    account: {
      id: "acc1",
      marketplace: "shopify",
      slug: "shopify_test",
      displayName: "Boutique test",
      enabled: true,
      externalAccountId: "test.myshopify.com",
    },
    credentials: {
      shopDomain: "test.myshopify.com",
      accessToken: "shpat_fake",
      webhookSecret: "secret-partage",
      locationId: "gid://shopify/Location/1",
    },
    http,
  };
}

const listing: Listing = {
  id: "l1",
  productId: "p1",
  accountId: "acc1",
  remoteId: "gid://shopify/ProductVariant/99",
  status: "active",
  price: { amount: 14900, currency: "EUR" },
  stock: 5,
  marketplaceData: { productId: "gid://shopify/Product/9" },
};

const adapter = new ShopifyAdapter();

describe("capacités", () => {
  it("déclare savoir expédier et poser un suivi", () => {
    const c = adapter.capabilities();
    expect(c.ordersFulfill).toBe(true);
    expect(c.trackingWrite).toBe(true);
    expect(c.inboundSales).toBe("both");
  });
});

describe("identifiants", () => {
  it("refuse d'appeler sans jeton", async () => {
    const bare: MarketplaceContext = {
      account: {
        id: "acc1",
        marketplace: "shopify",
        slug: "s",
        displayName: "s",
        enabled: true,
      },
      credentials: {},
    };
    await expect(adapter.testConnection(bare)).rejects.toThrow(/identifiants manquants/i);
  });

  it("envoie le jeton dans l'en-tête attendu", async () => {
    const { http, sent } = fakeHttp([
      { data: { shop: { name: "Test", myshopifyDomain: "test.myshopify.com" } } },
    ]);
    await adapter.testConnection(ctxWith(http));
    expect(sent[0]?.url).toContain("test.myshopify.com/admin/api/");
    expect((sent[0]?.headers as any)["X-Shopify-Access-Token"]).toBe("shpat_fake");
  });
});

describe("création d'annonce", () => {
  it("crée le produit puis sa variante, et renvoie l'identifiant de variante", async () => {
    const { http, sent } = fakeHttp([
      {
        data: {
          productCreate: {
            product: {
              id: "gid://shopify/Product/1",
              variants: { nodes: [{ id: "gid://shopify/ProductVariant/2" }] },
            },
            userErrors: [],
          },
        },
      },
      {
        data: {
          productVariantsBulkUpdate: {
            productVariants: [
              {
                id: "gid://shopify/ProductVariant/2",
                inventoryItem: { id: "gid://shopify/InventoryItem/3" },
              },
            ],
            userErrors: [],
          },
        },
      },
    ]);

    const r = await adapter.createListing(
      ctxWith(http),
      {
        id: "p1",
        sku: "SAC-01",
        title: "Sac besace",
        price: { amount: 14900, currency: "EUR" },
        stock: 5,
      },
      "k1",
    );

    expect(r.status).toBe("success");
    // C'est bien la VARIANTE qui est retenue : c'est elle que portent les
    // lignes de commande, donc elle qui permet de rattacher une vente.
    expect(r.remoteId).toBe("gid://shopify/ProductVariant/2");

    // Créé en brouillon : publier sans relecture est un automatisme qu'on regrette.
    expect(sent[0]?.body.variables.input.status).toBe("DRAFT");
    // Prix converti des centimes vers la chaîne décimale attendue par Shopify.
    expect(sent[1]?.body.variables.variants[0].price).toBe("149.00");
    expect(sent[1]?.body.variables.variants[0].inventoryItem.sku).toBe("SAC-01");
  });

  it("fait remonter les userErrors au lieu de les ignorer", async () => {
    // Shopify répond 200 même quand la mutation échoue : l'erreur est dans le
    // corps. Ne pas la lire ferait passer un refus pour une réussite.
    const { http } = fakeHttp([
      {
        data: {
          productCreate: {
            product: null,
            userErrors: [{ field: ["title"], message: "ne peut être vide" }],
          },
        },
      },
    ]);

    await expect(
      adapter.createListing(
        ctxWith(http),
        {
          id: "p1",
          sku: "X",
          title: "",
          price: { amount: 100, currency: "EUR" },
          stock: 1,
        },
        "k",
      ),
    ).rejects.toThrow(/ne peut être vide/);
  });
});

describe("prix et stock", () => {
  it("écrit le prix sur la variante du produit mémorisé", async () => {
    const { http, sent } = fakeHttp([
      { data: { productVariantsBulkUpdate: { userErrors: [] } } },
    ]);
    const r = await adapter.updatePrice(
      ctxWith(http),
      listing,
      { amount: 12900, currency: "EUR" },
      "k",
    );
    expect(r.status).toBe("success");
    expect(sent[0]?.body.variables.productId).toBe("gid://shopify/Product/9");
    expect(sent[0]?.body.variables.variants[0].price).toBe("129.00");
  });

  it("impose la quantité sans négocier avec l'état distant", async () => {
    const { http, sent } = fakeHttp([
      { data: { productVariant: { inventoryItem: { id: "gid://shopify/InventoryItem/7" } } } },
      { data: { inventorySetQuantities: { userErrors: [] } } },
    ]);

    const r = await adapter.updateStock(ctxWith(http), listing, 3);
    expect(r.status).toBe("success");

    const input = sent[1]?.body.variables.input;
    // Notre source de vérité est le stock central : on écrase, on ne compare pas.
    expect(input.ignoreCompareQuantity).toBe(true);
    expect(input.quantities[0].quantity).toBe(3);
    // L'emplacement configuré évite un appel réseau supplémentaire.
    expect(input.quantities[0].locationId).toBe("gid://shopify/Location/1");
  });
});

describe("expédition", () => {
  it("passe par les fulfillment orders et transmet le suivi", async () => {
    const { http, sent } = fakeHttp([
      {
        data: {
          order: {
            fulfillmentOrders: {
              nodes: [{ id: "gid://shopify/FulfillmentOrder/5", status: "OPEN" }],
            },
          },
        },
      },
      {
        data: {
          fulfillmentCreate: {
            fulfillment: { id: "gid://shopify/Fulfillment/8" },
            userErrors: [],
          },
        },
      },
    ]);

    const r = await adapter.markShipped(
      ctxWith(http),
      {
        remoteOrderId: "gid://shopify/Order/4",
        trackingNumber: "6A12345678901",
        carrier: "Colissimo",
      },
      "k",
    );

    expect(r.status).toBe("success");
    const f = sent[1]?.body.variables.fulfillment;
    expect(f.lineItemsByFulfillmentOrder[0].fulfillmentOrderId).toBe(
      "gid://shopify/FulfillmentOrder/5",
    );
    expect(f.trackingInfo.number).toBe("6A12345678901");
    expect(f.trackingInfo.company).toBe("Colissimo");
    expect(f.notifyCustomer).toBe(true);
  });

  it("ne considère pas comme une panne une commande déjà expédiée", async () => {
    const { http } = fakeHttp([
      { data: { order: { fulfillmentOrders: { nodes: [] } } } },
    ]);
    const r = await adapter.markShipped(
      ctxWith(http),
      { remoteOrderId: "gid://shopify/Order/4" },
      "k",
    );
    expect(r.status).toBe("success");
    expect(r.message).toMatch(/déjà entièrement traitée/);
  });
});

describe("webhooks", () => {
  /** Signe un corps comme le ferait Shopify. */
  async function sign(body: string, secret: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  const body = JSON.stringify({
    id: 1234,
    created_at: "2026-08-20T10:00:00Z",
    line_items: [{ sku: "SAC-01", quantity: 2, variant_id: 99 }],
  });

  it("accepte une signature valide et traduit la vente", async () => {
    const hmac = await sign(body, "secret-partage");
    const req = new Request("https://x/api/webhooks/shopify", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Topic": "orders/paid",
        "X-Shopify-Webhook-Id": "evt-77",
      },
      body,
    });

    const events = await adapter.verifyAndParseWebhook(
      ctxWith(undefined),
      req,
      body,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("paid");
    expect(events[0]?.eventId).toBe("evt-77");
    expect(events[0]?.lines[0]?.sku).toBe("SAC-01");
    expect(events[0]?.lines[0]?.remoteListingId).toBe(
      "gid://shopify/ProductVariant/99",
    );
  });

  it("rejette une signature falsifiée", async () => {
    const req = new Request("https://x/api/webhooks/shopify", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": await sign(body, "mauvais-secret"),
        "X-Shopify-Topic": "orders/paid",
      },
      body,
    });

    await expect(
      adapter.verifyAndParseWebhook(ctxWith(undefined), req, body),
    ).rejects.toThrow(/signature invalide/i);
  });

  it("rejette un corps modifié après signature", async () => {
    const hmac = await sign(body, "secret-partage");
    const altered = body.replace('"quantity":2', '"quantity":20');
    const req = new Request("https://x/api/webhooks/shopify", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Topic": "orders/paid",
      },
      body: altered,
    });

    await expect(
      adapter.verifyAndParseWebhook(ctxWith(undefined), req, altered),
    ).rejects.toThrow(/signature invalide/i);
  });

  it("traduit une annulation en restitution de stock", async () => {
    const hmac = await sign(body, "secret-partage");
    const req = new Request("https://x/api/webhooks/shopify", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Topic": "orders/cancelled",
        "X-Shopify-Webhook-Id": "evt-78",
      },
      body,
    });

    const events = await adapter.verifyAndParseWebhook(
      ctxWith(undefined),
      req,
      body,
    );
    expect(events[0]?.kind).toBe("cancelled");
  });
});

describe("relevé des ventes", () => {
  it("fabrique un identifiant d'événement stable pour la déduplication", async () => {
    const { http } = fakeHttp([
      {
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/Order/1",
                createdAt: "2026-08-20T09:00:00Z",
                displayFinancialStatus: "PAID",
                cancelledAt: null,
                lineItems: {
                  nodes: [{ quantity: 1, sku: "SAC-01", variant: { id: "v1" } }],
                },
              },
            ],
          },
        },
      },
    ]);

    const r = await adapter.pollOrderEvents(ctxWith(http));
    expect(r.events).toHaveLength(1);
    // Le relevé n'a pas d'identifiant d'événement propre : sans clé stable,
    // chaque relevé rejouerait toutes les commandes.
    expect(r.events[0]?.eventId).toBe("poll:gid://shopify/Order/1:PAID");
    expect(r.cursor).toBeUndefined();
  });
});
