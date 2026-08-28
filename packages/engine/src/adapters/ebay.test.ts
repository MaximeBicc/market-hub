import { describe, expect, it } from "vitest";
import { EbayAdapter, ebayConsentUrl } from "./ebay.js";
import type { MarketplaceContext } from "../ports/marketplace.js";
import type { Listing, Product, Variant } from "../domain/types.js";

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
    expect(r.url).toBe("https://www.ebay.fr/itm/1122334455");
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
    const r = await adapter.activateListing(ctxWith(http), seule);

    expect(sent[0]?.url).toContain("/offer/off-9/publish");
    expect(sent[0]?.url).not.toContain("inventory_item_group");
    expect(r.url).toBe("https://www.ebay.fr/itm/999");
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
   * eBay tient son stock PAR ARTICLE D'INVENTAIRE, donc par SKU, même à
   * l'intérieur d'un groupe. Toute la difficulté est de savoir quel SKU eBay
   * correspond à quelle déclinaison de chez nous — la réponse n'est pas
   * devinable, parce que le SKU a pu être FABRIQUÉ à la création.
   */
  const groupe: Listing = {
    id: "l-grp",
    productId: "p1",
    accountId: "acc-ebay",
    remoteId: "GRP-CASE",
    status: "active",
    price: { amount: 1990, currency: "EUR" },
    stock: 34,
    marketplaceData: {
      inventoryItemGroupKey: "GRP-CASE",
      offers: { "grp-case-couleur-noir": "off-1", "grp-case-couleur-blanc": "off-2" },
      unites: [
        { optionKey: "couleur=noir", sku: "grp-case-couleur-noir", offerId: "off-1" },
        { optionKey: "couleur=blanc", sku: "grp-case-couleur-blanc", offerId: "off-2" },
      ],
    },
  };

  it("écrit sur le SKU du coloris visé, et sur son offre", async () => {
    const { http, sent } = fakeHttp([{ status: 204, body: {} }]);
    const r = await adapter.updateStock(
      ctxWith(http),
      groupe,
      12,
      "k",
      variante("couleur=blanc", ["Blanc"]),
    );

    expect(r.status).toBe("success");
    const req = sent[0]?.body.requests[0];
    // Le SKU d'eBay, pas celui de la variante : il a été fabriqué.
    expect(req.sku).toBe("grp-case-couleur-blanc");
    expect(req.shipToLocationAvailability.quantity).toBe(12);
    // L'offre du BLANC. Celle du noir garderait sa quantité d'avant.
    expect(req.offers[0].offerId).toBe("off-2");
    expect(req.offers[0].availableQuantity).toBe(12);
  });

  it("refuse d'écrire sur un groupe sans savoir quel coloris", async () => {
    const { http, sent } = fakeHttp([]);
    const r = await adapter.updateStock(ctxWith(http), groupe, 12, "k");

    expect(r.status).toBe("unsupported");
    expect(sent).toHaveLength(0);
  });

  it("refuse plutôt que de créer un article hors du groupe", async () => {
    /*
     * Le piège que ce test verrouille : sans correspondance, la tentation est
     * d'utiliser le SKU de la variante. Mais si eBay a reçu un SKU fabriqué,
     * écrire sur celui-là créerait un article d'inventaire NEUF, hors du
     * groupe, invisible dans l'annonce et pourtant facturé.
     */
    const { http, sent } = fakeHttp([]);
    const r = await adapter.updateStock(
      ctxWith(http),
      groupe,
      12,
      "k",
      variante("couleur=rouge", ["Rouge"], "SKU-ROUGE"),
    );

    expect(r.status).toBe("unsupported");
    expect(r.message).toContain("rouge");
    expect(sent).toHaveLength(0);
  });

  it("laisse une annonce sans déclinaison sur son chemin d'origine", async () => {
    const { http, sent } = fakeHttp([{ status: 204, body: {} }]);
    await adapter.updateStock(
      ctxWith(http),
      {
        id: "l1",
        productId: "p2",
        accountId: "acc-ebay",
        remoteId: "AvionBBR",
        status: "active",
        price: { amount: 450, currency: "EUR" },
        stock: 29,
        marketplaceData: { offerId: "off-9" },
      },
      26,
      "k",
      variante("", []),
    );

    expect(sent[0]?.body.requests[0].sku).toBe("AvionBBR");
    expect(sent[0]?.body.requests[0].offers[0].offerId).toBe("off-9");
  });
});

