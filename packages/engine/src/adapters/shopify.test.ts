import { describe, expect, it } from "vitest";
import {
  SHOPIFY_WEBHOOK_TOPICS,
  ShopifyAdapter,
  shopifyEnsureWebhooks,
} from "./shopify.js";
import type { MarketplaceContext } from "../ports/marketplace.js";
import type { Listing, Product, Variant } from "../domain/types.js";

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

describe("formes d'erreur Shopify", () => {
  /**
   * Shopify renvoie `errors` tantôt en tableau, tantôt en chaîne. Supposer le
   * tableau faisait planter le code sur le cas le plus fréquent — un jeton
   * invalide — et remplaçait le message par une erreur interne.
   */
  it("lit une erreur d'authentification renvoyée sous forme de chaîne", async () => {
    const { http } = fakeHttp([
      { errors: "[API] Invalid API key or access token" },
    ]);
    await expect(adapter.testConnection(ctxWith(http))).rejects.toThrow(
      /Invalid API key or access token/,
    );
  });

  it("lit une erreur GraphQL renvoyée sous forme de tableau", async () => {
    const { http } = fakeHttp([
      { errors: [{ message: "Field 'nope' doesn't exist" }] },
    ]);
    await expect(adapter.testConnection(ctxWith(http))).rejects.toThrow(
      /doesn't exist/,
    );
  });

  it("signale un jeton refusé quand le code HTTP est 401", async () => {
    const http = async () =>
      new Response("Unauthorized", { status: 401 });
    await expect(adapter.testConnection(ctxWith(http))).rejects.toThrow(
      /jeton refusé/,
    );
  });
});

