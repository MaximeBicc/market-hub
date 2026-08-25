import { ConnectorError } from "@hub/core";
import type { Page, UnifiedListing, UnifiedOrder } from "@hub/core";
import type { MarketplaceConnector, SyncContext } from "./types.js";

/**
 * Connecteur Alibaba.com (Open Platform, passerelle REST).
 *
 * ÉTAT : SQUELETTE. La signature des requêtes et l'échange OAuth sont écrits,
 * la cartographie des données ne l'est pas — l'API Alibaba est peu documentée
 * en anglais et le jeu d'endpoints dépend du programme auquel votre compte est
 * rattaché (Alibaba.com International, AliExpress, 1688 : trois surfaces
 * différentes). À compléter une fois vos accès validés.
 *
 * ATTENTION AU PIÈGE QUI A DÉJÀ COÛTÉ PLUSIEURS DÉFAUTS ICI : ce n'est pas
 * la passerelle « TOP » de Taobao (gw.api.taobao.com), qui signait en MD5 avec
 * le secret en préfixe ET en suffixe, et dont les hôtes d'authentification
 * diffèrent. Les deux répondent, ce qui rend une confusion invisible jusqu'au
 * refus d'un appel signé.
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
  for (const k of sorted) {
    const v = params[k];
    // Une paire à valeur vide est SAUTÉE, elle n'ajoute pas sa clé seule.
    // C'est ce que fait l'implémentation de référence d'Alibaba, et la
    // différence ne se voit que le jour où un paramètre facultatif arrive
    // vide : la signature devient invalide sans que rien ne l'explique.
    if (v === undefined || v === "") continue;
    base += k + v;
  }

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

  /*
   * UN 200 N'EST PAS UN SUCCÈS.
   *
   * La passerelle répond HTTP 200 même quand elle refuse, avec l'erreur dans
   * le corps. Le code rendait ce corps tel quel : une permission manquante,
   * une signature invalide ou un jeton expiré passaient pour des données, et
   * la cartographie qui suivait lisait des champs absents en silence.
   */
  const corps = (await res.json()) as T & ReponseAlibaba;
  const erreur = lireErreur(corps);
  if (erreur) throw erreur;
  return corps as T;
}

/** L'enveloppe d'erreur de la passerelle REST, superposée à toute réponse. */
interface ReponseAlibaba {
  code?: string;
  type?: string;
  message?: string;
  request_id?: string;
}

/**
 * L'erreur portée par une réponse, ou `null` si elle n'en porte pas.
 *
 * Le `type` d'Alibaba porte la distinction qui compte pour nous :
 *   ISV     — la faute vient de nous (paramètre, permission, signature) ;
 *             réessayer ne changera rien.
 *   ISP     — un service en aval d'Alibaba a flanché ;
 *   SYSTEM  — la passerelle elle-même ; les deux sont passagers.
 *
 * Sans cette distinction, le consommateur de file traite tout comme
 * définitif : `consumer.ts` bascule la boutique en `reauth_required` et
 * acquitte le message. Un incident de trente secondes chez Alibaba
 * verrouillerait le compte jusqu'à une intervention humaine.
 */
function lireErreur(corps: ReponseAlibaba): ConnectorError | null {
  // `code` absent ou « 0 » : la passerelle n'a rien à redire.
  if (!corps?.code || corps.code === "0") return null;

  const texte = `Alibaba ${corps.code}${
    corps.message ? ` : ${corps.message}` : ""
  }${corps.request_id ? ` (requête ${corps.request_id})` : ""}`;

  const type = (corps.type ?? "").toUpperCase();
  if (type === "ISP" || type === "SYSTEM") {
    return new ConnectorError(texte, "transient");
  }
  return new ConnectorError(texte, "permanent");
}

