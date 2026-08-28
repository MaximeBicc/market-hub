import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayAdapter, ebayEnsureNotifications } from "./ebay.js";
import type { MarketplaceContext } from "../ports/marketplace.js";

/**
 * La lecture d'une notification eBay décide de mouvements de stock à partir
 * d'une charge que n'importe qui peut poster. Ces tests éprouvent donc les
 * deux moitiés : ce qu'on refuse, et ce qu'on comprend.
 *
 * Ils signent réellement, avec une clé générée à l'instant et servie par un
 * `fetch` simulé — comme eBay servirait la sienne.
 */

const FUTUR = String(Math.floor(Date.now() / 1000) + 3600);

function base64(o: Uint8Array): string {
  return btoa(String.fromCharCode(...o));
}

/** `r||s` brut vers DER, la forme qu'eBay émet. */
function rawVersDer(raw: Uint8Array): Uint8Array {
  const entier = (v: Uint8Array): number[] => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = [...v.subarray(i)];
    if ((b[0]! & 0x80) !== 0) b = [0x00, ...b];
    return [0x02, b.length, ...b];
  };
  const r = entier(raw.subarray(0, 32));
  const s = entier(raw.subarray(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

/**
 * Une identité eBay simulée : sa clé, et de quoi signer un corps.
 *
 * L'identifiant de clé est UNIQUE par appel, à dessein. L'adaptateur met les
 * clés en cache sur cet identifiant — comme eBay l'exige, sous peine de
 * dépassement de quota — et deux clés différentes sous le même identifiant
 * feraient échouer la vérification. C'est le comportement voulu ; le
 * réutiliser dans les tests masquerait ce qu'ils prétendent éprouver.
 */
let compteurKid = 0;
async function eBaySimule(kid = `kid-${++compteurKid}`) {
  const paire = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", paire.publicKey),
  );
  // eBay rend un PEM sans aucun saut de ligne : on reproduit ce détail.
  const pem = `-----BEGIN PUBLIC KEY-----${base64(spki)}-----END PUBLIC KEY-----`;

  const signer = async (corps: string) => {
    const brut = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-1" },
        paire.privateKey,
        new TextEncoder().encode(corps),
      ),
    );
    return btoa(
      JSON.stringify({
        alg: "ecdsa",
        kid,
        signature: base64(rawVersDer(brut)),
        digest: "SHA1",
      }),
    );
  };

  return { pem, signer, kid };
}

