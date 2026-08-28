import type {
  CanonicalOrderEvent,
  CapabilitySet,
  FulfillmentInput,
  Listing,
  Money,
  OptionAxis,
  Product,
  RemoteListing,
  CategorySuggestion,
  RemoteSetting,
  TargetResult,
  Variant,
  SignalWebhook,
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

/**
 * Un nœud de la taxonomie vendeur d'Etsy.
 *
 * `children` est RÉCURSIF : la réponse ne contient que la vingtaine de racines
 * au premier niveau, tout le reste est imbriqué. `count` ne compte donc que
 * les racines — s'en servir pour dimensionner quoi que ce soit induit en
 * erreur.
 */
interface NoeudTaxonomie {
  id?: number;
  name?: string;
  children?: NoeudTaxonomie[];
}

/*
 * Mots trop courants pour distinguer quoi que ce soit. Sans eux, « de » ou
 * « and » remonteraient la moitié du référentiel.
 */
const MOTS_VIDES = new Set([
  "les", "des", "une", "pour", "avec", "sur", "and", "the", "for", "with",
]);

/** Minuscules, accents pliés : « Câble » et « cable » doivent se trouver. */
function normaliserTexte(v: string): string {
  return v
    .normalize("NFD")
    // Les diacritiques décomposés par NFD. Écrit en points de code plutôt
    // qu'en caractères littéraux : ceux-ci sont invisibles dans un éditeur et
    // un copier-coller les perd sans que rien ne le signale.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

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

/**
 * Une propriété de la taxonomie Etsy, telle que
 * `/seller-taxonomy/nodes/{id}/properties` la rend.
 *
 * Tout est optionnel : la forme varie d'une catégorie à l'autre — certaines
 * n'ont ni `possible_values`, ni `display_name` — et croire un champ toujours
 * présent est la façon la plus rapide de faire tomber une publication sur un
 * `undefined`.
 */
interface EtsyPropriete {
  property_id?: number;
  property_name?: string;
  display_name?: string;
  supports_variations?: boolean;
  possible_values?: Array<{ value_id?: number; name?: string }>;
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
/**
 * Retrouve, dans l'inventaire d'Etsy, la ligne qui correspond à notre unité.
 *
 * Deux voies, dans cet ordre :
 *
 *   1. le SKU, quand les deux côtés en portent un — c'est l'identité la plus
 *      sûre, insensible à la traduction et à la casse ;
 *   2. les VALEURS d'options. Etsy les rend dans `property_values`, une entrée
 *      par propriété, chacune avec ses valeurs. On compare des ensembles
 *      normalisés : l'ordre des propriétés n'est pas garanti d'un appel à
 *      l'autre, et « Bleu Marine » chez nous peut être « bleu marine » chez
 *      Etsy sans que ce soit une autre couleur.
 */
function trouverProduit(
  produits: EtsyInventoryProduct[],
  unite: Variant,
): EtsyInventoryProduct | undefined {
  const sku = unite.sku?.trim();
  if (sku) {
    const parSku = produits.find((p) => (p.sku ?? "").trim() === sku);
    if (parSku) return parSku;
  }

  const attendues = ensembleNormalise(unite.optionValues);
  if (attendues.size === 0) return undefined;

  return produits.find((p) => {
    const siennes = ensembleNormalise(valeursEtsy(p));
    if (siennes.size !== attendues.size) return false;
    for (const v of attendues) if (!siennes.has(v)) return false;
    return true;
  });
}

/** Les valeurs d'options d'une ligne d'inventaire, à plat. */
function valeursEtsy(p: EtsyInventoryProduct): string[] {
  return (p.property_values ?? []).flatMap((pv) => {
    const v = (pv as { values?: unknown }).values;
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  });
}

/** Minuscules, accents pliés, espaces réduits — pour comparer, pas pour écrire. */
function ensembleNormalise(valeurs: string[]): Set<string> {
  return new Set(
    valeurs
      .map((v) =>
        v
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " "),
      )
      .filter(Boolean),
  );
}

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
/* Variations                                                          */
/* ------------------------------------------------------------------ */

/**
 * Etsy plafonne à DEUX propriétés de variation par annonce.
 *
 * Ce n'est pas contournable : ni en concaténant deux axes dans un seul, ce qui
 * fabriquerait des valeurs que le vendeur n'a jamais écrites, ni en créant
 * plusieurs annonces, ce qui multiplierait les frais d'insertion. Un produit à
 * trois axes ne se publie donc pas ici — et on le DIT.
 */
const ETSY_MAX_AXES = 2;

/**
 * Les deux propriétés « libres » d'Etsy (Custom Property 1 et 2).
 *
 * Toute catégorie n'expose pas les axes du vendeur : « Coloris de la coque »
 * n'existe dans aucune taxonomie. Etsy réserve pour cela deux propriétés à
 * texte libre, et c'est la seule façon documentée de porter un axe que sa
 * taxonomie ignore. On s'en sert en REPLI, jamais par défaut : une propriété
 * curatée donne un filtre de recherche à l'acheteur, la libre n'en donne pas.
 */
const PROPRIETE_LIBRE_1 = 513;
const PROPRIETE_LIBRE_2 = 514;

/** Les marques diacritiques, à retirer après décomposition NFD. */
const DIACRITIQUES = /[\u0300-\u036f]/g;

/** Compare des libellés sans se faire piéger par la casse ou les accents. */
function plier(v: string): string {
  return v
    .normalize("NFD")
    .replace(DIACRITIQUES, "")
    .trim()
    .toLowerCase();
}

/** Un axe résolu contre la taxonomie : ce qu'Etsy attend réellement. */
interface ColonneVariation {
  /** Le nom envoyé à Etsy — celui de la propriété quand elle existe. */
  nom: string;
  propertyId: number;
  /** Valeur pliée → identifiant curaté d'Etsy, quand il y en a un. */
  valeurs: Map<string, number>;
  /** Vrai quand la taxonomie n'a rien donné et qu'on part en valeur libre. */
  libre: boolean;
}

/**
 * Les axes du produit, ou leur reconstitution.
 *
 * `product.options` est la source normale. Mais un produit importé peut
 * arriver avec ses variantes et sans ses axes — c'est le cas aujourd'hui pour
 * tout produit lu depuis la base, dont le dépôt ne relit pas la colonne
 * `options`. Plutôt que de publier alors dix-sept coloris comme un article nu,
 * on relit les noms d'axes dans `optionKey` (« couleur=violet|taille=m »), qui
 * les porte par construction.
 *
 * Ces noms-là sont NORMALISÉS — minuscules, accents pliés. C'est une
 * dégradation, pas une invention : ils viennent des données du vendeur. Le
 * repli est signalé à l'appelant pour qu'il puisse le lire.
 */
function axesDeVariation(
  product: Product,
  variantes: Variant[],
): { axes: OptionAxis[]; reconstitues: boolean } {
  const declares = (product.options ?? []).filter(
    (a) => a.name.trim() !== "" && a.values.length > 0,
  );
  if (declares.length > 0) return { axes: declares, reconstitues: false };

  let noms: string[] = [];
  for (const v of variantes) {
    const segments = v.optionKey.split("|").filter((s) => s !== "");
    // La clé doit décrire EXACTEMENT les mêmes axes que les valeurs, sinon
    // elle ne dit rien de fiable sur cette variante.
    if (segments.length === 0 || segments.length !== v.optionValues.length) {
      continue;
    }
    const candidats = segments.map((s) => (s.split("=")[0] ?? "").trim());
    // Tout ou rien : un tableau à trous ferait publier un axe sans nom.
    if (candidats.every((n) => n !== "")) {
      noms = candidats;
      break;
    }
  }
  if (noms.length === 0) return { axes: [], reconstitues: true };

  const valeurs = noms.map(() => new Set<string>());
  for (const v of variantes) {
    for (const [i, val] of v.optionValues.entries()) {
      if (i < noms.length && val.trim() !== "") valeurs[i]?.add(val);
    }
  }
  return {
    axes: noms.map((name, i) => ({ name, values: [...(valeurs[i] ?? [])] })),
    reconstitues: true,
  };
}

/**
 * Ce qui interdit de publier ces variations — ou `null` si tout va bien.
 *
 * Tous ces contrôles tournent AVANT la moindre écriture. C'est la seule place
 * qui tienne : chez Etsy la création est facturée, et un brouillon posé puis
 * abandonné parce qu'un axe de trop traîne n'est pas rattrapable — il faudrait
 * aller le supprimer à la main, et l'annonce reste comptée.
 */
function refusDeVariation(
  axes: OptionAxis[],
  variantes: Variant[],
): string | null {
  if (axes.length === 0) {
    return "Ces déclinaisons n'ont pas d'axes nommés (ni options du produit, ni clé d'options exploitable). Publier ainsi écraserait toutes les déclinaisons en un seul article : nommez les axes, ou publiez à la main sur Etsy.";
  }

  if (axes.length > ETSY_MAX_AXES) {
    const retenus = axes.slice(0, ETSY_MAX_AXES).map((a) => a.name);
    const abandonnes = axes.slice(ETSY_MAX_AXES).map((a) => a.name);
    return `Etsy n'accepte que ${ETSY_MAX_AXES} axes de variation, ce produit en a ${axes.length}. Seraient retenus : ${retenus.join(" et ")} ; seraient abandonnés : ${abandonnes.join(", ")} — donc des déclinaisons vendues comme identiques. Ramenez le produit à deux axes, ou publiez-le à la main sur Etsy.`;
  }

  /*
   * Une valeur par axe, exactement. Ni moins — Etsy refuse une combinaison
   * incomplète — ni plus : les valeurs en trop seraient jetées, et une
   * déclinaison partirait sous l'identité d'une autre.
   */
  const bancales = variantes.filter(
    (v) =>
      v.optionValues.length !== axes.length ||
      v.optionValues.some((x) => x.trim() === ""),
  );
  if (bancales.length > 0) {
    const noms = bancales
      .slice(0, 5)
      .map((v) => v.sku || v.optionKey || v.id)
      .join(", ");
    return `Ces déclinaisons ne portent pas exactement une valeur par axe (${axes.length} attendue(s) : ${axes.map((a) => a.name).join(", ")}) : ${noms}${bancales.length > 5 ? "…" : ""}. Etsy exige une combinaison complète par déclinaison ; corrigez-les avant de diffuser.`;
  }

  /*
   * Les parenthèses sont REFUSÉES par Etsy dans une valeur de variation.
   * On ne les retire pas nous-mêmes : « Violet (mat) » deviendrait
   * « Violet mat » chez l'acheteur sans que personne l'ait décidé, et le
   * libellé ne correspondrait plus à celui des autres plateformes.
   */
  const fautives = [
    ...new Set(
      variantes.flatMap((v) => v.optionValues.filter((x) => /[()]/.test(x))),
    ),
  ];
  if (fautives.length > 0) {
    return `Etsy interdit les parenthèses dans les valeurs de variation : ${fautives.map((x) => `« ${x} »`).join(", ")}. Renommez ces valeurs avant de diffuser — les réécrire d'office changerait ce que voit l'acheteur.`;
  }

  return null;
}

/**
 * Le stock d'une déclinaison.
 *
 * Le modèle canonique ne le porte PAS : le stock vit par variante dans
 * l'inventaire central, que l'adaptateur ne reçoit pas. On lit donc un indice
 * s'il a été déposé dans `marketplaceData`, sinon on recopie le stock du
 * parent — et l'appelant est averti dans le message, parce que recopier 12 sur
 * dix-sept coloris annonce dix-sept fois douze pièces à la vente.
 */
function stockDeclare(v: Variant): number | null {
  const brut = v.marketplaceData?.["stock"];
  const n =
    typeof brut === "number"
      ? brut
      : typeof brut === "string" && brut.trim() !== ""
        ? Number(brut)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
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
    /*
     * LA TAXONOMIE N'EST PAS UN RÉGLAGE DE BOUTIQUE.
     *
     * Elle figurait dans cette condition, et c'était une incohérence : la
     * catégorie se choisit PAR PRODUIT — un porte-clés et une bougie ne vont
     * pas au même endroit — et `createListing` la lit d'abord sur le produit.
     * Un catalogue où chaque produit porte la sienne restait donc bloqué à la
     * porte, alors que l'adaptateur aurait su créer l'annonce.
     *
     * Ce qui manque vraiment se dit à la création, produit par produit, avec
     * un message qui le nomme.
     */
    const publiable = Boolean(c["shippingProfileId"] && c["readinessStateId"]);
    return {
      listingCreate: publiable,
      listingUpdate: true,
      listingActivate: true,
      listingDeactivate: true,
      listingDelete: true,
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
      inboundSales: "both",
      // Sans le secret de signature, aucune notification n'est acceptée :
      // l'abonnement existe peut-être chez Etsy, il ne sert à rien ici.
      pousseActive: Boolean(c["webhookSecret"]),
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
    marketplaceData?: Record<string, unknown>,
    url?: string,
  ): TargetResult {
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "success",
      ...(remoteId ? { remoteId } : {}),
      ...(message ? { message } : {}),
      ...(marketplaceData ? { marketplaceData } : {}),
      ...(url ? { url } : {}),
    };
  }

  /** Refus net, sans rien avoir écrit chez Etsy. */
  private aLaMain(ctx: MarketplaceContext, message: string): TargetResult {
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "manual_required",
      message,
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

    /*
     * QUI A FABRIQUÉ, ET QUAND — sans valeur par défaut, délibérément.
     *
     * Ces deux champs portaient `"i_did"` et `"made_to_order"` en dur, ce qui
     * déclarait à Etsy un article FAIT MAIN PAR LE VENDEUR, À LA COMMANDE.
     * Sur de la revente, c'est une fausse déclaration — et Etsy suspend des
     * boutiques pour ce motif, pas seulement des annonces.
     *
     * Inventer une valeur pour « faire passer » la publication reviendrait à
     * répéter l'erreur en silence. On refuse et on nomme ce qui manque.
     */
    const whoMade = product.whoMade;
    const whenMade = product.whenMade;
    if (!whoMade || !whenMade) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "manual_required",
        message:
          "Etsy exige de déclarer qui a fabriqué l'article et quand. Renseignez-les sur le produit : déclarer « fait main par moi » sur de la revente expose à la suspension de la boutique.",
      };
    }

    /*
     * L'ÉLIGIBILITÉ AVANT LA FACTURE.
     *
     * Etsy débite un frais d'insertion à la mise en vente et ne rembourse pas
     * un brouillon abandonné. Découvrir après coup que l'article n'entre dans
     * aucune de ses trois catégories laisse donc un brouillon payé et
     * invendable — et son message, « Oh dear, you cannot sell this item on
     * Etsy », ne nomme ni la règle ni le geste.
     */
    const partenaire = ctx.credentials?.["productionPartnerId"];
    const estFourniture = product.marketplaceData?.["etsyIsSupply"] === true;
    const inegible = refusEligibiliteEtsy({
      whoMade,
      whenMade,
      estFourniture,
      partenaire,
    });
    if (inegible) return this.aLaMain(ctx, inegible);

    /*
     * ══ LES DÉCLINAISONS, DÉCIDÉES AVANT LA MOINDRE ÉCRITURE ══
     *
     * Etsy facture chaque mise en ligne et ne rembourse pas un brouillon
     * abandonné. Tout ce qui peut interdire les variations — trois axes, une
     * valeur entre parenthèses, une déclinaison sans valeur — est donc tranché
     * ICI, avant que quoi que ce soit n'existe chez Etsy. Découvrir le
     * problème après la création laisserait un brouillon orphelin que
     * l'orchestrateur n'enregistre même pas sur un `manual_required` : le
     * prochain essai en créerait un second.
     */
    const variantes = (product.variants ?? []).filter(
      (v) => v.status === "active",
    );
    // Une variante unique sans valeur d'option EST le produit lui-même : c'est
    // le cas courant, et il ne passe pas par l'inventaire.
    const aDesDeclinaisons = variantes.some((v) => v.optionValues.length > 0);

    const { axes, reconstitues } = aDesDeclinaisons
      ? axesDeVariation(product, variantes)
      : { axes: [] as OptionAxis[], reconstitues: false };

    if (aDesDeclinaisons) {
      const refus = refusDeVariation(axes, variantes);
      if (refus) return this.aLaMain(ctx, refus);
    }

    /*
     * Tout ce qu'Etsy exige a été vérifié — déclarations, éligibilité,
     * profils, cohérence des axes. La ligne suivante crée un brouillon
     * FACTURÉ. On s'arrête ici en répétition : c'est précisément le genre
     * d'écriture qu'on ne veut pas déclencher pour vérifier.
     */
    if (ctx.dryRun) {
      return this.ok(
        ctx,
        undefined,
        `Prêt à publier chez Etsy : catégorie ${taxonomy}, ${whoMade}/${whenMade}${estFourniture ? ", fourniture créative" : partenaire ? ", partenaire de production déclaré" : ""}, ${variantes.length || 1} déclinaison(s).${product.title.length > 140 ? ` Titre coupé à 140 caractères : « ${product.title.slice(0, 140)} ».` : ""}`,
      );
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
          who_made: whoMade,
          when_made: whenMade,
          taxonomy_id: String(taxonomy),
          /*
           * Ces deux-là ne sont pas décoratifs : ce sont eux qui font entrer
           * l'article dans l'une des catégories autorisées. Omis, un article
           * fabriqué par quelqu'un d'autre n'entre dans aucune.
           */
          is_supply: String(estFourniture),
          ...(partenaire ? { production_partner_ids: partenaire } : {}),
          shipping_profile_id: String(shipping),
          readiness_state_id: String(readiness),
          ...((product.tags?.length ?? 0) > 0
            ? { tags: product.tags!.join(",") }
            : {}),
          ...((product.materials?.length ?? 0) > 0
            ? { materials: product.materials!.join(",") }
            : {}),
          // Créée en brouillon : Etsy débite un frais d'insertion à la
          // publication, et une annonce publiée sans relecture se paie.
          state: "draft",
        },
      },
    );

    /*
     * L'INVENTAIRE — le brouillon existe, on lui pose ses déclinaisons.
     *
     * Une annonce Etsy naît toujours avec UN produit d'inventaire. Les
     * variations ne s'écrivent pas à la création : elles arrivent par un
     * `PUT .../inventory` qui remplace ce produit unique par la liste complète.
     *
     * L'échec est NON BLOQUANT, comme pour les photos, et pour la même raison :
     * le brouillon est déjà chez Etsy et facturé. Renvoyer un refus le rendrait
     * invisible à l'orchestrateur — qui n'enregistre l'annonce que sur
     * `success` ou `pending_remote` — et le prochain essai en créerait un
     * second. On rend donc l'identifiant, et on DIT ce qui n'a pas été posé.
     */
    let produitsPoses = 1;
    let noteVariations = "";

    if (aDesDeclinaisons) {
      const retenus = axes.slice(0, ETSY_MAX_AXES);
      const { colonnes, avertissement } = await this.proprietesDeVariation(
        ctx,
        String(taxonomy),
        retenus,
      );
      try {
        produitsPoses = await this.poserVariations(
          ctx,
          created.listing_id,
          colonnes,
          variantes,
          product.stock,
          readiness,
        );
        noteVariations = ` · ${produitsPoses} déclinaison(s) posées sur ${colonnes
          .map((col) => col.nom)
          .join(" × ")}`;
      } catch (err) {
        produitsPoses = 1;
        noteVariations = ` · VARIATIONS NON POSÉES (${err instanceof Error ? err.message : String(err)}) — le brouillon existe mais n'a qu'une seule déclinaison : complétez-le dans Etsy`;
      }
      if (avertissement) noteVariations += ` · ${avertissement}`;
      if (reconstitues) {
        noteVariations +=
          " · noms d'axes repris des clés d'options, en minuscules : vérifiez-les avant publication";
      }
      if (variantes.every((v) => stockDeclare(v) === null)) {
        noteVariations += ` · stock du parent (${Math.max(0, product.stock)}) recopié sur chaque déclinaison — à ajuster avant publication`;
      }
    }

    /*
     * LES PHOTOS — le seul cas des trois plateformes où il faut transporter
     * les OCTETS.
     *
     * Etsy n'accepte aucune URL : ni champ `image_url`, ni récupération côté
     * serveur. Il faut un `multipart/form-data` sur un point d'entrée séparé,
     * après création du brouillon. Le Worker fait donc relais : il télécharge
     * l'image et la retransmet, sans jamais la stocker.
     *
     * C'est aussi pour cela qu'un brouillon Etsy sans photo est un cul-de-sac :
     * Etsy refuse de passer une annonce en `active` sans image.
     *
     * L'échec est NON BLOQUANT et rapporté : le brouillon existe déjà chez
     * Etsy, prétendre le contraire ferait recréer un doublon au prochain essai.
     */
    const photos = (product.images ?? []).slice(0, 10);
    let posees = 0;
    const refusees: string[] = [];

    for (const url of photos) {
      try {
        posees += await this.envoyerImage(ctx, created.listing_id, url, posees);
      } catch (err) {
        refusees.push(err instanceof Error ? err.message : String(err));
      }
    }

    const note =
      photos.length === 0
        ? " · AUCUNE photo : Etsy refusera de la mettre en vente"
        : refusees.length > 0
          ? ` · ${posees}/${photos.length} photo(s) transmises — ${refusees[0]}`
          : ` · ${posees} photo(s) transmises`;

    return this.ok(
      ctx,
      String(created.listing_id),
      `Créée en brouillon — à publier depuis Etsy après relecture${noteVariations}${note}`,
      // Ce que la suite exige : l'identifiant d'annonce pour toute mise à jour,
      // et le nombre de produits d'inventaire réellement écrits — sans lui,
      // impossible de savoir si les déclinaisons sont passées.
      { listingId: String(created.listing_id), products: produitsPoses },
    );
  }

  /**
   * Résout les axes du produit contre la taxonomie de sa catégorie.
   *
   * Etsy ne veut pas d'un nom d'axe : il veut un `property_id` pris dans la
   * catégorie choisie. « Couleur » n'est donc pas envoyable tel quel — il faut
   * le retrouver dans la liste que la taxonomie expose pour cette catégorie.
   *
   * En cas d'échec — catégorie sans propriété correspondante, ou taxonomie qui
   * ne répond pas — on retombe sur les deux propriétés libres d'Etsy. C'est
   * fonctionnel mais dégradé : l'acheteur perd le filtre de recherche associé
   * à la propriété curatée. Le repli est donc REMONTÉ dans le message, jamais
   * silencieux.
   */
  private async proprietesDeVariation(
    ctx: MarketplaceContext,
    taxonomyId: string,
    axes: OptionAxis[],
  ): Promise<{ colonnes: ColonneVariation[]; avertissement?: string }> {
    let catalogue: EtsyPropriete[] = [];
    let echec = "";

    try {
      const d = await this.call<{ results?: EtsyPropriete[] }>(
        ctx,
        `/seller-taxonomy/nodes/${encodeURIComponent(taxonomyId)}/properties`,
      );
      catalogue = d?.results ?? [];
    } catch (err) {
      echec = err instanceof Error ? err.message : String(err);
    }

    const inconnus: string[] = [];
    const colonnes: ColonneVariation[] = axes.map((axe, i) => {
      const trouvee = catalogue.find(
        (c) =>
          typeof c.property_id === "number" &&
          c.supports_variations !== false &&
          (plier(c.property_name ?? "") === plier(axe.name) ||
            plier(c.display_name ?? "") === plier(axe.name)),
      );

      if (!trouvee || typeof trouvee.property_id !== "number") {
        inconnus.push(axe.name);
        return {
          nom: axe.name,
          // Deux axes au maximum, donc deux propriétés libres : il n'y a pas
          // de troisième cas à traiter.
          propertyId: i === 0 ? PROPRIETE_LIBRE_1 : PROPRIETE_LIBRE_2,
          valeurs: new Map<string, number>(),
          libre: true,
        };
      }

      const valeurs = new Map<string, number>();
      for (const v of trouvee.possible_values ?? []) {
        if (typeof v.value_id === "number" && v.name) {
          valeurs.set(plier(v.name), v.value_id);
        }
      }
      return {
        nom: trouvee.display_name || trouvee.property_name || axe.name,
        propertyId: trouvee.property_id,
        valeurs,
        libre: false,
      };
    });

    const avertissement = echec
      ? `taxonomie illisible (${echec}) : ${axes.map((a) => a.name).join(" et ")} partent en propriété libre, sans filtre de recherche`
      : inconnus.length > 0
        ? `${inconnus.join(" et ")} n'existe pas dans cette catégorie Etsy : parti en propriété libre, sans filtre de recherche`
        : "";

    return {
      colonnes,
      ...(avertissement ? { avertissement } : {}),
    };
  }

  /**
   * Écrit les déclinaisons dans l'inventaire du brouillon.
   *
   * QUATRE PIÈGES, tous vérifiés sur la spécification :
   *
   * 1. Le prix est un DÉCIMAL (`24.50`). La forme `{amount, divisor}` que la
   *    LECTURE renvoie est refusée en écriture, avec un message qui ne le dit
   *    pas.
   * 2. `value_ids` et `values` sont appariés POSITION PAR POSITION. Une valeur
   *    non curatée n'a pas d'identifiant : la convention d'Etsy veut alors
   *    l'identifiant de la propriété elle-même en remplissage.
   * 3. Les trois tableaux `*_on_property` déclarent sur quels axes le prix, le
   *    stock et le SKU varient. Les omettre aplatit les variations.
   * 4. Rien de ce que la lecture ajoute — `product_id`, `offering_id`,
   *    `scale_name`, `is_deleted`, `value_pairs` — ne doit repartir. Ici on
   *    construit à partir du modèle canonique, donc le problème ne se pose pas
   *    en création ; il se poserait à la relecture.
   */
  private async poserVariations(
    ctx: MarketplaceContext,
    listingId: number,
    colonnes: ColonneVariation[],
    variantes: Variant[],
    stockParent: number,
    readiness: string,
  ): Promise<number> {
    const readinessId = Number(readiness);

    const produits = variantes.map((v) => ({
      sku: v.sku ?? "",
      property_values: colonnes.map((col, i) => {
        const brut = v.optionValues[i] ?? "";
        const curatee = col.valeurs.get(plier(brut));
        return {
          property_id: col.propertyId,
          property_name: col.nom,
          value_ids: [curatee ?? col.propertyId],
          values: [brut],
          // Aucune échelle : les échelles servent aux tailles normalisées
          // (« EU 38 »), et en inventer une changerait le sens de la valeur.
          scale_id: null,
        };
      }),
      offerings: [
        {
          price: Number((v.price.amount / 100).toFixed(2)),
          quantity: stockDeclare(v) ?? Math.max(0, stockParent),
          // `is_enabled` et non `state` : une offre désactivée disparaît de
          // l'annonce sans être supprimée. Toutes les déclinaisons actives
          // arrivent donc activées — l'annonce, elle, reste un brouillon.
          is_enabled: true,
          ...(Number.isFinite(readinessId) && readinessId > 0
            ? { readiness_state_id: readinessId }
            : {}),
        },
      ],
    }));

    const ids = colonnes.map((c) => c.propertyId);
    // Le plus granulaire qui soit : Etsy exige que deux déclinaisons partageant
    // la valeur d'une propriété PORTEUSE de prix aient le même prix. Déclarer
    // les deux axes est donc la seule forme qui accepte un prix par
    // combinaison.
    const prixVarie = new Set(variantes.map((v) => v.price.amount)).size > 1;
    const avecSku = variantes.some((v) => (v.sku ?? "") !== "");

    await this.call(ctx, `/listings/${listingId}/inventory`, {
      method: "PUT",
      body: JSON.stringify({
        products: produits,
        price_on_property: prixVarie ? ids : [],
        // Le stock est compté PAR déclinaison dans tout l'outil : le déclarer
        // porté par les propriétés est ce qui permettra de le repousser
        // coloris par coloris, même si les quantités sont égales aujourd'hui.
        quantity_on_property: ids,
        sku_on_property: avecSku ? ids : [],
      }),
    });

    return produits.length;
  }

  /**
   * Relaie une image vers Etsy : téléchargement puis renvoi en multipart.
   *
   * Rien n'est conservé. Le corps est lu en mémoire le temps d'un appel — les
   * photos produit pèsent quelques centaines de kilo-octets, très en deçà de
   * ce qu'une invocation de Worker peut tenir.
   *
   * `this.call` n'est pas utilisé : il impose un `Content-Type`, or celui d'un
   * multipart doit contenir la frontière générée par `FormData`. On passe donc
   * par le transport en laissant l'en-tête être calculé.
   */
  private async envoyerImage(
    ctx: MarketplaceContext,
    listingId: number,
    url: string,
    rang: number,
  ): Promise<number> {
    const http = ctx.http ?? fetch;

    const source = await fetch(url);
    if (!source.ok) {
      throw new Error(`image inaccessible (${source.status}) : ${url.slice(0, 80)}`);
    }
    const octets = await source.blob();

    const corps = new FormData();
    corps.append("image", octets, `image-${rang + 1}.jpg`);
    corps.append("rank", String(rang + 1));

    const token = await this.token(ctx);
    const res = await http(
      `${API}/shops/${this.shopId(ctx)}/listings/${listingId}/images`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "x-api-key": apiKeyHeader(
            ctx.credentials?.["clientId"] ?? "",
            ctx.credentials?.["clientSecret"],
          ),
        },
        body: corps,
      },
    );

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 150).trim();
      throw new Error(`Etsy a refusé l'image (${res.status}) ${detail}`);
    }
    return 1;
  }

  async updatePrice(
    ctx: MarketplaceContext,
    listing: Listing,
    price: Money,
    _idempotencyKey?: string,
    unite?: Variant,
  ): Promise<TargetResult> {
    return this.writeInventory(
      ctx,
      listing,
      { priceMinor: price.amount },
      unite,
    );
  }

  async updateStock(
    ctx: MarketplaceContext,
    listing: Listing,
    stock: number,
    _idempotencyKey?: string,
    unite?: Variant,
  ): Promise<TargetResult> {
    return this.writeInventory(
      ctx,
      listing,
      { quantity: Math.max(0, stock) },
      unite,
    );
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
    unite?: Variant,
  ): Promise<TargetResult> {
    const id = listing.remoteId;
    if (!id) throw new Error("Etsy : annonce sans identifiant distant");

    const inv = await this.call<EtsyInventory>(ctx, `/listings/${id}/inventory`);

    /*
     * ON RELIT TOUT, ON NE CHANGE QU'UNE LIGNE, ON RÉÉCRIT TOUT.
     *
     * L'écriture d'inventaire d'Etsy est un remplacement COMPLET : il n'existe
     * pas de modification partielle. Le code appliquait donc la nouvelle
     * quantité à CHAQUE déclinaison — inoffensif sur une annonce simple,
     * désastreux dès qu'elle a dix-sept coloris : une vente de trois violets
     * mettait les dix-sept à trois.
     *
     * Maintenant que le cœur dit quelle unité a bougé, on retrouve SA ligne et
     * on laisse les seize autres exactement comme Etsy les rend. Le
     * remplacement reste complet ; c'est son contenu qui devient juste.
     */
    const vivants = (inv.products ?? []).filter((p) => !p.is_deleted);
    if (vivants.length === 0) {
      throw new Error("Etsy : cette annonce n'a aucun produit d'inventaire");
    }

    let cible: EtsyInventoryProduct | undefined;
    if (vivants.length > 1) {
      if (!unite) {
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message:
            "Annonce à déclinaisons : impossible d'écrire sans savoir quel coloris est visé.",
        };
      }
      cible = trouverProduit(vivants, unite);
      if (!cible) {
        // Nommer l'échec plutôt que d'écrire sur la première venue : une
        // déclinaison ajoutée chez Etsy après la création n'est pas connue de
        // notre côté, et deviner mettrait la quantité sur le mauvais coloris.
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message: `Déclinaison « ${unite.optionValues.join(" / ") || unite.optionKey} » introuvable dans l'annonce Etsy. Relancez une synchronisation du catalogue.`,
        };
      }
    }

    const products = vivants.map((p) =>
      // Un patch vide laisse la ligne telle qu'Etsy la rend : même prix, même
      // quantité. C'est ce qui permet de réécrire l'inventaire entier sans
      // toucher aux déclinaisons que la commande ne vise pas.
      cleanProduct(p, !cible || p === cible ? patch : {}),
    );

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

  /**
   * Efface l'annonce chez Etsy.
   *
   * IRRÉVERSIBLE : l'annonce part avec son ancienneté, ses favoris et son
   * historique de ventes, et la republier se repaie. C'est pour cette raison
   * que la règle du stock à zéro DÉSACTIVE au lieu d'effacer — seule la
   * suppression du produit passe par ici.
   */
  async deleteListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const id = listing.remoteId;
    if (!id) throw new Error("Etsy : annonce sans identifiant distant");

    try {
      await this.call(ctx, `/listings/${id}`, { method: "DELETE" });
    } catch (e) {
      // Déjà effacée depuis Etsy : l'état voulu est atteint.
      if (!(e instanceof Error) || !/réponse 404/.test(e.message)) throw e;
      return this.ok(ctx, id, "Annonce déjà absente d'Etsy — rien à effacer.");
    }
    return this.ok(ctx, id, "Annonce effacée chez Etsy.");
  }

  private async setState(
    ctx: MarketplaceContext,
    listing: Listing,
    state: "active" | "inactive",
  ): Promise<TargetResult> {
    const id = listing.remoteId;
    if (!id) throw new Error("Etsy : annonce sans identifiant distant");

    try {
      await this.call(ctx, `/shops/${this.shopId(ctx)}/listings/${id}`, {
        method: "PATCH",
        form: { state },
      });
    } catch (e) {
      /*
       * UNE ANNONCE DÉJÀ ABSENTE N'EST PAS UN ÉCHEC — quand on la retirait.
       *
       * Effacée depuis Etsy, elle répond 404. Traiter cela en échec bloquait
       * la suppression du produit, qui commence par retirer partout, alors que
       * l'état voulu — plus rien en vente — est déjà atteint. Dans l'autre
       * sens, republier ce qui n'existe plus reste un échec.
       */
      const introuvable =
        state === "inactive" &&
        e instanceof Error &&
        /réponse 404/.test(e.message);
      if (!introuvable) throw e;
      return this.ok(
        ctx,
        id,
        "Annonce absente d'Etsy — il n'y avait plus rien à retirer de la vente.",
      );
    }
    if (state === "active") {
      const url = `https://www.etsy.com/listing/${id}`;
      return this.ok(
        ctx,
        id,
        "Annonce publiée et visible sur Etsy.",
        { listingId: id },
        url,
      );
    }
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

  /**
   * Les réglages de boutique sans lesquels Etsy refuse de publier.
   *
   * La catégorie n'y figure pas volontairement : elle se choisit PAR PRODUIT,
   * dans la taxonomie d'Etsy, et proposer une valeur unique de boutique
   * pousserait à ranger un porte-clés et une bougie au même endroit.
   */
  async listSettings(ctx: MarketplaceContext): Promise<RemoteSetting[]> {
    const boutique = this.shopId(ctx);

    const lire = async <T>(
      chemin: string,
      extraire: (
        d: T,
      ) => Array<{ id: string; label: string; detail?: string | undefined }>,
    ) => {
      try {
        return extraire(await this.call<T>(ctx, chemin));
      } catch {
        return [];
      }
    };

    const [livraison, preparation, partenaires] = await Promise.all([
      lire<{
        results?: Array<{
          shipping_profile_id?: number;
          title?: string;
          origin_country_iso?: string;
          origin_postal_code?: string;
        }>;
      }>(`/shops/${boutique}/shipping-profiles`, (d) =>
        (d.results ?? []).map((p) => ({
          id: String(p.shipping_profile_id),
          label: p.title ?? `Profil ${p.shipping_profile_id}`,
          // Un profil de livraison ne porte PAS de délai de préparation —
          // celui-ci vit dans le profil de traitement, séparé. On montre donc
          // l'origine de l'envoi, qui est ce qui distingue deux profils.
          detail: [p.origin_country_iso, p.origin_postal_code]
            .filter(Boolean)
            .join(" · "),
        })),
      ),
      lire<{
        results?: Array<{
          readiness_state_id?: number;
          min_processing_days?: number;
          max_processing_days?: number;
          /** Libellé déjà traduit par Etsy : « Réalisé sur commande (1-2 jours) ». */
          processing_days_display_label?: string;
        }>;
      }>(`/shops/${boutique}/readiness-state-definitions`, (d) =>
        (d.results ?? []).map((p) => ({
          id: String(p.readiness_state_id),
          /*
           * ETSY FOURNIT DÉJÀ LE LIBELLÉ, TRADUIT.
           *
           * Cette ligne cherchait `min_processing_time`, qui n'existe pas —
           * le champ s'appelle `min_processing_days`. Le repli affichait donc
           * l'identifiant brut, « 1510416135313 », dans un menu censé aider à
           * choisir. Un identifiant à quatorze chiffres dans une liste de
           * choix, c'est un formulaire qu'on remplit au hasard.
           */
          label:
            p.processing_days_display_label ??
            (p.min_processing_days != null
              ? `${p.min_processing_days} à ${p.max_processing_days} jours de préparation`
              : `Profil ${p.readiness_state_id}`),
        })),
      ),
      /*
       * LES PARTENAIRES DE PRODUCTION — la porte d'entrée de la revente.
       *
       * Etsy n'autorise que trois sortes d'articles : fait main, fourniture
       * créative, ou vintage de vingt ans et plus. Un article fabriqué par
       * quelqu'un d'autre n'entre dans la première qu'à une condition — que
       * ce « quelqu'un d'autre » soit DÉCLARÉ comme partenaire de production.
       * Sans lui, Etsy répond « Oh dear, you cannot sell this item on Etsy »,
       * un message qui ne nomme ni la règle ni le geste.
       */
      lire<{
        results?: Array<{
          production_partner_id?: number;
          partner_name?: string;
          location?: string;
        }>;
      }>(`/shops/${boutique}/production-partners`, (d) =>
        (d.results ?? []).map((p) => ({
          id: String(p.production_partner_id),
          label: p.partner_name ?? `Partenaire ${p.production_partner_id}`,
          detail: p.location ?? "",
        })),
      ),
    ]);

    return [
      {
        key: "productionPartnerId",
        label: "Partenaire de production",
        aide: "À déclarer dans votre boutique Etsy → Paramètres → Production. Obligatoire dès qu'un article est fabriqué par quelqu'un d'autre : sans lui, Etsy refuse la mise en vente sans expliquer pourquoi.",
        options: partenaires,
      },
      {
        key: "shippingProfileId",
        label: "Profil de livraison",
        aide: "À créer dans votre boutique Etsy → Paramètres → Expédition.",
        options: livraison,
      },
      {
        key: "readinessStateId",
        label: "Délai de préparation",
        aide: "À créer dans votre boutique Etsy → Paramètres → Délais de traitement.",
        options: preparation,
      },
    ];
  }

  /**
   * Cherche une catégorie Etsy depuis du texte libre.
   *
   * ETSY N'A AUCUNE RECHERCHE. Sa seule route de taxonomie renvoie l'ARBRE
   * ENTIER — environ six mille catégories, deux à trois mégaoctets — sans
   * pagination ni filtre. Le tri se fait donc ici.
   *
   * Conséquence pratique : chaque recherche coûte le téléchargement complet.
   * C'est pour cela que l'écran cherche sur validation, jamais à la frappe :
   * un arbre de trois mégaoctets par lettre tapée serait insoutenable.
   *
   * Seules les FEUILLES sont proposées. Etsy refuse une catégorie
   * intermédiaire, et en proposer une donnerait un refus incompréhensible au
   * moment de publier.
   */
  async searchCategories(
    ctx: MarketplaceContext,
    query: string,
  ): Promise<CategorySuggestion[]> {
    const racines = await this.call<{ results?: NoeudTaxonomie[] }>(
      ctx,
      "/seller-taxonomy/nodes",
    );

    /*
     * UN CLASSEMENT, PAS UN FILTRE BINAIRE.
     *
     * La première version exigeait que TOUS les mots soient présents. Comme le
     * champ est pré-rempli avec le titre du produit — sept mots pour « Clip
     * magnétique range câble / Organisateur de câbles » — aucune catégorie ne
     * pouvait satisfaire la condition, et l'écran restait vide sans rien
     * expliquer. Un « et » sur du texte libre ne trouve jamais rien.
     *
     * On compte donc les mots qui correspondent, et on classe. Un mot trouvé
     * dans le NOM de la feuille pèse plus qu'un mot trouvé dans son chemin :
     * « Cable » dans « Cable Organizers » vaut mieux que « Cable » aperçu
     * trois niveaux plus haut.
     */
    const mots = normaliserTexte(query)
      .split(/[^a-z0-9]+/)
      .filter((m) => m.length > 2 && !MOTS_VIDES.has(m));
    if (mots.length === 0) return [];

    const trouves: Array<CategorySuggestion & { score: number }> = [];

    const parcourir = (noeud: NoeudTaxonomie, chemin: string[]) => {
      const ici = [...chemin, noeud.name ?? ""];
      const enfants = noeud.children ?? [];

      if (enfants.length === 0 && noeud.id != null) {
        const nom = normaliserTexte(noeud.name ?? "");
        const complet = normaliserTexte(ici.join(" "));

        let score = 0;
        for (const m of mots) {
          if (nom.includes(m)) score += 3;
          else if (complet.includes(m)) score += 1;
        }

        if (score > 0) {
          trouves.push({
            score,
            id: String(noeud.id),
            label: noeud.name ?? String(noeud.id),
            path: ici.slice(0, -1),
          });
        }
      }
      for (const e of enfants) parcourir(e, ici);
    };

    for (const r of racines.results ?? []) parcourir(r, []);

    return trouves
      .sort(
        (a, b) =>
          b.score - a.score || (a.path?.length ?? 0) - (b.path?.length ?? 0),
      )
      .slice(0, 12)
      .map(({ score: _score, ...c }) => c);
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
  indiceCompte(_request: Request, rawBody: string): string | null {
    // Etsy met `shop_id` dans le corps, sous la forme numérique que porte
    // notre `externalId`. Le corps n'est pas encore vérifié à cet instant :
    // raison de plus pour n'en tirer qu'un ordre de passage.
    try {
      const corps = JSON.parse(rawBody) as { shop_id?: number | string };
      return corps.shop_id !== undefined ? String(corps.shop_id) : null;
    } catch {
      return null;
    }
  }

  webhookSignaux(): SignalWebhook[] {
    /*
     * Rien ici : la notification est désormais TRADUITE en vente par
     * `verifyAndParseWebhook`, qui lit la commande exacte. Demander en plus
     * une relecture des ventes ferait deux fois le travail — et le relevé de
     * secours, lui, tourne de toute façon.
     *
     * Si la lecture ciblée échoue, elle rend une liste vide : c'est le
     * routeur qui retombe alors sur la relecture, exactement là où il faut.
     */
    return [];
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

    /*
     * ══ À PARTIR D'ICI, LE CORPS EST DIGNE DE CONFIANCE ══
     *
     * Etsy nomme la commande exacte qui a changé. Le chemin d'avant répondait
     * « va relire les ventes », ce qui déclenchait une page complète de
     * commandes — cinquante lectures pour une vente. Lire LA commande coûte un
     * appel.
     */
    let charge: { event_type?: string; resource_url?: string; shop_id?: number };
    try {
      charge = JSON.parse(rawBody);
    } catch {
      return [];
    }

    /*
     * L'identifiant de boutique sert ici de CONTRÔLE, pas de prérequis. Le
     * réclamer ferait échouer la lecture d'un compte qui ne l'a pas encore
     * mémorisé — alors que l'adresse en porte un, et que le jeton employé
     * reste celui du compte : Etsy refuserait de toute façon la commande
     * d'une boutique étrangère.
     */
    const attendu = ctx.credentials?.["shopId"] ?? ctx.account.externalAccountId ?? "";
    const cible = lireResourceUrl(charge.resource_url, attendu);
    if (!cible) return [];

    /*
     * Le genre se lit sur `event_type`. Attention : la documentation écrit
     * « order.paid », la charge réelle porte « ORDER_PAID ». On normalise les
     * deux formes plutôt que de parier sur l'une.
     */
    const genre = GENRE_ETSY[
      (charge.event_type ?? "").toUpperCase().replace(/\./g, "_")
    ];
    if (!genre) return [];

    let recu: RecuEtsy;
    try {
      recu = await this.call<RecuEtsy>(
        ctx,
        `/shops/${cible.shopId}/receipts/${cible.receiptId}`,
      );
    } catch {
      /*
       * La commande n'a pas pu être lue — jeton fatigué, panne passagère. On
       * rend une liste vide plutôt que de lever : lever ferait croire au
       * routeur que ce webhook n'était pas pour ce compte, et il essaierait
       * les autres boutiques. Une liste vide laisse le relevé de secours
       * rattraper la vente au passage suivant.
       */
      return [];
    }

    return [
      {
        marketplace: "etsy",
        accountId: ctx.account.id,
        remoteOrderId: String(recu.receipt_id ?? cible.receiptId),
        /*
         * L'identifiant du webhook sert de clé de déduplication : Etsy
         * réessaie huit fois sur plus de vingt-quatre heures, et rejoue à la
         * demande depuis son portail. Sans cette clé, une vente serait
         * décomptée neuf fois du stock.
         */
        eventId: `hook:${id}`,
        kind: genre,
        occurredAt: recu.created_timestamp
          ? new Date(recu.created_timestamp * 1000).toISOString()
          : new Date().toISOString(),
        lines: (recu.transactions ?? []).map((t) => ({
          sku: t.sku ?? undefined,
          quantity: t.quantity ?? 1,
          remoteListingId: t.listing_id ? String(t.listing_id) : undefined,
        })),
        raw: recu,
      },
    ];
  }
}

/**
 * LES TROIS SEULES PORTES D'ENTRÉE D'ETSY.
 *
 * Etsy n'est pas une place de marché généraliste. Un article n'y est vendable
 * que s'il entre dans l'une de ces trois catégories, et dans aucun autre cas :
 *
 *   FAIT MAIN — fabriqué par le vendeur ou son collectif. Fabriqué par
 *   quelqu'un d'autre, il n'y entre QU'À LA CONDITION que ce quelqu'un soit
 *   déclaré comme partenaire de production de la boutique ;
 *
 *   FOURNITURE CRÉATIVE — matière, composant ou outil destiné à créer. Celle-
 *   là peut être industrielle : c'est sa destination qui compte ;
 *
 *   VINTAGE — vingt ans révolus, pas un de moins.
 *
 * Hors de ces trois cas, Etsy répond « Oh dear, you cannot sell this item on
 * Etsy » — un refus qui ne nomme ni la règle enfreinte, ni le geste qui la
 * lèverait, et qui arrive APRÈS la création du brouillon facturé.
 *
 * On ne refuse ICI que le cas certain et documenté : fabriqué par quelqu'un
 * d'autre, sans partenaire déclaré, ni fourniture, ni vintage. Tout le reste
 * part chez Etsy, à qui appartient la décision. Être plus sévère que la
 * plateforme interdirait des annonces qu'elle aurait acceptées.
 */
function refusEligibiliteEtsy(args: {
  whoMade: string;
  whenMade: string;
  estFourniture: boolean;
  partenaire: string | undefined;
}): string | null {
  if (args.whoMade !== "someone_else") return null;
  if (args.estFourniture) return null;
  if (args.partenaire) return null;
  if (EPOQUES_VINTAGE.has(args.whenMade)) return null;

  return (
    "Etsy n'accepte que trois sortes d'articles : fait main, fourniture créative, ou vintage de vingt ans et plus. " +
    "Celui-ci est déclaré « fabriqué par quelqu'un d'autre », ce qui n'entre dans la première qu'avec un PARTENAIRE DE PRODUCTION déclaré. " +
    "Trois issues, toutes honnêtes : déclarer le fabricant dans votre boutique Etsy → Paramètres → Production, puis le choisir dans les réglages du compte ; " +
    "ou marquer l'article comme fourniture créative si c'en est une ; ou corriger la période s'il a plus de vingt ans. " +
    "Sans cela Etsy refuse, et son message ne dit ni laquelle des trois manque ni comment la fournir."
  );
}

/**
 * Les périodes qu'Etsy tient pour vintage.
 *
 * Le seuil est de vingt ans révolus. Les valeurs listées ici sont celles
 * qu'Etsy propose et qui sont TOUJOURS au-delà du seuil, quelle que soit
 * l'année courante — une liste figée ne se périme donc pas. Les tranches
 * proches de la limite en sont absentes à dessein : les inclure ferait
 * accepter ici ce qu'Etsy refuserait ensuite.
 */
const EPOQUES_VINTAGE = new Set([
  "before_2006",
  "2000_2005",
  "1990s",
  "1980s",
  "1970s",
  "1960s",
  "1950s",
  "1940s",
  "1930s",
  "1920s",
  "1910s",
  "1900s",
  "1800s",
  "1700s",
  "before_1700",
]);

/** Une commande Etsy, réduite à ce qui décrémente le stock. */
interface RecuEtsy {
  receipt_id?: number;
  created_timestamp?: number;
  status?: string;
  transactions?: Array<{
    listing_id?: number | null;
    sku?: string | null;
    quantity?: number;
  }>;
}

/**
 * Les événements Etsy, et le sens qu'ils donnent au stock.
 *
 * Les deux graphies sont acceptées : la documentation écrit « order.paid »,
 * la charge réelle porte « ORDER_PAID ». Parier sur l'une des deux, c'est
 * ignorer la moitié des notifications sans le savoir.
 */
const GENRE_ETSY: Record<string, "paid" | "cancelled"> = {
  ORDER_PAID: "paid",
  ORDER_CANCELED: "cancelled",
  ORDER_CANCELLED: "cancelled",
};

/**
 * LIRE L'ADRESSE FOURNIE — SANS JAMAIS L'APPELER.
 *
 * Etsy joint un `resource_url` qui désigne la commande. La tentation est de
 * l'appeler tel quel. On ne le fait PAS, et la raison vaut d'être écrite :
 *
 * cet appel porterait notre jeton d'accès ET notre clé applicative. Si le
 * secret de signature fuitait un jour, une notification forgée nous ferait
 * livrer ces deux secrets à l'adresse de l'attaquant. La signature protège
 * contre une falsification à froid, pas contre une clé compromise.
 *
 * On extrait donc les DEUX ENTIERS et on reconstruit l'appel depuis notre
 * propre constante. La charge utile ne fournit plus alors que des nombres :
 * il n'y a plus rien à détourner.
 *
 * La boutique est vérifiée en prime — une commande d'une autre boutique lue
 * avec le jeton de celle-ci serait au mieux un refus, au pire un mélange.
 */
export function lireResourceUrl(
  resourceUrl: string | undefined,
  shopIdCompte: string,
): { shopId: string; receiptId: string } | null {
  if (!resourceUrl) return null;
  const m = /\/shops\/(\d+)\/receipts\/(\d+)(?:[/?#]|$)/.exec(resourceUrl);
  if (!m) return null;
  const [, shopId, receiptId] = m;
  if (!shopId || !receiptId) return null;
  // La commande doit appartenir à la boutique dont le secret a validé.
  if (shopIdCompte && shopId !== shopIdCompte) return null;
  return { shopId, receiptId };
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
