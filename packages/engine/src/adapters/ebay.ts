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
 * Adaptateur eBay — Sell APIs (Inventory + Fulfillment).
 *
 * AUTHENTIFICATION : parcours d'autorisation complet, pas de raccourci.
 * Contrairement à Shopify, eBay n'a pas de « client credentials » utilisable
 * pour les API vendeur : un jeton d'application n'ouvre que les API d'achat.
 * Il faut un jeton UTILISATEUR, obtenu après consentement dans un navigateur.
 *
 *   jeton d'accès        2 heures
 *   jeton de rafraîchissement  18 mois
 *
 * Le rafraîchissement est donc constant. C'est exactement ce pour quoi
 * `saveCredentials` a été ajouté au contrat.
 *
 * LE PIÈGE DU « redirect_uri » : eBay n'attend pas une URL, mais un RuName —
 * un alias créé dans le portail développeur, qui contient lui-même les URL
 * d'acceptation et de refus. Y mettre l'URL de rappel produit une erreur
 * incompréhensible.
 *
 * Identifiants attendus :
 *   clientId, clientSecret, ruName, refreshToken
 *   marketplaceId       ex. EBAY_FR (défaut)
 *   merchantLocationKey requis pour publier une annonce
 *   fulfillmentPolicyId, paymentPolicyId, returnPolicyId  idem
 */

/**
 * eBay a deux environnements complets, avec des hôtes, des comptes et des
 * identifiants DISTINCTS. Un jeton de bac à sable présenté à la production
 * est refusé, et réciproquement — avec un message qui n'explique pas la
 * cause. D'où un choix explicite plutôt qu'une constante.
 *
 * Le bac à sable est précieux : il permet de valider des écritures — créer
 * une annonce, changer un stock — sans toucher à de vraies ventes.
 */
export type EbayEnv = "production" | "sandbox";

const HOSTS: Record<EbayEnv, { api: string; auth: string }> = {
  production: { api: "https://api.ebay.com", auth: "https://auth.ebay.com" },
  sandbox: {
    api: "https://api.sandbox.ebay.com",
    auth: "https://auth.sandbox.ebay.com",
  },
};

function hosts(env?: string): { api: string; auth: string } {
  return HOSTS[env === "sandbox" ? "sandbox" : "production"];
}

/** Marge de sécurité : on renouvelle avant l'expiration réelle. */
const TOKEN_SKEW_SEC = 300;

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
].join(" ");

function basic(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

/** URL de consentement. Le `redirect_uri` est le RuName, jamais une URL. */
export function ebayConsentUrl(args: {
  clientId: string;
  ruName: string;
  state: string;
  environment?: string | undefined;
}): string {
  const p = new URLSearchParams({
    client_id: args.clientId,
    response_type: "code",
    redirect_uri: args.ruName,
    scope: EBAY_SCOPES,
    state: args.state,
  });
  return `${hosts(args.environment).auth}/oauth2/authorize?${p}`;
}

/** Échange du code de consentement contre un couple de jetons. */
export async function ebayExchangeCode(args: {
  clientId: string;
  clientSecret: string;
  ruName: string;
  code: string;
  environment?: string | undefined;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}> {
  const res = await fetch(
    `${hosts(args.environment).api}/identity/v1/oauth2/token`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic(args.clientId, args.clientSecret)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.ruName,
    }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `eBay a refusé l'échange (${res.status}). Vérifiez le RuName et que le code n'a pas déjà été utilisé. ${body.slice(0, 200)}`,
    );
  }

  const j = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in: number;
  };
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    accessExpiresAt: now + j.expires_in,
    refreshExpiresAt: now + j.refresh_token_expires_in,
  };
}

/* ------------------------------------------------------------------ */

interface EbayError {
  errorId?: number;
  message?: string;
  longMessage?: string;
}

/**
 * L'état de l'article, dans le vocabulaire d'eBay.
 *
 * eBay refuse ou déclasse une annonce dont l'état ne correspond pas à sa
 * catégorie. Il n'y a donc pas de valeur par défaut raisonnable : ne pas
 * savoir, c'est ne pas publier.
 */