describe("client credentials (Dev Dashboard)", () => {
  /**
   * Depuis janvier 2026, une nouvelle application Shopify ne reçoit plus de
   * jeton permanent : elle échange un ID client et un secret contre un jeton
   * valable environ 24 heures.
   */
  function ctxCc(
    http: MarketplaceContext["http"],
    creds: Record<string, string>,
    saved: Record<string, string>[],
  ): MarketplaceContext {
    return {
      account: {
        id: "acc1",
        marketplace: "shopify",
        slug: "s",
        displayName: "s",
        enabled: true,
        externalAccountId: "test.myshopify.com",
      },
      credentials: { shopDomain: "test.myshopify.com", ...creds },
      http,
      saveCredentials: async (patch) => {
        saved.push(patch);
      },
    };
  }

  it("échange l'ID client contre un jeton, puis le mémorise", async () => {
    const calls: string[] = [];
    const saved: Record<string, string>[] = [];

    // Le premier appel est l'échange de jeton (fetch nu), le second la requête
    // GraphQL (fetch instrumenté). On intercepte les deux.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ access_token: "shpua_frais", expires_in: 86399 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const { http, sent } = fakeHttp([
        { data: { shop: { name: "T", myshopifyDomain: "test.myshopify.com" } } },
      ]);
      await adapter.testConnection(
        ctxCc(http, { clientId: "cid", clientSecret: "csec" }, saved),
      );

      expect(calls[0]).toContain("/admin/oauth/access_token");
      // Le jeton frais part bien dans l'en-tête de la requête GraphQL.
      expect((sent[0]?.headers as any)["X-Shopify-Access-Token"]).toBe("shpua_frais");
      // Et il est mémorisé avec son échéance, pour ne pas le redemander.
      expect(saved[0]?.accessToken).toBe("shpua_frais");
      expect(Number(saved[0]?.accessTokenExpiresAt)).toBeGreaterThan(
        Math.floor(Date.now() / 1000),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("réutilise un jeton encore valide sans rappeler Shopify", async () => {
    const saved: Record<string, string>[] = [];
    let exchanged = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      exchanged = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const { http, sent } = fakeHttp([
        { data: { shop: { name: "T", myshopifyDomain: "test.myshopify.com" } } },
      ]);
      await adapter.testConnection(
        ctxCc(
          http,
          {
            clientId: "cid",
            clientSecret: "csec",
            accessToken: "encore_bon",
            accessTokenExpiresAt: String(Math.floor(Date.now() / 1000) + 3600),
          },
          saved,
        ),
      );

      expect(exchanged).toBe(false);
      expect((sent[0]?.headers as any)["X-Shopify-Access-Token"]).toBe("encore_bon");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("dit quoi corriger quand les identifiants sont refusés", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("bad", { status: 401 })) as typeof fetch;

    try {
      const { http } = fakeHttp([{ data: {} }]);
      await expect(
        adapter.testConnection(
          ctxCc(http, { clientId: "cid", clientSecret: "faux" }, []),
        ),
      ).rejects.toThrow(/installée sur la boutique/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("accepte encore un jeton permanent d'avant 2026", async () => {
    const { http, sent } = fakeHttp([
      { data: { shop: { name: "T", myshopifyDomain: "test.myshopify.com" } } },
    ]);
    await adapter.testConnection(ctxCc(http, { accessToken: "shpat_ancien" }, []));
    expect((sent[0]?.headers as any)["X-Shopify-Access-Token"]).toBe("shpat_ancien");
  });
});

/**
 * L'emplacement de stock, cause d'une panne réelle en production.
 *
 * `inventorySetQuantities` exige un `locationId` non nul. Quand la résolution
 * échouait, la propagation de stock partait avec `null` et Shopify refusait la
 * mutation — une vente sur un autre canal ne se répercutait donc jamais.
 */
describe("emplacement de stock", () => {
  /** Article d'inventaire déjà connu : la file de réponses ne porte alors
   *  que la résolution de l'emplacement puis la mutation. */
  const annonce = {
    ...listing,
    marketplaceData: {
      ...listing.marketplaceData,
      inventoryItemId: "gid://shopify/InventoryItem/5",
    },
  };
  function ctxSansEmplacement(
    http: MarketplaceContext["http"],
    saved: Record<string, string>[] = [],
  ): MarketplaceContext {
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
      },
      http,
      saveCredentials: async (patch) => {
        saved.push(patch);
      },
    };
  }

  it("utilise l'emplacement déjà mémorisé sans rien redemander", async () => {
    const { http, sent } = fakeHttp([
      { data: { inventorySetQuantities: { userErrors: [] } } },
    ]);
    await adapter.updateStock(ctxWith(http), annonce, 4);

    // Une seule requête : la lecture des emplacements n'a pas eu lieu.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.variables.input.quantities[0].locationId).toBe(
      "gid://shopify/Location/1",
    );
  });

  it("résout puis mémorise l'emplacement quand il manque", async () => {
    const saved: Record<string, string>[] = [];
    const { http, sent } = fakeHttp([
      {
        data: {
          locations: {
            nodes: [{ id: "gid://shopify/Location/7", isActive: true }],
          },
        },
      },
      { data: { inventorySetQuantities: { userErrors: [] } } },
    ]);
    await adapter.updateStock(ctxSansEmplacement(http, saved), annonce, 4);

    expect(sent[1]?.body.variables.input.quantities[0].locationId).toBe(
      "gid://shopify/Location/7",
    );
    // Mémorisé : sans cela, chaque propagation relit les emplacements.
    expect(saved[0]?.["locationId"]).toBe("gid://shopify/Location/7");
  });

  it("préfère un emplacement actif", async () => {
    const { http, sent } = fakeHttp([
      {
        data: {
          locations: {
            nodes: [
              { id: "gid://shopify/Location/1", isActive: false },
              { id: "gid://shopify/Location/2", isActive: true },
            ],
          },
        },
      },
      { data: { inventorySetQuantities: { userErrors: [] } } },
    ]);
    await adapter.updateStock(ctxSansEmplacement(http), annonce, 4);
    expect(sent[1]?.body.variables.input.quantities[0].locationId).toBe(
      "gid://shopify/Location/2",
    );
  });

  it("se rabat sur un emplacement inactif plutôt que de ne rien écrire", async () => {
    const { http, sent } = fakeHttp([
      {
        data: {
          locations: {
            nodes: [{ id: "gid://shopify/Location/3", isActive: false }],
          },
        },
      },
      { data: { inventorySetQuantities: { userErrors: [] } } },
    ]);
    await adapter.updateStock(ctxSansEmplacement(http), annonce, 4);
    // Une boutique dont l'unique emplacement est marqué inactif porte quand
    // même du stock. Refuser d'écrire laisserait l'écart s'installer.
    expect(sent[1]?.body.variables.input.quantities[0].locationId).toBe(
      "gid://shopify/Location/3",
    );
  });

  it("n'envoie JAMAIS un identifiant nul", async () => {
    const { http } = fakeHttp([{ data: { locations: { nodes: [] } } }]);
    // C'est le point : plutôt qu'une mutation partie avec null et refusée par
    // Shopify avec un message incompréhensible, une erreur qui nomme la cause.
    await expect(
      adapter.updateStock(ctxSansEmplacement(http), annonce, 4),
    ).rejects.toThrow(/read_locations/);
  });

  it("survit à une réponse où « locations » est nul", async () => {
    const { http } = fakeHttp([{ data: { locations: null } }]);
    await expect(
      adapter.updateStock(ctxSansEmplacement(http), annonce, 4),
    ).rejects.toThrow(/emplacement de stock lisible/);
  });
});

describe("temps réel", () => {
  it("relit l'inventaire sur un changement de stock", () => {
    const r = (topic: string) =>
      adapter.webhookResync(
        new Request("https://x/", { headers: { "X-Shopify-Topic": topic } }),
      );
    // Le sujet qui fait toute la différence : Shopify le pousse même quand la
    // quantité est saisie à la main dans l'administration.
    expect(r("inventory_levels/update")).toEqual(["inventory"]);
    expect(r("products/update")).toEqual(["inventory"]);
    expect(r("inventory_items/update")).toEqual(["inventory"]);
  });

  it("ne relit rien sur une commande, déjà traduite en événement", () => {
    const r = adapter.webhookResync(
      new Request("https://x/", {
        headers: { "X-Shopify-Topic": "orders/create" },
      }),
    );
    // Une vente porte déjà toute son information : relire serait un
    // aller-retour pour rien, et retarderait la propagation.
    expect(r).toEqual([]);
  });

  it("ne relit rien sans en-tête de sujet", () => {
    expect(adapter.webhookResync(new Request("https://x/"))).toEqual([]);
  });

  it("accepte un webhook signé avec le secret client", async () => {
    // Un webhook créé PAR l'application est signé avec le secret de
    // l'application. Sans ce repli, activer le temps réel exigerait de saisir
    // une valeur qu'on possède déjà.
    const corps = JSON.stringify({ id: 1, line_items: [] });
    const cle = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("secret-client"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      cle,
      new TextEncoder().encode(corps),
    );
    const hmac = btoa(String.fromCharCode(...new Uint8Array(sig)));

    const ctx: MarketplaceContext = {
      account: {
        id: "acc1",
        marketplace: "shopify",
        slug: "s",
        displayName: "s",
        enabled: true,
      },
      credentials: { clientSecret: "secret-client" },
    };
    const req = new Request("https://x/", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Webhook-Id": "w1",
      },
      body: corps,
    });

    const events = await adapter.verifyAndParseWebhook(ctx, req, corps);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("paid");
  });
});

