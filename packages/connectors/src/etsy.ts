import { ConnectorError, toMinorUnits } from "@hub/core";
import type { Page, UnifiedListing, UnifiedOrder } from "@hub/core";
import type { MarketplaceConnector, SyncContext } from "./types.js";

/**
 * Connecteur Etsy (Open API v3).
 *
 * ⚠️ LE RISQUE OPÉRATIONNEL N° 1 DU PROJET
 * Le refresh_token Etsy expire au bout de 90 JOURS. S'il n'est pas utilisé
 * avant, la boutique doit être réautorisée à la main dans un navigateur.
 * C'est pour cela que le cron horaire rafraîchit les jetons Etsy bien avant
 * l'échéance, et qu'une alerte push part si un jeton approche des 60 jours.
 *
 * Quotas : 10 requêtes/seconde et 10 000 requêtes/jour, sur une fenêtre
 * glissante de 24 h (pas un reset à minuit).
 *
 * Authentification : PKCE obligatoire, et CHAQUE appel API exige DEUX en-têtes,
 * `Authorization: Bearer` ET `x-api-key` (le client_id). Oublier le second
 * renvoie un 401 trompeur.
 */

const BASE = "https://api.etsy.com/v3/application";
const SCOPES = [
  "listings_r",
  "listings_w",
  "transactions_r",
  "shops_r",
  "shops_w",
  "email_r",
].join(" ");

