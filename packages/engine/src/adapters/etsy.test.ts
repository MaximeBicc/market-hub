import { describe, expect, it } from "vitest";
import { EtsyAdapter, ETSY_SCOPES, etsyConsentUrl, etsyPkce } from "./etsy.js";
import type { MarketplaceContext } from "../ports/marketplace.js";
import type { Listing, Product } from "../domain/types.js";

/**
 * Tests de l'adaptateur Etsy, sur un `fetch` simulé.
 *
 * Ils portent surtout sur les quatre pièges de cette API : les deux en-têtes
 * obligatoires, l'encodage en formulaire de la création, le nettoyage de
 * l'inventaire avant réécriture, et la rotation du jeton de rafraîchissement.
 * Aucun appel réel : pas d'annonce fantôme, pas de quota consommé.
 */

function fakeHttp(responses: Array<{ status?: number; body?: unknown }>) {
  const sent: Array<{
    url: string;
    method: string;
    raw: string | null;
    headers: Record<string, string>;
  }> = [];
  let i = 0;
  const http = async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      method: init?.method ?? "GET",
      raw: init?.body ? String(init.body) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = responses[i++] ?? { body: {} };
    const status = r.status ?? 200;
    return new Response(
      status === 204 ? null : JSON.stringify(r.body ?? {}),
      { status, headers: { "Content-Type": "application/json" } },
    );
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
      id: "acc-etsy",
      marketplace: "etsy",
      slug: "etsy_test",
      displayName: "Etsy test",
      enabled: true,
    },
    credentials: {
      clientId: "keystring123",
      clientSecret: "secret",
      refreshToken: "refresh-v1",
      accessToken: "12345.atok",
      accessTokenExpiresAt: FUTUR,
      shopId: "777",
      currency: "EUR",
      ...creds,
    },
    http,
    saveCredentials: async (patch) => {
      saved.push(patch);
    },
  };
}

const PUBLIABLE = {
  shippingProfileId: "sp1",
  readinessStateId: "rs1",
  taxonomyId: "1234",
};

const annonce: Listing = {
  id: "l1",
  productId: "p1",
  accountId: "acc-etsy",
  remoteId: "999",
  status: "active",
  price: { amount: 1200, currency: "EUR" },
  stock: 3,
};

const adapter = new EtsyAdapter();

/** Décode un corps `application/x-www-form-urlencoded`. */
function form(raw: string | null): Record<string, string> {
  const o: Record<string, string> = {};
  new URLSearchParams(raw ?? "").forEach((v, k) => {
    o[k] = v;
  });
  return o;
}

