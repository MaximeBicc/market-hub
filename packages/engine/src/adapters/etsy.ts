import type {
  CanonicalOrderEvent,
  CapabilitySet,
  FulfillmentInput,
  Listing,
  Money,
  Product,
  RemoteListing,
  TargetResult,
} from "../domain/types.js";
import type {
  MarketplaceAdapter,
  MarketplaceContext,
  PollResult,
} from "../ports/marketplace.js";

/**
 * Adaptateur Etsy — Open API v3.
 *
 * TROIS PARTICULARITÉS QUI STRUCTURENT TOUT LE FICHIER
 *
 * 1. DEUX en-têtes sur CHAQUE appel : `Authorization: Bearer` ET `x-api-key`.
 *    En oublier un renvoie 401 sans dire lequel manque. Et depuis le
 *    9 février 2026, `x-api-key` doit porter « keystring:secret_partagé » —
 *    la keystring seule est rejetée en 403. C'est la première cause d'échec
 *    sur cette API, et c'est pour cela que rien ici n'appelle l'API sans
 *    passer par `call()`.
 *
 * 2. PKCE OBLIGATOIRE. Etsy refuse l'échange de code sans `code_verifier`,
 *    même pour une application serveur qui garde son secret. Le vérificateur
 *    doit donc survivre entre la redirection et le retour : c'est l'hôte qui
 *    le range, l'adaptateur ne fait que le produire et le consommer.
 *
 * 3. AUCUN BAC À SABLE. Contrairement à eBay, tout se passe sur la vraie
 *    boutique. C'est la raison pour laquelle la création d'annonce reste
 *    verrouillée tant que les profils obligatoires ne sont pas renseignés,
 *    et pourquoi les annonces créées le sont en brouillon.
 *
 * DURÉES DE VIE : jeton d'accès 1 heure, jeton de rafraîchissement 90 jours.
 * Le rafraîchissement RENOUVELLE le jeton de rafraîchissement — l'ancien est
 * remplacé. Ne pas persister le nouveau condamne la boutique à une
 * réautorisation manuelle dès l'expiration du précédent.
 *
 * DÉBIT : 10 requêtes/seconde, 10 000/jour sur fenêtre glissante.
 */

const API = "https://api.etsy.com/v3/application";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const CONSENT_URL = "https://www.etsy.com/oauth/connect";

/** Marge de sécurité : on renouvelle avant l'expiration réelle. */
const TOKEN_SKEW_SEC = 120;

export const ETSY_SCOPES = [
  "listings_r",
  "listings_w",
  "transactions_r",
  "transactions_w",
  "shops_r",
] as const;

/**
 * L'en-tête `x-api-key`, au format qu'Etsy IMPOSE depuis le 9 février 2026 :
 * « keystring:secret_partagé ». La keystring seule est rejetée par un 403
 * dont le message ne se lit que si on va le chercher dans le corps.
 *
 * Sans secret connu, la keystring part seule : le refus d'Etsy nommera alors
 * la valeur manquante — mieux qu'un échec muet fabriqué de notre côté.
 */
function apiKeyHeader(clientId: string, sharedSecret?: string | undefined): string {
  return sharedSecret ? `${clientId}:${sharedSecret}` : clientId;
}

/* ------------------------------------------------------------------ */
/* Parcours d'autorisation                                             */
/* ------------------------------------------------------------------ */

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Produit le couple PKCE.
 *
 * Etsy impose un vérificateur de 43 à 128 caractères pris dans
 * `[A-Za-z0-9._~-]` : 32 octets aléatoires en base64url en font exactement 43.
 */
export async function etsyPkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(digest) };
}