const ETATS_EBAY: Record<string, string> = {
  new: "NEW",
  new_other: "NEW_OTHER",
  used_excellent: "USED_EXCELLENT",
  used_good: "USED_GOOD",
  used_acceptable: "USED_ACCEPTABLE",
  for_parts: "FOR_PARTS_OR_NOT_WORKING",
};

export class EbayAdapter implements MarketplaceAdapter {
  readonly id = "ebay";

  /**
   * Les capacités dépendent du COMPTE, pas seulement de la plateforme.
   *
   * Publier une annonce eBay exige un lieu d'expédition et trois politiques
   * (paiement, retour, livraison) créées dans le compte vendeur. Sans elles,
   * l'API refuse la publication. Déclarer `listingCreate: true` malgré tout
   * ferait proposer un bouton qui échoue systématiquement ; on préfère le
   * griser tant que la configuration manque.
   */
  capabilities(ctx: MarketplaceContext): CapabilitySet {
    const c = ctx.credentials ?? {};
    const publiable = Boolean(
      c["merchantLocationKey"] &&
        c["fulfillmentPolicyId"] &&
        c["paymentPolicyId"] &&
        c["returnPolicyId"],
    );

    return {
      listingCreate: publiable,
      listingUpdate: true,
      listingActivate: publiable,
      listingDeactivate: true,
      stockRead: true,
      stockWrite: true,
      priceRead: true,
      priceWrite: true,
      ordersRead: true,
      ordersFulfill: true,
      trackingWrite: true,
      // Les notifications eBay sont signées en ECDSA et exigent de récupérer
      // puis vérifier une clé publique. Tant que ce n'est pas fait, on ne
      // prétend pas les gérer : le relevé périodique fait le travail.
      inboundSales: "poll",
    };
  }

  /* ---------------------------------------------------------------- */