describe("abonnement aux webhooks", () => {
  const ctxAbo = (http: MarketplaceContext["http"]): MarketplaceContext => ({
    account: {
      id: "acc1",
      marketplace: "shopify",
      slug: "s",
      displayName: "s",
      enabled: true,
      externalAccountId: "test.myshopify.com",
    },
    credentials: {
      shopDomain: "test.myshopify.com",
      accessToken: "shpat_fake",
      clientSecret: "secret-client",
    },
    http,
  });

  const RAPPEL = "https://exemple.fr/api/webhooks/shopify";

  function reponsesPourTousLesSujets(dejaLa: string[] = []) {
    return [
      {
        data: {
          webhookSubscriptions: {
            nodes: dejaLa.map((t, i) => ({
              id: `gid://x/${i}`,
              topic: t,
              endpoint: { callbackUrl: RAPPEL },
            })),
          },
        },
      },
      ...Array.from({ length: 6 }, () => ({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: { id: "gid://x/new" },
            userErrors: [],
          },
        },
      })),
    ];
  }

  it("crée les six sujets sur une boutique vierge", async () => {
    const { http, sent } = fakeHttp(reponsesPourTousLesSujets());
    const r = await shopifyEnsureWebhooks(adapter, ctxAbo(http), RAPPEL);

    expect(r.crees).toEqual([...SHOPIFY_WEBHOOK_TOPICS]);
    expect(r.echecs).toHaveLength(0);
    // Le stock en fait partie : c'est tout l'objet de l'opération.
    expect(r.crees).toContain("INVENTORY_LEVELS_UPDATE");
    expect(sent[1]?.body.variables.sub.callbackUrl).toBe(RAPPEL);
  });

  it("ne recrée jamais un abonnement déjà posé", async () => {
    const { http } = fakeHttp(
      reponsesPourTousLesSujets(["INVENTORY_LEVELS_UPDATE", "ORDERS_CREATE"]),
    );
    const r = await shopifyEnsureWebhooks(adapter, ctxAbo(http), RAPPEL);

    // Shopify n'a pas de « créer ou remplacer » : recréer duplique, et chaque
    // événement arriverait alors en double.
    expect(r.dejaLa).toEqual(["INVENTORY_LEVELS_UPDATE", "ORDERS_CREATE"]);
    expect(r.crees).toHaveLength(4);
  });

  it("ignore un abonnement du même sujet pointant ailleurs", async () => {
    const { http } = fakeHttp([
      {
        data: {
          webhookSubscriptions: {
            nodes: [
              {
                id: "gid://x/0",
                topic: "ORDERS_CREATE",
                endpoint: { callbackUrl: "https://autre-app.example/hook" },
              },
            ],
          },
        },
      },
      ...Array.from({ length: 6 }, () => ({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: { id: "gid://x/n" },
            userErrors: [],
          },
        },
      })),
    ]);
    const r = await shopifyEnsureWebhooks(adapter, ctxAbo(http), RAPPEL);
    // Il appartient peut-être à une autre application : on ne le touche pas,
    // on pose le nôtre à côté.
    expect(r.crees).toContain("ORDERS_CREATE");
    expect(r.dejaLa).toHaveLength(0);
  });

  it("continue quand un sujet est refusé", async () => {
    const reponses = reponsesPourTousLesSujets();
    reponses[1] = {
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: null,
          userErrors: [{ message: "Address is invalid" }],
        },
      },
    } as never;
    const { http } = fakeHttp(reponses);
    const r = await shopifyEnsureWebhooks(adapter, ctxAbo(http), RAPPEL);

    // Le temps réel sur cinq sujets vaut mieux que rien sur six.
    expect(r.echecs).toHaveLength(1);
    expect(r.crees).toHaveLength(5);
  });

  it("refuse une adresse de rappel non chiffrée", async () => {
    const { http, sent } = fakeHttp([]);
    await expect(
      shopifyEnsureWebhooks(adapter, ctxAbo(http), "http://exemple.fr/hook"),
    ).rejects.toThrow(/HTTPS/);
    // Rien n'a été tenté : la vérification est en amont de tout appel.
    expect(sent).toHaveLength(0);
  });
});