/** Compte les appels à la clé publique, pour éprouver le cache. */
function fetchSimule(pem: string) {
  const appels: string[] = [];
  const stub = vi.fn(async (url: string | URL) => {
    const u = String(url);
    appels.push(u);
    if (u.includes("/public_key/")) {
      return new Response(
        JSON.stringify({ key: pem, algorithm: "ECDSA", digest: "SHA1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Le jeton applicatif, demandé une fois puis mis en cache par l'adaptateur.
    return new Response(
      JSON.stringify({ access_token: "app-token", expires_in: 7200 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", stub);
  return { appels };
}

function ctx(
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
      accessToken: "atok",
      accessTokenExpiresAt: FUTUR,
      // Jeton applicatif déjà en cache : le test porte sur la signature, pas
      // sur l'obtention du jeton.
      appToken: "app-token",
      appTokenExpiresAt: FUTUR,
      marketplaceId: "EBAY_FR",
      ...creds,
    },
    http: async () => new Response("{}", { status: 200 }),
    saveCredentials: async (patch) => {
      saved.push(patch);
    },
  };
}

function requete(signature?: string): Request {
  return new Request("https://h/api/webhooks/ebay", {
    method: "POST",
    ...(signature ? { headers: { "x-ebay-signature": signature } } : {}),
  });
}

const VENTE = {
  metadata: { topic: "ORDER_CONFIRMATION", schemaVersion: "1.0" },
  notification: {
    notificationId: "notif-42",
    eventDate: "2026-08-27T20:43:59.462Z",
    publishAttemptCount: 1,
    data: {
      user: { userId: "vendeur-A", username: "boutique" },
      order: {
        orderId: "12-34567-89012",
        orderLineItems: [
          { orderLineItemId: "l1", listingId: "111222333", quantity: 2 },
          { orderLineItemId: "l2", listingId: "444555666", quantity: 1 },
        ],
      },
    },
  },
};

const adapter = new EbayAdapter();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ce qu'on refuse", () => {
  it("une notification sans signature", async () => {
    fetchSimule("");
    await expect(
      adapter.verifyAndParseWebhook!(ctx(), requete(), "{}"),
    ).rejects.toThrow(/sans signature/);
  });

  it("un en-tête illisible", async () => {
    fetchSimule("");
    await expect(
      adapter.verifyAndParseWebhook!(ctx(), requete("pas du base64 !"), "{}"),
    ).rejects.toThrow(/illisible/);
  });

  it("une signature qui ne correspond pas au corps", async () => {
    const ebay = await eBaySimule();
    fetchSimule(ebay.pem);
    const corps = JSON.stringify(VENTE);
    const sig = await ebay.signer(corps);

    /*
     * Le corps est modifié d'un caractère APRÈS signature. C'est le piège des
     * SDK officiels : désérialiser puis re-sérialiser suffit à produire cet
     * écart, et la signature ne correspond plus.
     */
    await expect(
      adapter.verifyAndParseWebhook!(ctx(), requete(sig), `${corps} `),
    ).rejects.toThrow(/signature invalide/);
  });

  it("une notification destinée à un AUTRE vendeur", async () => {
    const ebay = await eBaySimule();
    fetchSimule(ebay.pem);
    const corps = JSON.stringify(VENTE);
    const sig = await ebay.signer(corps);

    /*
     * Le point qui distingue eBay de Shopify et d'Etsy : la clé est celle
     * d'eBay, pas celle du vendeur. La signature est donc VALIDE pour tous
     * les comptes — c'est l'identifiant de vendeur qui doit trancher, sans
     * quoi une vente serait imputée à la première boutique venue.
     */
    await expect(
      adapter.verifyAndParseWebhook!(
        ctx({ ebayUserId: "vendeur-B" }),
        requete(sig),
        corps,
      ),
    ).rejects.toThrow(/autre compte/);
  });
});

describe("ce qu'on comprend", () => {
  it("traduit une vente en événement, ligne par ligne", async () => {
    const ebay = await eBaySimule();
    fetchSimule(ebay.pem);
    const corps = JSON.stringify(VENTE);
    const sig = await ebay.signer(corps);

    const evts = await adapter.verifyAndParseWebhook!(
      ctx({ ebayUserId: "vendeur-A" }),
      requete(sig),
      corps,
    );

    expect(evts).toHaveLength(1);
    const e = evts[0]!;
    expect(e.kind).toBe("paid");
    expect(e.remoteOrderId).toBe("12-34567-89012");
    // eBay réessaie jusqu'à trois fois : sans cette clé, une vente serait
    // décomptée trois fois du stock.
    expect(e.eventId).toBe("notif-42");
    expect(e.lines).toEqual([
      { remoteListingId: "111222333", quantity: 2 },
      { remoteListingId: "444555666", quantity: 1 },
    ]);
  });

  it("apprend l'identifiant du vendeur au premier passage", async () => {
    const ebay = await eBaySimule();
    fetchSimule(ebay.pem);
    const corps = JSON.stringify(VENTE);
    const sig = await ebay.signer(corps);
    const saved: Record<string, string>[] = [];

    await adapter.verifyAndParseWebhook!(ctx({}, saved), requete(sig), corps);

    // eBay ne donne cet identifiant nulle part ailleurs sans une portée
    // supplémentaire : on le retient quand il passe.
    expect(saved).toContainEqual({ ebayUserId: "vendeur-A" });
  });

  it("compte une annulation comme un retour de stock", async () => {
    const ebay = await eBaySimule();
    fetchSimule(ebay.pem);
    const corps = JSON.stringify({
      ...VENTE,
      metadata: { topic: "ORDER_CANCELLATION_ACTIVITY" },
    });
    const sig = await ebay.signer(corps);

    const evts = await adapter.verifyAndParseWebhook!(
      ctx({ ebayUserId: "vendeur-A" }),
      requete(sig),
      corps,
    );
    expect(evts[0]?.kind).toBe("cancelled");
  });

  it("ignore un sujet qu'il ne sait pas traduire", async () => {
    const ebay = await eBaySimule();
    fetchSimule(ebay.pem);
    const corps = JSON.stringify({
      ...VENTE,
      metadata: { topic: "ITEM_MARKED_SHIPPED" },
    });
    const sig = await ebay.signer(corps);

    // Ne rien faire d'une notification qu'on ne comprend pas vaut mieux que
    // d'en deviner l'effet sur le stock.
    await expect(
      adapter.verifyAndParseWebhook!(
        ctx({ ebayUserId: "vendeur-A" }),
        requete(sig),
        corps,
      ),
    ).resolves.toEqual([]);
  });

  it("écarte une ligne sans quantité plutôt que de décrémenter de zéro", async () => {
    const ebay = await eBaySimule();
    fetchSimule(ebay.pem);
    const corps = JSON.stringify({
      ...VENTE,
      notification: {
        ...VENTE.notification,
        data: {
          ...VENTE.notification.data,
          order: {
            orderId: "o1",
            orderLineItems: [
              { listingId: "111", quantity: 0 },
              { listingId: "222", quantity: 3 },
            ],
          },
        },
      },
    });
    const sig = await ebay.signer(corps);

    const evts = await adapter.verifyAndParseWebhook!(
      ctx({ ebayUserId: "vendeur-A" }),
      requete(sig),
      corps,
    );
    expect(evts[0]?.lines).toEqual([{ remoteListingId: "222", quantity: 3 }]);
  });
});

describe("la clé publique", () => {
  it("n'est demandée qu'une fois pour plusieurs notifications", async () => {
    const ebay = await eBaySimule();
    const { appels } = fetchSimule(ebay.pem);
    const corps = JSON.stringify(VENTE);
    const sig = await ebay.signer(corps);
    const c = ctx({ ebayUserId: "vendeur-A" });

    await adapter.verifyAndParseWebhook!(c, requete(sig), corps);
    await adapter.verifyAndParseWebhook!(c, requete(sig), corps);
    await adapter.verifyAndParseWebhook!(c, requete(sig), corps);

    /*
     * eBay avertit explicitement du dépassement de quota si la clé est
     * redemandée à chaque notification. Trois notifications, un seul appel.
     */
    const demandes = appels.filter((u) => u.includes("/public_key/"));
    expect(demandes).toHaveLength(1);
  });
});

describe("la capacité dit la vérité", () => {
  it("reste en relevé tant qu'aucun abonnement n'existe", () => {
    expect(adapter.capabilities(ctx()).inboundSales).toBe("poll");
  });

  it("passe en poussée quand l'abonnement est marqué actif", () => {
    /*
     * « Savoir vérifier » n'est pas « être abonné ». Déclarer la poussée sans
     * abonnement détendrait le relevé à un quart d'heure pour des
     * notifications qui n'arriveraient jamais.
     */
    expect(
      adapter.capabilities(ctx({ notificationsActives: "1" })).inboundSales,
    ).toBe("both");
  });
});

describe("mise en place des abonnements", () => {
  /**
   * Trois pièces doivent exister avant qu'eBay pousse quoi que ce soit, et
   * l'ORDRE compte : sans configuration d'alerte, l'enregistrement de la
   * destination échoue avec un code qui ne dit pas laquelle des trois manque.
   */
  function fetchAbonnement(reponses: Record<string, unknown>) {
    const appels: Array<{
      url: string;
      methode: string;
      corps: unknown;
      /** Le jeton porté, pour vérifier lequel part où. */
      jeton?: string;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        /*
         * Le corps n'est pas toujours du JSON : la demande de jeton part en
         * formulaire. L'analyser sans précaution faisait échouer le journal
         * AVANT l'enregistrement de l'appel — et le test concluait alors que
         * l'appel n'avait pas eu lieu.
         */
        let corps: unknown = null;
        if (init?.body) {
          try {
            corps = JSON.parse(String(init.body));
          } catch {
            corps = String(init.body);
          }
        }
        const auth = new Headers(
          init?.headers as HeadersInit | undefined,
        ).get("Authorization");
        appels.push({
          url: u,
          methode: init?.method ?? "GET",
          corps,
          ...(auth ? { jeton: auth.replace(/^Bearer /, "") } : {}),
        });
        const cle = Object.keys(reponses).find((k) => u.includes(k));
        return new Response(JSON.stringify(cle ? reponses[cle] : {}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return appels;
  }

  const c = () => ({ ...ctx(), http: undefined }) as MarketplaceContext;

  it("refuse une adresse qui n'est pas en HTTPS", async () => {
    await expect(
      ebayEnsureNotifications(adapter, c(), "http://h/x", "a".repeat(32), "a@b.c"),
    ).rejects.toThrow(/HTTPS/);
  });

  it("refuse un jeton de vérification trop court, avant tout appel", async () => {
    const appels = fetchAbonnement({});
    await expect(
      ebayEnsureNotifications(adapter, c(), "https://h/x", "court", "a@b.c"),
    ).rejects.toThrow(/32 à 80/);
    // Rien n'est parti : inutile de déranger eBay pour un refus certain.
    expect(appels).toHaveLength(0);
  });

  it("emploie le jeton APPLICATIF pour l'alerte et le catalogue des sujets", async () => {
    /*
     * Ces deux objets appartiennent à l'application, pas au vendeur : eBay
     * les refuse avec un jeton d'utilisateur, par un 403 qui parle de jeton
     * refusé — et envoie chercher du côté des portées alors que le jeton est
     * simplement du mauvais type.
     */
    const appels = fetchAbonnement({
      "/oauth2/token": { access_token: "jeton-applicatif", expires_in: 7200 },
      "/destination?": { destinations: [] },
      "/topic?": { topics: [] },
      "/subscription?": { subscriptions: [] },
      "/destination": { destinationId: "d1" },
    });

    await ebayEnsureNotifications(
      adapter,
      // Sans jeton applicatif en cache, la séquence doit aller le chercher.
      {
        ...c(),
        credentials: { clientId: "cid", clientSecret: "csec", accessToken: "u", accessTokenExpiresAt: FUTUR },
      } as MarketplaceContext,
      "https://h/api/webhooks/ebay",
      "a".repeat(32),
      "a@b.c",
    );

    // Le jeton applicatif a bien été demandé : c'est la preuve que la
    // configuration ne part pas avec celui du vendeur.
    expect(appels.some((a) => a.url.includes("/identity/v1/oauth2/token"))).toBe(
      true,
    );
  });

  it("pose l'alerte, la destination, puis les abonnements — dans cet ordre", async () => {
    const appels = fetchAbonnement({
      "/destination?": { destinations: [] },
      "/topic?": {
        topics: [
          { topicId: "ORDER_CONFIRMATION", supportedPayloads: [{ schemaVersion: "1.0" }] },
        ],
      },
      "/subscription?": { subscriptions: [] },
      "/destination": { destinationId: "dest-1" },
    });

    const r = await ebayEnsureNotifications(
      adapter,
      c(),
      "https://h/api/webhooks/ebay",
      "a".repeat(32),
      "a@b.c",
    );

    const chemins = appels.map((a) => `${a.methode} ${a.url.split("/v1")[1]}`);
    expect(chemins[0]).toBe("PUT /config");
    expect(chemins.some((x) => x.startsWith("POST /destination"))).toBe(true);
    expect(r.crees).toContain("ORDER_CONFIRMATION");
  });

  it("nomme la PORTÉE manquante quand eBay refuse un sujet (195011)", async () => {
    /*
     * « 195011 — not authorized for this topic » désigne le sujet, jamais la
     * cause. Le lire au premier degré envoie chercher un réglage de sujet,
     * qui n'existe pas, pendant que le vrai geste est une reconnexion.
     *
     * Ici : le catalogue dit que le sujet réclame deux portées, la sonde
     * répond que la première n'est pas accordée. Le message doit la nommer.
     */
    const BASE = "https://api.ebay.com/oauth/api_scope";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const corps = String(init?.body ?? "");

        if (u.includes("/oauth2/token")) {
          // La sonde : seule la portée de base fait défaut.
          const refuse =
            corps.includes(`scope=${encodeURIComponent(BASE)}`) &&
            !corps.includes("sell.fulfillment") &&
            !corps.includes("commerce.notification");
          return refuse
            ? new Response(JSON.stringify({ error: "invalid_scope" }), {
                status: 400,
              })
            : new Response(
                JSON.stringify({ access_token: "t", expires_in: 7200 }),
                { status: 200 },
              );
        }
        if (u.includes("/topic?")) {
          return new Response(
            JSON.stringify({
              topics: [
                {
                  topicId: "ORDER_CANCELLATION_ACTIVITY",
                  authorizationScopes: [
                    BASE,
                    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
                  ],
                  supportedPayloads: [{ schemaVersion: "1.0" }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (u.includes("/subscription") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  errorId: 195011,
                  domain: "API_NOTIFICATION",
                  message: "not authorized for this topic.",
                },
              ],
            }),
            { status: 403 },
          );
        }
        if (u.includes("/destination") && init?.method === "POST") {
          return new Response(JSON.stringify({ destinationId: "d1" }), {
            status: 200,
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const rapport = await ebayEnsureNotifications(
      adapter,
      { ...c(), credentials: { ...c().credentials, refreshToken: "rtok" } },
      "https://h/api/webhooks/ebay",
      "a".repeat(32),
      "a@b.c",
    );

    const refus = rapport.echecs.find(
      (e) => e.topic === "ORDER_CANCELLATION_ACTIVITY",
    );
    expect(refus).toBeDefined();
    // La portée manquante est nommée, la portée accordée ne l'est pas.
    expect(refus!.message).toContain("api_scope »");
    expect(refus!.message).not.toContain("sell.fulfillment");
    expect(refus!.message).toContain("Reconnecter");
  });

  it("nomme la reconnexion quand la portée n'a jamais été accordée", async () => {
    /*
     * LE SCÉNARIO QUI A COÛTÉ TROIS ALLERS-RETOURS.
     *
     * Une boutique reliée avant l'ajout de la portée traverse la
     * configuration et la destination sans encombre, puis se fait refuser au
     * dernier appel. Le refus d'eBay parle de permissions, ce qui envoie
     * chercher dans la console développeur — où tout est coché, puisque
     * cocher n'accorde rien.
     *
     * La sonde doit trancher AVANT, et dire le geste exact.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/oauth2/token")) {
          return new Response(
            JSON.stringify({ error: "invalid_scope" }),
            { status: 400 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await expect(
      ebayEnsureNotifications(
        adapter,
        /*
         * La sonde interroge le CONSENTEMENT, qui vit dans le jeton de
         * rafraîchissement : sans lui elle ne peut rien trancher et laisse
         * passer, à dessein. Le décor doit donc en porter un.
         */
        { ...c(), credentials: { ...c().credentials, refreshToken: "rtok" } },
        "https://h/api/webhooks/ebay",
        "a".repeat(32),
        "a@b.c",
      ),
    ).rejects.toThrow(/Reconnecter/);
  });

  it("ne conserve JAMAIS le jeton restreint rendu par la sonde", async () => {
    /*
     * Le jeton que rend la sonde ne porte QUE la portée sondée. L'enregistrer
     * remplacerait le jeton complet par un jeton mutilé : stock, commandes et
     * annonces tomberaient toutes en « accès refusé », et la cause serait
     * introuvable — on aurait vérifié une permission et cassé les autres.
     */
    const enregistres: Array<Record<string, string>> = [];
    const appels = fetchAbonnement({
      "/oauth2/token": { access_token: "RESTREINT", expires_in: 7200 },
      "/destination?": { destinations: [] },
      "/topic?": { topics: [] },
      "/subscription?": { subscriptions: [] },
      "/destination": { destinationId: "d1" },
    });

    await ebayEnsureNotifications(
      adapter,
      {
        ...c(),
        credentials: { ...c().credentials, refreshToken: "rtok" },
        saveCredentials: async (patch: Record<string, string>) => {
          enregistres.push(patch);
        },
      } as unknown as MarketplaceContext,
      "https://h/api/webhooks/ebay",
      "a".repeat(32),
      "a@b.c",
    );

    // La sonde a bien demandé la portée, et personne n'a gardé sa réponse.
    expect(
      appels.some(
        (a) =>
          a.url.includes("/oauth2/token") &&
          String(a.corps).includes("commerce.notification.subscription"),
      ),
    ).toBe(true);
    expect(
      enregistres.some((p) => p["accessToken"] === "RESTREINT"),
    ).toBe(false);
  });

  it("envoie le jeton APPLICATIF sur la destination, le jeton VENDEUR sur l'abonnement", async () => {
    /*
     * LE PARTAGE EXACT, ET LA RAISON DE CHAQUE CÔTÉ.
     *
     * Une destination est notre adresse de rappel : commune à tous les
     * vendeurs, rattachée à l'application. Un abonnement lie UN vendeur à
     * cette destination, et réclame donc son consentement.
     *
     * Se tromper sur la destination donne « 1100 / ACCESS / Access denied »,
     * un refus qui parle de permissions et fait chercher du côté des portées
     * alors que le jeton est simplement du mauvais type.
     */
    const appels = fetchAbonnement({
      "/oauth2/token": { access_token: "APPLICATIF", expires_in: 7200 },
      "/destination?": { destinations: [] },
      "/topic?": { topics: [] },
      "/subscription?": { subscriptions: [] },
      "/destination": { destinationId: "d1" },
    });

    await ebayEnsureNotifications(
      adapter,
      {
        ...c(),
        credentials: {
          clientId: "cid",
          clientSecret: "csec",
          accessToken: "VENDEUR",
          accessTokenExpiresAt: FUTUR,
        },
      } as MarketplaceContext,
      "https://h/api/webhooks/ebay",
      "a".repeat(32),
      "a@b.c",
    );

    const jetonDe = (fragment: string, methode: string) =>
      appels.find((a) => a.url.includes(fragment) && a.methode === methode)
        ?.jeton;

    expect(jetonDe("/destination", "POST")).toBe("APPLICATIF");
    expect(jetonDe("/subscription", "POST")).toBe("VENDEUR");
  });

  it("réutilise une destination existante plutôt que d'en créer une seconde", async () => {
    const appels = fetchAbonnement({
      "/destination?": {
        destinations: [
          {
            destinationId: "dest-existante",
            deliveryConfig: { endpoint: "https://h/api/webhooks/ebay" },
          },
        ],
      },
      "/topic?": { topics: [] },
      "/subscription?": { subscriptions: [] },
    });

    await ebayEnsureNotifications(
      adapter,
      c(),
      "https://h/api/webhooks/ebay",
      "a".repeat(32),
      "a@b.c",
    );

    // En créer une seconde ferait arriver chaque notification en double.
    expect(
      appels.filter((a) => a.methode === "POST" && a.url.includes("/destination")),
    ).toHaveLength(0);
  });

  it("constate un abonnement déjà là au lieu de le dupliquer", async () => {
    fetchAbonnement({
      "/destination?": {
        destinations: [
          {
            destinationId: "dest-1",
            deliveryConfig: { endpoint: "https://h/api/webhooks/ebay" },
          },
        ],
      },
      "/topic?": { topics: [] },
      "/subscription?": {
        subscriptions: [
          { topicId: "ORDER_CONFIRMATION", destinationId: "dest-1" },
        ],
      },
    });

    const r = await ebayEnsureNotifications(
      adapter,
      c(),
      "https://h/api/webhooks/ebay",
      "a".repeat(32),
      "a@b.c",
    );
    expect(r.dejaLa).toContain("ORDER_CONFIRMATION");
    expect(r.crees).not.toContain("ORDER_CONFIRMATION");
  });
});

describe("rafraîchissement du jeton", () => {
  /**
   * LA RÉGRESSION QUE CES TESTS VERROUILLENT.
   *
   * Un rafraîchissement ne peut demander qu'un SOUS-ENSEMBLE de ce que le
   * vendeur a accordé. Envoyer la liste courante des portées revient à exiger
   * que le consentement d'hier contienne celles d'aujourd'hui : le jour où
   * l'on en ajoute une, TOUS les jetons existants cessent de se renouveler.
   *
   * C'est exactement ce qui est arrivé en ajoutant la portée des
   * notifications. eBay répondait 400, et le message parlait de compte à
   * relier — la vraie cause était invisible.
   */
  function fetchJeton(reponse: unknown, status = 200) {
    const corps: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        // `forEach` plutôt que `Object.fromEntries` : les types Workers ne
        // déclarent pas l'itérateur de `URLSearchParams`, et la conversion
        // implicite ne compile pas.
        const champs: Record<string, string> = {};
        new URLSearchParams(String(init?.body ?? "")).forEach((v, k) => {
          champs[k] = v;
        });
        corps.push(champs);
        return new Response(JSON.stringify(reponse), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return corps;
  }

  /** Un contexte dont le jeton d'accès est périmé : le renouvellement part. */
  const perime = (): MarketplaceContext => ({
    ...ctx(),
    credentials: {
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rtok",
      accessToken: "vieux",
      accessTokenExpiresAt: String(Math.floor(Date.now() / 1000) - 10),
      marketplaceId: "EBAY_FR",
    },
    http: async () => new Response("{}", { status: 200 }),
    saveCredentials: async () => {},
  });

  it("ne demande AUCUNE portée en se renouvelant", async () => {
    const corps = fetchJeton({ access_token: "neuf", expires_in: 7200 });
    await adapter.testConnection(perime());

    const renouvellement = corps.find((b) => b["grant_type"] === "refresh_token");
    expect(renouvellement).toBeDefined();
    expect(renouvellement!["refresh_token"]).toBe("rtok");
    // Le champ absent, et non vide : eBay renvoie alors les portées d'origine.
    expect(renouvellement!["scope"]).toBeUndefined();
  });

  it("nomme un défaut de portée comme venant de l'outil, pas du compte", async () => {
    fetchJeton(
      { error: "invalid_scope", error_description: "scope not authorized" },
      400,
    );
    // Sans cette distinction, on ferait reconnecter le vendeur en boucle pour
    // un problème que la reconnexion ne corrige pas durablement.
    await expect(adapter.testConnection(perime())).rejects.toThrow(
      /défaut de l'outil/,
    );
  });

  it("dit « à relier » seulement quand le jeton est vraiment mort", async () => {
    fetchJeton(
      { error: "invalid_grant", error_description: "refresh token expired" },
      400,
    );
    await expect(adapter.testConnection(perime())).rejects.toThrow(
      /périmé ou révoqué/,
    );
  });
});