export function etsyConsentUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[] | undefined;
}): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: (args.scopes ?? ETSY_SCOPES).join(" "),
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${CONSENT_URL}?${p}`;
}

/**
 * Poste sur le point de jeton d'Etsy.
 *
 * Le corps part en JSON, et ce choix est réfléchi. La spécification OAuth
 * voudrait du `x-www-form-urlencoded`, et Etsy le documente — mais son propre
 * tutoriel officiel échange le code en JSON, et depuis juillet 2026 une
 * régression avérée (etsy/open-api nº 1678) fait rejeter l'envoi en
 * formulaire chez certaines applications avec un 403 au message trompeur
 * (« Invalid API key »), pendant que le MÊME envoi en JSON passe. Le support
 * d'Etsy a confirmé accepter les deux formats ; seul le JSON marche partout.
 *
 * Le repli en formulaire couvre le cas symétrique. Il inclut le 403 : c'est
 * sous ce statut, pas 400, que les refus de passerelle d'Etsy arrivent.
 */
async function postToken(
  body: Record<string, string>,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  let res = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 400 || res.status === 403 || res.status === 415) {
    res = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
    throw new Error(
      res.status === 400 || res.status === 401
        ? `Etsy a refusé les identifiants (${res.status})${detail ? ` — ${detail}` : ""}. Vérifiez la keystring, l'URL de redirection déclarée, et que l'application a bien été validée.`
        : `Etsy : échange de jeton refusé (${res.status})${detail ? ` — ${detail}` : ""}`,
    );
  }

  const j = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!j.access_token || !j.refresh_token) {
    throw new Error("Etsy : réponse de jeton incomplète");
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_in: j.expires_in ?? 3600,
  };
}

/**
 * Échange le code d'autorisation contre un couple de jetons.
 *
 * Renvoie aussi l'identifiant utilisateur : le jeton d'accès Etsy a la forme
 * `{user_id}.{aléa}`, l'identifiant se lit donc sans appel réseau
 * supplémentaire. C'est lui qui permet de retrouver la boutique.
 */
export async function etsyExchangeCode(args: {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetcher?:
    | ((input: string, init?: RequestInit) => Promise<Response>)
    | undefined;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}> {
  const j = await postToken(
    {
      grant_type: "authorization_code",
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      code: args.code,
      code_verifier: args.codeVerifier,
    },
    args.fetcher ?? fetch,
  );
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + j.expires_in,
    userId: j.access_token.split(".")[0] ?? "",
  };
}

/**
 * Retrouve la boutique d'un utilisateur.
 *
 * Etsy a livré deux formes pour cette réponse selon les versions : un objet
 * boutique nu, ou une enveloppe `{count, results}`. On accepte les deux
 * plutôt que de parier sur celle du jour.
 */
export async function etsyFindShop(args: {
  clientId: string;
  sharedSecret?: string | undefined;
  accessToken: string;
  userId: string;
  fetcher?:
    | ((input: string, init?: RequestInit) => Promise<Response>)
    | undefined;
}): Promise<{ shopId: string; shopName: string; currency: string }> {
  const f = args.fetcher ?? fetch;
  const res = await f(`${API}/users/${args.userId}/shops`, {
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "x-api-key": apiKeyHeader(args.clientId, args.sharedSecret),
    },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
    /*
     * Trois situations très différentes arrivaient ici sous le même message.
     * Un 404 signifie que l'AUTORISATION A FONCTIONNÉ — c'est un compte
     * acheteur, sans boutique. Un 401/403 après un échange réussi est le
     * symptôme classique d'une application pas encore validée par Etsy : le
     * jeton est bon, mais la clé d'API n'ouvre pas encore les portes.
     * Les confondre envoie l'utilisateur vérifier la mauvaise chose.
     */
    if (res.status === 404) {
      throw new Error(
        "Etsy a bien autorisé la connexion, mais ce compte n'a pas de boutique ouverte — c'est un compte acheteur. Reliez le compte Etsy qui possède la boutique.",
      );
    }
    throw new Error(
      res.status === 401 || res.status === 403
        ? `Etsy a autorisé la connexion mais refuse de lire la boutique (${res.status})${detail ? ` — ${detail}` : ""}. Symptôme classique d'une application pas encore validée : vérifiez son état dans « Manage Your Apps ».`
        : `Etsy : lecture de la boutique refusée (${res.status})${detail ? ` — ${detail}` : ""}`,
    );
  }
  const j = (await res.json()) as {
    shop_id?: number;
    shop_name?: string;
    currency_code?: string;
    results?: Array<{
      shop_id: number;
      shop_name: string;
      currency_code?: string;
    }>;
  };
  const shop = j.results?.[0] ?? j;
  if (!shop?.shop_id) {
    throw new Error(
      "Etsy a bien autorisé la connexion, mais ce compte n'a pas de boutique ouverte — c'est un compte acheteur. Reliez le compte Etsy qui possède la boutique.",
    );
  }

  return {
    shopId: String(shop.shop_id),
    shopName: shop.shop_name ?? `Etsy ${shop.shop_id}`,
    currency: shop.currency_code ?? "EUR",
  };
}