describe("création avec déclinaisons", () => {
  const MULTI: Product = {
    id: "p1",
    sku: "SUPPORT",
    title: "Support téléphone",
    price: { amount: 990, currency: "EUR" },
    stock: 0,
    images: ["https://exemple.fr/a.jpg"],
    options: [{ name: "Couleur", values: ["Violet", "Noir"] }],
    variants: [
      {
        id: "v1",
        productId: "p1",
        sku: "SUP-VIO",
        optionValues: ["Violet"],
        optionKey: "couleur=violet",
        price: { amount: 990, currency: "EUR" },
        position: 0,
        status: "active",
        marketplaceData: { stock: 6 },
      },
      {
        id: "v2",
        productId: "p1",
        sku: "SUP-NOI",
        optionValues: ["Noir"],
        optionKey: "couleur=noir",
        price: { amount: 1090, currency: "EUR" },
        position: 1,
        status: "active",
        marketplaceData: { stock: 4 },
      },
    ],
  };

  it("crée UNE annonce avec ses options et ses deux coloris", async () => {
    const { http, sent } = fakeHttp([
      {
        data: {
          productCreate: {
            product: { id: "gid://shopify/Product/1", variants: { nodes: [] } },
            userErrors: [],
          },
        },
      },
      // Pas de lecture d'emplacement : le contexte de test en a déjà un en
      // cache dans ses identifiants.
      {
        data: {
          productVariantsBulkCreate: {
            productVariants: [
              {
                id: "gid://v/1",
                selectedOptions: [{ name: "Couleur", value: "Violet" }],
                inventoryItem: { id: "gid://ii/1" },
              },
              {
                id: "gid://v/2",
                selectedOptions: [{ name: "Couleur", value: "Noir" }],
                inventoryItem: { id: "gid://ii/2" },
              },
            ],
            userErrors: [],
          },
        },
      },
    ]);

    const r = await adapter.createListing(ctxWith(http), MULTI, "k");

    // Un seul produit chez Shopify, pas deux annonces concurrentes.
    const creations = sent.filter((x) => String(x.body.query).includes("productCreate"));
    expect(creations).toHaveLength(1);

    const opts = creations[0]?.body.variables.input.productOptions;
    expect(opts?.[0]?.name).toBe("Couleur");
    expect(opts?.[0]?.values).toHaveLength(2);
    expect(r.status).toBe("success");

    // Le stock de CHAQUE coloris part, et il est distinct. C'est le défaut
    // qu'une revue a trouvé : la valeur était lue sur la variante et écrite
    // nulle part, donc les dix-sept coloris arrivaient à zéro, invendables.
    const lot = sent.find((x) =>
      String(x.body.query).includes("productVariantsBulkCreate"),
    );
    const quantites = (lot?.body.variables.variants ?? []).map(
      (v: { inventoryQuantities?: Array<{ availableQuantity: number }> }) =>
        v.inventoryQuantities?.[0]?.availableQuantity,
    );
    expect(quantites).toEqual([6, 4]);
  });

  it("refuse une mise à jour de stock qui écraserait les autres coloris", async () => {
    // La valeur mémorisée est celle de la PREMIÈRE variante : l'écrire
    // laisserait les autres à zéro, sans erreur, pour toujours.
    const { http, sent } = fakeHttp([]);
    const r = await adapter.updateStock(
      ctxWith(http),
      {
        ...listing,
        marketplaceData: {
          productId: "gid://shopify/Product/1",
          variants: [{ id: "gid://v/1" }, { id: "gid://v/2" }],
        },
      },
      5,
    );
    expect(r.status).toBe("unsupported");
    expect(r.message).toMatch(/déclinaisons/);
    expect(sent).toHaveLength(0);
  });
});

