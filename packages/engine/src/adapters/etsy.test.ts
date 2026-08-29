import { describe, expect, it, vi } from "vitest";
import {
  EtsyAdapter,
  lireResourceUrl,
  ETSY_SCOPES,
  etsyConsentUrl,
  etsyFindShop,
  etsyPkce,
} from "./etsy.js";
import type { MarketplaceContext } from "../ports/marketplace.js";
import type { Listing, Product, Variant } from "../domain/types.js";

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

/*
 * Le décor d'un compte RÉELLEMENT publiable.
 *
 * Le partenaire de production en fait partie, et ce n'est pas un détail de
 * test : sans lui, un article « fabriqué par quelqu'un d'autre » n'entre dans
 * aucune des trois catégories qu'Etsy autorise, et la mise en vente est
 * refusée. Les scénarios ci-dessous emploient tous cette déclaration — la
 * plus courante en revente — et sans partenaire ils décrivaient donc un
 * chemin qui échoue en production tout en passant au vert ici.
 */
const PUBLIABLE = {
  shippingProfileId: "sp1",
  readinessStateId: "rs1",
  taxonomyId: "1234",
  productionPartnerId: "pp1",
  // Exigée à l'ACTIVATION par Etsy — l'oublier du décor referait passer au
  // vert un chemin qui échoue en production après la facture du brouillon.
  returnPolicyId: "rp1",
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
    expect(sent[0]?.headers["x-api-key"]).toBe("keystring123:secret");
  });

  it("porte keystring:secret — le format imposé depuis février 2026", async () => {
    // Un test affirmait ici l'exact inverse, sur la foi de la doc de
    // démarrage d'Etsy restée en retard sur sa propre exigence. La keystring
    // seule est rejetée en 403 sur chaque appel depuis le 9 février 2026.
    const { http, sent } = fakeHttp([{ body: { shop_id: 777 } }]);
    await adapter.testConnection(ctxWith(http));
    expect(sent[0]?.headers["x-api-key"]).toBe("keystring123:secret");
  });

  it("retombe sur la keystring seule quand le secret est inconnu", async () => {
    // Le refus d'Etsy nommera la valeur manquante — mieux qu'un échec muet.
    const { http, sent } = fakeHttp([{ body: { shop_id: 777 } }]);
    const ctx = ctxWith(http);
    delete ctx.credentials?.["clientSecret"];
    await adapter.testConnection(ctx);
    expect(sent[0]?.headers["x-api-key"]).toBe("keystring123");
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
    expect(JSON.parse(sent[0]?.raw ?? "{}")["grant_type"]).toBe("refresh_token");
    // Etsy fait TOURNER le refresh : ne pas garder le neuf condamne la
    // boutique à une réautorisation manuelle.
    expect(saved[0]?.["refreshToken"]).toBe("refresh-v2");
    expect(saved[0]?.["accessToken"]).toBe("12345.neuf");
  });

  it("poste le jeton en JSON, comme le tutoriel officiel d'Etsy", async () => {
    // Depuis juillet 2026, une régression Etsy avérée rejette l'envoi en
    // formulaire chez certaines applications (403 « Invalid API key »),
    // pendant que le même envoi en JSON passe. Seul le JSON marche partout.
    const { http, sent } = fakeHttp([
      { body: { access_token: "1.a", refresh_token: "r", expires_in: 3600 } },
      { body: { shop_id: 777 } },
    ]);
    await adapter.testConnection(ctxWith(http, { accessTokenExpiresAt: "0" }));
    expect(sent[0]?.headers["Content-Type"]).toBe("application/json");
  });

  it("retombe sur le formulaire si Etsy refuse le JSON", async () => {
    const { http, sent } = fakeHttp([
      { status: 400, body: { error: "unsupported" } },
      { body: { access_token: "1.a", refresh_token: "r", expires_in: 3600 } },
      { body: { shop_id: 777 } },
    ]);
    await adapter.testConnection(ctxWith(http, { accessTokenExpiresAt: "0" }));
    expect(sent[1]?.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(sent).toHaveLength(3);
  });

  it("réessaie aussi sur un 403 — le statut des refus de passerelle d'Etsy", async () => {
    // C'est LE cas de la régression de juillet 2026 : un repli qui n'écoute
    // que le 400 ne se déclenche jamais, et l'échange échoue en silence.
    const { http, sent } = fakeHttp([
      { status: 403, body: { error: "Invalid API key" } },
      { body: { access_token: "1.a", refresh_token: "r", expires_in: 3600 } },
      { body: { shop_id: 777 } },
    ]);
    await adapter.testConnection(ctxWith(http, { accessTokenExpiresAt: "0" }));
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

  it("sait pousser, mais pas sans son secret de signature", () => {
    // Etsy pousse des notifications ; sans le secret, aucune n'est acceptée.
    // La plateforme en est capable, ce compte-ci ne l'est pas.
    const capacites = adapter.capabilities(ctxWith(undefined));
    expect(capacites.inboundSales).toBe("both");
    expect(capacites.pousseActive).toBe(false);
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
      tags: ["bougie", "cadeau"],
      materials: ["cire de soja", "coton"],
      // Désormais exigées : déclarer « fait main par moi » d'office sur de la
      // revente expose à la suspension de la boutique.
      whoMade: "i_did",
      whenMade: "made_to_order",
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
    expect(b["tags"]).toBe("bougie,cadeau");
    expect(b["materials"]).toBe("cire de soja,coton");
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
    const r = await adapter.activateListing(ctxWith(http), annonce);
    expect(form(sent[0]?.raw ?? null)["state"]).toBe("active");
    expect(r.url).toBe("https://www.etsy.com/listing/999");
  });

  /*
   * Une annonce effacée depuis Etsy répond 404. Compter cela pour un échec
   * bloquait la suppression du produit — qui commence par retirer partout —
   * alors que l'état voulu, « plus rien en vente », est déjà atteint.
   */
  it("compte le retrait comme réussi quand l'annonce n'existe plus", async () => {
    const { http } = fakeHttp([{ status: 404, body: { error: "not found" } }]);
    const r = await adapter.deactivateListing(ctxWith(http), annonce);
    expect(r.status).toBe("success");
    expect(r.message).toMatch(/absente d'Etsy/);
  });

  it("refuse en revanche de dire qu'une remise en vente a réussi", async () => {
    const { http } = fakeHttp([{ status: 404, body: { error: "not found" } }]);
    await expect(
      adapter.activateListing(ctxWith(http), annonce),
    ).rejects.toThrow(/404/);
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

  it("ne demande plus de relecture : la commande est lue directement", () => {
    /*
     * Cette méthode répondait « va relire les ventes », ce qui déclenchait une
     * page complète de commandes — cinquante lectures pour une vente. La
     * notification nomme la commande exacte : `verifyAndParseWebhook` la lit
     * en un appel, et demander une relecture en plus ferait deux fois le
     * travail.
     */
    expect(adapter.webhookSignaux()).toEqual([]);
  });
});

describe("recherche de la boutique", () => {
  /**
   * Trois échecs très différents arrivaient sous le même message. Le bandeau
   * de connexion affiche désormais ces textes tels quels : chacun doit dire à
   * l'utilisateur QUOI vérifier, pas énumérer des hypothèses.
   */
  function fetcherFixe(status: number, body: unknown) {
    return async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
  }

  const args = { clientId: "k", accessToken: "12345.t", userId: "12345" };

  it("nomme le compte acheteur sur un 404", async () => {
    await expect(
      etsyFindShop({ ...args, fetcher: fetcherFixe(404, {}) }),
    ).rejects.toThrow(/compte acheteur/);
  });

  it("assemble keystring:secret quand le secret est fourni", async () => {
    const entetes: Record<string, string>[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      entetes.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ shop_id: 9, shop_name: "A" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await etsyFindShop({ ...args, sharedSecret: "s3cret", fetcher });
    expect(entetes[0]?.["x-api-key"]).toBe("k:s3cret");
  });

  it("pointe la validation de l'application sur un 403", async () => {
    // L'autorisation a réussi, mais la clé d'API n'ouvre pas encore les
    // portes : c'est le symptôme d'une application en attente de validation,
    // pas d'un problème de boutique.
    await expect(
      etsyFindShop({ ...args, fetcher: fetcherFixe(403, { error: "forbidden" }) }),
    ).rejects.toThrow(/pas encore validée/);
  });

  it("nomme aussi le compte acheteur sur une enveloppe vide", async () => {
    await expect(
      etsyFindShop({ ...args, fetcher: fetcherFixe(200, { count: 0, results: [] }) }),
    ).rejects.toThrow(/compte acheteur/);
  });

  it("accepte la forme enveloppée et la forme nue", async () => {
    const enveloppe = await etsyFindShop({
      ...args,
      fetcher: fetcherFixe(200, {
        count: 1,
        results: [{ shop_id: 9, shop_name: "Atelier", currency_code: "EUR" }],
      }),
    });
    expect(enveloppe).toEqual({ shopId: "9", shopName: "Atelier", currency: "EUR" });

    const nue = await etsyFindShop({
      ...args,
      fetcher: fetcherFixe(200, { shop_id: 9, shop_name: "Atelier" }),
    });
    expect(nue.shopId).toBe("9");
  });
});

describe("déclarations obligatoires", () => {
  const BASE: Product = {
    id: "p1",
    sku: "SKU1",
    title: "Bougie",
    price: { amount: 1500, currency: "EUR" },
    stock: 4,
  };

  it("refuse plutôt que de déclarer « fait main par moi »", async () => {
    // who_made: "i_did" et when_made: "made_to_order" étaient codés en dur.
    // Sur de la revente, c'est une fausse déclaration — et Etsy suspend des
    // boutiques pour ce motif, pas seulement des annonces.
    const { http, sent } = fakeHttp([]);
    const r = await adapter.createListing(ctxWith(http, PUBLIABLE), BASE, "i");

    expect(r.status).toBe("manual_required");
    expect(r.message).toMatch(/qui a fabriqué/);
    expect(sent).toHaveLength(0);
  });

  it("exige les deux, pas seulement l'un", async () => {
    const { http } = fakeHttp([]);
    const r = await adapter.createListing(
      ctxWith(http, PUBLIABLE),
      { ...BASE, whoMade: "someone_else" },
      "i",
    );
    expect(r.status).toBe("manual_required");
  });

  it("en répétition, vérifie tout et n'écrit RIEN chez Etsy", async () => {
    /*
     * LA PROPRIÉTÉ QUI FAIT TOUT L'INTÉRÊT DE LA RÉPÉTITION.
     *
     * Etsy facture chaque brouillon et ne rembourse pas celui qu'on
     * abandonne. Une vérification qui créerait l'annonce pour savoir si elle
     * est créable serait pire que le problème qu'elle résout.
     *
     * Le test ne regarde pas le message : il regarde les ÉCRITURES. Aucune
     * requête autre qu'une lecture ne doit partir.
     */
    const { http, sent } = fakeHttp([{ body: { listing_id: 7 } }]);

    const r = await adapter.createListing(
      { ...ctxWith(http, PUBLIABLE), dryRun: true },
      { ...BASE, whoMade: "someone_else", whenMade: "2020_2026" },
      "i",
    );

    expect(r.status).toBe("success");
    expect(r.remoteId).toBeUndefined();
    expect(sent.filter((x) => x.method !== "GET")).toHaveLength(0);
  });

  it("en répétition, rend le MÊME refus qu'une vraie tentative", async () => {
    /*
     * Une seconde fonction qui listerait les exigences dériverait de celle
     * qui les applique. Ici c'est le même code arrêté plus tôt : le refus
     * doit donc être identique, mot pour mot.
     */
    const { productionPartnerId: _sans, ...sansPartenaire } = PUBLIABLE;
    const produit = {
      ...BASE,
      whoMade: "someone_else" as const,
      whenMade: "2020_2026" as const,
    };

    const vrai = await adapter.createListing(
      ctxWith(fakeHttp([]).http, sansPartenaire),
      produit,
      "i",
    );
    const repete = await adapter.createListing(
      { ...ctxWith(fakeHttp([]).http, sansPartenaire), dryRun: true },
      produit,
      "i",
    );

    expect(repete.status).toBe(vrai.status);
    expect(repete.message).toBe(vrai.message);
  });

  it("envoie la politique de retour dès le brouillon", async () => {
    /*
     * Etsy accepte un brouillon sans politique de retour, puis refuse son
     * ACTIVATION (« /return/policy : cannot be null ») — après la facture.
     * Le champ doit donc partir dès la création, et manquer doit bloquer
     * AVANT toute écriture.
     */
    const { http, sent } = fakeHttp([{ body: { listing_id: 7 } }]);
    await adapter.createListing(
      ctxWith(http, PUBLIABLE),
      { ...BASE, whoMade: "someone_else", whenMade: "2020_2026" },
      "i",
    );
    expect(form(sent[0]?.raw ?? null)["return_policy_id"]).toBe("rp1");

    const { returnPolicyId: _sans, ...sansRetour } = PUBLIABLE;
    const { http: http2, sent: sent2 } = fakeHttp([]);
    const r = await adapter.createListing(
      ctxWith(http2, sansRetour),
      { ...BASE, whoMade: "someone_else", whenMade: "2020_2026" },
      "i",
    );
    expect(r.status).toBe("manual_required");
    expect(r.message).toMatch(/politique de retour/i);
    expect(sent2).toHaveLength(0);
  });

  it("répare à l'activation un brouillon né sans politique de retour", async () => {
    /*
     * Le brouillon a été créé AVANT que l'outil exige la politique — le cas
     * réel : l'annonce 4564650504, draftée sans, refusée à l'activation même
     * une fois le réglage renseigné, parce que le PATCH n'envoyait que
     * l'état. La politique doit accompagner l'activation, et jamais la
     * désactivation.
     */
    const { http, sent } = fakeHttp([{ body: {} }, { body: {} }]);
    const ctx = ctxWith(http, PUBLIABLE);

    await adapter.activateListing(ctx, annonce, "i");
    const actif = form(sent[0]?.raw ?? null);
    expect(actif["state"]).toBe("active");
    expect(actif["return_policy_id"]).toBe("rp1");

    await adapter.deactivateListing(ctx, annonce, "i");
    const inactif = form(sent[1]?.raw ?? null);
    expect(inactif["state"]).toBe("inactive");
    expect(inactif["return_policy_id"]).toBeUndefined();
  });

  it("refuse AVANT d'écrire un article qui n'entre dans aucune catégorie Etsy", async () => {
    /*
     * LE REFUS QU'ETSY N'EXPLIQUE PAS.
     *
     * « Oh dear, you cannot sell this item on Etsy » arrive APRÈS la création
     * du brouillon — facturé, invendable, et sans un mot sur la règle
     * enfreinte. Ici : fabriqué par quelqu'un d'autre, sans partenaire de
     * production déclaré, ni fourniture, ni vintage. Aucune des trois portes.
     *
     * Rien ne doit partir chez Etsy, et le message doit nommer les trois
     * issues possibles plutôt que de constater l'échec.
     */
    const { http, sent } = fakeHttp([{ body: { listing_id: 7 } }]);
    const { productionPartnerId: _sans, ...sansPartenaire } = PUBLIABLE;

    const r = await adapter.createListing(
      ctxWith(http, sansPartenaire),
      { ...BASE, whoMade: "someone_else", whenMade: "2020_2026" },
      "i",
    );

    expect(r.status).toBe("manual_required");
    expect(r.message).toMatch(/partenaire de production/i);
    expect(sent).toHaveLength(0);
  });

  it("laisse passer un vintage, une fourniture, ou un article fait main", async () => {
    /*
     * L'inverse du test précédent, et il compte autant : être plus sévère
     * qu'Etsy interdirait des annonces qu'elle aurait acceptées. Les trois
     * portes doivent rester ouvertes sans partenaire.
     */
    const { productionPartnerId: _sans, ...sansPartenaire } = PUBLIABLE;

    const cas = [
      { nom: "vintage", produit: { whoMade: "someone_else", whenMade: "1980s" } },
      { nom: "fait main", produit: { whoMade: "i_did", whenMade: "2020_2026" } },
      {
        nom: "fourniture",
        produit: {
          whoMade: "someone_else",
          whenMade: "2020_2026",
          marketplaceData: { etsyIsSupply: true },
        },
      },
    ] as const;

    for (const c of cas) {
      const { http, sent } = fakeHttp([{ body: { listing_id: 7 } }]);
      const r = await adapter.createListing(
        ctxWith(http, sansPartenaire),
        { ...BASE, ...c.produit },
        "i",
      );
      expect(r.status, c.nom).not.toBe("manual_required");
      expect(sent.length, c.nom).toBeGreaterThan(0);
    }
  });

  it("transmet la déclaration réelle quand elle est fournie", async () => {
    const { http, sent } = fakeHttp([{ body: { listing_id: 7 } }]);
    await adapter.createListing(
      ctxWith(http, PUBLIABLE),
      { ...BASE, whoMade: "someone_else", whenMade: "2020_2026" },
      "i",
    );
    const b = form(sent[0]?.raw ?? null);
    expect(b["who_made"]).toBe("someone_else");
    expect(b["when_made"]).toBe("2020_2026");
  });

  it("signale une annonce sans photo comme impubliable", async () => {
    // Etsy refuse de passer en vente une annonce sans image : un brouillon
    // sans photo est un cul-de-sac, et le message doit le dire.
    const { http } = fakeHttp([{ body: { listing_id: 7 } }]);
    const r = await adapter.createListing(
      ctxWith(http, PUBLIABLE),
      { ...BASE, whoMade: "someone_else", whenMade: "2020_2026" },
      "i",
    );
    expect(r.status).toBe("success");
    expect(r.message).toMatch(/AUCUNE photo/);
  });
});

describe("vocabulaire imposé par Etsy", () => {
  /*
   * Ces listes sont copiées de la spécification OpenAPI d'Etsy, relevée le
   * 23/08/2026. Le test existe parce que trois valeurs INVENTÉES avaient été
   * livrées ici — « 2000_2009 », « before_2000 », « vintage » — soit la
   * moitié du menu. Elles n'existent pas chez Etsy : les choisir faisait
   * échouer la création en 400, après avoir traversé le type, deux
   * validations serveur et l'interface sans que rien ne bronche.
   *
   * Un vocabulaire imposé par un tiers ne se devine pas. Il se recopie, et
   * il se verrouille.
   */
  const WHEN_MADE_ETSY = ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] as const;
  const WHO_MADE_ETSY = ["i_did", "someone_else", "collective"] as const;

  it("n'emploie que des valeurs « quand » qui existent", async () => {
    for (const v of WHEN_MADE_ETSY) {
      const { http, sent } = fakeHttp([{ body: { listing_id: 1 } }]);
      await adapter.createListing(
        ctxWith(http, PUBLIABLE),
        {
          id: "p",
          sku: "S",
          title: "T",
          price: { amount: 100, currency: "EUR" },
          stock: 1,
          whoMade: "someone_else",
          whenMade: v as never,
        },
        "i",
      );
      // La valeur part telle quelle : si elle est acceptée par notre type,
      // elle doit être acceptée par Etsy.
      expect(form(sent[0]?.raw ?? null)["when_made"]).toBe(v);
    }
  });

  it("n'emploie que des valeurs « qui » qui existent", async () => {
    for (const v of WHO_MADE_ETSY) {
      const { http, sent } = fakeHttp([{ body: { listing_id: 1 } }]);
      await adapter.createListing(
        ctxWith(http, PUBLIABLE),
        {
          id: "p",
          sku: "S",
          title: "T",
          price: { amount: 100, currency: "EUR" },
          stock: 1,
          whoMade: v as never,
          whenMade: "made_to_order",
        },
        "i",
      );
      expect(form(sent[0]?.raw ?? null)["who_made"]).toBe(v);
    }
  });
});

describe("recherche de catégorie", () => {
  /** Un fragment d'arbre, dans la forme imbriquée que renvoie Etsy. */
  const ARBRE = {
    count: 2,
    results: [
      {
        id: 1,
        name: "Craft Supplies & Tools",
        children: [
          {
            id: 10,
            name: "Storage & Organization",
            children: [
              { id: 100, name: "Cable Organizers", children: [] },
              { id: 101, name: "Desk Organizers", children: [] },
            ],
          },
        ],
      },
      {
        id: 2,
        name: "Home & Living",
        children: [{ id: 200, name: "Storage Baskets", children: [] }],
      },
    ],
  };

  it("trouve une feuille et rend son chemin", async () => {
    const { http } = fakeHttp([{ body: ARBRE }]);
    const r = await adapter.searchCategories(ctxWith(http), "cable organizer");

    expect(r[0]?.id).toBe("100");
    expect(r[0]?.label).toBe("Cable Organizers");
    expect(r[0]?.path).toEqual(["Craft Supplies & Tools", "Storage & Organization"]);
  });

  it("ne propose JAMAIS une catégorie intermédiaire", async () => {
    // Etsy refuse une annonce rangée dans un nœud qui a des enfants. En
    // proposer un donnerait un refus incompréhensible au moment de publier.
    const { http } = fakeHttp([{ body: ARBRE }]);
    const r = await adapter.searchCategories(ctxWith(http), "storage");
    expect(r.map((c) => c.id)).not.toContain("10");
  });

  it("classe au lieu d'exiger tous les mots", async () => {
    /*
     * LE DÉFAUT QUE CE TEST VERROUILLE.
     *
     * La première version exigeait que tous les mots soient présents. Le champ
     * étant pré-rempli avec le titre du produit, la recherche portait sur sept
     * mots et ne trouvait jamais rien — un écran vide, sans explication.
     */
    const { http } = fakeHttp([{ body: ARBRE }]);
    const r = await adapter.searchCategories(
      ctxWith(http),
      "clip magnetique range cable organizer inexistant",
    );

    expect(r.length).toBeGreaterThan(0);
    // « Cable » et « Organizers » sont dans le NOM de la feuille : elle passe
    // devant celles qui ne matchent que par leur chemin.
    expect(r[0]?.id).toBe("100");
  });

  it("plie les accents", async () => {
    const { http } = fakeHttp([{ body: ARBRE }]);
    const r = await adapter.searchCategories(ctxWith(http), "câble");
    expect(r[0]?.id).toBe("100");
  });

  it("ignore les mots trop courants", async () => {
    // Sans cette précaution, « and » remonterait la moitié du référentiel.
    const { http } = fakeHttp([{ body: ARBRE }]);
    expect(await adapter.searchCategories(ctxWith(http), "and the")).toEqual([]);
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

/**
 * Le corps de l'écriture d'inventaire, quel que soit son rang.
 *
 * Le journal des requêtes garde le corps en BRUT ; le repérer par sa méthode
 * plutôt que par sa position évite qu'un appel ajouté en amont — un
 * rafraîchissement de jeton, par exemple — casse des tests sans rapport.
 */
function corpsPut(
  sent: Array<{ method: string; raw: string | null }>,
): any | undefined {
  const put = sent.find((x) => x.method === "PUT");
  return put?.raw ? JSON.parse(put.raw) : undefined;
}

describe("photos rattachées à leur coloris", () => {
  /*
   * Etsy pose trois règles, et le lot envoyé doit les respecter TOUTES :
   * les images doivent déjà être sur l'annonce, un seul `property_id` est
   * accepté, et aucun doublon. Se tromper donne « Invalid property_id,
   * value_id combination » — un refus qui ne dit pas laquelle des trois.
   */
  const produit: Product = {
    id: "p1",
    sku: "CLIP",
    title: "Clip",
    price: { amount: 599, currency: "EUR" },
    stock: 5,
    whoMade: "i_did",
    whenMade: "2020_2026",
    images: ["https://img/generique.jpg"],
    options: [{ name: "Couleur", values: ["Noir", "Blanc"] }],
    variants: [
      { ...variante("couleur=noir", ["Noir"], "CLIP-N"), imageUrl: "https://img/noir.jpg" },
      { ...variante("couleur=blanc", ["Blanc"], "CLIP-B"), imageUrl: "https://img/blanc.jpg" },
    ],
  };

  it("téléverse les photos de coloris D'ABORD, puis les rattache", async () => {
    /*
     * L'ordre n'est pas un détail : Etsy plafonne à dix images, et une photo
     * de coloris sert deux fois — elle illustre ET rattache. Reléguée après
     * les génériques, elle peut tomber hors plafond et le rattachement
     * devient impossible.
     */
    vi.stubGlobal("fetch", async () => new Response("x", { status: 200 }));

    const { http, sent } = fakeHttp([
      { body: { listing_id: 900 } }, // création du brouillon
      { body: { results: [] } }, // propriétés de la taxonomie
      { body: {} }, // PUT inventaire
      { body: { listing_image_id: 11 } }, // photo noir
      { body: { listing_image_id: 12 } }, // photo blanc
      { body: { listing_image_id: 13 } }, // photo générique
      {
        body: {
          products: [
            {
              property_values: [
                { property_id: 200, value_ids: [51], values: ["Noir"] },
              ],
            },
            {
              property_values: [
                { property_id: 200, value_ids: [52], values: ["Blanc"] },
              ],
            },
          ],
        },
      },
      { body: {} }, // POST variation-images
    ]);

    const r = await adapter.createListing(ctxWith(http, PUBLIABLE), produit, "i");
    expect(r.status).toBe("success");

    const images = sent.filter((a) => a.url.endsWith("/listings/900/images"));
    expect(images.map((a) => a.url)).toHaveLength(3);

    const lien = sent.find((a) => a.url.includes("variation-images"));
    expect(lien).toBeDefined();
    const corps = JSON.parse(String(lien!.raw));
    expect(corps.variation_images).toEqual([
      { property_id: 200, value_id: 51, image_id: 11 },
      { property_id: 200, value_id: 52, image_id: 12 },
    ]);
    // Un seul axe : Etsy refuse un lot qui en mélangerait deux.
    expect(new Set(corps.variation_images.map((x: any) => x.property_id)).size).toBe(1);
    vi.unstubAllGlobals();
  });

  it("n'échoue jamais l'annonce quand le rattachement rate", async () => {
    // L'annonce est créée ET FACTURÉE : rendre un échec ferait croire à une
    // création ratée, et le prochain essai en créerait une seconde.
    vi.stubGlobal("fetch", async () => new Response("x", { status: 200 }));
    const { http } = fakeHttp([
      { body: { listing_id: 901 } },
      { body: { results: [] } }, // propriétés de la taxonomie
      { body: {} },
      { body: { listing_image_id: 11 } },
      { body: { listing_image_id: 12 } },
      { body: { listing_image_id: 13 } },
      { status: 500, body: { error: "boom" } }, // lecture d'inventaire cassée
    ]);
    const r = await adapter.createListing(ctxWith(http, PUBLIABLE), produit, "i");
    expect(r.status).toBe("success");
    expect(r.message).toMatch(/coloris non rattachées|impossibles/);
    vi.unstubAllGlobals();
  });
});

describe("reposer les photos sur une annonce existante", () => {
  const produit: Product = {
    id: "p1",
    sku: "CLIP",
    title: "Clip",
    price: { amount: 599, currency: "EUR" },
    stock: 5,
    options: [{ name: "Couleur", values: ["Noir"] }],
    variants: [
      { ...variante("couleur=noir", ["Noir"], "CLIP-N"), imageUrl: "https://img/noir.jpg" },
    ],
  };
  const enLigne: Listing = {
    id: "l1",
    productId: "p1",
    accountId: "acc-etsy",
    remoteId: "900",
    status: "active",
    price: { amount: 599, currency: "EUR" },
    stock: 5,
    marketplaceData: {},
  };

  it("refuse de se répéter une fois les photos posées", async () => {
    /*
     * LA GARDE QUI PROTÈGE LA BOUTIQUE.
     *
     * Etsy réhéberge les images sous ses propres adresses : rien dans sa
     * réponse ne renvoie à l'URL d'origine, donc rien ne permet de
     * reconnaître une photo déjà versée. Un second passage les téléverserait
     * une deuxième fois, jusqu'à saturer les dix places de l'annonce avec
     * des doublons. Refuser vaut mieux que salir la boutique.
     */
    const { http, sent } = fakeHttp([]);
    const r = await adapter.refreshMedia!(
      ctxWith(http, PUBLIABLE),
      { ...enLigne, marketplaceData: { photosCouleurs: true } },
      produit,
    );
    expect(r.status).toBe("success");
    expect(r.message).toMatch(/déjà posées/);
    expect(sent).toHaveLength(0);
  });

  it("verse la photo, la rattache, et marque l'annonce", async () => {
    vi.stubGlobal("fetch", async () => new Response("x", { status: 200 }));
    const { http } = fakeHttp([
      { body: { count: 2 } }, // photos déjà présentes : on se place après
      { body: { listing_image_id: 44 } },
      {
        body: {
          products: [
            {
              property_values: [
                { property_id: 200, value_ids: [51], values: ["Noir"] },
              ],
            },
          ],
        },
      },
      { body: {} }, // variation-images
    ]);

    const r = await adapter.refreshMedia!(
      ctxWith(http, PUBLIABLE),
      enLigne,
      produit,
    );
    expect(r.status).toBe("success");
    // La marque n'est posée QUE si le rattachement a abouti : sinon elle
    // interdirait le seul nouvel essai qui aurait pu réussir.
    expect(r.marketplaceData).toMatchObject({ photosCouleurs: true });
    vi.unstubAllGlobals();
  });
});

describe("relevé d'une annonce à déclinaisons", () => {
  it("lit la quantité DU COLORIS, pas le total de l'annonce", async () => {
    /*
     * LA BAGARRE SANS FIN, OBSERVÉE EN PRODUCTION.
     *
     * `quantity` est la SOMME des déclinaisons — 19 blancs + 20 noirs = 39 —
     * et notre modèle rattache l'annonce au premier SKU. Comparer 39 au stock
     * du seul noir faisait conclure « la plateforme a changé », adopter 39,
     * puis repousser 39 sur les autres boutiques : le stock corrigé à la main
     * revenait tout seul à sa valeur d'avant, toutes les deux minutes.
     */
    const { http } = fakeHttp([
      {
        body: {
          count: 1,
          results: [
            {
              listing_id: 4564650504,
              title: "Clip",
              state: "active",
              quantity: 39, // le TOTAL, celui qui trompait
              price: { amount: 599, divisor: 100, currency_code: "EUR" },
              skus: ["ALI-noir"],
              inventory: {
                products: [
                  {
                    sku: "ALI-blanc",
                    offerings: [{ quantity: 19, is_enabled: true }],
                  },
                  {
                    sku: "ALI-noir",
                    offerings: [{ quantity: 20, is_enabled: true }],
                  },
                ],
              },
            },
          ],
        },
      },
    ]);

    const r = await adapter.fetchListings(ctxWith(http));
    expect(r.items[0]?.sku).toBe("ALI-noir");
    expect(r.items[0]?.stock).toBe(20);
  });

  it("retombe sur le total quand aucune déclinaison ne porte le SKU", async () => {
    // Une annonce sans variations : total et quantité du coloris se
    // confondent, et il ne faut pas rendre zéro sous prétexte d'absence.
    const { http } = fakeHttp([
      {
        body: {
          count: 1,
          results: [
            {
              listing_id: 77,
              title: "Bougie",
              state: "active",
              quantity: 8,
              price: { amount: 1200, divisor: 100, currency_code: "EUR" },
            },
          ],
        },
      },
    ]);
    const r = await adapter.fetchListings(ctxWith(http));
    expect(r.items[0]?.stock).toBe(8);
  });

  it("demande le détail des déclinaisons dans la même requête", async () => {
    // `includes=Inventory` évite un appel par annonce : le quota de
    // sous-requêtes ne permettrait pas de les payer un par un.
    const { http, sent } = fakeHttp([{ body: { count: 0, results: [] } }]);
    await adapter.fetchListings(ctxWith(http));
    expect(sent[0]?.url).toContain("includes=Images,Inventory");
  });
});

describe("stock d'une déclinaison", () => {
  /**
   * L'écriture d'inventaire d'Etsy est un remplacement COMPLET : il faut
   * relire, modifier une ligne, et tout réécrire. Ces tests vérifient que les
   * lignes NON visées repartent exactement comme elles sont arrivées — c'est
   * là que se jouait la panne : les dix-sept coloris passaient à la quantité
   * du seul qui avait été vendu.
   */
  const annonce: Listing = {
    id: "l1",
    productId: "p1",
    accountId: "acc-etsy",
    remoteId: "5551",
    status: "active",
    price: { amount: 1990, currency: "EUR" },
    stock: 9,
    marketplaceData: {},
  };

  const inventaire = {
    products: [
      {
        product_id: 1,
        sku: "",
        property_values: [{ property_id: 200, property_name: "Couleur", values: ["Noir"] }],
        offerings: [{ offering_id: 11, price: { amount: 1990, divisor: 100 }, quantity: 5, is_enabled: true }],
      },
      {
        product_id: 2,
        sku: "",
        property_values: [{ property_id: 200, property_name: "Couleur", values: ["Bleu Marine"] }],
        offerings: [{ offering_id: 12, price: { amount: 1990, divisor: 100 }, quantity: 4, is_enabled: true }],
      },
    ],
  };

  it("garde le délai de préparation de CHAQUE déclinaison", async () => {
    /*
     * LE REFUS RÉEL : « All offerings need readiness state ».
     *
     * L'écriture d'inventaire d'Etsy est un remplacement complet, et notre
     * recopie ne gardait que le prix, la quantité et l'activation. Le délai
     * de préparation, qu'Etsy rend pourtant à la lecture, tombait — et toute
     * mise à jour de stock sur une annonce à déclinaisons échouait.
     *
     * Celui de l'annonce l'emporte sur le réglage de la boutique : c'est le
     * choix du vendeur, et le remplacer changerait un délai annoncé à
     * l'acheteur sans le lui dire.
     */
    const avecDelais = {
      products: [
        {
          product_id: 1,
          sku: "",
          property_values: [{ property_id: 200, property_name: "Couleur", values: ["Noir"] }],
          offerings: [
            {
              offering_id: 11,
              price: { amount: 1990, divisor: 100 },
              quantity: 5,
              is_enabled: true,
              readiness_state_id: 777,
            },
          ],
        },
        {
          product_id: 2,
          sku: "",
          property_values: [{ property_id: 200, property_name: "Couleur", values: ["Bleu Marine"] }],
          // Celle-ci n'en a pas : le réglage de la boutique prend le relais.
          offerings: [
            { offering_id: 12, price: { amount: 1990, divisor: 100 }, quantity: 4, is_enabled: true },
          ],
        },
      ],
    };

    const { http, sent } = fakeHttp([{ body: avecDelais }, { body: {} }]);
    const r = await adapter.updateStock(
      ctxWith(http, PUBLIABLE),
      annonce,
      3,
      "k",
      variante("couleur=bleu-marine", ["Bleu Marine"]),
    );

    expect(r.status).toBe("success");
    const ecrits = corpsPut(sent)?.products;
    expect(ecrits[0].offerings[0].readiness_state_id).toBe(777);
    // PUBLIABLE porte readinessStateId « rs1 », non numérique : rien à poser
    // plutôt qu'un identifiant inventé.
    expect(ecrits[1].offerings[0].readiness_state_id).toBeUndefined();
  });

  it("pose le délai de la boutique quand la déclinaison n'en a pas", async () => {
    const sansDelai = {
      products: [
        {
          product_id: 1,
          sku: "",
          property_values: [{ property_id: 200, property_name: "Couleur", values: ["Noir"] }],
          offerings: [
            { offering_id: 11, price: { amount: 1990, divisor: 100 }, quantity: 5, is_enabled: true },
          ],
        },
      ],
    };
    const { http, sent } = fakeHttp([{ body: sansDelai }, { body: {} }]);
    await adapter.updateStock(
      ctxWith(http, { ...PUBLIABLE, readinessStateId: "1510416135313" }),
      annonce,
      3,
      "k",
      variante("couleur=noir", ["Noir"]),
    );
    expect(corpsPut(sent)?.products[0].offerings[0].readiness_state_id).toBe(
      1510416135313,
    );
  });

  it("ne change que la déclinaison visée", async () => {
    const { http, sent } = fakeHttp([{ body: inventaire }, { body: {} }]);
    const r = await adapter.updateStock(
      ctxWith(http),
      annonce,
      3,
      "k",
      variante("couleur=bleu-marine", ["Bleu Marine"]),
    );

    expect(r.status).toBe("success");
    // L'écriture est repérée par sa NATURE, pas par son rang : l'adaptateur
    // peut émettre d'autres requêtes avant (rafraîchissement de jeton), et un
    // index en dur casserait au premier changement sans rapport.
    const ecrits = corpsPut(sent)?.products;
    expect(ecrits).toHaveLength(2);
    // Le noir garde ses cinq. C'est tout l'objet du correctif.
    expect(ecrits[0].offerings[0].quantity).toBe(5);
    expect(ecrits[1].offerings[0].quantity).toBe(3);
  });

  it("compare les valeurs sans se laisser piéger par la casse ni les accents", async () => {
    const { http, sent } = fakeHttp([{ body: inventaire }, { body: {} }]);
    // « bleu marine » chez nous, « Bleu Marine » chez Etsy : même couleur.
    const r = await adapter.updateStock(
      ctxWith(http),
      annonce,
      7,
      "k",
      variante("couleur=bleu-marine", ["bleu marine"]),
    );

    expect(r.status).toBe("success");
    expect(corpsPut(sent)?.products[1].offerings[0].quantity).toBe(7);
  });

  it("refuse d'écrire sur une annonce à déclinaisons sans savoir laquelle", async () => {
    const { http, sent } = fakeHttp([{ body: inventaire }]);
    const r = await adapter.updateStock(ctxWith(http), annonce, 3, "k");

    expect(r.status).toBe("unsupported");
    // La lecture a eu lieu, l'écriture non.
    expect(sent.some((x) => x.method === "PUT")).toBe(false);
  });

  it("refuse nommément une déclinaison qu'Etsy ne connaît pas", async () => {
    const { http, sent } = fakeHttp([{ body: inventaire }]);
    const r = await adapter.updateStock(
      ctxWith(http),
      annonce,
      3,
      "k",
      variante("couleur=rouge", ["Rouge"]),
    );

    expect(r.status).toBe("unsupported");
    expect(r.message).toContain("Rouge");
    expect(sent.some((x) => x.method === "PUT")).toBe(false);
  });

  it("garde le chemin simple pour une annonce sans déclinaison", async () => {
    const simple = { products: [inventaire.products[0]] };
    const { http, sent } = fakeHttp([{ body: simple }, { body: {} }]);
    const r = await adapter.updateStock(ctxWith(http), annonce, 8, "k");

    expect(r.status).toBe("success");
    expect(corpsPut(sent)?.products[0].offerings[0].quantity).toBe(8);
  });
});

describe("prix d'une déclinaison", () => {
  const annonce: Listing = {
    id: "l1",
    productId: "p1",
    accountId: "acc-etsy",
    remoteId: "5551",
    status: "active",
    price: { amount: 1990, currency: "EUR" },
    stock: 9,
    marketplaceData: {},
  };

  const inventaire = {
    products: [
      {
        product_id: 1,
        sku: "",
        property_values: [{ property_id: 200, property_name: "Couleur", values: ["Noir"] }],
        offerings: [{ offering_id: 11, price: { amount: 1990, divisor: 100 }, quantity: 5, is_enabled: true }],
      },
      {
        product_id: 2,
        sku: "",
        property_values: [{ property_id: 200, property_name: "Couleur", values: ["Blanc"] }],
        offerings: [{ offering_id: 12, price: { amount: 1990, divisor: 100 }, quantity: 4, is_enabled: true }],
      },
    ],
  };

  it("ne change le prix que de la déclinaison visée", async () => {
    const { http, sent } = fakeHttp([{ body: inventaire }, { body: {} }]);
    const r = await adapter.updatePrice(
      ctxWith(http),
      annonce,
      { amount: 2490, currency: "EUR" },
      "k",
      variante("couleur=blanc", ["Blanc"]),
    );

    expect(r.status).toBe("success");
    const ecrits = corpsPut(sent)?.products;
    // Le noir garde son prix ET sa quantité : le remplacement est complet,
    // son contenu ne l'est pas.
    expect(ecrits[0].offerings[0].price).toBe(19.9);
    expect(ecrits[0].offerings[0].quantity).toBe(5);
    expect(ecrits[1].offerings[0].price).toBe(24.9);
  });
});

describe("indice de boutique", () => {
  it("lit shop_id dans le corps, sous forme de texte", () => {
    // Etsy envoie un nombre ; notre `externalId` est une chaîne. Sans cette
    // conversion la comparaison échouerait toujours, en silence.
    expect(
      adapter.indiceCompte(new Request("https://x/"), '{"shop_id":67654730}'),
    ).toBe("67654730");
  });

  it("rend null sur un corps illisible plutôt que de lever", () => {
    // Le corps n'est pas encore vérifié à cet instant : il peut être
    // n'importe quoi, y compris une tentative de faire planter la route.
    expect(adapter.indiceCompte(new Request("https://x/"), "pas du json")).toBeNull();
    expect(adapter.indiceCompte(new Request("https://x/"), "{}")).toBeNull();
  });
});

describe("lecture d'une adresse de ressource", () => {
  /**
   * LA GARANTIE QUI COMPTE ICI EST DE SÉCURITÉ.
   *
   * Etsy joint une adresse désignant la commande. L'appeler telle quelle
   * porterait notre jeton d'accès ET notre clé applicative vers l'hôte
   * qu'elle nomme. La signature protège contre une falsification à froid,
   * pas contre un secret compromis — alors on n'appelle jamais cette
   * adresse : on en extrait deux entiers et on reconstruit l'appel.
   */
  it("extrait la boutique et la commande d'une adresse normale", () => {
    expect(
      lireResourceUrl(
        "https://api.etsy.com/v3/application/shops/777/receipts/3917482190",
        "777",
      ),
    ).toEqual({ shopId: "777", receiptId: "3917482190" });
  });

  it("accepte l'autre hôte d'Etsy, les deux étant équivalents", () => {
    expect(
      lireResourceUrl(
        "https://openapi.etsy.com/v3/application/shops/777/receipts/42",
        "777",
      ),
    ).toEqual({ shopId: "777", receiptId: "42" });
  });

  it("refuse une commande d'une AUTRE boutique", () => {
    /*
     * Le secret qui a validé appartient à une boutique donnée. Lire la
     * commande d'une autre avec ce jeton serait au mieux un refus d'Etsy, au
     * pire un mélange de deux catalogues.
     */
    expect(
      lireResourceUrl(
        "https://api.etsy.com/v3/application/shops/999/receipts/42",
        "777",
      ),
    ).toBeNull();
  });

  it("ne se laisse pas détourner vers un hôte étranger", () => {
    /*
     * Ce cas ne peut PAS mal tourner, et c'est tout l'intérêt : on ne lit que
     * les deux nombres. L'hôte annoncé n'est jamais utilisé, donc même une
     * adresse hostile ne fait que fournir des chiffres.
     */
    const r = lireResourceUrl(
      "https://attaquant.test/v3/application/shops/777/receipts/42",
      "777",
    );
    expect(r).toEqual({ shopId: "777", receiptId: "42" });
    // Rien de l'hôte ne survit à l'extraction.
    expect(JSON.stringify(r)).not.toContain("attaquant");
  });

  it("refuse ce qui n'a pas la forme attendue", () => {
    for (const url of [
      undefined,
      "",
      "pas une adresse",
      "https://api.etsy.com/v3/application/shops/abc/receipts/42",
      "https://api.etsy.com/v3/application/listings/777/receipts/42",
    ]) {
      expect(lireResourceUrl(url, "777")).toBeNull();
    }
  });
});

describe("une notification devient une vente", () => {
  /** Signe un corps comme Svix, format qu'Etsy utilise. */
  async function signer(corps: string, secret: string, id = "msg_1") {
    const horodatage = String(Math.floor(Date.now() / 1000));
    const cle = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) =>
        c.charCodeAt(0),
      ),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      cle,
      new TextEncoder().encode(`${id}.${horodatage}.${corps}`),
    );
    return {
      "webhook-id": id,
      "webhook-timestamp": horodatage,
      "webhook-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`,
    };
  }

  const SECRET = `whsec_${btoa("un-secret-de-test")}`;

  const RECU = {
    receipt_id: 3917482190,
    created_timestamp: 1756400000,
    status: "paid",
    transactions: [
      { listing_id: 111, sku: "SAC-NOIR", quantity: 2 },
      { listing_id: 222, sku: null, quantity: 1 },
    ],
  };

  it("lit UNE commande au lieu d'une page entière", async () => {
    const { http, sent } = fakeHttp([{ body: RECU }]);
    const corps = JSON.stringify({
      event_type: "ORDER_PAID",
      resource_url:
        "https://api.etsy.com/v3/application/shops/777/receipts/3917482190",
      shop_id: 777,
    });
    const entetes = await signer(corps, SECRET);

    const evts = await adapter.verifyAndParseWebhook!(
      ctxWith(http, { webhookSecret: SECRET }),
      new Request("https://h/", { method: "POST", headers: entetes }),
      corps,
    );

    // Un seul appel, et c'est bien la commande nommée — pas la liste.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("/shops/777/receipts/3917482190");
    expect(sent[0]?.url).not.toContain("receipts?limit");

    expect(evts).toHaveLength(1);
    expect(evts[0]?.kind).toBe("paid");
    expect(evts[0]?.remoteOrderId).toBe("3917482190");
    expect(evts[0]?.lines).toEqual([
      { sku: "SAC-NOIR", quantity: 2, remoteListingId: "111" },
      { sku: undefined, quantity: 1, remoteListingId: "222" },
    ]);
  });

  it("déduplique sur l'identifiant du webhook, pas sur la commande", async () => {
    /*
     * Etsy réessaie huit fois sur plus de vingt-quatre heures, et rejoue à la
     * demande depuis son portail. Sans clé stable, une vente serait décomptée
     * neuf fois du stock.
     */
    const { http } = fakeHttp([{ body: RECU }]);
    const corps = JSON.stringify({
      event_type: "ORDER_PAID",
      resource_url:
        "https://api.etsy.com/v3/application/shops/777/receipts/3917482190",
    });
    const entetes = await signer(corps, SECRET, "msg_abc");

    const evts = await adapter.verifyAndParseWebhook!(
      ctxWith(http, { webhookSecret: SECRET }),
      new Request("https://h/", { method: "POST", headers: entetes }),
      corps,
    );
    expect(evts[0]?.eventId).toBe("hook:msg_abc");
  });

  it("accepte les deux graphies d'événement", async () => {
    // La documentation écrit « order.paid », la charge réelle « ORDER_PAID ».
    for (const forme of ["ORDER_PAID", "order.paid"]) {
      const { http } = fakeHttp([{ body: RECU }]);
      const corps = JSON.stringify({
        event_type: forme,
        resource_url:
          "https://api.etsy.com/v3/application/shops/777/receipts/1",
      });
      const entetes = await signer(corps, SECRET);
      const evts = await adapter.verifyAndParseWebhook!(
        ctxWith(http, { webhookSecret: SECRET }),
        new Request("https://h/", { method: "POST", headers: entetes }),
        corps,
      );
      expect(evts[0]?.kind).toBe("paid");
    }
  });

  it("rend une liste vide, sans lever, quand la commande est illisible", async () => {
    /*
     * Lever ferait croire au routeur que ce webhook n'était pas pour ce
     * compte, et il essaierait les autres boutiques. Une liste vide laisse le
     * relevé de secours rattraper la vente.
     */
    const { http } = fakeHttp([{ status: 500, body: {} }]);
    const corps = JSON.stringify({
      event_type: "ORDER_PAID",
      resource_url: "https://api.etsy.com/v3/application/shops/777/receipts/9",
    });
    const entetes = await signer(corps, SECRET);

    await expect(
      adapter.verifyAndParseWebhook!(
        ctxWith(http, { webhookSecret: SECRET }),
        new Request("https://h/", { method: "POST", headers: entetes }),
        corps,
      ),
    ).resolves.toEqual([]);
  });

  it("ne demande plus de relecture : la vente est déjà lue", () => {
    // La demander en plus ferait deux fois le travail.
    expect(adapter.webhookSignaux()).toEqual([]);
  });
});

/*
 * LA LECTURE DES RÉGLAGES DE BOUTIQUE.
 *
 * Ce qui est verrouillé ici n'est pas le contenu des menus mais la
 * DISTINCTION entre leurs deux façons d'être vides. « Vous n'avez rien créé »
 * et « Etsy nous a refusé la lecture » s'affichaient à l'identique, et le
 * second envoyait le vendeur recréer chez Etsy ce qu'il y avait déjà.
 */
describe("réglages de boutique : vide par absence ou vide par refus", () => {
  /** Un `fetch` qui répond selon le chemin, pour ne dépendre d'aucun ordre. */
  function httpQuiRefuse(...chemins: string[]) {
    return async (url: string) =>
      chemins.some((c) => url.includes(c))
        ? new Response(JSON.stringify({ error: "insufficient_scope" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
  }

  it("nomme le refus au lieu de le faire passer pour une boutique vide", async () => {
    const reglages = await adapter.listSettings(
      ctxWith(httpQuiRefuse("/policies/return")),
    );

    const retour = reglages.find((r) => r.key === "returnPolicyId");
    expect(retour?.options).toEqual([]);
    expect(retour?.panne).toMatch(/403/);
  });

  it("ne signale aucune panne quand la lecture réussit et ne rapporte rien", async () => {
    // Une boutique neuve est légitimement vide : l'aide « à créer chez Etsy »
    // est alors la bonne consigne, et un avertissement serait un faux signal.
    const reglages = await adapter.listSettings(ctxWith(httpQuiRefuse()));

    for (const r of reglages) {
      expect(r.options).toEqual([]);
      expect(r.panne).toBeUndefined();
    }
  });

  it("n'attribue le refus qu'à la lecture qui a échoué", async () => {
    // Les quatre lectures sont indépendantes : une portée manquante sur les
    // partenaires ne doit pas laisser croire que les trois autres ont échoué.
    const reglages = await adapter.listSettings(
      ctxWith(httpQuiRefuse("/production-partners")),
    );

    expect(reglages.filter((r) => r.panne).map((r) => r.key)).toEqual([
      "productionPartnerId",
    ]);
  });
});