  /**
   * Jeton d'accès valide, renouvelé si nécessaire.
   *
   * eBay ne renvoie PAS de nouveau jeton de rafraîchissement lors d'un
   * renouvellement : on conserve celui d'origine. L'écraser par `undefined`
   * déconnecterait le compte au premier renouvellement.
   */
  private async token(ctx: MarketplaceContext): Promise<string> {
    const c = ctx.credentials ?? {};
    const now = Math.floor(Date.now() / 1000);

    const cached = c["accessToken"];
    const expiresAt = Number(c["accessTokenExpiresAt"] ?? 0);
    if (cached && expiresAt > now + TOKEN_SKEW_SEC) return cached;

    const clientId = c["clientId"] ?? "";
    const clientSecret = c["clientSecret"] ?? "";
    const refreshToken = c["refreshToken"] ?? "";
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "eBay : identifiants incomplets. Reliez le compte pour obtenir un jeton de rafraîchissement.",
      );
    }

    const res = await fetch(
      `${hosts(c["environment"]).api}/identity/v1/oauth2/token`,
      {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic(clientId, clientSecret)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: EBAY_SCOPES,
      }),
      },
    );

    if (!res.ok) {
      // 400 ici signifie presque toujours un jeton de rafraîchissement périmé
      // (18 mois) ou révoqué : seule une réautorisation manuelle le rétablit.
      throw new Error(
        res.status === 400
          ? "eBay a refusé le rafraîchissement. Le compte doit être relié à nouveau."
          : `eBay : rafraîchissement refusé (${res.status})`,
      );
    }

    const j = (await res.json()) as { access_token: string; expires_in: number };
    await ctx.saveCredentials?.({
      accessToken: j.access_token,
      accessTokenExpiresAt: String(now + j.expires_in),
    });
    return j.access_token;
  }

  private async call<T>(
    ctx: MarketplaceContext,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const token = await this.token(ctx);
    const http = ctx.http ?? fetch;
    const marketplaceId = ctx.credentials?.["marketplaceId"] ?? "EBAY_FR";

    const api = hosts(ctx.credentials?.["environment"]).api;
    const res = await http(`${api}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Language": "fr-FR",
        "Accept-Language": "fr-FR",
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    // 204 : succès sans contenu, courant sur les écritures d'inventaire.
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!res.ok) {
      const errs = (json["errors"] as EbayError[] | undefined) ?? [];
      const detail = errs
        .map((e) => e.longMessage || e.message || `erreur ${e.errorId}`)
        .join(" ; ");
      throw new Error(
        detail || `eBay a répondu ${res.status} sur ${path.split("?")[0]}`,
      );
    }
    return json as T;
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
    // Une lecture minimale suffit à prouver que le jeton et les portées
    // fonctionnent, sans rien modifier ni consommer de quota notable.
    await this.call(ctx, "/sell/inventory/v1/inventory_item?limit=1&offset=0");
  }

  /* ---------------------------------------------------------------- */
  /* Lecture du catalogue                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Le catalogue eBay se lit en DEUX temps, et c'est une contrainte de leur
   * modèle : l'« inventory item » porte le SKU et le stock, l'« offer » porte
   * le prix et l'état de publication. Il n'existe pas d'appel qui rende les
   * deux d'un coup.
   *
   * D'où une page volontairement petite : chaque article coûte un appel
   * supplémentaire pour son offre, et une invocation ne dispose que de
   * cinquante sous-requêtes.
   */
  async fetchListings(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<{ items: RemoteListing[]; cursor?: string | undefined }> {
    const offset = cursor ? Number(cursor) : 0;
    const limit = 15;

    const page = await this.call<{
      total?: number;
      inventoryItems?: Array<{
        sku: string;
        product?: { title?: string; imageUrls?: string[] };
        availability?: {
          shipToLocationAvailability?: { quantity?: number };
        };
      }>;
    }>(ctx, `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`);

    const items: RemoteListing[] = [];

    for (const it of page.inventoryItems ?? []) {
      const stock = it.availability?.shipToLocationAvailability?.quantity ?? 0;

      let price: Money = { amount: 0, currency: "EUR" };
      let status: RemoteListing["status"] = "draft";
      let offerId: string | undefined;
      let listingId: string | undefined;

      try {
        const offers = await this.call<{
          offers?: Array<{
            offerId: string;
            status?: string;
            listing?: { listingId?: string };
            pricingSummary?: { price?: { value?: string; currency?: string } };
          }>;
        }>(
          ctx,
          `/sell/inventory/v1/offer?sku=${encodeURIComponent(it.sku)}`,
        );
        const offer = offers.offers?.[0];
        if (offer) {
          offerId = offer.offerId;
          listingId = offer.listing?.listingId;
          const v = offer.pricingSummary?.price;
          if (v?.value) {
            price = {
              amount: Math.round(Number(v.value) * 100),
              currency: v.currency ?? "EUR",
            };
          }
          status =
            offer.status === "PUBLISHED"
              ? stock > 0
                ? "active"
                : "sold"
              : "draft";
        }
      } catch {
        // Un article sans offre est normal : il existe en stock mais n'a
        // jamais été mis en vente. On l'importe en brouillon.
      }

      items.push({
        // Le SKU est l'identifiant stable côté eBay : l'offerId change à
        // chaque republication, le listingId n'existe qu'une fois publié.
        remoteId: it.sku,
        sku: it.sku,
        title: it.product?.title ?? it.sku,
        price,
        stock,
        status,
        url: listingId
          ? `https://www.${ctx.credentials?.["environment"] === "sandbox" ? "sandbox." : ""}ebay.fr/itm/${listingId}`
          : undefined,
        imageUrl: it.product?.imageUrls?.[0],
        marketplaceData: { offerId, listingId },
      });
    }

    const consumed = offset + (page.inventoryItems?.length ?? 0);
    return {
      items,
      cursor:
        page.total !== undefined && consumed < page.total
          ? String(consumed)
          : undefined,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Écritures                                                         */
  /* ---------------------------------------------------------------- */

  async createListing(
    ctx: MarketplaceContext,
    product: Product,
    _idempotencyKey: string,
  ): Promise<TargetResult> {
    const c = ctx.credentials ?? {};
    const marketplaceId = c["marketplaceId"] ?? "EBAY_FR";
    const categoryId =
      (product.marketplaceData?.["ebayCategoryId"] as string | undefined) ??
      c["defaultCategoryId"];

    if (!categoryId) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "manual_required",
        message:
          "eBay exige une catégorie. Renseignez-la sur le produit ou définissez une catégorie par défaut sur le compte.",
      };
    }

    /*
     * L'état de l'article n'a PAS de valeur par défaut, et c'est délibéré.
     *
     * Cette ligne portait `condition: "NEW"` en dur. Tout article diffusé
     * était donc déclaré neuf, y compris de la revente d'occasion — une
     * fausse déclaration envoyée automatiquement, que personne ne voyait
     * passer. Mieux vaut une publication refusée qu'une annonce mensongère.
     */
    const conditionEbay = product.condition
      ? ETATS_EBAY[product.condition]
      : undefined;
    if (!conditionEbay) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "manual_required",
        message:
          "eBay exige l'état de l'article (neuf, très bon état, pour pièces…). Renseignez-le sur le produit : eBay déclasse une annonce dont l'état ne correspond pas à sa catégorie.",
      };
    }

    if ((product.images?.length ?? 0) === 0) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "manual_required",
        message:
          "eBay exige au moins une photo en HTTPS. Sans elle, l'annonce se crée mais ne peut jamais être mise en vente.",
      };
    }

    // 1. L'article d'inventaire : ce qu'on possède.
    await this.call(
      ctx,
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(product.sku)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          availability: {
            shipToLocationAvailability: { quantity: product.stock },
          },
          condition: conditionEbay,
          product: {
            title: product.title.slice(0, 80), // eBay tronque à 80 caractères
            description: product.description ?? product.title,
            imageUrls: product.images ?? [],
          },
        }),
      },
    );

    // 2. L'offre : à quel prix, dans quelle catégorie, sous quelles politiques.
    const offer = await this.call<{ offerId: string }>(
      ctx,
      "/sell/inventory/v1/offer",
      {
        method: "POST",
        body: JSON.stringify({
          sku: product.sku,
          marketplaceId,
          format: "FIXED_PRICE",
          availableQuantity: product.stock,
          categoryId,
          merchantLocationKey: c["merchantLocationKey"],
          pricingSummary: {
            price: {
              value: (product.price.amount / 100).toFixed(2),
              currency: product.price.currency,
            },
          },
          listingPolicies: {
            fulfillmentPolicyId: c["fulfillmentPolicyId"],
            paymentPolicyId: c["paymentPolicyId"],
            returnPolicyId: c["returnPolicyId"],
          },
        }),
      },
    );

    // 3. La publication est laissée à l'utilisateur. Mettre en vente
    // automatiquement une annonce que personne n'a relue engage un contrat
    // de vente réel — on s'arrête volontairement au brouillon.
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "success",
      remoteId: product.sku,
      // L'identifiant d'offre REMONTE, au lieu de finir dans un texte que
      // personne ne relit. Sans lui, l'annonce créée n'accepterait plus
      // jamais ni changement de prix, ni activation, ni retrait.
      marketplaceData: { offerId: offer.offerId, categoryId },
      message: `Offre ${offer.offerId} créée en brouillon — à publier après relecture`,
    };
  }

  async updateStock(
    ctx: MarketplaceContext,
    listing: Listing,
    stock: number,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const sku = listing.remoteId;
    if (!sku) throw new Error("eBay : SKU manquant sur l'annonce");

    // `bulk_update_price_quantity` met à jour l'article ET son offre en un
    // seul appel. Passer par l'inventory_item seul laisserait l'offre publiée
    // avec l'ancienne quantité.
    await this.call(ctx, "/sell/inventory/v1/bulk_update_price_quantity", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            sku,
            shipToLocationAvailability: { quantity: stock },
            ...(listing.marketplaceData?.["offerId"]
              ? {
                  offers: [
                    {
                      offerId: listing.marketplaceData["offerId"],
                      availableQuantity: stock,
                    },
                  ],
                }
              : {}),
          },
        ],
      }),
    });

    return this.ok(ctx, sku);
  }

  async updatePrice(
    ctx: MarketplaceContext,
    listing: Listing,
    price: Money,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const offerId = listing.marketplaceData?.["offerId"] as string | undefined;
    if (!offerId) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "unsupported",
        message:
          "Aucune offre eBay pour cet article : le prix vit sur l'offre, pas sur l'inventaire.",
      };
    }

    await this.call(ctx, "/sell/inventory/v1/bulk_update_price_quantity", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            sku: listing.remoteId,
            offers: [
              {
                offerId,
                price: {
                  value: (price.amount / 100).toFixed(2),
                  currency: price.currency,
                },
              },
            ],
          },
        ],
      }),
    });

    return this.ok(ctx, listing.remoteId);
  }

  async activateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const offerId = listing.marketplaceData?.["offerId"] as string | undefined;
    if (!offerId) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "unsupported",
        message: "Aucune offre eBay à publier pour cet article.",
      };
    }
    const r = await this.call<{ listingId?: string }>(
      ctx,
      `/sell/inventory/v1/offer/${offerId}/publish`,
      { method: "POST" },
    );
    return this.ok(ctx, r?.listingId ?? listing.remoteId);
  }

  async deactivateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const offerId = listing.marketplaceData?.["offerId"] as string | undefined;
    if (!offerId) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "unsupported",
        message: "Aucune offre eBay à retirer pour cet article.",
      };
    }
    // « withdraw » retire l'annonce mais conserve l'offre : on peut republier
    // sans tout recréer. Supprimer l'offre perdrait son historique.
    await this.call(ctx, `/sell/inventory/v1/offer/${offerId}/withdraw`, {
      method: "POST",
    });
    return this.ok(ctx, listing.remoteId);
  }

  /* ---------------------------------------------------------------- */
  /* Expédition                                                        */
  /* ---------------------------------------------------------------- */

  async markShipped(
    ctx: MarketplaceContext,
    input: FulfillmentInput,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const body: Record<string, unknown> = {};
    if (input.trackingNumber) {
      body["trackingNumber"] = input.trackingNumber;
      // eBay exige le transporteur dès qu'un numéro est fourni ; sans lui,
      // le suivi est enregistré mais l'acheteur ne voit rien.
      body["shippingCarrierCode"] = input.carrier ?? "Other";
    }
    if (input.lines?.length) {
      body["lineItems"] = input.lines.map((l) => ({
        lineItemId: l.remoteLineId,
        quantity: l.quantity,
      }));
    }

    const r = await this.call<{ fulfillmentId?: string }>(
      ctx,
      `/sell/fulfillment/v1/order/${encodeURIComponent(input.remoteOrderId)}/shipping_fulfillment`,
      { method: "POST", body: JSON.stringify(body) },
    );

    return this.ok(ctx, r?.fulfillmentId ?? input.remoteOrderId);
  }

  /* ---------------------------------------------------------------- */
  /* Ventes entrantes                                                  */
  /* ---------------------------------------------------------------- */

  async pollOrderEvents(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<PollResult> {
    const offset = cursor ? Number(cursor) : 0;
    const limit = 50;

    const d = await this.call<{
      total?: number;
      orders?: Array<{
        orderId: string;
        creationDate: string;
        orderPaymentStatus?: string;
        cancelStatus?: { cancelState?: string };
        lineItems?: Array<{
          lineItemId: string;
          sku?: string;
          legacyItemId?: string;
          quantity: number;
        }>;
      }>;
    }>(ctx, `/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}`);

    const events: CanonicalOrderEvent[] = (d.orders ?? []).map((o) => {
      const annule = o.cancelStatus?.cancelState === "CANCELED";
      return {
        marketplace: "ebay",
        accountId: ctx.account.id,
        remoteOrderId: o.orderId,
        // Le relevé n'a pas d'identifiant d'événement propre : on en fabrique
        // un stable à partir de la commande et de son état, sans quoi chaque
        // passage rejouerait toutes les commandes.
        eventId: `poll:${o.orderId}:${annule ? "cancelled" : (o.orderPaymentStatus ?? "unknown")}`,
        kind: annule ? "cancelled" : "paid",
        occurredAt: o.creationDate,
        lines: (o.lineItems ?? []).map((l) => ({
          sku: l.sku ?? undefined,
          quantity: l.quantity,
          remoteListingId: l.sku ?? l.legacyItemId ?? undefined,
        })),
        raw: o,
      };
    });

    const consumed = offset + (d.orders?.length ?? 0);
    return {
      events,
      cursor:
        d.total !== undefined && consumed < d.total ? String(consumed) : undefined,
    };
  }
}
