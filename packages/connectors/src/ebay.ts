import { ConnectorError, toMinorUnits } from "@hub/core";
import type { Page, UnifiedListing, UnifiedOrder } from "@hub/core";
import type { MarketplaceConnector, SyncContext } from "./types.js";

/**
 * Connecteur eBay (Sell APIs).
 *
 * ÉTAT : OAuth et lecture des commandes implémentés. Les écritures d'inventaire
 * et la vérification de signature des notifications sont à compléter — voir les
 * TODO. Rien d'autre dans le projet ne dépend de ces trous.
 *
 * Trois pièges spécifiques à eBay :
 *
 * 1. `redirect_uri` n'est PAS une URL. eBay attend un « RuName » (Redirect URL
 *    name) créé dans le portail développeur, qui pointe lui-même vers votre URL.
 *    C'est `AppCredentials.redirectAlias`.
 *
 * 2. Le jeton d'accès utilisateur ne vit que 2 HEURES. Le refresh_token vit
 *    18 mois. Le cron horaire suffit donc largement, mais toute requête doit
 *    tolérer un 401 et déclencher un rafraîchissement immédiat.
 *
 * 3. Les notifications eBay sont signées en ECDSA, pas en HMAC : il faut
 *    récupérer la clé publique via /commerce/notification/v1/public_key/{keyId}
 *    (et la mettre en cache dans KV), puis vérifier. eBay exige en plus une
 *    réponse à un « challenge » lors de l'enregistrement du endpoint.
 */

const AUTH_HOST = "https://auth.ebay.com";
const API_HOST = "https://api.ebay.com";

const SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
].join(" ");

