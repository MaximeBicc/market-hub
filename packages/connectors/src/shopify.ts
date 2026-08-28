import { ConnectorError, toMinorUnits } from "@hub/core";
import type { Page, UnifiedListing, UnifiedOrder, Money } from "@hub/core";
import type { MarketplaceConnector, SyncContext, TokenSet } from "./types.js";

/**
 * Connecteur Shopify — implémentation de RÉFÉRENCE.
 *
 * Les trois autres connecteurs suivent exactement la même forme. Si vous devez
 * en écrire un nouveau, copiez celui-ci et remplacez les appels réseau.
 *
 * Particularités Shopify :
 *  - Le jeton « offline » n'expire jamais → refresh() n'a rien à faire.
 *  - L'API GraphQL Admin facture un COÛT par requête (seau percé), pas un
 *    nombre de requêtes. Le coût réel revient dans `extensions.cost`.
 *  - Le HMAC des webhooks porte sur le corps BRUT.
 */

const API_VERSION = "2026-01";

function endpoint(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;
}

async function gql<T>(
  ctx: SyncContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await ctx.http(endpoint(ctx.externalId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ctx.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
    extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number } } };
  };

  if (json.errors?.length) {
    const throttled = json.errors.some(
      (e) => e.extensions?.code === "THROTTLED",
    );
    throw new ConnectorError(
      json.errors.map((e) => e.message).join("; "),
      throttled ? "rate_limited" : "permanent",
      throttled ? 2000 : undefined,
    );
  }
  if (!json.data) {
    throw new ConnectorError("Réponse Shopify sans data", "transient");
  }
  return json.data;
}

const ORDERS_QUERY = `
query Orders($cursor: String) {
  orders(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { displayName }
      lineItems(first: 25) {
        nodes {
          title
          quantity
          sku
          variant { id }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }
}`;

const PRODUCTS_QUERY = `
query Products($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      title
      price
      inventoryQuantity
      product { id title status onlineStoreUrl featuredMedia { preview { image { url } } } }
    }
  }
}`;

/** Shopify renvoie un statut financier + un statut d'exécution : on les fusionne. */
function mapOrderStatus(financial: string, fulfillment: string) {
  if (financial === "REFUNDED" || financial === "PARTIALLY_REFUNDED")
    return "refunded" as const;
  if (financial === "VOIDED") return "cancelled" as const;
  if (fulfillment === "FULFILLED") return "delivered" as const;
  if (fulfillment === "PARTIALLY_FULFILLED") return "shipped" as const;
  if (financial === "PAID") return "paid" as const;
  return "pending" as const;
}

