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
 * Erreur HTTP d'eBay, avec son CODE conservé.
 *
 * Sans elle, le code de statut se perdait : `call` fabriquait un message à
 * partir du tableau `errors` d'eBay, et la sonde d'existence cherchait
 * ensuite « 404 » dans ce TEXTE. Or un article inconnu répond
 * « The specified SKU was not found », sans le moindre chiffre — la sonde
 * concluait « je ne sais pas » et la création était refusée alors que le SKU
 * était libre. Le garde-fou anti-écrasement bloquait donc les créations
 * légitimes, et ne se déclenchait correctement que dans les tests, où le
 * corps d'erreur est vide.
 */
class EbayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EbayHttpError";
  }
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

/* ------------------------------------------------------------------ */
/* Un produit, plusieurs déclinaisons, UNE annonce                     */
/* ------------------------------------------------------------------ */

/**
 * LE BUDGET DE SOUS-REQUÊTES EST LA VRAIE LIMITE, pas eBay.
 *
 * Une invocation dispose de 40 sous-requêtes et chaque appel en consomme 2 :
 * vingt allers-retours, pas un de plus. Or une variante en coûte trois — la
 * sonde d'existence, l'article d'inventaire, l'offre — auxquels s'ajoutent la
 * sonde du groupe, son écriture, et une marge pour un renouvellement de jeton.
 *
 * D'où un plafond calculé, et non deviné. Il tombe à cinq variantes : très en
 * dessous des vingt-cinq qu'eBay accepte dans un groupe. Le lever demande les
 * points d'entrée groupés (`bulk_create_or_replace_inventory_item`,
 * `bulk_create_offer`, 25 objets par appel), qui ramèneraient les dix-sept
 * coloris à trois allers-retours — c'est la suite à écrire, pas un détail
 * d'optimisation.
 */
const SOUS_REQUETES_PAR_INVOCATION = 40;
const SOUS_REQUETES_PAR_APPEL = 2;
/** Sonde d'existence + article d'inventaire + offre. */
const APPELS_PAR_VARIANTE = 3;
/** Sonde du groupe + écriture du groupe + marge de renouvellement de jeton. */
const APPELS_RESERVES = 3;
export const EBAY_MAX_VARIANTES = Math.floor(
  (SOUS_REQUETES_PAR_INVOCATION / SOUS_REQUETES_PAR_APPEL - APPELS_RESERVES) /
    APPELS_PAR_VARIANTE,
);

/** Limites d'eBay, relevées sur la Sell Inventory API. */
const SKU_MAX = 50;
const CLE_GROUPE_MAX = 50;
const ASPECT_NOM_MAX = 40;
const ASPECT_VALEUR_MAX = 65;
const TITRE_MAX = 80;

/** Une unité vendable, réduite à ce que la création d'annonce exige. */
interface UniteEbay {
  sku: string;
  /** Vrai quand le SKU a été FABRIQUÉ faute d'en trouver un sur la variante. */
  skuFabrique: boolean;
  prix: Money;
  quantite: number;
  imageUrl?: string | undefined;
  /** Un couple nom → valeur par axe. Repris verbatim dans le groupe. */
  aspects: Record<string, string>;
  /** « Violet / M » — pour parler de cette variante à un humain. */
  etiquette: string;
}

/** Minuscules pliées, ponctuation retirée : de quoi fabriquer un code stable. */
function pliure(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
}

/**
 * Empreinte courte et DÉTERMINISTE (FNV-1a 32 bits).
 *
 * Elle ne sert qu'à désambiguïser un code tronqué. Une valeur aléatoire ferait
 * changer le SKU d'un passage à l'autre — donc recréer la variante à chaque
 * diffusion, ce qui est exactement le défaut qu'on cherche à éviter.
 */
function empreinte(texte: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).toUpperCase().padStart(7, "0").slice(-7);
}

/**
 * Le SKU d'une variante qui n'en a pas.
 *
 * Vingt-six variantes sur vingt-huit n'en portent pas chez Shopify, et eBay en
 * EXIGE un par article d'inventaire. On le dérive donc du couple stable
 * (SKU parent, clé d'options) : « SUPPORT-TEL-COULEUR-VIOLET ». Deux appels
 * successifs produisent le même code, ce qui rend la variante retrouvable.
 */
function skuDerive(skuParent: string, optionKey: string): string {
  const base = pliure(`${skuParent}-${optionKey}`);
  if (base.length <= SKU_MAX) return base || empreinte(optionKey);
  return `${base.slice(0, SKU_MAX - 8)}-${empreinte(optionKey)}`;
}

/** La clé du groupe vit dans l'URI : lettres, chiffres, tiret ou souligné. */
function cleGroupe(skuParent: string): string {
  if (/^[A-Za-z0-9_-]{1,50}$/.test(skuParent)) return skuParent;
  const base = pliure(skuParent);
  return base.length <= CLE_GROUPE_MAX
    ? base || empreinte(skuParent)
    : `${base.slice(0, CLE_GROUPE_MAX - 8)}-${empreinte(skuParent)}`;
}

/*
 * LA RÈGLE D'OR D'eBAY : le nom d'un aspect qui varie doit apparaître
 * VERBATIM — même casse, mêmes accents — dans `variesBy.specifications` du
 * groupe ET dans les `aspects` de chaque article, et la valeur de l'article
 * doit figurer telle quelle parmi les valeurs déclarées. Un « Couleur » d'un
 * côté, « couleur » de l'autre, et eBay refuse le groupe sans dire lequel des
 * deux il attendait.
 *
 * D'où ces deux fonctions : elles coupent aux longueurs maximales d'eBay, et
 * elles sont les SEULES à le faire. Le groupe et les articles lisent la même
 * chaîne déjà coupée, donc aucune troncature ne peut les désaccorder.
 */
