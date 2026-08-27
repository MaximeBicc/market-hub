import { describe, expect, it } from "vitest";
import { EbayAdapter, ebayConsentUrl } from "./ebay.js";
import type { MarketplaceContext } from "../ports/marketplace.js";
import type { Listing, Product } from "../domain/types.js";

/**
 * Tests de l'adaptateur eBay, sur un `fetch` simulé.
 *
 * Ils valident la forme des requêtes, la gestion du jeton de 2 heures, la
 * lecture en deux temps du catalogue et l'extraction des erreurs — sans
 * toucher à un compte réel, donc sans créer d'annonce fantôme ni consommer
 * de quota.
 */

function fakeHttp(responses: Array<{ status?: number; body: unknown }>) {
  const sent: Array<{ url: string; method: string; body: any; headers: any }> = [];
  let i = 0;
  const http = async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    const r = responses[i++] ?? { body: {} };
    const status = r.status ?? 200;
    // Une reponse 204 ne peut pas porter de corps : le constructeur leve.
    // eBay repond justement 204 sur ses ecritures d'inventaire.
    return new Response(status === 204 ? null : JSON.stringify(r.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { http, sent };
}

const FUTUR = String(Math.floor(Date.now() / 1000) + 3600);

function ctxWith(
  http: MarketplaceContext["http"],
  creds: Record<string, string> = {},
  saved: Record<string, string>[] = [],
): MarketplaceContext {
  return {
    account: {
      id: "acc-ebay",
      marketplace: "ebay",
      slug: "ebay_test",
      displayName: "eBay test",
      enabled: true,
    },
    credentials: {
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rtok",
      accessToken: "atok",
      accessTokenExpiresAt: FUTUR,
      marketplaceId: "EBAY_FR",
      ...creds,
    },
    http,
    saveCredentials: async (patch) => {
      saved.push(patch);
    },
  };
}

const PUBLIABLE = {
  merchantLocationKey: "entrepot-1",
  fulfillmentPolicyId: "fp1",
  paymentPolicyId: "pp1",
  returnPolicyId: "rp1",
};

const adapter = new EbayAdapter();

describe("consentement", () => {
  it("envoie le RuName comme redirect_uri, pas une URL", () => {
    const url = ebayConsentUrl({
      clientId: "cid",
      ruName: "Mon-App-RuName-xyz",
      state: "s1",
    });
    const p = new URL(url).searchParams;
    // C'est le piège eBay : y mettre l'URL de rappel produit une erreur
    // incompréhensible côté plateforme.
    expect(p.get("redirect_uri")).toBe("Mon-App-RuName-xyz");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toContain("sell.inventory");
  });
});

describe("capacités", () => {
  it("refuse la création tant que les politiques manquent", () => {
    const c = adapter.capabilities(ctxWith(undefined));
    expect(c.listingCreate).toBe(false);
    // Le reste fonctionne : on peut lire, ajuster prix et stock, expédier.
    expect(c.stockWrite).toBe(true);
    expect(c.ordersFulfill).toBe(true);
  });

  it("autorise la création une fois le compte configuré", () => {
    const c = adapter.capabilities(ctxWith(undefined, PUBLIABLE));
    expect(c.listingCreate).toBe(true);
    expect(c.listingActivate).toBe(true);
  });

  it("annonce le relevé, pas les webhooks", () => {
    // Les notifications eBay sont signées en ECDSA et non vérifiées ici :
    // prétendre les gérer ferait manquer des ventes en silence.
    expect(adapter.capabilities(ctxWith(undefined)).inboundSales).toBe("poll");
  });
});

describe("jeton d'accès", () => {
  it("réutilise un jeton encore valide", async () => {
    const { http, sent } = fakeHttp([{ body: { inventoryItems: [] } }]);
    await adapter.testConnection(ctxWith(http));
    expect(sent).toHaveLength(1);
    expect((sent[0]?.headers as any)["Authorization"]).toBe("Bearer atok");
  });

  it("renouvelle un jeton expiré sans écraser le jeton de rafraîchissement", async () => {
    const saved: Record<string, string>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "neuf", expires_in: 7200 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const { http, sent } = fakeHttp([{ body: { inventoryItems: [] } }]);
      await adapter.testConnection(
        ctxWith(http, { accessToken: "vieux", accessTokenExpiresAt: "1" }, saved),
      );

      expect((sent[0]?.headers as any)["Authorization"]).toBe("Bearer neuf");
      expect(saved[0]?.accessToken).toBe("neuf");
      // eBay ne renvoie pas de nouveau refresh_token : l'écraser
      // déconnecterait le compte au premier renouvellement.
      expect(saved[0]).not.toHaveProperty("refreshToken");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("dit qu'il faut relier à nouveau quand le rafraîchissement est refusé", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", { status: 400 })) as typeof fetch;
    try {
      const { http } = fakeHttp([{ body: {} }]);
      await expect(
        adapter.testConnection(
          ctxWith(http, { accessToken: "vieux", accessTokenExpiresAt: "1" }),
        ),
      ).rejects.toThrow(/relié à nouveau/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("lecture du catalogue", () => {
  it("croise l'inventaire et l'offre pour obtenir stock ET prix", async () => {
    const { http, sent } = fakeHttp([
      {
        body: {
          total: 1,
          inventoryItems: [
            {
              sku: "AvionBBR",
              product: { title: "Porte-clés avion", imageUrls: ["u1"] },
              availability: { shipToLocationAvailability: { quantity: 29 } },
            },
          ],
        },
      },
      {
        body: {
          offers: [
            {
              offerId: "off-1",
              status: "PUBLISHED",
              listing: { listingId: "1234" },
              pricingSummary: { price: { value: "4.50", currency: "EUR" } },
            },
          ],
        },
      },
    ]);

    const r = await adapter.fetchListings(ctxWith(http));

    expect(r.items).toHaveLength(1);
    const item = r.items[0]!;
    // Le stock vient de l'inventaire, le prix de l'offre : eBay ne rend
    // jamais les deux d'un seul appel.
    expect(item.stock).toBe(29);
    expect(item.price.amount).toBe(450);
    expect(item.status).toBe("active");
    // Le SKU sert d'identifiant stable : l'offerId change à chaque
    // republication, le listingId n'existe qu'une fois publié.
    expect(item.remoteId).toBe("AvionBBR");
    expect(item.marketplaceData?.["offerId"]).toBe("off-1");
    expect(sent[1]?.url).toContain("offer?sku=AvionBBR");
  });

  it("importe en brouillon un article sans offre", async () => {
    const { http } = fakeHttp([
      {
        body: {
          total: 1,
          inventoryItems: [
            {
              sku: "SansOffre",
              availability: { shipToLocationAvailability: { quantity: 3 } },
            },
          ],
        },
      },
      { status: 404, body: { errors: [{ message: "not found" }] } },
    ]);

    const r = await adapter.fetchListings(ctxWith(http));
    // Un article en stock jamais mis en vente est normal, pas une panne.
    expect(r.items[0]?.status).toBe("draft");
    expect(r.items[0]?.stock).toBe(3);
  });
});

describe("écritures", () => {
  const listing: Listing = {
    id: "l1",
    productId: "p1",
    accountId: "acc-ebay",
    remoteId: "AvionBBR",
    status: "active",
    price: { amount: 450, currency: "EUR" },
    stock: 29,
    marketplaceData: { offerId: "off-1" },
  };

  it("met à jour l'inventaire ET l'offre en un seul appel", async () => {
    const { http, sent } = fakeHttp([{ status: 204, body: {} }]);
    const r = await adapter.updateStock(ctxWith(http), listing, 26);

    expect(r.status).toBe("success");
    expect(sent[0]?.url).toContain("bulk_update_price_quantity");
    const req = sent[0]?.body.requests[0];
    expect(req.shipToLocationAvailability.quantity).toBe(26);
    // Sans cette partie, l'offre publiée garderait l'ancienne quantité.
    expect(req.offers[0].availableQuantity).toBe(26);
  });

  it("refuse d'écrire un prix sans offre, en expliquant pourquoi", async () => {
    const { http } = fakeHttp([]);
    const r = await adapter.updatePrice(
      ctxWith(http),
      { ...listing, marketplaceData: {} },
      { amount: 500, currency: "EUR" },
    );
    expect(r.status).toBe("unsupported");
    expect(r.message).toMatch(/prix vit sur l'offre/);
  });

  it("crée une offre en brouillon, sans la publier", async () => {
    const { http, sent } = fakeHttp([
      // La sonde d'existence passe en premier : 404 = ce SKU est libre.
      { status: 404, body: {} },
      { status: 204, body: {} },
      { body: { offerId: "off-9" } },
    ]);

    const r = await adapter.createListing(
      ctxWith(http, { ...PUBLIABLE, defaultCategoryId: "1234" }),
      {
        id: "p1",
        sku: "NEW-1",
        title: "Article de test",
        price: { amount: 1990, currency: "EUR" },
        stock: 4,
        // L'état et la photo sont désormais exigés : sans eux, eBay refuse
        // avant tout appel réseau. Voir les tests des garde-fous plus bas.
        condition: "used_good",
        images: ["https://exemple.fr/photo.jpg"],
      },
      "k",
    );

    expect(r.status).toBe("success");
    // Publier automatiquement engagerait un contrat de vente réel sur une
    // annonce que personne n'a relue.
    expect(r.message).toMatch(/brouillon/);
    expect(sent.some((s) => s.url.includes("/publish"))).toBe(false);
    expect(sent[2]?.body.pricingSummary.price.value).toBe("19.90");
  });

  it("demande une catégorie plutôt que d'échouer obscurément", async () => {
    const { http } = fakeHttp([]);
    const r = await adapter.createListing(
      ctxWith(http, PUBLIABLE),
      {
        id: "p1",
        sku: "X",
        title: "T",
        price: { amount: 100, currency: "EUR" },
        stock: 1,
      },
      "k",
    );
    expect(r.status).toBe("manual_required");
    expect(r.message).toMatch(/catégorie/);
  });

  it("joint le transporteur dès qu'un numéro de suivi est fourni", async () => {
    const { http, sent } = fakeHttp([{ body: { fulfillmentId: "f1" } }]);
    await adapter.markShipped(ctxWith(http), {
      remoteOrderId: "12-3456-7890",
      trackingNumber: "6A123",
      carrier: "Colissimo",
    });
    expect(sent[0]?.body.trackingNumber).toBe("6A123");
    // Sans transporteur, eBay enregistre le suivi mais l'acheteur ne voit rien.
    expect(sent[0]?.body.shippingCarrierCode).toBe("Colissimo");
  });
});

describe("ventes et erreurs", () => {
  it("fabrique un identifiant d'événement stable", async () => {
    const { http } = fakeHttp([
      {
        body: {
          total: 1,
          orders: [
            {
              orderId: "12-3456",
              creationDate: "2026-08-20T10:00:00Z",
              orderPaymentStatus: "PAID",
              lineItems: [{ lineItemId: "li1", sku: "AvionBBR", quantity: 2 }],
            },
          ],
        },
      },
    ]);

    const r = await adapter.pollOrderEvents(ctxWith(http));
    expect(r.events[0]?.eventId).toBe("poll:12-3456:PAID");
    expect(r.events[0]?.kind).toBe("paid");
    expect(r.events[0]?.lines[0]?.sku).toBe("AvionBBR");
  });

  it("traduit une annulation", async () => {
    const { http } = fakeHttp([
      {
        body: {
          total: 1,
          orders: [
            {
              orderId: "12-9999",
              creationDate: "2026-08-20T10:00:00Z",
              orderPaymentStatus: "PAID",
              cancelStatus: { cancelState: "CANCELED" },
              lineItems: [],
            },
          ],
        },
      },
    ]);
    const r = await adapter.pollOrderEvents(ctxWith(http));
    expect(r.events[0]?.kind).toBe("cancelled");
  });

  it("remonte le message long d'eBay, pas un code nu", async () => {
    const { http } = fakeHttp([
      {
        status: 400,
        body: {
          errors: [
            {
              errorId: 25709,
              message: "Invalid value",
              longMessage: "La quantité doit être un entier positif.",
            },
          ],
        },
      },
    ]);
    await expect(adapter.testConnection(ctxWith(http))).rejects.toThrow(
      /quantité doit être un entier positif/,
    );
  });
});

describe("environnements", () => {
  /**
   * eBay a deux environnements complets. Un jeton de bac à sable présenté à
   * la production est refusé, avec un message qui n'explique pas la cause :
   * l'hôte doit donc suivre l'environnement partout.
   */
  it("dirige le consentement vers le bon hôte", () => {
    const prod = ebayConsentUrl({ clientId: "c", ruName: "r", state: "s" });
    const bac = ebayConsentUrl({
      clientId: "c",
      ruName: "r",
      state: "s",
      environment: "sandbox",
    });
    expect(new URL(prod).host).toBe("auth.ebay.com");
    expect(new URL(bac).host).toBe("auth.sandbox.ebay.com");
  });

  it("appelle l'API du bac à sable quand le compte y est rattaché", async () => {
    const { http, sent } = fakeHttp([{ body: { inventoryItems: [] } }]);
    await adapter.testConnection(ctxWith(http, { environment: "sandbox" }));
    expect(sent[0]?.url).toContain("api.sandbox.ebay.com");
  });

  it("reste sur la production par défaut", async () => {
    const { http, sent } = fakeHttp([{ body: { inventoryItems: [] } }]);
    await adapter.testConnection(ctxWith(http));
    expect(sent[0]?.url).toContain("api.ebay.com");
    expect(sent[0]?.url).not.toContain("sandbox");
  });
});

describe("déclarations obligatoires", () => {
  const BASE = {
    id: "p1",
    sku: "SKU-1",
    title: "Article",
    price: { amount: 1990, currency: "EUR" },
    stock: 4,
    images: ["https://exemple.fr/photo.jpg"],
  } satisfies Product;

  it("refuse de publier sans état plutôt que de déclarer « neuf »", async () => {
    // Cette valeur était codée en dur : tout article diffusé était déclaré
    // neuf, y compris de la revente d'occasion. Une fausse déclaration
    // envoyée automatiquement, que personne ne voyait passer.
    const { http, sent } = fakeHttp([]);
    const r = await adapter.createListing(
      ctxWith(http, { ...PUBLIABLE, defaultCategoryId: "1234" }),
      { ...BASE },
      "idem",
    );

    expect(r.status).toBe("manual_required");
    expect(r.message).toMatch(/état de l'article/);
    // Rien n'est parti sur le réseau : le refus précède tout appel.
    expect(sent).toHaveLength(0);
  });

  it("refuse de publier sans photo", async () => {
    const { http, sent } = fakeHttp([]);
    const r = await adapter.createListing(
      ctxWith(http, { ...PUBLIABLE, defaultCategoryId: "1234" }),
      { ...BASE, condition: "new", images: [] },
      "idem",
    );
    expect(r.status).toBe("manual_required");
    expect(r.message).toMatch(/photo/);
    expect(sent).toHaveLength(0);
  });

  it("traduit chaque état dans le vocabulaire d'eBay", async () => {
    const attendus: Array<[string, string]> = [
      ["new", "NEW"],
      ["used_good", "USED_GOOD"],
      ["for_parts", "FOR_PARTS_OR_NOT_WORKING"],
    ];
    for (const [notre, leur] of attendus) {
      const { http, sent } = fakeHttp([
        // La sonde d'existence passe en premier : 404 = ce SKU est libre.
        { status: 404, body: {} },
        { status: 204, body: {} },
        { body: { offerId: "off-1" } },
      ]);
      await adapter.createListing(
        ctxWith(http, { ...PUBLIABLE, defaultCategoryId: "1234" }),
        { ...BASE, condition: notre as never },
        "idem",
      );
      expect(sent[1]?.body.condition).toBe(leur);
    }
  });

  it("remonte l'identifiant d'offre au lieu de le noyer dans un message", async () => {
    // Sans lui, l'annonce créée n'accepte plus jamais ni changement de prix,
    // ni activation, ni retrait : l'outil crée un objet qu'il ne sait plus
    // piloter.
    const { http } = fakeHttp([
      // La sonde d'existence passe en premier : 404 = ce SKU est libre.
      { status: 404, body: {} },
      { status: 204, body: {} },
      { body: { offerId: "off-42" } },
    ]);
    const r = await adapter.createListing(
      ctxWith(http, { ...PUBLIABLE, defaultCategoryId: "1234" }),
      { ...BASE, condition: "new" },
      "idem",
    );
    expect(r.status).toBe("success");
    expect(r.marketplaceData).toMatchObject({ offerId: "off-42" });
  });
});

describe("ne jamais écraser ce qui est déjà en ligne", () => {
  const PRODUIT: Product = {
    id: "p1",
    sku: "DEJA-LA",
    title: "Article",
    price: { amount: 1990, currency: "EUR" },
    stock: 4,
    condition: "new",
    images: ["https://exemple.fr/photo.jpg"],
  };
  const CTX = { ...PUBLIABLE, defaultCategoryId: "1234" };

  it("refuse quand le SKU existe déjà chez eBay", async () => {
    // Le PUT sur inventory_item est un REMPLACEMENT COMPLET. Sur un SKU déjà
    // publié, il écrasait titre, description, photos, état, et forçait la
    // quantité — une annonce épuisée se remettait à prendre des commandes.
    const { http, sent } = fakeHttp([{ body: { sku: "DEJA-LA" } }]);
    const r = await adapter.createListing(ctxWith(http, CTX), PRODUIT, "i");

    expect(r.status).toBe("manual_required");
    expect(r.message).toMatch(/existe déjà/);
    // Une seule requête : la sonde. Rien n'a été écrit.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("GET");
  });

  it("refuse aussi quand on ne peut PAS savoir", async () => {
    // Une panne réseau ou un 500 laisse l'état inconnu. L'incertitude ne
    // justifie pas d'écrire par-dessus.
    const { http, sent } = fakeHttp([{ status: 500, body: {} }]);
    const r = await adapter.createListing(ctxWith(http, CTX), PRODUIT, "i");

    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/Impossible de vérifier/);
    expect(sent).toHaveLength(1);
  });

  it("crée normalement quand le SKU est libre", async () => {
    const { http, sent } = fakeHttp([
      { status: 404, body: {} },
      { status: 204, body: {} },
      { body: { offerId: "off-7" } },
    ]);
    const r = await adapter.createListing(ctxWith(http, CTX), PRODUIT, "i");

    expect(r.status).toBe("success");
    expect(sent[1]?.method).toBe("PUT");
  });
});

describe("annonces à déclinaisons", () => {
  /**
   * Le cœur envoie la même commande — « publie », « retire » — quelle que
   * soit la forme de l'annonce chez eBay. C'est l'adaptateur qui traduit.
   * Ces tests verrouillent la traduction, parce qu'elle est invisible depuis
   * l'orchestrateur : rien, à ce niveau-là, ne distinguerait un groupe publié
   * d'un groupe resté brouillon.
   */
  const groupe: Listing = {
    id: "l-grp",
    productId: "p1",
    accountId: "acc-ebay",
    remoteId: "GRP-CASE",
    status: "draft",
    price: { amount: 450, currency: "EUR" },
    stock: 34,
    marketplaceData: {
      inventoryItemGroupKey: "GRP-CASE",
      offers: { "GRP-CASE-1": "off-1", "GRP-CASE-2": "off-2" },
    },
  };

  const seule: Listing = {
    id: "l-off",
    productId: "p2",
    accountId: "acc-ebay",
    remoteId: "AvionBBR",
    status: "draft",
    price: { amount: 450, currency: "EUR" },
    stock: 29,
    marketplaceData: { offerId: "off-9" },
  };

  it("publie un groupe d'un seul tenant, pas offre par offre", async () => {
    const { http, sent } = fakeHttp([{ body: { listingId: "1122334455" } }]);
    const r = await adapter.activateListing(ctxWith(http), groupe);

    expect(r.status).toBe("success");
    // UN seul appel : publier offre par offre produirait deux annonces
    // distinctes au lieu d'un menu déroulant, et deux lignes du plafond.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("publish_by_inventory_item_group");
    expect(sent[0]?.body.inventoryItemGroupKey).toBe("GRP-CASE");
    expect(sent[0]?.body.marketplaceId).toBe("EBAY_FR");
    expect(r.remoteId).toBe("1122334455");
  });

  it("retire un groupe d'un seul tenant", async () => {
    const { http, sent } = fakeHttp([{ status: 204, body: {} }]);
    const r = await adapter.deactivateListing(ctxWith(http), groupe);

    expect(r.status).toBe("success");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("withdraw_by_inventory_item_group");
    expect(sent[0]?.body.inventoryItemGroupKey).toBe("GRP-CASE");
  });

  it("garde le chemin de l'offre unique pour une annonce sans déclinaison", async () => {
    const { http, sent } = fakeHttp([{ body: { listingId: "999" } }]);
    await adapter.activateListing(ctxWith(http), seule);

    expect(sent[0]?.url).toContain("/offer/off-9/publish");
    expect(sent[0]?.url).not.toContain("inventory_item_group");
  });

  it("préfère le groupe quand l'annonce porte les deux", async () => {
    /*
     * Le piège que ce test verrouille : une annonce groupée porte AUSSI une
     * carte d'offres. Choisir l'offre publierait une seule déclinaison sur
     * les deux, et l'autre resterait invisible sans que rien ne le signale.
     */
    const ambigu: Listing = {
      ...groupe,
      marketplaceData: { ...groupe.marketplaceData, offerId: "off-1" },
    };
    const { http, sent } = fakeHttp([{ body: { listingId: "77" } }]);
    await adapter.activateListing(ctxWith(http), ambigu);

    expect(sent[0]?.url).toContain("publish_by_inventory_item_group");
  });

  it("respecte la place de marché du compte", async () => {
    const { http, sent } = fakeHttp([{ status: 204, body: {} }]);
    await adapter.deactivateListing(
      ctxWith(http, { marketplaceId: "EBAY_DE" }),
      groupe,
    );

    expect(sent[0]?.body.marketplaceId).toBe("EBAY_DE");
  });

  it("dit ce qui manque plutôt que d'échouer, sans offre ni groupe", async () => {
    const { http, sent } = fakeHttp([]);
    const r = await adapter.deactivateListing(ctxWith(http), {
      ...seule,
      marketplaceData: {},
    });

    expect(r.status).toBe("unsupported");
    expect(sent).toHaveLength(0);
  });
});
