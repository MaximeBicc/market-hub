import { ConnectorError } from "@hub/core";
import type { Page, UnifiedListing, UnifiedOrder } from "@hub/core";
import type { MarketplaceConnector, SyncContext } from "./types.js";

/**
 * Connecteur Alibaba.com (Open Platform / passerelle « TOP »).
 *
 * ÉTAT : SQUELETTE. La signature des requêtes et l'échange OAuth sont écrits,
 * la cartographie des données ne l'est pas — l'API Alibaba est peu documentée
 * en anglais et le jeu d'endpoints dépend du programme auquel votre compte est
 * rattaché (Alibaba.com International, AliExpress, 1688 : trois surfaces
 * différentes). À compléter une fois vos accès validés.
 *
 * Ce que ce squelette fixe déjà correctement :
 *
 *  - Alibaba n'utilise PAS un Bearer classique. Chaque appel porte des
 *    paramètres communs (app_key, timestamp, sign_method, access_token) et une
 *    SIGNATURE `sign` calculée sur l'ensemble des paramètres triés.
 *  - La signature est un HMAC-SHA256 hexadécimal MAJUSCULE de la
 *    concaténation `chemin + clé1valeur1 + clé2valeur2 + ...` (paramètres triés
 *    par clé), avec l'app_secret comme clé.
 *  - L'horodatage doit être proche de l'heure serveur, sinon rejet.
 *
 * Dans l'architecture, Alibaba sert surtout de source d'APPROVISIONNEMENT
 * (prix d'achat, délais fournisseur) plutôt que de canal de vente : c'est ce
 * qui alimente `product.costPrice` et donc le calcul de marge du tableau de bord.
 */

const GATEWAY = "https://openapi-api.alibaba.com/rest";

/** Signature TOP : HMAC-SHA256 hex majuscule sur `path + k1v1k2v2...` trié. */
export async function signRequest(
  path: string,
  params: Record<string, string>,
  appSecret: string,
): Promise<string> {
  const sorted = Object.keys(params).sort();
  let base = path;
  for (const k of sorted) base += k + params[k];

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function call<T>(
  ctx: SyncContext,
  path: string,
  business: Record<string, string>,
): Promise<T> {
  const params: Record<string, string> = {
    app_key: String(ctx.config["clientId"] ?? ""),
    timestamp: String(Date.now()),
    sign_method: "sha256",
    access_token: ctx.accessToken,
    ...business,
  };
  params["sign"] = await signRequest(
    path,
    params,
    String(ctx.config["clientSecret"] ?? ""),
  );

  const res = await ctx.http(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return (await res.json()) as T;
}

export const alibabaConnector: MarketplaceConnector = {
  platform: "alibaba",
  supportsWebhooks: false,
  limits: { qps: 2, qpd: 3000, burst: 5 },

  buildAuthUrl({ creds, state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    });
    return `https://oauth.alibaba.com/authorize?${p}`;
  },

  async exchangeCode({ creds, code, redirectUri }) {
    const path = "/auth/token/create";
    const params: Record<string, string> = {
      app_key: creds.clientId,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      code,
      redirect_uri: redirectUri,
    };
    params["sign"] = await signRequest(path, params, creds.clientSecret);

    const res = await fetch(`${GATEWAY}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const j = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      account?: string;
      error_code?: string;
      error_msg?: string;
    };
    if (!j.access_token) {
      throw new ConnectorError(
        `Alibaba : ${j.error_code ?? "?"} ${j.error_msg ?? ""}`,
        "permanent",
      );
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      tokens: {
        accessToken: j.access_token,
        refreshToken: j.refresh_token ?? null,
        scope: null,
        accessExpiresAt: j.expires_in ? now + j.expires_in : null,
        refreshExpiresAt: null,
      },
      externalId: j.account ?? "alibaba",
      displayName: j.account ?? "Alibaba",
    };
  },

  async refresh({ creds, refreshToken }) {
    const path = "/auth/token/refresh";
    const params: Record<string, string> = {
      app_key: creds.clientId,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      refresh_token: refreshToken,
    };
    params["sign"] = await signRequest(path, params, creds.clientSecret);
    const res = await fetch(`${GATEWAY}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const j = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!j.access_token) {
      throw new ConnectorError("Rafraîchissement Alibaba refusé", "auth_expired");
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? refreshToken,
      scope: null,
      accessExpiresAt: j.expires_in ? now + j.expires_in : null,
      refreshExpiresAt: null,
    };
  },

  async fetchOrders(_ctx, _cursor): Promise<Page<UnifiedOrder>> {
    // TODO : alibaba.trade.getBuyerOrderList (côté achat) puis mapper vers
    // UnifiedOrder. Utiliser `call(ctx, "/alibaba/trade/...", {...})`.
    return { items: [], nextCursor: null };
  },

  async fetchListings(ctx, cursor): Promise<Page<UnifiedListing>> {
    // TODO : alibaba.icbu.product.list — sert à récupérer les prix
    // fournisseur qui alimentent product.costPrice.
    void call;
    void ctx;
    void cursor;
    return { items: [], nextCursor: null };
  },

  async updateStock() {
    throw new ConnectorError("Alibaba updateStock non implémenté", "permanent");
  },
  async updatePrice() {
    throw new ConnectorError("Alibaba updatePrice non implémenté", "permanent");
  },
  async verifyWebhook() {
    return false;
  },
  parseWebhook() {
    return null;
  },
  async applyWebhook() {
    return {};
  },
};