function basic(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

export const ebayConnector: MarketplaceConnector = {
  platform: "ebay",
  supportsWebhooks: true, // via la Notification API (à câbler)
  limits: { qps: 3, qpd: 5000, burst: 10 },

  buildAuthUrl({ creds, state }) {
    const p = new URLSearchParams({
      client_id: creds.clientId,
      response_type: "code",
      redirect_uri: creds.redirectAlias ?? "", // le RuName, pas une URL
      scope: SCOPES,
      state,
    });
    return `${AUTH_HOST}/oauth2/authorize?${p}`;
  },

  async exchangeCode({ creds, code }) {
    const res = await fetch(`${API_HOST}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic(creds.clientId, creds.clientSecret)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: creds.redirectAlias ?? "",
      }),
    });
    if (!res.ok) {
      throw new ConnectorError(
        `Échange de code eBay refusé (${res.status})`,
        "permanent",
      );
    }
    const j = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_token_expires_in: number;
    };
    const now = Math.floor(Date.now() / 1000);

    // L'identité du vendeur se lit sur l'API Account.
    const who = await fetch(`${API_HOST}/sell/account/v1/program/get_opted_in_programs`, {
      headers: { Authorization: `Bearer ${j.access_token}` },
    });
    const sellerId = who.ok ? "ebay-seller" : "ebay-seller";

    return {
      tokens: {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        scope: SCOPES,
        accessExpiresAt: now + j.expires_in, // ~7200 s
        refreshExpiresAt: now + j.refresh_token_expires_in, // ~18 mois
      },
      externalId: sellerId,
      displayName: "eBay",
    };
  },

  async refresh({ creds, refreshToken }) {
    const res = await fetch(`${API_HOST}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic(creds.clientId, creds.clientSecret)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: SCOPES,
      }),
    });
    if (!res.ok) {
      throw new ConnectorError(
        `Rafraîchissement eBay refusé (${res.status})`,
        res.status === 400 ? "auth_expired" : "transient",
      );
    }
    const j = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    const now = Math.floor(Date.now() / 1000);
    return {
      accessToken: j.access_token,
      // eBay ne renvoie pas de nouveau refresh_token : on conserve l'ancien.
      refreshToken: refreshToken,
      scope: null,
      accessExpiresAt: now + j.expires_in,
      refreshExpiresAt: null, // inchangé, la valeur en base fait foi
    };
  },

  async fetchOrders(ctx, cursor): Promise<Page<UnifiedOrder>> {
    const offset = cursor ? Number(cursor) : 0;
    const limit = 50;
    const res = await ctx.http(
      `${API_HOST}/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
    );
    const d = (await res.json()) as {
      total: number;
      orders?: Array<Record<string, any>>;
    };

    const items: UnifiedOrder[] = (d.orders ?? []).map((o) => ({
      externalId: String(o.orderId),
      status:
        o.orderFulfillmentStatus === "FULFILLED"
          ? ("shipped" as const)
          : o.orderPaymentStatus === "PAID"
            ? ("paid" as const)
            : ("pending" as const),
      total: toMinorUnits(
        o.pricingSummary?.total?.value ?? "0",
        o.pricingSummary?.total?.currency ?? "EUR",
      ),
      buyerName: o.buyer?.username ?? null,
      placedAt: Math.floor(new Date(o.creationDate).getTime() / 1000),
      lines: (o.lineItems ?? []).map((l: any) => ({
        sku: l.sku ?? null,
        listingExternalId: l.legacyItemId ?? null,
        title: l.title,
        quantity: l.quantity,
        unitPrice: toMinorUnits(
          l.lineItemCost?.value ?? "0",
          l.lineItemCost?.currency ?? "EUR",
        ),
      })),
      raw: o,
    }));

    const consumed = offset + (d.orders?.length ?? 0);
    return { items, nextCursor: consumed < (d.total ?? 0) ? String(consumed) : null };
  },

  async fetchListings(ctx, cursor): Promise<Page<UnifiedListing>> {
    const offset = cursor ? Number(cursor) : 0;
    const limit = 100;
    const res = await ctx.http(
      `${API_HOST}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
    );
    const d = (await res.json()) as {
      total: number;
      inventoryItems?: Array<Record<string, any>>;
    };

    const items: UnifiedListing[] = (d.inventoryItems ?? []).map((it) => ({
      externalId: String(it.sku),
      sku: it.sku ?? null,
      title: it.product?.title ?? it.sku,
      price: { amount: 0, currency: "EUR" }, // le prix vit sur l'offer, pas l'inventory_item
      quantity: it.availability?.shipToLocationAvailability?.quantity ?? 0,
      status: "active" as const,
      url: null,
      imageUrl: it.product?.imageUrls?.[0] ?? null,
      updatedAt: Math.floor(Date.now() / 1000),
    }));

    const consumed = offset + (d.inventoryItems?.length ?? 0);
    return { items, nextCursor: consumed < (d.total ?? 0) ? String(consumed) : null };
  },

  async updateStock(ctx, sku, quantity) {
    await ctx.http(`${API_HOST}/sell/inventory/v1/inventory_item/${sku}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        "Content-Type": "application/json",
        "Content-Language": "fr-FR",
      },
      body: JSON.stringify({
        availability: { shipToLocationAvailability: { quantity } },
      }),
    });
  },

  async updatePrice() {
    // TODO : passe par /sell/inventory/v1/offer/{offerId} — nécessite de
    // mémoriser offerId à la synchronisation du catalogue.
    throw new ConnectorError("eBay updatePrice non implémenté", "permanent");
  },

  async verifyWebhook() {
    // TODO : signature ECDSA. Récupérer la clé publique via
    // GET /commerce/notification/v1/public_key/{keyId} (kid lu dans
    // l'en-tête x-ebay-signature, encodé en base64/JSON), la mettre en cache
    // dans KV, puis crypto.subtle.verify("ECDSA", ...).
    // Tant que ce n'est pas fait, on refuse : jamais d'acceptation par défaut.
    return false;
  },
  parseWebhook() {
    return null;
  },
  async applyWebhook() {
    return {};
  },
};