/* ------------------------------------------------------------------ */
/* Formes renvoyées par Etsy                                           */
/* ------------------------------------------------------------------ */

/** Etsy exprime l'argent en entiers : `{amount: 1250, divisor: 100}` = 12,50. */
interface EtsyMoney {
  amount: number;
  divisor: number;
  currency_code?: string;
}

interface EtsyOffering {
  offering_id?: number;
  price?: EtsyMoney | number;
  quantity?: number;
  is_enabled?: boolean;
  is_deleted?: boolean;
}

interface EtsyInventoryProduct {
  product_id?: number;
  sku?: string;
  is_deleted?: boolean;
  offerings?: EtsyOffering[];
  property_values?: Array<Record<string, unknown>>;
}

interface EtsyInventory {
  products?: EtsyInventoryProduct[];
  price_on_property?: number[];
  quantity_on_property?: number[];
  sku_on_property?: number[];
}

function toMinor(m: EtsyMoney | number | undefined, fallback = 0): number {
  if (typeof m === "number") return Math.round(m * 100);
  if (!m?.divisor) return fallback;
  return Math.round((m.amount / m.divisor) * 100);
}

/**
 * Nettoie un produit d'inventaire avant réécriture.
 *
 * LE PIÈGE N° 1 DE `updateListingInventory` : la lecture renvoie des champs
 * en lecture seule — `product_id`, `offering_id`, `scale_name`, `is_deleted`,
 * `value_pairs` — que l'écriture REFUSE. Renvoyer l'objet lu tel quel, ce que
 * fait tout code écrit de bonne foi, produit un 400 dont le message ne
 * désigne pas le champ fautif. Et le prix doit repasser en décimal : la forme
 * `{amount, divisor}` de la lecture n'est pas acceptée en écriture.
 */
function cleanProduct(
  p: EtsyInventoryProduct,
  patch: { quantity?: number; priceMinor?: number },
): Record<string, unknown> {
  return {
    sku: p.sku ?? "",
    property_values: (p.property_values ?? []).map((pv) => {
      const rest = { ...pv };
      delete rest["scale_name"];
      delete rest["value_pairs"];
      return rest;
    }),
    offerings: (p.offerings ?? []).map((o) => ({
      price: Number(((patch.priceMinor ?? toMinor(o.price)) / 100).toFixed(2)),
      quantity: patch.quantity ?? o.quantity ?? 0,
      is_enabled: o.is_enabled ?? true,
    })),
  };
}

/* ------------------------------------------------------------------ */

export class EtsyAdapter implements MarketplaceAdapter {
  readonly id = "etsy";

