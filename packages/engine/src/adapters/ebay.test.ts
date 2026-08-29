import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aspectsCommuns, EbayAdapter, lireRefusGroupe, ebayConsentUrl } from "./ebay.js";
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


/*
 * AUCUN APPEL RÉSEAU RÉEL DANS CE FICHIER.
 *
 * Tout passe par le faux http des décors — sauf le jeton applicatif, qui
 * part par le fetch GLOBAL quand un test ne le fournit pas en cache. Trois
 * tests devenaient alors intermittents : verts quand ebay.com répondait
 * vite, rouges au timeout. Un test qui dépend de la météo d'un serveur
 * distant ne prouve plus rien ; ici, le fetch global échoue immédiatement,
 * et le pré-vol retombe sur son échec ouvert — rapide et déterministe.
 */
beforeAll(() => {
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("réseau réel interdit dans les tests")),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

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

  it("sait pousser, mais ne pousse pas tant qu'on ne l'a pas abonné", () => {
    /*
     * DEUX QUESTIONS, PAS UNE.
     *
     * « eBay sait-il pousser ? » — oui, toujours. « Cette boutique-ci
     * pousse-t-elle ? » — seulement si l'abonnement a été créé.
     *
     * Les confondre coûtait dans les deux sens : le diagnostic ne pouvait
     * plus dire « cette plateforme pourrait pousser, personne ne le lui a
     * demandé », et le relevé lisait la capacité pour décider sa cadence.
     */
    const capacites = adapter.capabilities(ctxWith(undefined));
    expect(capacites.inboundSales).toBe("both");
    expect(capacites.pousseActive).toBe(false);
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

  it("en répétition, vérifie tout et n'écrit RIEN chez eBay", async () => {
    /*
     * Une offre créée puis abandonnée n'est pas gratuite : elle occupe le
     * plafond d'annonces du vendeur et laisse un objet d'inventaire que la
     * synchronisation retrouvera. Vérifier ne doit rien créer.
     */
    const { http, sent } = fakeHttp([]);

    const r = await adapter.createListing(
      { ...ctxWith(http, { ...PUBLIABLE, defaultCategoryId: "1234" }), dryRun: true },
      {
        id: "p1",
        sku: "NEW-1",
        title: "Article de test",
        price: { amount: 1990, currency: "EUR" },
        stock: 4,
        condition: "used_good",
        images: ["https://exemple.fr/photo.jpg"],
      },
      "k",
    );

    expect(r.status).toBe("success");
    expect(r.remoteId).toBeUndefined();
    expect(sent.filter((x) => x.method !== "GET")).toHaveLength(0);
  });

  it("en répétition, refuse pour les mêmes raisons qu'une vraie tentative", async () => {
    // Sans état déclaré, eBay refuse — et la répétition doit le dire avec
    // exactement le même message, sinon les deux réponses divergeront un jour.
    const sansEtat = {
      id: "p1",
      sku: "NEW-1",
      title: "Article de test",
      price: { amount: 1990, currency: "EUR" },
      stock: 4,
      images: ["https://exemple.fr/photo.jpg"],
    };
    const creds = { ...PUBLIABLE, defaultCategoryId: "1234" };

    const vrai = await adapter.createListing(
      ctxWith(fakeHttp([]).http, creds),
      sansEtat,
      "k",
    );
    const repete = await adapter.createListing(
      { ...ctxWith(fakeHttp([]).http, creds), dryRun: true },
      sansEtat,
      "k",
    );

    expect(repete.status).toBe(vrai.status);
    expect(repete.message).toBe(vrai.message);
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

describe("réparer une annonce refusée pour caractéristique manquante", () => {
  const annonce: Listing = {
    id: "l-rep",
    productId: "p1",
    accountId: "acc-ebay",
    remoteId: "SKU-REP",
    status: "inactive",
    price: { amount: 599, currency: "EUR" },
    stock: 12,
    marketplaceData: { offerId: "off-rep" },
  };
  const fiche: Product = {
    id: "p1",
    sku: "SKU-REP",
    title: "Clip range câble",
    price: { amount: 599, currency: "EUR" },
    stock: 12,
    condition: "new",
    images: ["https://exemple.fr/p.jpg"],
    marketplaceData: { ebayAspects: { Marque: "Sans marque" } },
  };

  it("réécrit l'article avec les caractéristiques puis republie, une fois", async () => {
    /*
     * LE PIÈGE DU BROUILLON NÉ INCOMPLET.
     *
     * L'article a été créé chez eBay AVANT que « Marque » soit renseignée.
     * eBay refuse le publish en 25002 — et rejouer l'activation rejouait le
     * même refus pour toujours : rien ne réécrivait jamais l'article distant.
     * Le seul débouché était de supprimer le brouillon à la main chez eBay.
     *
     * Attendu : publish (refusé 25002) → PUT de l'article AVEC les
     * caractéristiques de la fiche → second publish, réussi.
     */
    const { http, sent } = fakeHttp([
      {
        status: 400,
        body: {
          errors: [
            {
              errorId: 25002,
              message: "La caractéristique de l'objet Marque est manquante.",
            },
          ],
        },
      },
      { status: 204, body: {} },
      { body: { listingId: "9988" } },
    ]);

    const r = await adapter.activateListing(ctxWith(http), annonce, "i", fiche);

    expect(r.status).toBe("success");
    expect(r.remoteId).toBe("9988");
    expect(sent.map((a) => a.method)).toEqual(["POST", "PUT", "POST"]);
    expect(sent[1]?.url).toContain("/inventory_item/SKU-REP");
    expect(sent[1]?.body.product.aspects).toEqual({
      Marque: ["Sans marque"],
    });
    // La quantité réécrite est celle de l'ANNONCE, pas un zéro par défaut.
    expect(
      sent[1]?.body.availability.shipToLocationAvailability.quantity,
    ).toBe(12);
  });

  it("nomme la liste COMPLÈTE des caractéristiques manquantes avant de publier", async () => {
    /*
     * eBay les révèle une par une : un refus 25002 par essai, sur un
     * brouillon créé la veille — la création, seule à porter le pré-vol,
     * ne se rejoue pas. Le contrôle doit donc vivre à la publication, et
     * dire TOUT ce qui manque en un seul message.
     */
    const { http, sent } = fakeHttp([
      // Le catalogue des caractéristiques de la catégorie, seul appel :
      // le jeton applicatif est fourni en cache — il part par fetch global,
      // invisible pour ce faux http.
      {
        body: {
          aspects: [
            { localizedAspectName: "Type", aspectConstraint: { aspectRequired: true } },
            { localizedAspectName: "Matière", aspectConstraint: { aspectRequired: true } },
            { localizedAspectName: "Marque", aspectConstraint: { aspectRequired: true } },
          ],
        },
      },
    ]);

    const r = await adapter.activateListing(
      ctxWith(http, {
        categoryTreeId: "3",
        defaultCategoryId: "9999",
        appToken: "app",
        appTokenExpiresAt: FUTUR,
      }),
      annonce,
      "i",
      fiche, // porte Marque, pas Type ni Matière
    );

    expect(r.status).toBe("manual_required");
    expect(r.message).toContain("Type");
    expect(r.message).toContain("Matière");
    expect(r.message).not.toMatch(/Marque[^s]/);
    // Aucune publication tentée : le refus est venu AVANT l'appel.
    expect(sent.some((a) => a.url.includes("publish"))).toBe(false);
  });

  it("rapporte « déjà en ligne » comme un succès, pas comme une panne", async () => {
    // L'activation se rejoue quand la preuve de vitrine manque : eBay
    // répond alors que l'offre est déjà publiée. L'état voulu est atteint.
    const { http } = fakeHttp([
      {
        status: 400,
        body: {
          errors: [
            { errorId: 25016, message: "This offer is already published." },
          ],
        },
      },
    ]);
    const r = await adapter.activateListing(ctxWith(http), annonce, "i");
    expect(r.status).toBe("success");
    expect(r.message).toMatch(/déjà en ligne/i);
  });

  it("traduit en geste le refus qui SURVIT à la réécriture", async () => {
    /*
     * Après réécriture complète, un second 25002 a un sens précis : la
     * caractéristique n'est pas dans la SAISIE — la transmission, elle,
     * vient d'être refaite. Le texte brut d'eBay ferait chercher un défaut
     * de transmission qui n'existe plus ; le message doit nommer la
     * caractéristique et l'écran où la remplir.
     */
    const refus = {
      status: 400,
      body: {
        errors: [
          {
            errorId: 25002,
            longMessage:
              "La caractéristique de l'objet Type est manquante. Ajoutez Type à cette annonce, saisissez une valeur valide, puis réessayez.",
          },
        ],
      },
    };
    const { http, sent } = fakeHttp([
      refus, // publish n° 1
      { status: 204, body: {} }, // réécriture de l'article
      refus, // publish n° 2 : la fiche ne porte toujours pas Type
    ]);

    const r = await adapter.activateListing(ctxWith(http), annonce, "i", fiche);

    expect(r.status).toBe("manual_required");
    expect(r.message).toContain("« Type »");
    expect(r.message).toContain("Publier");
    expect(sent).toHaveLength(3);
  });

  it("répare aussi quand la couche HTTP LÈVE au lieu de rendre la réponse", async () => {
    /*
     * LA COMPOSITION DE PRODUCTION, PAS CELLE DES TESTS.
     *
     * En production, la couche HTTP du worker intercepte les non-2xx AVANT
     * l'adaptateur et lève une erreur générique — le corps d'eBay n'y survit
     * que comme texte : « ebay 400 : {"errors":[{"errorId":25002,...}]} ».
     * Tous les tests précédents rendaient la Response : la réparation était
     * verte ici et morte en production, où l'utilisateur a revu trois fois
     * le même refus brut. Ce décor-là lève, comme le vrai.
     */
    let appels = 0;
    const http = async (url: string, init?: RequestInit) => {
      appels += 1;
      if (String(url).includes("/publish") && appels === 1) {
        // Backticks : la phrase d'eBay porte une apostrophe.
        throw new Error(
          `ebay 400 : {"errors":[{"errorId":25002,"domain":"API_INVENTORY","message":"La caractéristique de l${"'"}objet Marque est manquante."}]}`,
        );
      }
      return new Response(
        String(url).includes("/publish")
          ? JSON.stringify({ listingId: "7777" })
          : null,
        { status: String(url).includes("/publish") ? 200 : 204 },
      );
    };

    const r = await adapter.activateListing(
      ctxWith(http as MarketplaceContext["http"]),
      annonce,
      "i",
      fiche,
    );

    expect(r.status).toBe("success");
    expect(r.remoteId).toBe("7777");
    expect(appels).toBe(3); // publish refusé, réécriture, publish réussi
  });

  it("sans la fiche, le refus est rendu tel quel — pas de réécriture aveugle", async () => {
    const { http, sent } = fakeHttp([
      {
        status: 400,
        body: { errors: [{ errorId: 25002, message: "Marque manquante" }] },
      },
    ]);
    await expect(
      adapter.activateListing(ctxWith(http), annonce, "i"),
    ).rejects.toThrow(/Marque/);
    expect(sent).toHaveLength(1);
  });

  it("un refus qui n'est PAS un 25002 n'est jamais « réparé »", async () => {
    // Réécrire l'article sur n'importe quel refus transformerait une panne
    // passagère en écriture non demandée chez le marchand.
    const { http, sent } = fakeHttp([
      {
        status: 400,
        body: { errors: [{ errorId: 25001, message: "Autre refus" }] },
      },
    ]);
    await expect(
      adapter.activateListing(ctxWith(http), annonce, "i", fiche),
    ).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
});

describe("aspects communs face aux axes de variation", () => {
  it("écarte du groupe l'aspect qui porte le nom d'un axe", () => {
    /*
     * LE CAS RÉEL : l'écran des caractéristiques liste « Couleur » parce que
     * la catégorie l'exige — et l'utilisateur la remplit (« Blanc »), alors
     * que Couleur est l'AXE du groupe. Un aspect partagé qui contredit l'axe
     * fait refuser le groupe entier par eBay, sur une saisie que l'écran
     * avait lui-même invitée. La valeur vraie vit dans les déclinaisons.
     */
    const produit: Product = {
      id: "p1",
      sku: "GRP-1",
      title: "Clip",
      price: { amount: 599, currency: "EUR" },
      stock: 12,
      options: [{ name: "Couleur", values: ["Noir", "Vert", "Blanc"] }],
      marketplaceData: {
        ebayAspects: {
          Marque: "Sans marque/Générique",
          Type: "Magnétique",
          Couleur: "Blanc",
          Fixation: "Magnétique",
        },
      },
    };
    expect(aspectsCommuns(produit)).toEqual({
      Marque: ["Sans marque/Générique"],
      Type: ["Magnétique"],
      Fixation: ["Magnétique"],
    });
  });
});

describe("supprimer libère les références", () => {
  it("efface les articles d'inventaire du groupe, pas seulement le groupe", async () => {
    /*
     * LA RÉFÉRENCE BRÛLÉE À VIE.
     *
     * Supprimer le groupe ne supprime PAS les articles d'inventaire : les
     * SKU survivent chez eBay, invisibles. Republier le même produit se
     * heurtait alors à « ce SKU existe déjà chez eBay » — et le vendeur
     * devait changer de référence pour un article qu'il possède toujours.
     * Constaté en base après une vraie suppression.
     */
    const groupe: Listing = {
      id: "l-grp",
      productId: "p1",
      accountId: "acc-ebay",
      remoteId: "GRP-1",
      status: "active",
      price: { amount: 599, currency: "EUR" },
      stock: 5,
      marketplaceData: {
        inventoryItemGroupKey: "GRP-1",
        offers: { "GRP-1-N": "o1", "GRP-1-B": "o2" },
      },
    };

    const { http, sent } = fakeHttp([
      { status: 204, body: {} }, // retrait préalable
      { status: 204, body: {} }, // suppression du groupe
      { status: 204, body: {} }, // article noir
      { status: 204, body: {} }, // article blanc
    ]);

    const r = await adapter.deleteListing(ctxWith(http), groupe, "i");
    expect(r.status).toBe("success");

    const effaces = sent
      .filter((a) => a.method === "DELETE" && a.url.includes("/inventory_item/"))
      .map((a) => decodeURIComponent(a.url.split("/inventory_item/")[1] ?? ""));
    expect(effaces.sort()).toEqual(["GRP-1-B", "GRP-1-N"]);
    expect(r.message).toMatch(/2 référence\(s\) libérée/);
  });

  it("ne fait pas échouer la suppression quand un SKU résiste", async () => {
    // L'annonce est déjà partie : c'est l'essentiel. Un SKU récalcitrant se
    // signale, il n'annule pas une suppression accomplie.
    const groupe: Listing = {
      id: "l-grp", productId: "p1", accountId: "acc-ebay", remoteId: "GRP-1",
      status: "active", price: { amount: 599, currency: "EUR" }, stock: 5,
      marketplaceData: { inventoryItemGroupKey: "GRP-1", offers: { "GRP-1-N": "o1" } },
    };
    const { http } = fakeHttp([
      { status: 204, body: {} },
      { status: 204, body: {} },
      { status: 400, body: { errors: [{ errorId: 25001, message: "occupé" }] } },
    ]);

    const r = await adapter.deleteListing(ctxWith(http), groupe, "i");
    expect(r.status).toBe("success");
    expect(r.message).toMatch(/restent occupées/);
  });
});

describe("restaurer une déclinaison retirée par eBay", () => {
  it("réécrit le groupe amputé avant de publier", async () => {
    /*
     * LE CAS VÉCU, CONSTATÉ SUR L'ANNONCE.
     *
     * eBay supprime d'une annonce à déclinaisons celle dont la quantité tombe
     * à zéro. Le menu ne proposait plus que « Blanc (En rupture de stock) » —
     * le noir avait disparu, et toute écriture de quantité sur lui échouait
     * en 25004. La préférence « rester actif en rupture » évite que ça se
     * reproduise, mais ne rend pas ce qui est déjà parti.
     */
    const produit: Product = {
      id: "p1",
      sku: "GRP-1",
      title: "Clip",
      price: { amount: 599, currency: "EUR" },
      stock: 25,
      condition: "new",
      images: ["https://ex.fr/p.jpg"],
      options: [{ name: "Couleur", values: ["Noir", "Blanc"] }],
      variants: [
        {
          ...variante("couleur=noir", ["Noir"], "GRP-1-N"),
          marketplaceData: { stock: 20 },
        },
        {
          ...variante("couleur=blanc", ["Blanc"], "GRP-1-B"),
          marketplaceData: { stock: 19 },
        },
      ],
    };
    const groupe: Listing = {
      id: "l-grp",
      productId: "p1",
      accountId: "acc-ebay",
      remoteId: "GRP-1",
      status: "inactive",
      price: { amount: 599, currency: "EUR" },
      stock: 25,
      marketplaceData: {
        inventoryItemGroupKey: "GRP-1",
        offers: { "GRP-1-N": "o1", "GRP-1-B": "o2" },
      },
    };

    const { http, sent } = fakeHttp([
      // Le groupe tel qu'eBay le détient : le noir n'y est plus.
      { body: { variantSKUs: ["GRP-1-B"] } },
      { status: 204, body: {} }, // réécriture du groupe
      { status: 204, body: {} }, // quantité du noir
      { status: 204, body: {} }, // quantité du blanc
      { body: { listingId: "5566" } }, // publication
    ]);

    const r = await adapter.activateListing(
      ctxWith(http, { categoryTreeId: "3", appToken: "app", appTokenExpiresAt: FUTUR }),
      groupe,
      "i",
      produit,
    );

    expect(r.status).toBe("success");
    const ecriture = sent.find(
      (a) => a.method === "PUT" && a.url.includes("/inventory_item_group/"),
    );
    expect(ecriture).toBeDefined();
    // La liste ENTIÈRE est renvoyée : le PUT est un remplacement complet.
    expect(ecriture!.body.variantSKUs).toEqual(["GRP-1-N", "GRP-1-B"]);

    /*
     * ET LEUR QUANTITÉ AVEC. Publier ne fait que rendre visible ce qu'eBay
     * détient : une annonce couchée pour rupture y est à zéro, et republier
     * sans réécrire la ramènerait « en rupture de stock », marchandise en
     * main. C'est exactement ce qui a été constaté.
     */
    const quantites = sent
      .filter((a) => a.url.includes("bulk_update_price_quantity"))
      .map((a) => a.body.requests[0]);
    expect(quantites).toHaveLength(2);
    expect(quantites[0].shipToLocationAvailability.quantity).toBe(20);
    expect(quantites[0].offers[0]).toEqual({
      offerId: "o1",
      availableQuantity: 20,
    });
    expect(quantites[1].shipToLocationAvailability.quantity).toBe(19);
  });

  it("ne touche à rien quand le groupe est complet", async () => {
    // Une réécriture inutile est une écriture chez le marchand : on lit, on
    // compare, et on s'abstient.
    const produit: Product = {
      id: "p1", sku: "GRP-1", title: "Clip",
      price: { amount: 599, currency: "EUR" }, stock: 25, condition: "new",
      images: ["https://ex.fr/p.jpg"],
      options: [{ name: "Couleur", values: ["Noir", "Blanc"] }],
      variants: [
        variante("couleur=noir", ["Noir"], "GRP-1-N"),
        variante("couleur=blanc", ["Blanc"], "GRP-1-B"),
      ],
    };
    const groupe: Listing = {
      id: "l-grp", productId: "p1", accountId: "acc-ebay", remoteId: "GRP-1",
      status: "inactive", price: { amount: 599, currency: "EUR" }, stock: 25,
      marketplaceData: { inventoryItemGroupKey: "GRP-1", offers: { "GRP-1-N": "o1" } },
    };

    const { http, sent } = fakeHttp([
      { body: { variantSKUs: ["GRP-1-N", "GRP-1-B"] } },
      { body: { listingId: "5566" } },
    ]);
    // Aucune quantité connue sur ces variantes : rien à réécrire.

    await adapter.activateListing(
      ctxWith(http, { categoryTreeId: "3", appToken: "app", appTokenExpiresAt: FUTUR }),
      groupe,
      "i",
      produit,
    );

    expect(
      sent.some((a) => a.method === "PUT" && a.url.includes("/inventory_item_group/")),
    ).toBe(false);
  });
});

describe("lisibilité d'un refus d'écriture groupée", () => {
  it("extrait le message long au lieu de rendre le JSON tronqué", () => {
    /*
     * LE CAS VÉCU. `bulk_update_price_quantity` rend un TABLEAU de réponses —
     * une par objet touché, l'article puis l'offre. La couche HTTP recopie ce
     * corps brut et le tronque : l'utilisateur reçoit un pavé coupé au milieu
     * du seul champ qui explique quelque chose. Le message français d'eBay
     * était là, invisible.
     */
    const brut =
      `ebay 400 : {"responses":[{"statusCode":400,"sku":"ALI-643"},` +
      `{"statusCode":400,"sku":"ALI-643","offerId":"248362810011","errors":` +
      `[{"errorId":25004,"domain":"API_INVENTORY","longMessage":` +
      `"Quantite disponible inferieure a celle de l annonce eBay."}]}]}`;

    expect(lireRefusGroupe(brut)).toBe(
      "ALI-643 : Quantite disponible inferieure a celle de l annonce eBay. (25004)",
    );
  });

  it("rend le message d'origine quand la forme n'est pas celle attendue", () => {
    // Un refus qui n'est pas une écriture groupée ne doit pas être avalé :
    // mieux vaut un texte brut qu'un message vidé de sa substance.
    expect(lireRefusGroupe("ebay 500 : passerelle indisponible")).toBe(
      "ebay 500 : passerelle indisponible",
    );
    expect(lireRefusGroupe('ebay 400 : {"pas":"la bonne forme"}')).toBe(
      'ebay 400 : {"pas":"la bonne forme"}',
    );
  });
});

describe("galerie d'un groupe à photos par coloris", () => {
  it("joint les photos des coloris à la galerie du groupe, sans doublon", async () => {
    /*
     * Quand chaque coloris a sa photo, l'axe-image est déclaré — et eBay
     * exige alors une image PAR VALEUR DE L'AXE dans la galerie du GROUPE.
     * Les photos posées sur les articles ne comptent pas pour cette règle :
     * n'envoyer que celles du parent faisait refuser un groupe pourtant
     * complet, avec un message qui parle d'images sans dire où les mettre.
     */
    const produit: Product = {
      id: "p1",
      sku: "GRP-1",
      title: "Clip",
      price: { amount: 599, currency: "EUR" },
      stock: 12,
      condition: "new",
      images: ["https://ex.fr/parent.jpg", "https://ex.fr/noir.jpg"],
      options: [{ name: "Couleur", values: ["Noir", "Vert"] }],
      variants: [
        {
          ...variante("couleur=noir", ["Noir"], "GRP-1-N"),
          imageUrl: "https://ex.fr/noir.jpg",
        },
        {
          ...variante("couleur=vert", ["Vert"], "GRP-1-V"),
          imageUrl: "https://ex.fr/vert.jpg",
        },
      ],
    };
    const { http, sent } = fakeHttp([
      // Le pré-vol lit d'abord le catalogue des caractéristiques : jeton et
      // arbre fournis en cache, sinon il partirait sur le RÉSEAU RÉEL — et
      // ce test devenait dépendant de la météo d'ebay.com.
      { body: { aspects: [] } },
      { status: 404, body: {} }, // SKU 1 libre
      { status: 404, body: {} }, // SKU 2 libre
      { status: 404, body: {} }, // groupe libre
      { status: 204, body: {} }, // item 1
      { status: 204, body: {} }, // item 2
      { status: 204, body: {} }, // groupe
      { body: { offerId: "o1" } },
      { body: { offerId: "o2" } },
    ]);

    await adapter.createListing(
      ctxWith(http, {
        ...PUBLIABLE,
        defaultCategoryId: "1234",
        appToken: "app",
        appTokenExpiresAt: FUTUR,
        categoryTreeId: "3",
      }),
      produit,
      "i",
    );

    // Le PUT, pas la sonde d'existence : les deux visent la même URL.
    const groupe = sent.find(
      (a) => a.method === "PUT" && a.url.includes("/inventory_item_group/"),
    );
    expect(groupe?.body.imageUrls).toEqual([
      "https://ex.fr/parent.jpg",
      "https://ex.fr/noir.jpg", // déjà dans la galerie : pas dupliquée
      "https://ex.fr/vert.jpg", // celle qui manquait
    ]);
  });
});

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