export const alibabaConnector: MarketplaceConnector = {
  platform: "alibaba",
  supportsWebhooks: false,
  // Alibaba ne publie AUCUN quota : la limite est un attribut de la
  // catégorie d'application, visible seulement dans la console. Ces chiffres
  // sont donc un garde-fou maison, prudent — pas une règle Alibaba.
  limits: { qps: 2, qpd: 3000, burst: 5 },

  buildAuthUrl({ creds, state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    });
    /*
     * `oauth.alibaba.com` — l'hôte historique de la passerelle TOP — RÉPOND.
     * C'est précisément ce qui rendait l'erreur indétectable. L'hôte de
     * l'Open Platform actuelle est celui-ci. À confirmer au premier passage
     * réel : un mauvais hôte se voit tout de suite, l'utilisateur atterrit
     * sur une page d'autorisation qui ne connaît pas l'application.
     */
    return `https://openapi-auth.alibaba.com/oauth/authorize?${p}`;
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
    // `error_code` / `error_msg` n'existent pas sur cette passerelle : le
    // message levé était littéralement « Alibaba : ? ». Les vrais champs sont
    // ceux de l'enveloppe REST, lus par `lireErreur`.
    const j = (await res.json()) as ReponseAlibaba & {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_expires_in?: number;
      account?: string;
    };
    const erreur = lireErreur(j);
    if (erreur) throw erreur;
    if (!j.access_token) {
      throw new ConnectorError(
        "Alibaba : réponse sans jeton d'accès",
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
        // `refresh_expires_in` ÉTAIT JETÉ. C'est pourtant la seule donnée qui
        // annonce la ré-autorisation manuelle inévitable : la durée du jeton
        // de rafraîchissement ne se remet jamais à zéro. Sans elle, le compte
        // tombe sans préavis.
        refreshExpiresAt: j.refresh_expires_in
          ? now + j.refresh_expires_in
          : null,
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
    const j = (await res.json()) as ReponseAlibaba & {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_expires_in?: number;
    };

    /*
     * TOUT ÉCHEC N'EST PAS UNE AUTORISATION MORTE.
     *
     * Le code levait `auth_expired` quoi qu'il arrive. En face,
     * `consumer.ts` bascule la boutique en `reauth_required` et acquitte le
     * message sans réessai : un hoquet passager d'Alibaba verrouillait le
     * compte jusqu'à ce qu'un humain reconnecte la boutique.
     *
     * `lireErreur` distingue le passager du définitif. Ce n'est que faute de
     * jeton rendu SANS erreur déclarée que l'autorisation est réputée morte.
     */
    const erreur = lireErreur(j);
    if (erreur) throw erreur;
    if (!j.access_token) {
      throw new ConnectorError(
        "Rafraîchissement Alibaba refusé : reconnectez la boutique",
        "auth_expired",
      );
    }

    const now = Math.floor(Date.now() / 1000);
    return {
      accessToken: j.access_token,
      // Le jeton de rafraîchissement peut TOURNER. Garder l'ancien quand un
      // nouveau arrive rendrait le compte injoignable au passage suivant.
      refreshToken: j.refresh_token ?? refreshToken,
      scope: null,
      accessExpiresAt: j.expires_in ? now + j.expires_in : null,
      refreshExpiresAt: j.refresh_expires_in
        ? now + j.refresh_expires_in
        : null,
    };
  },

  async fetchOrders(_ctx, _cursor): Promise<Page<UnifiedOrder>> {
    /*
     * À BRANCHER, MAIS SUR QUOI RESTE À ÉTABLIR.
     *
     * L'ancien commentaire nommait `alibaba.trade.getBuyerOrderList` : cette
     * API appartient à 1688, pas à Alibaba.com International. La piste
     * actuelle est `/alibaba/order/list` du groupe « ICBU Dropshipping
     * Solution », avec `role=buyer`.
     *
     * LA QUESTION OUVERTE, celle qui décide de tout : cette liste rend-elle
     * les commandes passées À LA MAIN sur alibaba.com, ou seulement celles
     * créées par l'API ? Les indices penchent pour la première (des statuts
     * y figurent qu'aucun appel API ne peut produire), mais rien ne le
     * confirme. Un seul appel réel tranchera — d'ici là, le stock entrant se
     * saisit à la main dans l'outil, et c'est le chemin nominal.
     *
     * Piège relevé : les dates de cette API sont en fuseau
     * America/Los_Angeles, pas UTC.
     */
    return { items: [], nextCursor: null };
  },

  async fetchListings(ctx, cursor): Promise<Page<UnifiedListing>> {
    /*
     * À BRANCHER. L'ancien commentaire nommait `alibaba.icbu.product.list`,
     * qui est une API VENDEUR : elle liste les produits qu'on publie soi-même
     * sur Alibaba, pas ceux qu'on achète. Inutile ici.
     *
     * La piste est `/eco/buyer/product/description`, côté acheteur. Réserve
     * connue : elle pourrait n'accepter que les produits du vivier « curated
     * for Dropshipping », auquel cas les fiches des fournisseurs négociés
     * resteraient hors de portée.
     */
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