/** Une variante de chez nous, telle que le cœur la transmet au module. */
function variante(optionKey: string, valeurs: string[], sku?: string): Variant {
  return {
    id: `v-${optionKey}`,
    productId: "p1",
    ...(sku ? { sku } : {}),
    optionValues: valeurs,
    optionKey,
    price: { amount: 1990, currency: "EUR" },
    position: 0,
    status: "active",
  };
}

describe("stock d'une déclinaison", () => {
  /**
   * Chaque variante Shopify a son propre article d'inventaire.
   * `marketplaceData.inventoryItemId` est celui de la PREMIÈRE — pratique
   * pour une annonce simple, faux dès qu'il y en a dix-sept.
   */
  const groupe: Listing = {
    id: "l-grp",
    productId: "p1",
    accountId: "acc-shopify",
    remoteId: "gid://shopify/ProductVariant/1",
    status: "active",
    price: { amount: 1990, currency: "EUR" },
    stock: 9,
    marketplaceData: {
      productId: "gid://shopify/Product/9",
      inventoryItemId: "gid://shopify/InventoryItem/1",
      variants: [
        { id: "gid://shopify/ProductVariant/1", optionKey: "couleur=noir", inventoryItemId: "gid://shopify/InventoryItem/1" },
        { id: "gid://shopify/ProductVariant/2", optionKey: "couleur=blanc", inventoryItemId: "gid://shopify/InventoryItem/2" },
      ],
    },
  };

  it("écrit sur l'article d'inventaire du coloris visé", async () => {
    // Le journal de ce fichier prend les réponses telles quelles, et le
    // contexte fournit déjà l'emplacement : un seul appel suffit.
    const { http, sent } = fakeHttp([
      { data: { inventorySetQuantities: { userErrors: [] } } },
    ]);
    const r = await adapter.updateStock(
      ctxWith(http),
      groupe,
      6,
      "k",
      variante("couleur=blanc", ["Blanc"]),
    );

    expect(r.status).toBe("success");
    const mutation = sent.find((x) =>
      String(x.body?.query ?? "").includes("inventorySetQuantities"),
    );
    const q = mutation?.body.variables.input.quantities[0];
    // Le BLANC. Sans ciblage, la quantité partait sur le noir.
    expect(q.inventoryItemId).toBe("gid://shopify/InventoryItem/2");
    expect(q.quantity).toBe(6);
  });

  it("refuse d'écrire sur un produit décliné sans savoir quel coloris", async () => {
    const { http, sent } = fakeHttp([]);
    const r = await adapter.updateStock(ctxWith(http), groupe, 6, "k");

    expect(r.status).toBe("unsupported");
    expect(sent).toHaveLength(0);
  });

  it("refuse nommément une déclinaison absente de l'annonce", async () => {
    const { http, sent } = fakeHttp([]);
    const r = await adapter.updateStock(
      ctxWith(http),
      groupe,
      6,
      "k",
      variante("couleur=rouge", ["Rouge"]),
    );

    expect(r.status).toBe("unsupported");
    expect(r.message).toContain("rouge");
    expect(sent).toHaveLength(0);
  });
});