describe("durée de mise en vente", () => {
  it("pose GTC sur chaque offre, sans quoi la publication échouerait", async () => {
    const { http, sent } = fakeHttp([
      { status: 404, body: {} }, // la sonde d'existence du SKU
      { status: 204, body: {} }, // l'article d'inventaire
      { body: { offerId: "off-1" } }, // l'offre
    ]);

    await adapter.createListing(
      ctxWith(http, {
        merchantLocationKey: "e1",
        fulfillmentPolicyId: "f1",
        paymentPolicyId: "p1",
        returnPolicyId: "r1",
        defaultCategoryId: "9355",
      }),
      {
        id: "p1",
        sku: "AvionBBR",
        title: "Porte-clés avion",
        price: { amount: 450, currency: "EUR" },
        stock: 29,
        images: ["https://exemple.test/a.jpg"],
        condition: "new",
      } as unknown as Product,
      "k",
    );

    const offre = sent.find((x) => x.url.endsWith("/offer"));
    // eBay tolère l'absence à la création et l'exige à la publication : le
    // test doit donc porter sur la création, seul endroit où on peut la poser.
    expect(offre?.body.listingDuration).toBe("GTC");
    expect(offre?.body.format).toBe("FIXED_PRICE");
  });
});

describe("prix d'une déclinaison", () => {
  const groupe: Listing = {
    id: "l-grp",
    productId: "p1",
    accountId: "acc-ebay",
    remoteId: "GRP-CASE",
    status: "active",
    price: { amount: 1990, currency: "EUR" },
    stock: 34,
    marketplaceData: {
      inventoryItemGroupKey: "GRP-CASE",
      offers: { "grp-case-couleur-noir": "off-1", "grp-case-couleur-blanc": "off-2" },
      unites: [
        { optionKey: "couleur=noir", sku: "grp-case-couleur-noir", offerId: "off-1" },
        { optionKey: "couleur=blanc", sku: "grp-case-couleur-blanc", offerId: "off-2" },
      ],
    },
  };

  it("écrit sur l'offre du coloris visé", async () => {
    const { http, sent } = fakeHttp([{ status: 204, body: {} }]);
    const r = await adapter.updatePrice(
      ctxWith(http),
      groupe,
      { amount: 2490, currency: "EUR" },
      "k",
      variante("couleur=blanc", ["Blanc"]),
    );

    expect(r.status).toBe("success");
    const req = sent[0]?.body.requests[0];
    expect(req.sku).toBe("grp-case-couleur-blanc");
    expect(req.offers[0].offerId).toBe("off-2");
    expect(req.offers[0].price.value).toBe("24.90");
  });

  it("refuse un prix sur un groupe sans savoir quel coloris", async () => {
    const { http, sent } = fakeHttp([]);
    const r = await adapter.updatePrice(
      ctxWith(http),
      groupe,
      { amount: 2490, currency: "EUR" },
      "k",
    );

    expect(r.status).toBe("unsupported");
    expect(sent).toHaveLength(0);
  });
});

describe("relevé de stock allégé", () => {
  /**
   * Le point qui casse un plafond, pas seulement un quota.
   *
   * La page d'articles rend déjà les quantités ; le prix et le statut coûtent
   * un appel PAR ARTICLE. Sur un relevé de deux minutes, cinq articles au
   * catalogue suffisaient à franchir les 5 000 appels quotidiens qu'on
   * s'impose — 6 × 720 + 720 = 5 040.
   */
  const pageInventaire = {
    total: 2,
    inventoryItems: [
      {
        sku: "A1",
        product: { title: "Article un" },
        availability: { shipToLocationAvailability: { quantity: 7 } },
      },
      {
        sku: "A2",
        product: { title: "Article deux" },
        availability: { shipToLocationAvailability: { quantity: 0 } },
      },
    ],
  };

  it("ne fait plus qu'UN appel par page, quel que soit le nombre d'articles", async () => {
    const { http, sent } = fakeHttp([{ body: pageInventaire }]);
    const r = await adapter.fetchListings(ctxWith(http), undefined, {
      stockSeul: true,
    });

    // Un seul appel : la page. Zéro appel d'offre.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("inventory_item?limit=");
    expect(sent.some((x) => x.url.includes("/offer?sku="))).toBe(false);

    expect(r.items.map((i) => i.stock)).toEqual([7, 0]);
    // Le drapeau qui interdit à l'appelant d'écrire prix et statut.
    expect(r.items.every((i) => i.stockSeul)).toBe(true);
  });

  it("garde le relevé complet quand on ne demande rien", async () => {
    const { http, sent } = fakeHttp([
      { body: pageInventaire },
      { body: { offers: [{ offerId: "o1", status: "PUBLISHED", pricingSummary: { price: { value: "12.50", currency: "EUR" } } }] } },
      { body: { offers: [{ offerId: "o2", status: "PUBLISHED", pricingSummary: { price: { value: "9.90", currency: "EUR" } } }] } },
    ]);
    const r = await adapter.fetchListings(ctxWith(http));

    // Trois appels pour deux articles : c'est le N+1, assumé une fois par
    // jour parce que le prix et le statut n'existent que sur l'offre.
    expect(sent).toHaveLength(3);
    expect(r.items[0]?.price.amount).toBe(1250);
    expect(r.items[0]?.stockSeul).toBeUndefined();
  });
});