async function api<T>(
  ctx: SyncContext,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await ctx.http(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      "x-api-key": String(ctx.config["clientId"] ?? ""),
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return (await res.json()) as T;
}

export const etsyConnector: MarketplaceConnector = {
  platform: "etsy",
  supportsWebhooks: false, // Etsy ne pousse rien : polling obligatoire.
  limits: { qps: 5, qpd: 8000, burst: 10 }, // marge de 20 % sous les limites réelles

  buildAuthUrl({ creds, state, redirectUri, codeChallenge }) {
    const p = new URLSearchParams({
      response_type: "code",
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://www.etsy.com/oauth/connect?${p}`;
  },

  async exchangeCode({ creds, code, redirectUri, codeVerifier }) {
    const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) {
      throw new ConnectorError(
        `Échange de code Etsy refusé (${res.status})`,
        "permanent",
      );
    }
    const j = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Le access_token Etsy a la forme "{user_id}.{token}" — l'identifiant
    // utilisateur se lit directement dedans, sans appel supplémentaire.
    const userId = j.access_token.split(".")[0] ?? "";
    const now = Math.floor(Date.now() / 1000);

    const shopsRes = await fetch(`${BASE}/users/${userId}/shops`, {
      headers: {
        Authorization: `Bearer ${j.access_token}`,
        "x-api-key": creds.clientId,
      },
    });
    const shops = (await shopsRes.json()) as {
      shop_id?: number;
      shop_name?: string;
      results?: Array<{ shop_id: number; shop_name: string }>;
    };
    const shop = shops.results?.[0] ?? shops;

    return {
      tokens: {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        scope: SCOPES,
        accessExpiresAt: now + j.expires_in,
        refreshExpiresAt: now + 90 * 86400, // 90 jours — voir l'avertissement en tête
      },
      externalId: String(shop.shop_id ?? userId),
      displayName: shop.shop_name ?? `Etsy ${userId}`,
    };
  },

  async refresh({ creds, refreshToken }) {
    const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: creds.clientId,
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) {
      // 400 ici = refresh_token périmé (> 90 j) → réautorisation manuelle requise.
      throw new ConnectorError(
        `Rafraîchissement Etsy refusé (${res.status})`,
        res.status === 400 ? "auth_expired" : "transient",
      );
    }
    const j = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const now = Math.floor(Date.now() / 1000);
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      scope: null,
      accessExpiresAt: now + j.expires_in,
      refreshExpiresAt: now + 90 * 86400, // la fenêtre repart à chaque rafraîchissement
    };
  },

  async fetchOrders(ctx, cursor): Promise<Page<UnifiedOrder>> {
    const offset = cursor ? Number(cursor) : 0;
    const limit = 50;
    type R = {
      count: number;
      results: Array<Record<string, any>>;
    };
    const d = await api<R>(
      ctx,
      `/shops/${ctx.externalId}/receipts?limit=${limit}&offset=${offset}&was_paid=true`,
    );

    const items: UnifiedOrder[] = (d.results ?? []).map((r) => {
      const currency = r.grandtotal?.currency_code ?? "EUR";
      return {
        externalId: String(r.receipt_id),
        status: r.is_shipped
          ? ("shipped" as const)
          : r.is_paid
            ? ("paid" as const)
            : ("pending" as const),
        // Etsy renvoie déjà des entiers : {amount, divisor}. Pas de float.
        total: {
          amount: Math.round(
            (r.grandtotal.amount / r.grandtotal.divisor) * 100,
          ),
          currency,
        },
        buyerName: r.name ?? null,
        placedAt: r.created_timestamp,
        lines: (r.transactions ?? []).map((t: any) => ({
          sku: t.sku ?? null,
          listingExternalId: String(t.listing_id),
          title: t.title,
          quantity: t.quantity,
          unitPrice: {
            amount: Math.round((t.price.amount / t.price.divisor) * 100),
            currency: t.price.currency_code ?? currency,
          },
        })),
        raw: r,
      };
    });

    const consumed = offset + (d.results?.length ?? 0);
    return {
      items,
      nextCursor: consumed < (d.count ?? 0) ? String(consumed) : null,
    };
  },

  async fetchListings(ctx, cursor): Promise<Page<UnifiedListing>> {
    const offset = cursor ? Number(cursor) : 0;
    const limit = 100;
    type R = { count: number; results: Array<Record<string, any>> };
    const d = await api<R>(
      ctx,
      `/shops/${ctx.externalId}/listings?limit=${limit}&offset=${offset}&includes=Images`,
    );

    const items: UnifiedListing[] = (d.results ?? []).map((l) => ({
      externalId: String(l.listing_id),
      sku: l.skus?.[0] ?? null,
      title: l.title,
      price: {
        amount: Math.round((l.price.amount / l.price.divisor) * 100),
        currency: l.price.currency_code ?? "EUR",
      },
      quantity: l.quantity ?? 0,
      status:
        l.state === "active"
          ? l.quantity > 0
            ? ("active" as const)
            : ("sold_out" as const)
          : l.state === "draft"
            ? ("draft" as const)
            : ("ended" as const),
      url: l.url ?? null,
      imageUrl: l.images?.[0]?.url_570xN ?? null,
      updatedAt: l.last_modified_timestamp ?? Math.floor(Date.now() / 1000),
    }));

    const consumed = offset + (d.results?.length ?? 0);
    return {
      items,
      nextCursor: consumed < (d.count ?? 0) ? String(consumed) : null,
    };
  },

  async updateStock(ctx, listingExternalId, quantity) {
    // L'inventaire Etsy passe par les « products » de l'annonce : il faut lire
    // l'inventaire complet, muter la quantité, puis le réécrire entièrement.
    const inv = await api<{ products: Array<Record<string, any>> }>(
      ctx,
      `/listings/${listingExternalId}/inventory`,
    );
    const products = (inv.products ?? []).map((p) => ({
      ...p,
      offerings: (p.offerings ?? []).map((o: any) => ({ ...o, quantity })),
    }));
    await api(ctx, `/listings/${listingExternalId}/inventory`, {
      method: "PUT",
      body: JSON.stringify({ products }),
    });
  },

  async updatePrice(ctx, listingExternalId, price) {
    const inv = await api<{ products: Array<Record<string, any>> }>(
      ctx,
      `/listings/${listingExternalId}/inventory`,
    );
    const products = (inv.products ?? []).map((p) => ({
      ...p,
      offerings: (p.offerings ?? []).map((o: any) => ({
        ...o,
        price: price.amount / 100,
      })),
    }));
    await api(ctx, `/listings/${listingExternalId}/inventory`, {
      method: "PUT",
      body: JSON.stringify({ products }),
    });
  },

  async verifyWebhook() {
    return false; // Etsy ne fournit pas de webhooks.
  },
  parseWebhook() {
    return null;
  },
  async applyWebhook() {
    return {};
  },
};