describe("authentification", () => {
  it("envoie TOUJOURS les deux en-têtes", async () => {
    const { http, sent } = fakeHttp([{ body: { shop_id: 777 } }]);
    await adapter.testConnection(ctxWith(http));

    expect(sent[0]?.headers["Authorization"]).toBe("Bearer 12345.atok");
    // Oublier celui-ci renvoie un 401 qui ressemble à un jeton expiré.
    expect(sent[0]?.headers["x-api-key"]).toBe("keystring123");
  });

  it("porte la keystring seule, jamais keystring:secret", async () => {
    const { http, sent } = fakeHttp([{ body: { shop_id: 777 } }]);
    await adapter.testConnection(ctxWith(http));
    expect(sent[0]?.headers["x-api-key"]).not.toContain(":");
  });

  it("réutilise un jeton encore valide sans appel réseau", async () => {
    const { http, sent } = fakeHttp([{ body: { shop_id: 777 } }]);
    await adapter.testConnection(ctxWith(http));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("/shops/777");
  });

  it("renouvelle un jeton expiré et PERSISTE le nouveau refresh", async () => {
    const saved: Record<string, string>[] = [];
    const { http, sent } = fakeHttp([
      {
        body: {
          access_token: "12345.neuf",
          refresh_token: "refresh-v2",
          expires_in: 3600,
        },
      },
      { body: { shop_id: 777 } },
    ]);
    await adapter.testConnection(
      ctxWith(http, { accessTokenExpiresAt: "0" }, saved),
    );

    expect(sent[0]?.url).toBe("https://api.etsy.com/v3/public/oauth/token");
    expect(form(sent[0]?.raw ?? null)["grant_type"]).toBe("refresh_token");
    // Etsy fait TOURNER le refresh : ne pas garder le neuf condamne la
    // boutique à une réautorisation manuelle.
    expect(saved[0]?.["refreshToken"]).toBe("refresh-v2");
    expect(saved[0]?.["accessToken"]).toBe("12345.neuf");
  });

  it("poste le jeton en formulaire, pas en JSON", async () => {
    const { http, sent } = fakeHttp([
      { body: { access_token: "1.a", refresh_token: "r", expires_in: 3600 } },
      { body: { shop_id: 777 } },
    ]);
    await adapter.testConnection(ctxWith(http, { accessTokenExpiresAt: "0" }));
    expect(sent[0]?.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("retombe sur JSON si Etsy refuse le formulaire", async () => {
    const { http, sent } = fakeHttp([
      { status: 400, body: { error: "unsupported" } },
      { body: { access_token: "1.a", refresh_token: "r", expires_in: 3600 } },
      { body: { shop_id: 777 } },
    ]);
    await adapter.testConnection(ctxWith(http, { accessTokenExpiresAt: "0" }));
    expect(sent[1]?.headers["Content-Type"]).toBe("application/json");
    expect(sent).toHaveLength(3);
  });

  it("explique un 401 au lieu de le laisser nu", async () => {
    const { http } = fakeHttp([{ status: 401, body: {} }]);
    await expect(adapter.testConnection(ctxWith(http))).rejects.toThrow(
      /x-api-key/,
    );
  });
});

describe("PKCE", () => {
  it("produit un vérificateur conforme aux exigences d'Etsy", async () => {
    const { verifier, challenge } = await etsyPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // Etsy n'accepte que ce jeu de caractères.
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it("place le défi et la méthode dans l'URL de consentement", async () => {
    const { challenge } = await etsyPkce();
    const u = new URL(
      etsyConsentUrl({
        clientId: "k",
        redirectUri: "https://exemple.fr/cb",
        state: "s",
        codeChallenge: challenge,
      }),
    );
    expect(u.host).toBe("www.etsy.com");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(challenge);
    expect(u.searchParams.get("scope")).toBe(ETSY_SCOPES.join(" "));
  });
});

describe("capacités", () => {
  it("refuse la création tant que les profils manquent", () => {
    const c = adapter.capabilities(ctxWith(undefined));
    expect(c.listingCreate).toBe(false);
    // Le reste doit rester ouvert : c'est la création seule qui est bloquée.
    expect(c.stockWrite).toBe(true);
    expect(c.ordersRead).toBe(true);
  });

  it("ouvre la création une fois les profils renseignés", () => {
    const c = adapter.capabilities(ctxWith(undefined, PUBLIABLE));
    expect(c.listingCreate).toBe(true);
  });

  it("annonce le relevé, jamais le webhook", () => {
    expect(adapter.capabilities(ctxWith(undefined)).inboundSales).toBe("poll");
  });
});

describe("création d'annonce", () => {
  it("répond manual_required plutôt que d'échouer sans profils", async () => {
    const { http, sent } = fakeHttp([]);
    const p: Product = {
      id: "p1",
      sku: "SKU1",
      title: "Bougie",
      price: { amount: 1500, currency: "EUR" },
      stock: 4,
    };
    const r = await adapter.createListing(ctxWith(http), p, "idem");
    expect(r.status).toBe("manual_required");
    // Aucun appel réseau : on n'a rien tenté d'écrire.
    expect(sent).toHaveLength(0);
  });

  it("poste en formulaire et crée en brouillon", async () => {
    const { http, sent } = fakeHttp([{ body: { listing_id: 4242 } }]);
    const p: Product = {
      id: "p1",
      sku: "SKU1",
      title: "Bougie",
      description: "Cire de soja",
      price: { amount: 1500, currency: "EUR" },
      stock: 4,
    };
    const r = await adapter.createListing(ctxWith(http, PUBLIABLE), p, "idem");

    // JSON ici renvoie une erreur qui désigne des champs pourtant présents.
    expect(sent[0]?.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const b = form(sent[0]?.raw ?? null);
    expect(b["state"]).toBe("draft");
    expect(b["price"]).toBe("15.00");
    expect(b["quantity"]).toBe("4");
    expect(b["shipping_profile_id"]).toBe("sp1");
    expect(b["readiness_state_id"]).toBe("rs1");
    expect(b["taxonomy_id"]).toBe("1234");
    expect(r.remoteId).toBe("4242");
  });
});

describe("inventaire", () => {
  const INVENTAIRE = {
    products: [
      {
        product_id: 111,
        sku: "SKU1",
        is_deleted: false,
        offerings: [
          {
            offering_id: 222,
            price: { amount: 1500, divisor: 100, currency_code: "EUR" },
            quantity: 4,
            is_enabled: true,
            is_deleted: false,
          },
        ],
        property_values: [
          { property_id: 1, scale_name: "Taille", value_pairs: ["a"], values: ["M"] },
        ],
      },
      { product_id: 999, sku: "MORT", is_deleted: true, offerings: [] },
    ],
    price_on_property: [1],
  };

  it("retire les champs en lecture seule avant de réécrire", async () => {
    const { http, sent } = fakeHttp([{ body: INVENTAIRE }, { status: 200 }]);
    await adapter.updateStock(ctxWith(http), annonce, 7);

    const corps = JSON.parse(sent[1]?.raw ?? "{}");
    const p = corps.products[0];
    // Les renvoyer produit un 400 dont le message ne nomme pas le coupable.
    expect(p).not.toHaveProperty("product_id");
    expect(p).not.toHaveProperty("is_deleted");
    expect(p.offerings[0]).not.toHaveProperty("offering_id");
    expect(p.property_values[0]).not.toHaveProperty("scale_name");
    expect(p.property_values[0]).not.toHaveProperty("value_pairs");
    // Ce qui identifie la variante doit survivre.
    expect(p.property_values[0].property_id).toBe(1);
  });

  it("repasse le prix en décimal", async () => {
    const { http, sent } = fakeHttp([{ body: INVENTAIRE }, { status: 200 }]);
    await adapter.updateStock(ctxWith(http), annonce, 7);
    const corps = JSON.parse(sent[1]?.raw ?? "{}");
    // La forme {amount, divisor} de la lecture est refusée en écriture.
    expect(corps.products[0].offerings[0].price).toBe(15);
  });

  it("écrit la quantité demandée et ignore les produits supprimés", async () => {
    const { http, sent } = fakeHttp([{ body: INVENTAIRE }, { status: 200 }]);
    await adapter.updateStock(ctxWith(http), annonce, 7);
    const corps = JSON.parse(sent[1]?.raw ?? "{}");
    expect(corps.products).toHaveLength(1);
    expect(corps.products[0].offerings[0].quantity).toBe(7);
  });

  it("préserve la structure des variations", async () => {
    const { http, sent } = fakeHttp([{ body: INVENTAIRE }, { status: 200 }]);
    await adapter.updateStock(ctxWith(http), annonce, 7);
    const corps = JSON.parse(sent[1]?.raw ?? "{}");
    // L'omettre écraserait les variations de l'annonce.
    expect(corps.price_on_property).toEqual([1]);
  });

  it("change le prix sans toucher au stock", async () => {
    const { http, sent } = fakeHttp([{ body: INVENTAIRE }, { status: 200 }]);
    await adapter.updatePrice(ctxWith(http), annonce, {
      amount: 2050,
      currency: "EUR",
    });
    const o = JSON.parse(sent[1]?.raw ?? "{}").products[0].offerings[0];
    expect(o.price).toBe(20.5);
    expect(o.quantity).toBe(4);
  });

  it("ne négocie jamais un stock négatif", async () => {
    const { http, sent } = fakeHttp([{ body: INVENTAIRE }, { status: 200 }]);
    await adapter.updateStock(ctxWith(http), annonce, -3);
    const corps = JSON.parse(sent[1]?.raw ?? "{}");
    expect(corps.products[0].offerings[0].quantity).toBe(0);
  });
});

describe("état d'une annonce", () => {
  it("désactive au lieu de supprimer", async () => {
    const { http, sent } = fakeHttp([{ status: 200 }]);
    await adapter.deactivateListing(ctxWith(http), annonce);
    expect(sent[0]?.method).toBe("PATCH");
    expect(sent[0]?.url).toContain("/shops/777/listings/999");
    expect(form(sent[0]?.raw ?? null)["state"]).toBe("inactive");
  });

  it("réactive", async () => {
    const { http, sent } = fakeHttp([{ status: 200 }]);
    await adapter.activateListing(ctxWith(http), annonce);
    expect(form(sent[0]?.raw ?? null)["state"]).toBe("active");
  });
});

describe("expédition", () => {
  it("demande une intervention humaine sans numéro de suivi", async () => {
    const { http, sent } = fakeHttp([]);
    const r = await adapter.markShipped(
      ctxWith(http),
      { remoteOrderId: "3001" },
      "idem",
    );
    // Ni un échec ni un succès : rien n'est cassé, mais rien n'est fait.
    expect(r.status).toBe("manual_required");
    expect(sent).toHaveLength(0);
  });

  it("pose le suivi quand il est complet", async () => {
    const { http, sent } = fakeHttp([{ body: { receipt_id: 3001 } }]);
    const r = await adapter.markShipped(
      ctxWith(http),
      {
        remoteOrderId: "3001",
        trackingNumber: "6A123456789",
        carrier: "colissimo",
      },
      "idem",
    );
    expect(r.status).toBe("success");
    expect(sent[0]?.url).toContain("/shops/777/receipts/3001/tracking");
    const b = form(sent[0]?.raw ?? null);
    expect(b["tracking_code"]).toBe("6A123456789");
    expect(b["carrier_name"]).toBe("colissimo");
  });
});

describe("lecture du catalogue", () => {
  it("commence par les annonces actives", async () => {
    const { http, sent } = fakeHttp([
      {
        body: {
          count: 1,
          results: [
            {
              listing_id: 1,
              title: "Bougie",
              state: "active",
              quantity: 3,
              price: { amount: 1500, divisor: 100, currency_code: "EUR" },
              skus: ["SKU1"],
              url: "https://etsy.com/listing/1",
              images: [{ url_570xN: "https://img/1.jpg" }],
            },
          ],
        },
      },
    ]);
    const r = await adapter.fetchListings(ctxWith(http));

    expect(sent[0]?.url).toContain("state=active");
    expect(r.items[0]).toMatchObject({
      remoteId: "1",
      sku: "SKU1",
      stock: 3,
      status: "active",
      imageUrl: "https://img/1.jpg",
    });
    expect(r.items[0]?.price.amount).toBe(1500);
  });

  it("enchaîne sur l'état suivant une fois le premier épuisé", async () => {
    const { http } = fakeHttp([{ body: { count: 0, results: [] } }]);
    const r = await adapter.fetchListings(ctxWith(http), "active:0");
    // Sans cet enchaînement, brouillons et épuisés resteraient invisibles.
    expect(r.cursor).toBe("sold_out:0");
  });

  it("continue dans le même état tant qu'il reste des pages", async () => {
    const { http } = fakeHttp([
      { body: { count: 120, results: Array.from({ length: 50 }, (_, i) => ({ listing_id: i })) } },
    ]);
    const r = await adapter.fetchListings(ctxWith(http), "active:0");
    expect(r.cursor).toBe("active:50");
  });

  it("s'arrête après le dernier état", async () => {
    const { http, sent } = fakeHttp([{ body: { count: 0, results: [] } }]);
    const r = await adapter.fetchListings(ctxWith(http), "draft:0");
    expect(sent[0]?.url).toContain("state=draft");
    expect(r.cursor).toBeUndefined();
  });

  it("marque « vendu » une annonce active à zéro", async () => {
    const { http } = fakeHttp([
      {
        body: {
          count: 1,
          results: [{ listing_id: 2, state: "active", quantity: 0 }],
        },
      },
    ]);
    const r = await adapter.fetchListings(ctxWith(http));
    expect(r.items[0]?.status).toBe("sold");
  });
});

describe("relevé des ventes", () => {
  it("traduit une vente en événement canonique", async () => {
    const { http } = fakeHttp([
      {
        body: {
          count: 1,
          results: [
            {
              receipt_id: 5001,
              status: "Paid",
              created_timestamp: 1_700_000_000,
              transactions: [
                { listing_id: 1, sku: "SKU1", quantity: 2 },
              ],
            },
          ],
        },
      },
    ]);
    const r = await adapter.pollOrderEvents(ctxWith(http));
    expect(r.events[0]).toMatchObject({
      marketplace: "etsy",
      remoteOrderId: "5001",
      kind: "paid",
    });
    expect(r.events[0]?.lines[0]).toMatchObject({ sku: "SKU1", quantity: 2 });
    expect(r.events[0]?.occurredAt).toBe("2023-11-14T22:13:20.000Z");
  });

  it("donne le même identifiant à la même vente relue", async () => {
    const reponse = {
      body: {
        count: 1,
        results: [{ receipt_id: 5001, status: "paid", transactions: [] }],
      },
    };
    const a = await adapter.pollOrderEvents(ctxWith(fakeHttp([reponse]).http));
    const b = await adapter.pollOrderEvents(ctxWith(fakeHttp([reponse]).http));
    // Sans stabilité, chaque passage rejouerait toutes les ventes.
    expect(a.events[0]?.eventId).toBe(b.events[0]?.eventId);
  });

  it("reconnaît une annulation", async () => {
    const { http } = fakeHttp([
      {
        body: {
          count: 1,
          results: [{ receipt_id: 5002, status: "Canceled", transactions: [] }],
        },
      },
    ]);
    const r = await adapter.pollOrderEvents(ctxWith(http));
    expect(r.events[0]?.kind).toBe("cancelled");
  });
});

describe("webhooks", () => {
  const SECRET_BRUT = "c3VwZXItc2VjcmV0LXBvdXItbGVzLXRlc3Rz"; // base64
  const SECRET = `whsec_${SECRET_BRUT}`;

  /** Signe comme Svix : identifiant.horodatage.corps, clé base64-décodée. */
  async function signer(id: string, ts: string, corps: string, secret = SECRET_BRUT) {
    const cle = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      cle,
      new TextEncoder().encode(`${id}.${ts}.${corps}`),
    );
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  function requete(entetes: Record<string, string>, corps: string) {
    return new Request("https://x/", {
      method: "POST",
      headers: entetes,
      body: corps,
    });
  }

  const ctxWebhook = (secret?: string): MarketplaceContext => ({
    account: {
      id: "acc-etsy",
      marketplace: "etsy",
      slug: "e",
      displayName: "e",
      enabled: true,
    },
    credentials: secret === undefined ? {} : { webhookSecret: secret },
  });

  it("accepte une signature valide", async () => {
    const corps = JSON.stringify({ type: "order.paid", receipt_id: 5001 });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signer("msg_1", ts, corps);

    await expect(
      adapter.verifyAndParseWebhook(
        ctxWebhook(SECRET),
        requete(
          {
            "webhook-id": "msg_1",
            "webhook-timestamp": ts,
            "webhook-signature": `v1,${sig}`,
          },
          corps,
        ),
        corps,
      ),
    ).resolves.toEqual([]);
  });

  it("refuse une signature calculée sur le seul corps", async () => {
    // L'erreur classique : Etsy signe « id.horodatage.corps », pas le corps.
    const corps = JSON.stringify({ type: "order.paid" });
    const ts = String(Math.floor(Date.now() / 1000));
    const cle = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(SECRET_BRUT), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const brut = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.sign("HMAC", cle, new TextEncoder().encode(corps)),
        ),
      ),
    );

    await expect(
      adapter.verifyAndParseWebhook(
        ctxWebhook(SECRET),
        requete(
          {
            "webhook-id": "msg_1",
            "webhook-timestamp": ts,
            "webhook-signature": `v1,${brut}`,
          },
          corps,
        ),
        corps,
      ),
    ).rejects.toThrow(/signature/);
  });

  it("accepte plusieurs signatures, pour une rotation de secret", async () => {
    const corps = "{}";
    const ts = String(Math.floor(Date.now() / 1000));
    const bonne = await signer("msg_2", ts, corps);

    await expect(
      adapter.verifyAndParseWebhook(
        ctxWebhook(SECRET),
        requete(
          {
            "webhook-id": "msg_2",
            "webhook-timestamp": ts,
            "webhook-signature": `v1,AAAAduMMY= v1,${bonne}`,
          },
          corps,
        ),
        corps,
      ),
    ).resolves.toEqual([]);
  });

  it("rejette un rejeu ancien", async () => {
    const corps = "{}";
    const vieux = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = await signer("msg_3", vieux, corps);

    // Une notification interceptée ne doit pas pouvoir être renvoyée plus tard.
    await expect(
      adapter.verifyAndParseWebhook(
        ctxWebhook(SECRET),
        requete(
          {
            "webhook-id": "msg_3",
            "webhook-timestamp": vieux,
            "webhook-signature": `v1,${sig}`,
          },
          corps,
        ),
        corps,
      ),
    ).rejects.toThrow(/trop ancien/);
  });

  it("accepte le secret sans son préfixe", async () => {
    const corps = "{}";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signer("msg_4", ts, corps);

    await expect(
      adapter.verifyAndParseWebhook(
        ctxWebhook(SECRET_BRUT),
        requete(
          {
            "webhook-id": "msg_4",
            "webhook-timestamp": ts,
            "webhook-signature": `v1,${sig}`,
          },
          corps,
        ),
        corps,
      ),
    ).resolves.toEqual([]);
  });

  it("refuse quand le secret n'a pas été renseigné", async () => {
    await expect(
      adapter.verifyAndParseWebhook(
        ctxWebhook(),
        requete(
          {
            "webhook-id": "m",
            "webhook-timestamp": "1",
            "webhook-signature": "v1,x",
          },
          "{}",
        ),
        "{}",
      ),
    ).rejects.toThrow(/secret/);
  });

  it("déclenche une relecture des ventes", () => {
    // On ne parse pas le corps : sa forme n'est pas documentée de façon
    // fiable, et deviner la structure d'une vente décrémente un stock deux
    // fois. Le webhook dit « ça a bougé », le relevé va lire quoi.
    expect(adapter.webhookResync()).toEqual(["orders"]);
  });
});
