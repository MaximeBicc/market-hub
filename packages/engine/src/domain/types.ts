/**
 * Modèle canonique multi-marketplace.
 *
 * Repris du paquet `@variety/marketplace-engine` v0.1, qui posait déjà les
 * bonnes abstractions. Rien au-dessus de cette couche ne connaît eBay, Etsy,
 * Vinted ou TikTok : les adaptateurs traduisent vers ces types, et seulement
 * vers eux.
 */

export const MARKETPLACES = [
  "shopify",
  "etsy",
  "ebay",
  "allegro",
  "tiktok_shop",
  "vinted",
  "mock",
] as const;

export type MarketplaceId = (typeof MARKETPLACES)[number] | (string & {});

export type AccountId = string;
export type ProductId = string;
export type ListingId = string;

/** Montants en entiers (centimes) : jamais de flottant pour de l'argent. */
export type Money = { amount: number; currency: string };

/**
 * Un COMPTE sur une marketplace, pas une marketplace.
 *
 * La distinction est structurante : on peut tenir deux boutiques eBay
 * (`ebay_electronique`, `ebay_vintage`) avec des identifiants et des règles
 * différentes. Le `slug` est lisible par un humain et sert dans les journaux ;
 * l'`id` est immuable et ne doit jamais servir d'affichage.
 */
export interface MarketplaceAccount {
  id: AccountId;
  marketplace: MarketplaceId;
  slug: string;
  displayName: string;
  enabled: boolean;
  externalAccountId?: string | undefined;
}

/** Le produit « maître », indépendant des plateformes. Clé de rapprochement : le SKU. */
/**
 * État de l'article, tel que les places de marché l'entendent.
 *
 * Ce n'est pas un détail de confort : eBay refuse ou déclasse une annonce dont
 * l'état ne correspond pas à sa catégorie, et vendre de l'occasion en la
 * déclarant neuve est une fausse déclaration, pas une approximation.
 */
export type ProductCondition =
  | "new"
  | "new_other"
  | "used_excellent"
  | "used_good"
  | "used_acceptable"
  | "for_parts";

/** Qui a fabriqué l'article — vocabulaire imposé par Etsy. */
export type WhoMade = "i_did" | "collective" | "someone_else";

/**
 * Quand — vocabulaire imposé par Etsy, relevé sur sa spécification OpenAPI.
 *
 * Trois valeurs inventées figuraient ici (`2000_2009`, `before_2000`,
 * `vintage`) : elles n'existent pas chez Etsy et faisaient échouer la
 * création en 400. Les intervalles ne sont pas réguliers et se chevauchent
 * — c'est la liste d'Etsy, pas la nôtre.
 */
export type WhenMade =
  | "made_to_order"
  | "2020_2026"
  | "2010_2019"
  | "2007_2009"
  | "2000_2006"
  | "before_2007"
  | "1990s"
  | "1980s"
  | "1970s"
  | "1960s"
  | "1950s"
  | "1940s"
  | "1930s"
  | "1920s"
  | "1910s"
  | "1900s"
  | "1800s"
  | "1700s"
  | "before_1700";

export interface Product {
  id: ProductId;
  sku: string;
  title: string;
  description?: string | undefined;
  price: Money;
  stock: number;
  images?: string[] | undefined;
  tags?: string[] | undefined;

  /*
   * ══ DÉCLARATIONS OBLIGATOIRES ══
   *
   * Ces champs étaient auparavant codés en dur dans les adaptateurs :
   * `condition: "NEW"` chez eBay, `who_made: "i_did"` et
   * `when_made: "made_to_order"` chez Etsy. Autrement dit, tout article
   * diffusé était déclaré neuf et fait main par le vendeur — ce qui est faux
   * pour de la revente, et ce qu'aucun écran n'affichait.
   *
   * Une valeur fausse envoyée automatiquement, en masse, sans que personne la
   * voie, n'est pas une dette technique : c'est un risque de suspension de
   * boutique. Ils sont donc OPTIONNELS dans le type — un produit importé n'en
   * a pas — mais leur absence bloque la publication au lieu de l'inventer.
   */

  /** Sans valeur, la diffusion vers eBay renvoie `manual_required`. */
  condition?: ProductCondition | undefined;
  /** Sans valeur, la diffusion vers Etsy renvoie `manual_required`. */
  whoMade?: WhoMade | undefined;
  whenMade?: WhenMade | undefined;
  /** Matériaux. Etsy les accepte, les autres les ignorent. */
  materials?: string[] | undefined;
  /** Poids en grammes, pour les frais de port calculés. */
  weightGrams?: number | undefined;

  /** Champs spécifiques à une plateforme (catégorie eBay, taxonomie Etsy…). */
  marketplaceData?: Record<string, unknown> | undefined;
}

/** La présence d'un produit sur un compte donné. */
export interface Listing {
  id: ListingId;
  productId: ProductId;
  accountId: AccountId;
  remoteId?: string | undefined;
  status: "draft" | "active" | "inactive" | "sold" | "error";
  price: Money;
  stock: number;
  marketplaceData?: Record<string, unknown> | undefined;
}

/**
 * Stock central.
 *
 * `reserved` couvre le laps de temps entre une vente constatée et son
 * expédition : la marchandise est encore physiquement là, mais elle n'est plus
 * disponible. `version` permet un verrouillage optimiste — deux ventes
 * simultanées sur deux plateformes ne doivent pas se perdre l'une l'autre.
 */
export interface InventoryItem {
  productId: ProductId;
  onHand: number;
  reserved: number;
  version: number;
}