  /**
   * La création d'annonce reste fermée tant que la boutique n'a pas fourni
   * ses profils obligatoires.
   *
   * Etsy exige, pour tout article physique, un profil d'expédition, un profil
   * de traitement (`readiness_state_id`, qui a remplacé les délais de
   * préparation) et une catégorie de taxonomie. Aucun n'est déductible d'un
   * produit maître : ils décrivent la boutique, pas l'article. Annoncer la
   * capacité sans eux ferait échouer la commande au moment le plus coûteux —
   * après avoir tout préparé.
   */
  capabilities(ctx: MarketplaceContext): CapabilitySet {
    const c = ctx.credentials ?? {};
    const publiable = Boolean(
      c["shippingProfileId"] && c["readinessStateId"] && c["taxonomyId"],
    );
    return {
      listingCreate: publiable,
      listingUpdate: true,
      listingActivate: true,
      listingDeactivate: true,
      stockRead: true,
      stockWrite: true,
      priceRead: true,
      priceWrite: true,
      ordersRead: true,
      ordersFulfill: true,
      trackingWrite: true,
      /*
       * Etsy a livré ses premiers webhooks en 2026 : les quatre événements de
       * commande, et rien sur le stock. Encore faut-il que le point d'entrée
       * ait été déclaré dans son portail et son secret collé ici — sans quoi
       * toute notification est refusée faute de signature vérifiable.
       *
       * D'où « both » plutôt que « webhook » : les ventes arrivent en direct,
       * mais le relevé reste la seule voie pour le stock, et le filet quand
       * une notification se perd.
       */
      inboundSales: c["webhookSecret"] ? "both" : "poll",
    };
  }

  /* ---------------------------------------------------------------- */

  private shopId(ctx: MarketplaceContext): string {
    const s = ctx.credentials?.["shopId"] ?? ctx.account.externalAccountId ?? "";
    if (!s) throw new Error("Etsy : identifiant de boutique manquant");
    return s;
  }

  /**
   * Jeton d'accès valide, renouvelé si nécessaire.
   *
   * Le nouveau jeton de rafraîchissement est persisté systématiquement :
   * Etsy le renouvelle à chaque échange, et perdre le dernier oblige à
   * repasser par le navigateur.
   */
  private async token(ctx: MarketplaceContext): Promise<string> {
    const c = ctx.credentials ?? {};
    const now = Math.floor(Date.now() / 1000);

    const cached = c["accessToken"];
    if (cached && Number(c["accessTokenExpiresAt"] ?? 0) > now + TOKEN_SKEW_SEC) {
      return cached;
    }

    const clientId = c["clientId"] ?? "";
    const refreshToken = c["refreshToken"] ?? "";
    if (!clientId || !refreshToken) {
      throw new Error(
        "Etsy : identifiants manquants (keystring et jeton de rafraîchissement requis)",
      );
    }

    const j = await postToken(
      {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      },
      ctx.http ?? fetch,
    );

    await ctx.saveCredentials?.({
      accessToken: j.access_token,
      accessTokenExpiresAt: String(now + j.expires_in),
      // Etsy fait tourner le jeton de rafraîchissement : celui-ci remplace
      // l'ancien, et la fenêtre de 90 jours repart de zéro.
      refreshToken: j.refresh_token,
      refreshTokenObtainedAt: String(now),
    });

    return j.access_token;
  }

  /**
   * Appel API.
   *
   * Les deux en-têtes partent ensemble, toujours. `x-api-key` porte la
   * keystring SEULE — pas la keystring suivie du secret partagé, que l'on lit
   * parfois ailleurs et qui produit un 401 identique à celui d'un jeton
   * expiré, donc particulièrement pénible à diagnostiquer.
   */
  private async call<T>(
    ctx: MarketplaceContext,
    path: string,
    init: RequestInit & { form?: Record<string, string> } = {},
  ): Promise<T> {
    const token = await this.token(ctx);
    const http = ctx.http ?? fetch;
    const { form, ...rest } = init;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "x-api-key": apiKeyHeader(
        ctx.credentials?.["clientId"] ?? "",
        ctx.credentials?.["clientSecret"],
      ),
      ...(rest.headers as Record<string, string> | undefined),
    };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    else if (rest.body) headers["Content-Type"] = "application/json";