export const shopifyConnector: MarketplaceConnector = {
  platform: "shopify",
  supportsWebhooks: true,
  // Seau standard : 100 points restitués/seconde, capacité 1000.
  // On raisonne en « requêtes » avec une marge volontairement large.
  limits: { qps: 2, qpd: 0, burst: 10 },

  buildAuthUrl({ creds, state, redirectUri }) {
    // `shop` est fourni par l'utilisateur au moment de la connexion et injecté
    // dans redirectUri par la route OAuth (voir routes/oauth.ts).
    const shopDomain = new URL(redirectUri).searchParams.get("shop") ?? "";
    const p = new URLSearchParams({
      client_id: creds.clientId,
      scope: "read_orders,read_products,write_products,read_inventory,write_inventory,read_publications,write_publications",
      redirect_uri: redirectUri,
      state,
      "grant_options[]": "", // vide = jeton offline, qui n'expire pas
    });
    return `https://${shopDomain}/admin/oauth/authorize?${p}`;
  },

  async exchangeCode({ creds, code, redirectUri }) {
    const shopDomain = new URL(redirectUri).searchParams.get("shop") ?? "";
    const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code,
      }),
    });
    if (!res.ok) {
      throw new ConnectorError(
        `Échange de code Shopify refusé (${res.status})`,
        "permanent",
      );
    }
    const json = (await res.json()) as { access_token: string; scope: string };
    return {
      tokens: {
        accessToken: json.access_token,
        refreshToken: null,
        scope: json.scope,
        accessExpiresAt: null, // jeton offline : pas d'expiration
        refreshExpiresAt: null,
      },
      externalId: shopDomain,
      displayName: shopDomain.replace(".myshopify.com", ""),
    };
  },

  async refresh(): Promise<TokenSet> {
    throw new ConnectorError(
      "Shopify (jeton offline) n'a pas de rafraîchissement",
      "permanent",
    );
  },

  async fetchOrders(ctx, cursor): Promise<Page<UnifiedOrder>> {
    type R = {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<Record<string, any>>;
      };
    };
    const d = await gql<R>(ctx, ORDERS_QUERY, { cursor });

    const items: UnifiedOrder[] = d.orders.nodes.map((o) => ({
      externalId: String(o.id),
      status: mapOrderStatus(
        o.displayFinancialStatus,
        o.displayFulfillmentStatus,
      ),
      total: toMinorUnits(
        o.totalPriceSet.shopMoney.amount,
        o.totalPriceSet.shopMoney.currencyCode,
      ),
      buyerName: o.customer?.displayName ?? null,
      placedAt: Math.floor(new Date(o.createdAt).getTime() / 1000),
      lines: (o.lineItems?.nodes ?? []).map((l: any) => ({
        sku: l.sku ?? null,
        listingExternalId: l.variant?.id ?? null,
        title: l.title,
        quantity: l.quantity,
        unitPrice: toMinorUnits(
          l.originalUnitPriceSet.shopMoney.amount,
          l.originalUnitPriceSet.shopMoney.currencyCode,
        ),
      })),
      raw: o,
    }));

    return {
      items,
      nextCursor: d.orders.pageInfo.hasNextPage
        ? d.orders.pageInfo.endCursor
        : null,
    };
  },

  async fetchListings(ctx, cursor): Promise<Page<UnifiedListing>> {
    type R = {
      productVariants: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<Record<string, any>>;
      };
    };
    const d = await gql<R>(ctx, PRODUCTS_QUERY, { cursor });

    const items: UnifiedListing[] = d.productVariants.nodes.map((v) => ({
      externalId: String(v.id),
      sku: v.sku || null,
      title: `${v.product?.title ?? ""}${v.title && v.title !== "Default Title" ? ` — ${v.title}` : ""}`,
      price: toMinorUnits(v.price, "EUR"), // devise réelle : shop.currencyCode, lu à la connexion
      quantity: v.inventoryQuantity ?? 0,
      status:
        v.product?.status === "ACTIVE"
          ? (v.inventoryQuantity ?? 0) > 0
            ? "active"
            : "sold_out"
          : "draft",
      url: v.product?.onlineStoreUrl ?? null,
      imageUrl: v.product?.featuredMedia?.preview?.image?.url ?? null,
      updatedAt: Math.floor(Date.now() / 1000),
    }));

    return {
      items,
      nextCursor: d.productVariants.pageInfo.hasNextPage
        ? d.productVariants.pageInfo.endCursor
        : null,
    };
  },

  async updateStock(ctx, listingExternalId, quantity) {
    const M = `
    mutation SetQty($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message }
      }
    }`;
    await gql(ctx, M, {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [{ inventoryItemId: listingExternalId, quantity }],
      },
    });
  },

  async updatePrice(ctx, listingExternalId, price: Money) {
    const M = `
    mutation UpdatePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }`;
    await gql(ctx, M, {
      productId: ctx.config["productId"],
      variants: [
        { id: listingExternalId, price: (price.amount / 100).toFixed(2) },
      ],
    });
  },

  async verifyWebhook({ creds, headers, rawBody }) {
    const received = headers.get("X-Shopify-Hmac-Sha256");
    if (!received) return false;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(creds.clientSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(rawBody),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

    // Comparaison à temps constant : une comparaison naïve fuit le secret.
    if (expected.length !== received.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
    }
    return diff === 0;
  },

  parseWebhook({ headers }) {
    const eventId = headers.get("X-Shopify-Webhook-Id");
    const topic = headers.get("X-Shopify-Topic");
    const shop = headers.get("X-Shopify-Shop-Domain");
    if (!eventId || !topic || !shop) return null;
    return { eventId, topic, externalShopId: shop };
  },

  async applyWebhook(_ctx, topic, rawBody) {
    if (!topic.startsWith("orders/")) return {};
    const o = JSON.parse(rawBody) as Record<string, any>;
    const currency = o.currency ?? "EUR";
    return {
      orders: [
        {
          externalId: `gid://shopify/Order/${o.id}`,
          status: mapOrderStatus(
            String(o.financial_status ?? "").toUpperCase(),
            String(o.fulfillment_status ?? "").toUpperCase(),
          ),
          total: toMinorUnits(o.total_price, currency),
          buyerName:
            [o.customer?.first_name, o.customer?.last_name]
              .filter(Boolean)
              .join(" ") || null,
          placedAt: Math.floor(new Date(o.created_at).getTime() / 1000),
          lines: (o.line_items ?? []).map((l: any) => ({
            sku: l.sku ?? null,
            listingExternalId: l.variant_id
              ? `gid://shopify/ProductVariant/${l.variant_id}`
              : null,
            title: l.title,
            quantity: l.quantity,
            unitPrice: toMinorUnits(l.price, currency),
          })),
          raw: o,
        },
      ],
    };
  },
};