export interface CanonicalOrderLine {
  productId?: ProductId | undefined;
  sku?: string | undefined;
  quantity: number;
  remoteListingId?: string | undefined;
}

/**
 * Événement de vente normalisé.
 *
 * Toute source — webhook Shopify, relevé Etsy, notification eBay — doit être
 * traduite dans cette forme avant d'entrer dans le système. C'est ce qui
 * permet à la déduplication et à la propagation de stock d'être écrites une
 * seule fois plutôt qu'une fois par plateforme.
 */
export interface CanonicalOrderEvent {
  marketplace: MarketplaceId;
  accountId: AccountId;
  remoteOrderId: string;
  /** Identifiant fourni par la plateforme. Sert de clé de déduplication. */
  eventId: string;
  kind: "paid" | "cancelled" | "returned";
  occurredAt: string;
  lines: CanonicalOrderLine[];
  raw?: unknown;
}

/**
 * Ce qu'un adaptateur sait réellement faire.
 *
 * C'est la pièce qui rend l'orchestrateur honnête. Sans elle, on suppose que
 * toute plateforme sait tout faire — ce qui est faux : Vinted ne permet aucune
 * écriture automatique sans accès Pro, et plusieurs API sont en lecture seule
 * sur certains objets. Déclarer les capacités permet à l'interface de griser
 * une action au lieu de la proposer puis d'échouer.
 */
export interface CapabilitySet {
  listingCreate: boolean;
  listingUpdate: boolean;
  listingActivate: boolean;
  listingDeactivate: boolean;
  stockRead: boolean;
  stockWrite: boolean;
  priceRead: boolean;
  priceWrite: boolean;
  ordersRead: boolean;
  /** Marquer une commande expédiée chez la plateforme. */
  ordersFulfill: boolean;
  /** Poser un numéro de suivi. Certaines plateformes acceptent l'un sans l'autre. */
  trackingWrite: boolean;
  /** Comment les ventes entrantes arrivent, si elles arrivent. */
  inboundSales: "webhook" | "poll" | "both" | "manual" | "none";
  messagesRead?: boolean | undefined;
  messagesSend?: boolean | undefined;
  reviewsRead?: boolean | undefined;
  reviewsReply?: boolean | undefined;
}

/**
 * Résultat d'une commande sur une cible.
 *
 * `manual_required` est le statut qui fait la différence : il dit « cette
 * plateforme ne peut pas le faire automatiquement, quelqu'un doit s'en
 * charger ». Le confondre avec `failed` ferait apparaître une opération
 * normale comme une panne, et déclencherait des alertes pour rien.
 */
export type TargetStatus =
  | "success"
  | "pending_remote"
  | "manual_required"
  | "unsupported"
  | "failed";

export type TargetResult = {
  accountId: AccountId;
  marketplace: MarketplaceId;
  status: TargetStatus;
  remoteId?: string | undefined;
  message?: string | undefined;
  /**
   * Identifiants secondaires rendus par la plateforme à la création.
   *
   * Sans ce champ, eBay n'avait aucun moyen de remonter son `offerId` : il
   * finissait glissé dans le TEXTE du message, donc nulle part. Conséquence
   * concrète et vérifiée : une annonce eBay créée par l'outil ne pouvait plus
   * jamais recevoir de changement de prix, ni être activée, ni désactivée —
   * un outil de synchronisation qui crée des objets qu'il ne sait pas
   * resynchroniser.
   */
  marketplaceData?: Record<string, unknown> | undefined;
};

/**
 * Expédition d'une commande.
 *
 * Contrairement aux commandes de catalogue, celle-ci ne se diffuse pas : une
 * commande n'existe que sur une plateforme. On vise donc un compte précis.
 *
 * `lines` vide signifie « tout le contenu de la commande ». Les expéditions
 * partielles existent (rupture sur un article), et les plateformes les gèrent
 * différemment : Shopify passe par des « fulfillment orders », eBay par une
 * simple mise à jour. Le contrat expose l'intention, l'adaptateur traduit.
 */
export interface FulfillmentInput {
  remoteOrderId: string;
  trackingNumber?: string | undefined;
  /** Transporteur, tel que la plateforme l'attend (« Colissimo », « DHL »...). */
  carrier?: string | undefined;
  trackingUrl?: string | undefined;
  lines?:
    | Array<{
        remoteLineId?: string | undefined;
        sku?: string | undefined;
        quantity: number;
      }>
    | undefined;
  /** Prévenir l'acheteur par e-mail. Vrai par défaut chez la plupart des plateformes. */
  notifyBuyer?: boolean | undefined;
}

/**
 * Une annonce telle que la plateforme la décrit.
 *
 * Distincte de `Listing` : celui-ci est notre représentation interne, liée à un
 * produit maître. Une annonce lue chez la plateforme n'a pas encore de produit
 * maître — c'est justement le rapprochement par SKU qui va le lui donner.
 *
 * Sans cette lecture, on ne peut relier qu'une boutique vide : impossible
 * d'importer un catalogue déjà garni, donc impossible de commencer à surveiller
 * un stock existant.
 */
export interface RemoteListing {
  remoteId: string;
  sku: string | null;
  title: string;
  price: Money;
  stock: number;
  status: Listing["status"];
  url?: string | undefined;
  imageUrl?: string | undefined;
  /** Identifiants propres à la plateforme, mémorisés pour éviter des relectures. */
  marketplaceData?: Record<string, unknown> | undefined;
}