    const res = await http(`${API}${path}`, {
      ...rest,
      headers,
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 250).trim();
      if (res.status === 401) {
        throw new Error(
          "Etsy : accès refusé (401). Jeton expiré, portée manquante, ou en-tête x-api-key absent.",
        );
      }
      if (res.status === 429) {
        throw new Error(
          "Etsy : quota atteint (429). 10 requêtes/seconde et 10 000/jour sur fenêtre glissante.",
        );
      }
      throw new Error(
        `Etsy : réponse ${res.status}${detail ? ` — ${detail}` : ""}`,
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private ok(
    ctx: MarketplaceContext,
    remoteId?: string,
    message?: string,
  ): TargetResult {
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "success",
      ...(remoteId ? { remoteId } : {}),
      ...(message ? { message } : {}),
    };
  }

  /* ---------------------------------------------------------------- */

  async testConnection(ctx: MarketplaceContext): Promise<void> {
    const shop = await this.call<{ shop_id?: number }>(
      ctx,
      `/shops/${this.shopId(ctx)}`,
    );
    if (!shop?.shop_id) throw new Error("Etsy : la boutique n'a pas répondu");
  }

  /* ---------------------------------------------------------------- */
  /* Catalogue                                                         */
  /* ---------------------------------------------------------------- */

  async createListing(
    ctx: MarketplaceContext,
    product: Product,
    _idempotencyKey: string,
  ): Promise<TargetResult> {
    const c = ctx.credentials ?? {};
    const shipping = c["shippingProfileId"];
    const readiness = c["readinessStateId"];
    const taxonomy =
      (product.marketplaceData?.["etsyTaxonomyId"] as string | undefined) ??
      c["taxonomyId"];

    if (!shipping || !readiness || !taxonomy) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "manual_required",
        message:
          "Etsy exige un profil d'expédition, un profil de traitement et une catégorie avant toute création. Renseignez-les sur la boutique.",
      };
    }

    // `createDraftListing` n'accepte PAS de JSON : le corps doit être encodé
    // en formulaire. Envoyer du JSON renvoie une erreur de validation qui
    // désigne des champs pourtant présents.
    const created = await this.call<{ listing_id: number }>(
      ctx,
      `/shops/${this.shopId(ctx)}/listings`,
      {
        method: "POST",
        form: {
          quantity: String(Math.max(0, product.stock)),
          title: product.title.slice(0, 140),
          description: product.description ?? product.title,
          price: (product.price.amount / 100).toFixed(2),
          who_made:
            (product.marketplaceData?.["etsyWhoMade"] as string | undefined) ??
            "i_did",
          when_made:
            (product.marketplaceData?.["etsyWhenMade"] as string | undefined) ??
            "made_to_order",
          taxonomy_id: String(taxonomy),
          shipping_profile_id: String(shipping),
          readiness_state_id: String(readiness),
          // Créée en brouillon : Etsy débite un frais d'insertion à la
          // publication, et une annonce publiée sans relecture se paie.
          state: "draft",
        },
      },
    );