function nomAspect(brut: string): string {
  return brut.trim().slice(0, ASPECT_NOM_MAX);
}

function valeurAspect(brut: string): string {
  return brut.trim().slice(0, ASPECT_VALEUR_MAX);
}

/**
 * Les noms des axes, dans l'ordre des `optionValues`.
 *
 * `product.options` est la source à préférer — c'est le vocabulaire du
 * vendeur. Mais il n'est pas toujours chargé, alors que `optionKey` porte les
 * mêmes noms sous forme normalisée (« couleur=violet|taille=m »). Un repli
 * moins joli vaut mieux qu'un refus : ce qu'eBay exige, c'est la constance,
 * pas l'élégance.
 *
 * `null` = les axes ne sont pas cohérents, il ne faut rien écrire.
 */
function nomsAxes(
  options: OptionAxis[] | undefined,
  variantes: Variant[],
): string[] | null {
  const nb = variantes[0]?.optionValues.length ?? 0;
  if (nb === 0) return null;
  if (variantes.some((v) => v.optionValues.length !== nb)) return null;

  const declares = (options ?? [])
    .map((o) => nomAspect(o.name))
    .filter((n) => n.length > 0);

  const noms =
    declares.length === nb
      ? declares
      : (variantes[0]?.optionKey ?? "")
          .split("|")
          .slice(0, nb)
          .map((c, i) => nomAspect(c.split("=")[0] ?? "") || `Option ${i + 1}`);

  if (noms.length !== nb) return null;
  // Deux axes de même nom rendraient la combinaison ambiguë côté eBay.
  if (new Set(noms).size !== noms.length) return null;
  return noms;
}

/**
 * Le stock d'une variante, quand on le connaît.
 *
 * `Variant` n'en porte pas : le stock central est compté par variante, mais il
 * vit dans `InventoryItem` et l'appelant ne le joint pas encore. Plutôt que de
 * recopier `product.stock` sur chaque coloris — ce qui multiplierait le stock
 * par le nombre de déclinaisons et ferait vendre ce qui n'existe pas — on pose
 * zéro et on le DIT. Un brouillon à zéro ne peut pas être mis en vente : la
 * décision revient à un humain, ce qui est exactement le but.
 */