    return this.ok(
      ctx,
      String(created.listing_id),
      "Créée en brouillon — à publier depuis Etsy après relecture",
    );
  }

  async updatePrice(
    ctx: MarketplaceContext,
    listing: Listing,
    price: Money,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    return this.writeInventory(ctx, listing, { priceMinor: price.amount });
  }

  async updateStock(
    ctx: MarketplaceContext,
    listing: Listing,
    stock: number,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    return this.writeInventory(ctx, listing, { quantity: Math.max(0, stock) });
  }

  /**
   * Prix et stock vivent dans l'inventaire, pas sur l'annonce.
   *
   * Il n'existe pas d'écriture partielle : il faut lire l'inventaire complet,
   * modifier, puis le réécrire en entier. Deux sous-requêtes par changement —
   * c'est le coût de cette API, et c'est pourquoi le moteur ne propage que
   * les valeurs qui ont réellement changé.
   */
  private async writeInventory(
    ctx: MarketplaceContext,
    listing: Listing,
    patch: { quantity?: number; priceMinor?: number },
  ): Promise<TargetResult> {
    const id = listing.remoteId;
    if (!id) throw new Error("Etsy : annonce sans identifiant distant");

    const inv = await this.call<EtsyInventory>(ctx, `/listings/${id}/inventory`);
    const products = (inv.products ?? [])
      .filter((p) => !p.is_deleted)
      .map((p) => cleanProduct(p, patch));

    if (products.length === 0) {
      throw new Error("Etsy : cette annonce n'a aucun produit d'inventaire");
    }

    await this.call(ctx, `/listings/${id}/inventory`, {
      method: "PUT",
      body: JSON.stringify({
        products,
        // Ces trois tableaux disent quelles variantes portent un prix, un
        // stock ou un SKU propres. Les omettre écrase la structure des
        // variations de l'annonce.
        ...(inv.price_on_property
          ? { price_on_property: inv.price_on_property }
          : {}),
        ...(inv.quantity_on_property
          ? { quantity_on_property: inv.quantity_on_property }
          : {}),
        ...(inv.sku_on_property ? { sku_on_property: inv.sku_on_property } : {}),
      }),
    });

    return this.ok(ctx, id);
  }

  async activateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    return this.setState(ctx, listing, "active");
  }

  async deactivateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    // « inactive » et non « supprimée » : une annonce retirée chez Etsy est
    // irrécupérable, et son historique de ventes avec elle.
    return this.setState(ctx, listing, "inactive");
  }

  private async setState(
    ctx: MarketplaceContext,
    listing: Listing,
    state: "active" | "inactive",
  ): Promise<TargetResult> {
    const id = listing.remoteId;
    if (!id) throw new Error("Etsy : annonce sans identifiant distant");

    await this.call(ctx, `/shops/${this.shopId(ctx)}/listings/${id}`, {
      method: "PATCH",
      form: { state },
    });
    return this.ok(ctx, id);
  }

  /* ---------------------------------------------------------------- */
  /* Expédition                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Etsy n'a pas d'« expédier sans suivi » côté API.
   *
   * Le seul point d'entrée exige un numéro de suivi ET un transporteur. Sans
   * eux, on ne renvoie pas un échec — rien n'est cassé — mais un
   * `manual_required` : quelqu'un doit cocher la case dans Etsy. Confondre
   * les deux ferait sonner une alerte à chaque commande remise en main propre.
   */
  async markShipped(
    ctx: MarketplaceContext,
    input: FulfillmentInput,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    if (!input.trackingNumber || !input.carrier) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "manual_required",
        remoteId: input.remoteOrderId,
        message:
          "Etsy n'accepte l'expédition qu'avec un numéro de suivi et un transporteur. À marquer expédiée dans Etsy.",
      };
    }

    await this.call(
      ctx,
      `/shops/${this.shopId(ctx)}/receipts/${input.remoteOrderId}/tracking`,
      {
        method: "POST",
        form: {
          tracking_code: input.trackingNumber,
          // Etsy attend son propre nom de transporteur (« colissimo »,
          // « dhl », « usps »…). Un nom inconnu est refusé en 400.
          carrier_name: input.carrier,
          send_bcc: String(input.notifyBuyer ?? true),
        },
      },
    );

    return this.ok(ctx, input.remoteOrderId);
  }

  /* ---------------------------------------------------------------- */
  /* Lecture                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Lit le catalogue, état par état.
   *
   * `getListingsByShop` ne renvoie qu'UN état à la fois et retombe sur
   * « active » par défaut. Une lecture naïve laisserait donc invisibles les
   * brouillons, les épuisés et les désactivés — précisément les annonces dont
   * on veut reprendre le stock en main.
   *
   * Le curseur porte l'état courant et le décalage (« active:50 ») et enchaîne
   * les états : la pagination reste une simple suite d'appels, sans mémoire
   * côté appelant.
   */
  async fetchListings(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<{ items: RemoteListing[]; cursor?: string | undefined }> {
    const ETATS = ["active", "sold_out", "inactive", "draft"] as const;
    const LIMITE = 50;

    const [etatBrut, offsetBrut] = (cursor ?? "active:0").split(":");
    const iEtat = Math.max(
      0,
      ETATS.indexOf((etatBrut ?? "active") as (typeof ETATS)[number]),
    );
    const etat = ETATS[iEtat] ?? "active";
    const offset = Number(offsetBrut ?? 0) || 0;

    const d = await this.call<{
      count?: number;
      results?: Array<{
        listing_id: number;
        title?: string;
        state?: string;
        quantity?: number;
        price?: EtsyMoney;
        url?: string;
        skus?: string[];
        images?: Array<{ url_570xN?: string; url_fullxfull?: string }>;
      }>;
    }>(
      ctx,
      `/shops/${this.shopId(ctx)}/listings?state=${etat}&limit=${LIMITE}&offset=${offset}&includes=Images`,
    );

    const devise = ctx.credentials?.["currency"] ?? "EUR";

    const items: RemoteListing[] = (d.results ?? []).map((l) => {
      const stock = l.quantity ?? 0;
      return {
        remoteId: String(l.listing_id),
        sku: l.skus?.[0] || null,
        title: l.title ?? String(l.listing_id),
        price: {
          amount: toMinor(l.price),
          currency: l.price?.currency_code ?? devise,
        },
        stock,
        status:
          l.state === "draft"
            ? "draft"
            : l.state === "active"
              ? stock > 0
                ? "active"
                : "sold"
              : l.state === "sold_out"
                ? "sold"
                : "inactive",
        url: l.url ?? undefined,
        imageUrl: l.images?.[0]?.url_570xN ?? l.images?.[0]?.url_fullxfull,
      };
    });

    const consommes = offset + (d.results?.length ?? 0);
    const resteDansEtat = consommes < (d.count ?? 0);
    const suivant = resteDansEtat
      ? `${etat}:${consommes}`
      : ETATS[iEtat + 1]
        ? `${ETATS[iEtat + 1]}:0`
        : undefined;

    return { items, cursor: suivant };
  }

  /**
   * Relevé des ventes.
   *
   * Etsy ne pousse rien : pas de webhook, pas de notification. Le relevé est
   * la seule source, et c'est pour cela que la fréquence du cron détermine
   * directement le délai de détection d'une vente.
   */
  async pollOrderEvents(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<PollResult> {
    const offset = cursor ? Number(cursor) : 0;
    const LIMITE = 25;

    const d = await this.call<{
      count?: number;
      results?: Array<{
        receipt_id: number;
        status?: string;
        create_timestamp?: number;
        created_timestamp?: number;
        transactions?: Array<{
          listing_id?: number;
          sku?: string | null;
          quantity?: number;
        }>;
      }>;
    }>(
      ctx,
      `/shops/${this.shopId(ctx)}/receipts?limit=${LIMITE}&offset=${offset}`,
    );

    const events: CanonicalOrderEvent[] = (d.results ?? []).map((r) => {
      const statut = (r.status ?? "").toLowerCase();
      const annule = statut === "canceled" || statut === "cancelled";
      const horodatage = r.created_timestamp ?? r.create_timestamp ?? 0;
      return {
        marketplace: "etsy",
        accountId: ctx.account.id,
        remoteOrderId: String(r.receipt_id),
        // Le relevé n'a pas d'identifiant d'événement : on en fabrique un
        // stable à partir de la commande et de son état, sinon chaque passage
        // rejouerait toutes les ventes et viderait le stock.
        eventId: `poll:${r.receipt_id}:${annule ? "cancelled" : statut || "paid"}`,
        kind: annule ? "cancelled" : "paid",
        occurredAt: horodatage
          ? new Date(horodatage * 1000).toISOString()
          : new Date().toISOString(),
        lines: (r.transactions ?? []).map((t) => ({
          sku: t.sku ?? undefined,
          quantity: t.quantity ?? 1,
          remoteListingId: t.listing_id ? String(t.listing_id) : undefined,
        })),
        raw: r,
      };
    });

    const consommes = offset + (d.results?.length ?? 0);
    return {
      events,
      cursor:
        d.count !== undefined && consommes < d.count
          ? String(consommes)
          : undefined,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Webhooks                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Toute notification Etsy vérifiée déclenche une relecture des ventes.
   *
   * Les quatre événements livrés — `order.paid`, `order.canceled`,
   * `order.shipped`, `order.delivered` — concernent tous des commandes. On ne
   * lit donc pas le corps pour décider : il n'y a qu'une réponse possible.
   *
   * Et surtout : on ne PARSE pas le corps. La forme exacte du payload n'est
   * pas documentée de façon fiable, et deviner la structure d'un événement de
   * vente est le genre d'approximation qui décrémente un stock deux fois. Le
   * webhook dit « une commande a bougé » ; le relevé, déjà éprouvé, va lire
   * laquelle. Quelques secondes au lieu de quinze minutes, sans rien inventer.
   */
  webhookResync(): string[] {
    return ["orders"];
  }

  /**
   * Vérifie la signature d'un webhook Etsy.
   *
   * Etsy utilise le format de signature de Svix, qui n'est PAS un simple HMAC
   * du corps : le contenu signé est `identifiant.horodatage.corps`. Signer le
   * seul corps échoue systématiquement, et le message d'erreur ne le dit pas.
   *
   * Le secret arrive préfixé `whsec_` et le reste est en base64 : c'est le
   * résultat du décodage qui sert de clé, pas la chaîne littérale. C'est la
   * seconde erreur classique.
   *
   * Renvoie une liste vide : la vérification est le seul objectif ici, la
   * lecture des ventes revient au relevé. Voir `webhookResync`.
   */
  async verifyAndParseWebhook(
    ctx: MarketplaceContext,
    request: Request,
    rawBody: string,
  ): Promise<CanonicalOrderEvent[]> {
    const id = request.headers.get("webhook-id");
    const horodatage = request.headers.get("webhook-timestamp");
    const signatures = request.headers.get("webhook-signature");
    const secret = ctx.credentials?.["webhookSecret"] ?? "";

    if (!id || !horodatage || !signatures || !secret) {
      throw new Error("Etsy : en-têtes de webhook ou secret manquants");
    }

    // Rejeu : une notification interceptée ne doit pas pouvoir être renvoyée
    // des heures plus tard. Cinq minutes de tolérance, dans les deux sens,
    // pour absorber le décalage d'horloge.
    const ecart = Math.abs(Math.floor(Date.now() / 1000) - Number(horodatage));
    if (!Number.isFinite(ecart) || ecart > 300) {
      throw new Error("Etsy : webhook trop ancien ou horodatage invalide");
    }

    const brut = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const cle = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(brut), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      cle,
      new TextEncoder().encode(`${id}.${horodatage}.${rawBody}`),
    );
    const attendue = btoa(String.fromCharCode(...new Uint8Array(sig)));

    // L'en-tête porte plusieurs signatures séparées par des espaces, chacune
    // préfixée de sa version : Etsy peut faire tourner son secret sans
    // interruption, et pendant la rotation les deux sont valables.
    const proposees = signatures
      .split(" ")
      .filter((v) => v.startsWith("v1,"))
      .map((v) => v.slice(3));

    if (!proposees.some((p) => egalesEnTempsConstant(p, attendue))) {
      throw new Error("Etsy : signature de webhook invalide");
    }

    return [];
  }
}

/**
 * Comparaison à temps constant.
 *
 * Une comparaison naïve s'arrête au premier octet différent : le temps de
 * réponse révèle alors la signature attendue, octet par octet.
 */
function egalesEnTempsConstant(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