function quantiteVariante(v: Variant): number | null {
  const brut = v.marketplaceData?.["stock"];
  const n =
    typeof brut === "number"
      ? brut
      : typeof brut === "string" && brut.trim() !== ""
        ? Number(brut)
        : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Les aspects COMMUNS à toutes les déclinaisons — marque, matière…
 *
 * Ils vivent sur le groupe, jamais sur un article : posés sur un article, ils
 * ne s'appliqueraient qu'à un coloris. Rien n'est inventé ici : on relaie ce
 * que le produit porte sous `marketplaceData.ebayAspects`, et seulement s'il
 * a la forme attendue.
 */
function aspectsCommuns(
  product: Product,
): Record<string, string[]> | undefined {
  const brut = product.marketplaceData?.["ebayAspects"];
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return undefined;

  const sortie: Record<string, string[]> = {};
  for (const [nom, valeur] of Object.entries(brut as Record<string, unknown>)) {
    const cle = nomAspect(nom);
    const valeurs = (Array.isArray(valeur) ? valeur : [valeur])
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map((v) => valeurAspect(String(v)))
      .filter((v) => v.length > 0);
    if (cle.length > 0 && valeurs.length > 0) sortie[cle] = valeurs;
  }
  return Object.keys(sortie).length > 0 ? sortie : undefined;
}

type Preparation =
  | {
      ok: true;
      unites: UniteEbay[];
      specifications: Array<{ name: string; values: string[] }>;
      /** L'axe dont l'image change, quand toutes les variantes en ont une. */
      axeImage?: string | undefined;
      quantitesInconnues: boolean;
      skusFabriques: number;
    }
  | { ok: false; message: string };

/**
 * Traduit les variantes en unités eBay, ou explique pourquoi c'est impossible.
 *
 * Tout est vérifié AVANT le premier appel réseau. Un groupe à moitié écrit ne
 * se rattrape pas : `variantSKUs` est un remplacement complet, et l'appelant
 * refuse de recréer une annonce déjà rattachée.
 */
function preparerUnites(product: Product, variantes: Variant[]): Preparation {
  const noms = nomsAxes(product.options, variantes);
  if (!noms) {
    return {
      ok: false,
      message:
        "Les déclinaisons de ce produit ne forment pas des axes cohérents : chaque variante doit porter une valeur par axe, et deux axes ne peuvent pas avoir le même nom. eBay refuse un groupe dont les aspects ne correspondent pas exactement.",
    };
  }

  const unites: UniteEbay[] = [];
  const parCombinaison = new Map<string, string>();
  const parSku = new Map<string, string>();
  const valeursParAxe = noms.map(() => new Set<string>());
  let quantitesInconnues = false;
  let skusFabriques = 0;

  for (const v of variantes) {
    const valeurs = v.optionValues.map(valeurAspect);
    if (valeurs.some((x) => x.length === 0)) {
      return {
        ok: false,
        message: `La variante « ${v.optionKey || v.id} » a une valeur d'option vide. eBay exige une valeur pour chaque aspect qui varie.`,
      };
    }

    const etiquette = valeurs.join(" / ");
    const combinaison = JSON.stringify(valeurs);
    const deja = parCombinaison.get(combinaison);
    if (deja) {
      return {
        ok: false,
        message: `Deux variantes portent la même combinaison « ${etiquette} » (${deja} et ${v.id}). eBay exige qu'elle soit unique dans un groupe.`,
      };
    }
    parCombinaison.set(combinaison, v.id);

    const skuPropre = v.sku?.trim() ?? "";
    const sku = skuPropre.length > 0 ? skuPropre.slice(0, SKU_MAX) : skuDerive(product.sku, v.optionKey);
    if (skuPropre.length === 0) skusFabriques += 1;

    const dejaSku = parSku.get(sku);
    if (dejaSku) {
      return {
        ok: false,
        message: `Deux variantes aboutissent au même SKU « ${sku} » (${dejaSku} et ${etiquette}). Donnez un SKU distinct à chacune : eBay compte un article d'inventaire par SKU.`,
      };
    }
    parSku.set(sku, etiquette);

    const aspects: Record<string, string> = {};
    noms.forEach((nom, i) => {
      const valeur = valeurs[i] ?? "";
      aspects[nom] = valeur;
      valeursParAxe[i]?.add(valeur);
    });

    const quantite = quantiteVariante(v);
    if (quantite === null) quantitesInconnues = true;

    unites.push({
      sku,
      skuFabrique: skuPropre.length === 0,
      prix: v.price,
      quantite: quantite ?? 0,
      ...(v.imageUrl ? { imageUrl: v.imageUrl } : {}),
      aspects,
      etiquette,
    });
  }

  /*
   * `aspectsImageVariesBy` n'est déclaré que si TOUTES les variantes ont une
   * photo propre. Déclaré à moitié, eBay réclame une image pour chaque valeur
   * de l'aspect et refuse le groupe — mieux vaut une galerie commune qu'un
   * refus.
   */
  const axeImage =
    unites.length > 0 && unites.every((u) => u.imageUrl) ? noms[0] : undefined;

  return {
    ok: true,
    unites,
    specifications: noms.map((name, i) => ({
      name,
      values: Array.from(valeursParAxe[i] ?? []),
    })),
    ...(axeImage ? { axeImage } : {}),
    quantitesInconnues,
    skusFabriques,
  };
}

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
      throw new EbayHttpError(
        res.status,
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

  /**
   * Crée UNE annonce, avec toutes ses déclinaisons.
   *
   * Ce chemin créait autrefois un article par produit. Sur un support de
   * téléphone à dix-sept coloris, l'appelant diffusait donc dix-sept fois —
   * dix-sept annonces quasi identiques, dix-sept lignes du plafond vendeur
   * eBay consommées, et un acheteur qui voit la même chose dix-sept fois au
   * lieu d'un menu déroulant. eBay a un objet pour ça : l'`inventory_item_group`.
   *
   * La séquence, dans cet ordre et pas un autre :
   *   1. un `PUT inventory_item/{sku}` par variante — ce qu'on possède
   *   2. un `PUT inventory_item_group/{cle}` — ce qui les relie
   *   3. un `POST offer` par SKU — à quel prix, sous quelles politiques
   *
   * Et surtout PAS de `publish_by_inventory_item_group` : publier engage un
   * contrat de vente sur une annonce que personne n'a relue.
   */
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
      return this.manuel(
        ctx,
        "eBay exige une catégorie. Renseignez-la sur le produit ou définissez une catégorie par défaut sur le compte.",
      );
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
      return this.manuel(
        ctx,
        "eBay exige l'état de l'article (neuf, très bon état, pour pièces…). Renseignez-le sur le produit : eBay déclasse une annonce dont l'état ne correspond pas à sa catégorie.",
      );
    }

    if ((product.images?.length ?? 0) === 0) {
      return this.manuel(
        ctx,
        "eBay exige au moins une photo en HTTPS. Sans elle, l'annonce se crée mais ne peut jamais être mise en vente.",
      );
    }

    /*
     * Les variantes archivées sont écartées : la plateforme ne les renvoie
     * plus, les republier ressusciterait un coloris retiré.
     */
    const variantes = (product.variants ?? [])
      .filter((v) => v.status === "active")
      .slice()
      .sort((a, b) => a.position - b.position);

    const commun = { categoryId, marketplaceId, conditionEbay };

    /*
     * Zéro ou une variante : rien à grouper. Un groupe d'un seul élément n'a
     * pas de déclinaison à proposer, et eBay refuse un `variesBy` sans axe qui
     * varie. On garde donc le chemin mono-SKU d'origine, à un détail près : si
     * cette variante unique porte son propre SKU et son propre prix, ce sont
     * les siens qui font foi, pas ceux du parent.
     */
    if (variantes.length < 2) {
      return this.creerMonoSku(ctx, product, variantes[0], commun);
    }

    return this.creerGroupeVariantes(ctx, product, variantes, commun);
  }

  /** Le raccourci d'un produit sans déclinaison : un article, une offre. */
  private async creerMonoSku(
    ctx: MarketplaceContext,
    product: Product,
    solo: Variant | undefined,
    commun: { categoryId: string; marketplaceId: string; conditionEbay: string },
  ): Promise<TargetResult> {
    const sku = solo?.sku?.trim() || product.sku;
    const prix = solo?.price ?? product.price;
    const stock = solo ? (quantiteVariante(solo) ?? product.stock) : product.stock;

    /*
     * VÉRIFIER AVANT D'ÉCRIRE — le défaut le plus grave de ce chemin.
     *
     * L'appel suivant est un PUT sur `inventory_item/{sku}` : un remplacement
     * COMPLET, pas une création. Si le SKU existe déjà chez eBay — annonce
     * publiée à la main, ou SKU saisi deux fois — ce PUT écrasait le titre
     * (tronqué à 80 caractères), la description, les photos, l'état, et
     * forçait la quantité. Une annonce épuisée se remettait à prendre des
     * commandes. Le `POST /offer` échouait ensuite, la commande était
     * rapportée « échec », rien n'était écrit localement — et le geste
     * naturel, réessayer, rejouait l'écrasement.
     *
     * Le garde-fou d'idempotence de l'orchestrateur ne pouvait rien : il lit
     * la base LOCALE, qui ignore tout d'une annonce créée hors de l'outil.
     *
     * En cas de doute — réponse illisible, panne réseau — on refuse. L'état
     * inconnu ne justifie pas d'écrire par-dessus.
     */
    const existe = await this.skuExiste(ctx, sku);
    if (existe === true) {
      return this.manuel(
        ctx,
        `Le SKU « ${sku} » existe déjà chez eBay. Créer l'annonce écraserait ce qui est en ligne : rattachez-la par un import, ou changez de SKU.`,
      );
    }
    if (existe === null) {
      return this.echec(
        ctx,
        "Impossible de vérifier si ce SKU existe déjà chez eBay. Rien n'a été écrit — réessayez plus tard.",
      );
    }

    // 1. L'article d'inventaire : ce qu'on possède.
    await this.call(
      ctx,
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          availability: {
            shipToLocationAvailability: { quantity: stock },
          },
          condition: commun.conditionEbay,
          product: {
            title: product.title.slice(0, TITRE_MAX), // eBay tronque à 80 caractères
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
        body: JSON.stringify(this.corpsOffre(ctx, { sku, prix, stock }, commun)),
      },
    );

    // 3. La publication est laissée à l'utilisateur. Mettre en vente
    // automatiquement une annonce que personne n'a relue engage un contrat
    // de vente réel — on s'arrête volontairement au brouillon.
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "success",
      remoteId: sku,
      // L'identifiant d'offre REMONTE, au lieu de finir dans un texte que
      // personne ne relit. Sans lui, l'annonce créée n'accepterait plus
      // jamais ni changement de prix, ni activation, ni retrait.
      marketplaceData: { offerId: offer.offerId, categoryId: commun.categoryId },
      message: `Offre ${offer.offerId} créée en brouillon — à publier après relecture`,
    };
  }

  /** Une annonce, plusieurs déclinaisons : articles, groupe, puis offres. */
  private async creerGroupeVariantes(
    ctx: MarketplaceContext,
    product: Product,
    variantes: Variant[],
    commun: { categoryId: string; marketplaceId: string; conditionEbay: string },
  ): Promise<TargetResult> {
    const prep = preparerUnites(product, variantes);
    if (!prep.ok) return this.manuel(ctx, prep.message);

    /*
     * TRONQUER SERAIT PIRE QUE REFUSER.
     *
     * Passé le plafond, on pourrait ne créer que les premières variantes. Mais
     * `variantSKUs` est un remplacement complet, et l'orchestrateur considère
     * qu'un produit déjà rattaché à ce compte n'a plus rien à créer : un
     * nouvel essai ne compléterait donc RIEN. On se retrouverait avec une
     * annonce à cinq coloris sur dix-sept, définitivement, sans que personne
     * l'ait décidé. Refuser avant la première écriture laisse le choix à un
     * humain — et ne consomme aucun quota.
     */
    if (prep.unites.length > EBAY_MAX_VARIANTES) {
      return this.manuel(
        ctx,
        `Ce produit a ${prep.unites.length} déclinaisons actives ; une diffusion ne peut en créer que ${EBAY_MAX_VARIANTES} (40 sous-requêtes par invocation, 2 par appel, 3 appels par variante). Rien n'a été écrit : une annonce partielle ne se complète pas au second essai. Réduisez le nombre de variantes actives, ou attendez le passage aux appels groupés.`,
      );
    }

    /*
     * SONDER TOUTES LES VARIANTES, pas seulement le parent.
     *
     * Chaque `PUT inventory_item/{sku}` est un remplacement complet. Le
     * garde-fou ne valait donc rien tant qu'il ne couvrait qu'un SKU : les
     * seize autres pouvaient écraser seize articles existants.
     */
    for (const u of prep.unites) {
      const existe = await this.skuExiste(ctx, u.sku);
      if (existe === true) {
        return this.manuel(
          ctx,
          `Le SKU « ${u.sku} » (${u.etiquette}) existe déjà chez eBay. Le créer écraserait ce qui est en ligne : rattachez l'annonce par un import, ou changez de SKU.`,
        );
      }
      if (existe === null) {
        return this.echec(
          ctx,
          `Impossible de vérifier si le SKU « ${u.sku} » existe déjà chez eBay. Rien n'a été écrit — réessayez plus tard.`,
        );
      }
    }

    // Le groupe aussi s'écrit par un PUT : même règle, même sonde.
    const cle = cleGroupe(product.sku);
    const groupe = await this.existe(
      ctx,
      `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(cle)}`,
    );
    if (groupe === true) {
      return this.manuel(
        ctx,
        `Un groupe de variantes « ${cle} » existe déjà chez eBay. L'écrire remplacerait sa liste de déclinaisons : rattachez l'annonce par un import, ou changez le SKU parent.`,
      );
    }
    if (groupe === null) {
      return this.echec(
        ctx,
        `Impossible de vérifier si le groupe « ${cle} » existe déjà chez eBay. Rien n'a été écrit — réessayez plus tard.`,
      );
    }

    // 1. Un article par variante, puis 2. le groupe qui les relie.
    const communs = aspectsCommuns(product);
    const ecrits: string[] = [];
    try {
      for (const u of prep.unites) {
        await this.call(
          ctx,
          `/sell/inventory/v1/inventory_item/${encodeURIComponent(u.sku)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              availability: {
                shipToLocationAvailability: { quantity: u.quantite },
              },
              condition: commun.conditionEbay,
              product: {
                /*
                 * NI titre NI sous-titre sur un article de groupe : ils
                 * écraseraient ceux du groupe, et l'annonce s'afficherait sous
                 * le nom d'une seule déclinaison. Le titre, la description et
                 * la galerie appartiennent au groupe.
                 */
                aspects: Object.fromEntries(
                  Object.entries(u.aspects).map(([nom, valeur]) => [
                    nom,
                    [valeur],
                  ]),
                ),
                ...(u.imageUrl ? { imageUrls: [u.imageUrl] } : {}),
              },
            }),
          },
        );
        ecrits.push(u.sku);
      }

      await this.call(
        ctx,
        `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(cle)}`,
        {
          method: "PUT",
          // La clé vit dans l'URI, PAS dans le corps : l'y mettre est ignoré
          // en silence et le groupe se crée sous une autre clé.
          body: JSON.stringify({
            title: product.title.slice(0, TITRE_MAX),
            description: product.description ?? product.title,
            imageUrls: product.images ?? [],
            // Remplacement COMPLET : la liste envoyée devient la liste du
            // groupe. Un SKU omis est un SKU détaché.
            variantSKUs: prep.unites.map((u) => u.sku),
            ...(communs ? { aspects: communs } : {}),
            variesBy: {
              ...(prep.axeImage
                ? { aspectsImageVariesBy: [prep.axeImage] }
                : {}),
              specifications: prep.specifications,
            },
          }),
        },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.echec(
        ctx,
        ecrits.length === 0
          ? `eBay a refusé la création : ${detail}`
          : `eBay a refusé la création après ${ecrits.length} article(s) : ${detail}. Les SKU ${ecrits.join(", ")} existent maintenant chez eBay SANS offre ni groupe — un nouvel essai les signalera comme existants ; supprimez-les d'abord depuis eBay.`,
      );
    }

    // 3. Une offre par SKU. Elles partagent tout sauf le SKU, la quantité et
    // le prix — c'est ce qu'eBay exige des offres d'un même groupe.
    const offers: Record<string, string> = {};
    const echecs: string[] = [];
    for (const u of prep.unites) {
      try {
        const offre = await this.call<{ offerId?: string }>(
          ctx,
          "/sell/inventory/v1/offer",
          {
            method: "POST",
            body: JSON.stringify(
              this.corpsOffre(
                ctx,
                { sku: u.sku, prix: u.prix, stock: u.quantite },
                commun,
              ),
            ),
          },
        );
        if (offre?.offerId) offers[u.sku] = offre.offerId;
        else echecs.push(`${u.sku} (aucun identifiant d'offre rendu)`);
      } catch (err) {
        echecs.push(
          `${u.sku} (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    const notes = [
      prep.skusFabriques > 0
        ? `${prep.skusFabriques} SKU dérivé(s) du SKU parent faute d'en porter un`
        : "",
      prep.quantitesInconnues
        ? "stock par variante inconnu : quantités posées à 0, à corriger avant mise en vente"
        : "",
    ].filter(Boolean);

    const resume = `Groupe ${cle} créé en brouillon — ${prep.unites.length} déclinaisons, à publier après relecture${notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}`;

    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      // Le groupe et les articles existent : l'oublier localement rendrait
      // l'annonce impilotable. `pending_remote` dit exactement cela — c'est
      // chez eBay, ce n'est pas terminé.
      status: echecs.length === 0 ? "success" : "pending_remote",
      // L'identité stable du parent, celle qui sert aux mises à jour.
      remoteId: cle,
      marketplaceData: {
        inventoryItemGroupKey: cle,
        offers,
        categoryId: commun.categoryId,
      },
      message:
        echecs.length === 0
          ? resume
          : `${resume} · offre manquante pour ${echecs.length} déclinaison(s) : ${echecs.join(" ; ")}`,
    };
  }

  /** Le corps d'une offre. Identique pour tout un groupe, hors SKU/prix/stock. */
  private corpsOffre(
    ctx: MarketplaceContext,
    unite: { sku: string; prix: Money; stock: number },
    commun: { categoryId: string; marketplaceId: string },
  ): Record<string, unknown> {
    const c = ctx.credentials ?? {};
    return {
      sku: unite.sku,
      marketplaceId: commun.marketplaceId,
      format: "FIXED_PRICE",
      availableQuantity: unite.stock,
      categoryId: commun.categoryId,
      merchantLocationKey: c["merchantLocationKey"],
      pricingSummary: {
        price: {
          value: (unite.prix.amount / 100).toFixed(2),
          currency: unite.prix.currency,
        },
      },
      listingPolicies: {
        fulfillmentPolicyId: c["fulfillmentPolicyId"],
        paymentPolicyId: c["paymentPolicyId"],
        returnPolicyId: c["returnPolicyId"],
      },
    };
  }

  private manuel(ctx: MarketplaceContext, message: string): TargetResult {
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "manual_required",
      message,
    };
  }

  private echec(ctx: MarketplaceContext, message: string): TargetResult {
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "failed",
      message,
    };
  }

  /**
   * Un JETON APPLICATIF, distinct de celui du vendeur.
   *
   * L'API de taxonomie n'est pas une API vendeur : elle ne lit rien du compte,
   * elle interroge le référentiel public des catégories. eBay l'a donc placée
   * derrière une portée applicative — `api_scope` — qu'un jeton obtenu par
   * rafraîchissement ne porte PAS. Réutiliser le jeton du vendeur donne un
   * refus qui ressemble à une session expirée, et envoie chercher au mauvais
   * endroit.
   *
   * Il s'obtient par `client_credentials`, sans consentement, et vit deux
   * heures. Mémorisé comme les autres pour ne pas le redemander à chaque
   * frappe.
   */
  private async jetonApplicatif(ctx: MarketplaceContext): Promise<string> {
    const c = ctx.credentials ?? {};
    const now = Math.floor(Date.now() / 1000);
    const cache = c["appToken"];
    if (cache && Number(c["appTokenExpiresAt"] ?? 0) > now + 120) return cache;

    const clientId = c["clientId"] ?? "";
    const clientSecret = c["clientSecret"] ?? "";
    if (!clientId || !clientSecret) {
      throw new Error("eBay : identifiants applicatifs manquants");
    }

    const res = await fetch(`${hosts(c["environment"]).api}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic(clientId, clientSecret)}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://api.ebay.com/oauth/api_scope",
      }),
    });
    if (!res.ok) {
      throw new Error(`eBay a refusé le jeton applicatif (${res.status})`);
    }
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("eBay : jeton applicatif absent");

    await ctx.saveCredentials?.({
      appToken: j.access_token,
      appTokenExpiresAt: String(now + (j.expires_in ?? 7200)),
    });
    return j.access_token;
  }

  /**
   * Cherche une catégorie eBay depuis du texte libre.
   *
   * eBay renvoie ses suggestions triées par pertinence, et toutes sont des
   * catégories FEUILLES — c'est ce qu'exige la publication, une catégorie
   * intermédiaire est refusée. Les ancêtres servent à lever le doute entre
   * deux libellés identiques dans des rayons différents.
   *
   * Deux limites documentées : la réponse est un 204 SANS CORPS quand rien ne
   * correspond, et l'appel ne fonctionne PAS en bac à sable — il y répond 200
   * avec des libellés au hasard, ce qui est pire qu'une erreur.
   */
  async searchCategories(
    ctx: MarketplaceContext,
    query: string,
  ): Promise<CategorySuggestion[]> {
    const c = ctx.credentials ?? {};
    if (c["environment"] === "sandbox") {
      throw new Error(
        "La recherche de catégorie ne fonctionne pas dans le bac à sable eBay : il répond au hasard. Saisissez l'identifiant à la main, ou utilisez le compte de production.",
      );
    }

    const jeton = await this.jetonApplicatif(ctx);
    const api = hosts(c["environment"]).api;
    const marketplaceId = c["marketplaceId"] ?? "EBAY_FR";
    const http = ctx.http ?? fetch;

    const appel = async <T>(chemin: string): Promise<T | null> => {
      const res = await http(`${api}${chemin}`, {
        headers: {
          Authorization: `Bearer ${jeton}`,
          "Accept-Language": "fr-FR",
        },
      });
      // 204 : rien ne correspond. Ce n'est pas une erreur.
      if (res.status === 204) return null;
      return (await res.json()) as T;
    };

    // L'arbre de la place de marché. Mémorisé : il ne change que rarement, et
    // le redemander à chaque recherche coûterait un appel pour rien.
    let tree = c["categoryTreeId"];
    if (!tree) {
      const d = await appel<{ categoryTreeId?: string }>(
        `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${marketplaceId}`,
      );
      tree = d?.categoryTreeId;
      if (!tree) throw new Error("eBay : arbre de catégories introuvable");
      await ctx.saveCredentials?.({ categoryTreeId: tree });
    }

    const d = await appel<{
      categorySuggestions?: Array<{
        category?: { categoryId?: string; categoryName?: string };
        categoryTreeNodeAncestors?: Array<{ categoryName?: string }>;
      }>;
    }>(
      `/commerce/taxonomy/v1/category_tree/${tree}/get_category_suggestions?q=${encodeURIComponent(query)}`,
    );

    return (d?.categorySuggestions ?? [])
      .filter((x) => x.category?.categoryId)
      .slice(0, 12)
      .map((x) => ({
        id: String(x.category!.categoryId),
        label: x.category!.categoryName ?? String(x.category!.categoryId),
        // Les ancêtres arrivent du plus proche au plus lointain : on retourne
        // pour lire « Maison > Rangement > Câbles », comme chez eBay.
        path: (x.categoryTreeNodeAncestors ?? [])
          .map((a) => a.categoryName ?? "")
          .filter(Boolean)
          .reverse(),
      }));
  }

  /**
   * Accès brut à l'API eBay, pour ce qui sort du contrat commun.
   *
   * Exposé plutôt que dupliqué : l'obtention du jeton, son renouvellement, le
   * choix de l'hôte selon l'environnement et la lecture des erreurs d'eBay
   * vivent à un seul endroit.
   */
  async rawCall<T>(
    ctx: MarketplaceContext,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    return this.call<T>(ctx, path, init);
  }

  /**
   * Les réglages de compte sans lesquels eBay refuse de publier.
   *
   * Quatre lectures, chacune ISOLÉE : une politique de retour absente ne doit
   * pas cacher que les trois autres sont là. Une liste vide n'est pas une
   * erreur — c'est le cas normal tant que les règles de gestion ne sont pas
   * activées, et le message le dit.
   *
   * Aucune écriture : ces objets engagent les conditions de vente du vendeur,
   * l'outil les lit et n'en crée jamais.
   */
  async listSettings(ctx: MarketplaceContext): Promise<RemoteSetting[]> {
    const marketplaceId = ctx.credentials?.["marketplaceId"] ?? "EBAY_FR";
    const q = `?marketplace_id=${marketplaceId}`;

    const lire = async <T>(
      chemin: string,
      extraire: (
        d: T,
      ) => Array<{ id: string; label: string; detail?: string | undefined }>,
    ) => {
      try {
        return extraire(await this.call<T>(ctx, chemin));
      } catch {
        // Un refus se lit comme « rien à proposer » : le message d'aide
        // couvre les deux cas, et un écran à moitié rempli vaut mieux qu'une
        // page d'erreur.
        return [];
      }
    };

    type Pol = { name?: string; description?: string };
    type Liste<K extends string> = Record<K, Array<Pol & Record<string, string>>>;

    const [livraison, paiement, retour, lieux] = await Promise.all([
      lire<Liste<"fulfillmentPolicies">>(
        `/sell/account/v1/fulfillment_policy${q}`,
        (d) =>
          (d.fulfillmentPolicies ?? []).map((p) => ({
            id: String(p["fulfillmentPolicyId"]),
            label: p.name ?? String(p["fulfillmentPolicyId"]),
            detail: p.description,
          })),
      ),
      lire<Liste<"paymentPolicies">>(`/sell/account/v1/payment_policy${q}`, (d) =>
        (d.paymentPolicies ?? []).map((p) => ({
          id: String(p["paymentPolicyId"]),
          label: p.name ?? String(p["paymentPolicyId"]),
          detail: p.description,
        })),
      ),
      lire<Liste<"returnPolicies">>(`/sell/account/v1/return_policy${q}`, (d) =>
        (d.returnPolicies ?? []).map((p) => ({
          id: String(p["returnPolicyId"]),
          label: p.name ?? String(p["returnPolicyId"]),
          detail: p.description,
        })),
      ),
      lire<{
        locations?: Array<{
          merchantLocationKey?: string;
          name?: string;
          location?: { address?: { city?: string; country?: string } };
        }>;
      }>("/sell/inventory/v1/location", (d) =>
        (d.locations ?? []).map((l) => ({
          id: String(l.merchantLocationKey),
          label: l.name ?? String(l.merchantLocationKey),
          detail: [l.location?.address?.city, l.location?.address?.country]
            .filter(Boolean)
            .join(", "),
        })),
      ),
    ]);

    const AIDE =
      "À créer dans Seller Hub → Paramètres du compte → Règles de gestion. Si la page propose une activation, eBay met jusqu'à 24 h à la traiter.";

    return [
      {
        key: "merchantLocationKey",
        label: "Adresse d'expédition",
        aide: "À créer dans Seller Hub → Préférences d'expédition.",
        options: lieux,
      },
      { key: "fulfillmentPolicyId", label: "Politique de livraison", aide: AIDE, options: livraison },
      { key: "paymentPolicyId", label: "Politique de paiement", aide: AIDE, options: paiement },
      { key: "returnPolicyId", label: "Politique de retour", aide: AIDE, options: retour },
    ];
  }

  /**
   * Ce SKU existe-t-il déjà chez eBay ?
   *
   * `true` il existe · `false` il n'existe pas · `null` on n'a pas pu savoir.
   * La distinction compte : seul `false` autorise un remplacement complet.
   */
  private async skuExiste(
    ctx: MarketplaceContext,
    sku: string,
  ): Promise<boolean | null> {
    return this.existe(
      ctx,
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    );
  }

  /**
   * Cet objet existe-t-il déjà ? Même règle pour un article et pour un groupe :
   * les deux s'écrivent par un PUT qui remplace tout.
   */
  private async existe(
    ctx: MarketplaceContext,
    chemin: string,
  ): Promise<boolean | null> {
    try {
      await this.call(ctx, chemin);
      return true;
    } catch (err) {
      // Le transport lève sur tout code anormal. Seul un 404 signifie
      // franchement « cet objet n'existe pas » ; le reste est une
      // incertitude, et une incertitude ne doit pas autoriser une écriture.
      if (err instanceof EbayHttpError) return err.status === 404 ? false : null;
      const m = err instanceof Error ? err.message : String(err);
      return /\b404\b/.test(m) ? false : null;
    }
  }

  async updateStock(
    ctx: MarketplaceContext,
    listing: Listing,
    stock: number,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    /*
     * UNE ANNONCE GROUPÉE NE SE MET PAS À JOUR PAR SON GROUPE.
     *
     * Quand l'annonce a été créée avec des déclinaisons, `remoteId` porte la
     * clé du GROUPE d'articles d'inventaire — pas un SKU. La passer telle
     * quelle à `bulk_update_price_quantity` produit un 400 chez eBay, et le
     * stock ne se propage jamais. Pire : si la clé ressemblait par accident à
     * un SKU existant, on écrirait sur le mauvais article.
     *
     * Tant que chaque déclinaison n'a pas sa propre ligne locale, on refuse
     * en le disant. Un refus visible vaut mieux qu'une écriture au hasard.
     */
    if (listing.marketplaceData?.["inventoryItemGroupKey"]) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "unsupported",
        message:
          "Annonce à déclinaisons : la mise à jour coloris par coloris n'est pas encore branchée. Modifiez depuis eBay en attendant.",
      };
    }

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

  /*
   * ══ UNE ANNONCE, DEUX FORMES CHEZ EBAY ══
   *
   * Le cœur ne connaît qu'une commande : « mets cette annonce en ligne », ou
   * « retire-la ». C'est ici, et nulle part ailleurs, que se sait comment
   * eBay veut l'entendre — parce qu'eBay a deux façons de dire la même chose :
   *
   *   sans déclinaison   une OFFRE            /offer/{id}/publish
   *   avec déclinaisons  un GROUPE d'articles /offer/publish_by_inventory_item_group
   *
   * Les deux chemins ne sont pas interchangeables. Publier une offre d'un
   * groupe coloris par coloris produirait dix-sept annonces distinctes au lieu
   * d'un menu déroulant, dix-sept lignes du plafond vendeur consommées, et un
   * acheteur qui voit le même article dix-sept fois.
   *
   * L'ancienne version exigeait un `offerId`, que les annonces groupées ne
   * portent pas : elles rendent un `inventoryItemGroupKey` et une CARTE de
   * SKU vers offres. Elles répondaient donc « aucune offre à publier » et
   * restaient hors d'atteinte de l'outil, à la publication comme au retrait.
   */

  /** La forme de cette annonce chez eBay, telle que la création l'a laissée. */
  private forme(listing: Listing):
    | { type: "offre"; offerId: string }
    | { type: "groupe"; cle: string }
    | null {
    const groupe = listing.marketplaceData?.["inventoryItemGroupKey"] as
      | string
      | undefined;
    // Le groupe est testé EN PREMIER : une annonce groupée peut aussi porter
    // une carte d'offres, et la traiter comme une offre unique en publierait
    // une seule des dix-sept.
    if (groupe) return { type: "groupe", cle: groupe };
    const offerId = listing.marketplaceData?.["offerId"] as string | undefined;
    if (offerId) return { type: "offre", offerId };
    return null;
  }

  async activateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const forme = this.forme(listing);
    if (!forme) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "unsupported",
        message: "Aucune offre eBay à publier pour cet article.",
      };
    }

    if (forme.type === "groupe") {
      const r = await this.call<{ listingId?: string }>(
        ctx,
        "/sell/inventory/v1/offer/publish_by_inventory_item_group",
        {
          method: "POST",
          body: JSON.stringify({
            inventoryItemGroupKey: forme.cle,
            marketplaceId: ctx.credentials?.["marketplaceId"] ?? "EBAY_FR",
          }),
        },
      );
      return this.ok(
        ctx,
        r?.listingId ?? listing.remoteId,
        "Annonce à déclinaisons publiée d'un seul tenant.",
      );
    }

    const r = await this.call<{ listingId?: string }>(
      ctx,
      `/sell/inventory/v1/offer/${forme.offerId}/publish`,
      { method: "POST" },
    );
    return this.ok(ctx, r?.listingId ?? listing.remoteId);
  }

  async deactivateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const forme = this.forme(listing);
    if (!forme) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "unsupported",
        message: "Aucune offre eBay à retirer pour cet article.",
      };
    }

    /*
     * « withdraw » retire l'annonce mais CONSERVE l'offre et le groupe : on
     * peut republier sans tout recréer. Supprimer l'offre perdrait son
     * historique de vente, et le groupe ses déclinaisons.
     */
    if (forme.type === "groupe") {
      await this.call(
        ctx,
        "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
        {
          method: "POST",
          body: JSON.stringify({
            inventoryItemGroupKey: forme.cle,
            marketplaceId: ctx.credentials?.["marketplaceId"] ?? "EBAY_FR",
          }),
        },
      );
      return this.ok(
        ctx,
        listing.remoteId,
        "Annonce à déclinaisons retirée d'un seul tenant.",
      );
    }

    await this.call(ctx, `/sell/inventory/v1/offer/${forme.offerId}/withdraw`, {
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

/**
 * Crée l'adresse d'expédition qu'eBay exige pour publier.
 *
 * POURQUOI CE N'EST PAS UN RÉGLAGE COMME LES AUTRES. Les trois politiques —
 * livraison, paiement, retour — se créent dans Seller Hub, parce qu'elles
 * engagent les conditions de vente. L'« adresse d'expédition » d'eBay, elle,
 * n'apparaît nulle part dans son interface : c'est un objet purement
 * technique, l'entrepôt d'où part le colis, et il ne se crée QUE par l'API.
 * Un vendeur qui ne code pas ne peut littéralement pas publier.
 *
 * C'est la seule écriture de compte que cet outil se permette, et elle reste
 * derrière un geste explicite : elle ne s'exécute jamais toute seule.
 *
 * eBay demande au minimum un pays et un code postal. Le type par défaut est
 * WAREHOUSE, ce qui convient : ce n'est pas une boutique physique.
 */
export async function ebayCreerAdresse(
  adapter: EbayAdapter,
  ctx: MarketplaceContext,
  args: { cle: string; nom: string; pays: string; codePostal: string; ville?: string },
): Promise<void> {
  const cle = args.cle.trim().slice(0, 36);
  if (!/^[A-Za-z0-9_-]+$/.test(cle)) {
    throw new Error(
      "L'identifiant d'adresse ne doit contenir que lettres, chiffres, tiret ou souligné.",
    );
  }
  if (!args.pays || !args.codePostal) {
    throw new Error("eBay exige au minimum un pays et un code postal.");
  }

  await adapter.rawCall(ctx, `/sell/inventory/v1/location/${encodeURIComponent(cle)}`, {
    method: "POST",
    body: JSON.stringify({
      name: args.nom.slice(0, 1000) || cle,
      merchantLocationStatus: "ENABLED",
      locationTypes: ["WAREHOUSE"],
      location: {
        address: {
          country: args.pays.toUpperCase().slice(0, 2),
          postalCode: args.codePostal,
          ...(args.ville ? { city: args.ville } : {}),
        },
      },
    }),
  });
}
