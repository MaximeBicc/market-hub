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
export type VariantId = string;
export type ListingId = string;
export type ListingGroupId = string;

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

/**
 * Un AXE de variation : « Couleur », avec ses valeurs.
 *
 * Le nom est libre de notre côté, parce qu'aucune plateforme n'impose le même
 * vocabulaire et qu'imposer le nôtre reviendrait à choisir à la place du
 * vendeur. Le prix de cette liberté se paie à la publication : eBay exige que
 * le nom de l'aspect corresponde EXACTEMENT entre le groupe et chaque article,
 * Etsy veut un identifiant de propriété tiré de sa taxonomie.
 *
 * Limites réelles à respecter : Shopify accepte 3 axes, Etsy 2.
 */
export interface OptionAxis {
  name: string;
  /** Dans l'ordre d'affichage. Aucune valeur vide, aucun doublon. */
  values: string[];
}

/**
 * L'UNITÉ RÉELLEMENT VENDABLE.
 *
 * Tout produit en a au moins une : un produit sans déclinaison a une variante
 * unique, aux `optionValues` vides. Pas de « variante optionnelle » — c'est ce
 * qui évite d'avoir deux chemins de code, celui qu'on teste et celui qui casse.
 */
export interface Variant {
  id: VariantId;
  productId: ProductId;

  /**
   * NULLABLE, et c'est le fait central de tout ce modèle : vingt-six des
   * vingt-huit variantes lues chez Shopify n'en ont pas. Shopify ne l'exige
   * pas, et n'impose même pas qu'il soit unique entre deux variantes.
   */
  sku?: string | undefined;

  /** Une valeur par axe du produit, DANS LE MÊME ORDRE. */
  optionValues: string[];

  /**
   * Identité de repli quand le SKU manque : « couleur=violet ».
   * Normalisée — minuscules, accents pliés — et unique par produit. C'est elle
   * qui permet de retrouver une variante d'un passage de synchronisation à
   * l'autre sans dépendre d'un SKU que la plateforme n'impose pas.
   */
  optionKey: string;

  price: Money;
  imageUrl?: string | undefined;
  position: number;

  /**
   * `archived` : la plateforme ne renvoie plus cette variante. On ne supprime
   * pas la ligne — son historique de ventes y pend — mais son stock cesse
   * d'être compté. Sans cet état, un coloris retiré reste comptabilisé ici
   * pour toujours.
   */
  status: "active" | "archived";
  marketplaceData?: Record<string, unknown> | undefined;
}

export interface Product {
  id: ProductId;
  /**
   * Code du PARENT. N'est plus la clé de rapprochement : un produit à
   * dix-sept coloris n'a pas « un » SKU, ce sont ses variantes qui en portent.
   */
  sku: string;
  title: string;
  description?: string | undefined;
  price: Money;
  stock: number;
  images?: string[] | undefined;
  tags?: string[] | undefined;

  /** Les axes de variation. Tableau VIDE = produit sans déclinaison. */
  options?: OptionAxis[] | undefined;
  /** Les unités vendables. Chargées à la demande, pas toujours présentes. */
  variants?: Variant[] | undefined;

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
  /** L'unité vendable visée. Absente tant que le rapprochement n'a pas eu lieu. */
  variantId?: VariantId | undefined;
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
/**
 * Stock central, compté PAR VARIANTE.
 *
 * Il n'y a pas d'alternative défendable : deux coloris du même produit ont des
 * quantités indépendantes, et tout l'objet de l'outil est de refléter ce
 * nombre. Une somme au niveau du produit ne se repousserait pas — « mettre le
 * stock à 12 » n'a aucun sens pour un parent à dix-sept coloris.
 */
export interface InventoryItem {
  variantId: VariantId;
  onHand: number;
  reserved: number;
  version: number;
}

export interface CanonicalOrderLine {
  productId?: ProductId | undefined;
  /** L'unité réellement vendue, quand on a su la retrouver. */
  variantId?: VariantId | undefined;
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
/**
 * CE QU'UN WEBHOOK APPREND, UNE FOIS TRADUIT.
 *
 * Une notification est un texte propre à sa plateforme. Le cœur n'en veut
 * rien savoir : il veut la SUBSTANCE. Deux formes seulement, parce qu'il n'y
 * a que deux situations.
 *
 * `stock` est celle qui compte. Shopify dit exactement quel article
 * d'inventaire a changé et à combien : tout est déjà là, il n'y a rien à
 * relire. Le traduire en « relis ton inventaire » revenait à recevoir une
 * adresse précise et repartir fouiller la ville — mille variantes relues
 * pour une seule qui a bougé.
 *
 * `relire` reste pour ce qui n'est pas exploitable directement : Etsy ne
 * pousse qu'un identifiant de commande sans forme documentée, et un
 * changement de titre chez Shopify n'a pas de raccourci.
 */
export type SignalWebhook =
  | {
      type: "stock";
      /** L'identité de l'unité chez la plateforme — pas chez nous. */
      refDistante: string;
      disponible: number;
    }
  | { type: "relire"; resource: "orders" | "inventory" | "listings" };

export interface CapabilitySet {
  listingCreate: boolean;
  listingUpdate: boolean;
  listingActivate: boolean;
  listingDeactivate: boolean;
  /**
   * EFFACER l'annonce chez la plateforme, et non la coucher.
   *
   * Distincte de `listingDeactivate` parce que les deux gestes n'ont rien à
   * voir : désactiver se défait, effacer non — l'ancienneté de l'annonce, son
   * référencement et ses avis partent avec elle. Facultative : une plateforme
   * qui ne sait pas effacer n'a pas à mentir en le déclarant.
   */
  listingDelete?: boolean | undefined;
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
  /** Adresse publique de l'annonce, uniquement une fois réellement en ligne. */
  url?: string | undefined;
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
 * Un réglage de compte que la plateforme impose, et les choix disponibles.
 *
 * POURQUOI CE TYPE EXISTE. Publier une annonce demande des objets qui vivent
 * dans le compte marchand, pas dans l'outil : chez eBay une adresse
 * d'expédition et trois politiques, chez Etsy un profil de livraison et un
 * profil de préparation. L'outil ne peut pas les créer — ils engagent les
 * conditions de vente du vendeur — mais rien ne l'oblige à faire recopier
 * sept identifiants numériques à la main.
 *
 * Il va donc les LIRE. Le vendeur choisit dans une liste lisible
 * — « Colissimo 48 h », « Retours sous 14 jours » — et l'identifiant se range
 * tout seul. La saisie manuelle d'un identifiant est une source d'erreur qui
 * ne se voit qu'à la première publication ratée, des jours plus tard.
 */
export interface RemoteSetting {
  /** La clé d'identifiant à renseigner : « fulfillmentPolicyId ». */
  key: string;
  /** Ce que ça désigne, en français. */
  label: string;
  /** Ce qu'il faut faire quand la liste est vide. */
  aide: string;
  options: Array<{ id: string; label: string; detail?: string | undefined }>;
}

/**
 * Une catégorie proposée par la plateforme, pour un texte donné.
 *
 * Les deux référentiels n'ont rien en commun — eBay a plusieurs dizaines de
 * milliers de catégories, Etsy environ six mille, et aucune correspondance
 * officielle n'existe entre les deux. Chercher « range câble » doit donc être
 * fait DEUX fois, chez chacun, et c'est ce que ce type normalise.
 */
export interface CategorySuggestion {
  id: string;
  label: string;
  /** Le chemin complet, du plus général au plus précis. Sert à lever le doute. */
  path?: string[] | undefined;
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
  /**
   * Vrai quand SEUL le stock est fiable dans cette ligne.
   *
   * Certaines plateformes rendent la quantité dans la liste, mais le prix et
   * le statut un appel par article — chez eBay, quinze articles coûtent seize
   * requêtes. Sur un relevé qui tourne toutes les deux minutes, c'est le
   * plafond quotidien franchi avec cinq articles au catalogue.
   *
   * Le relevé de stock demande donc à ne pas payer ce qu'il ne regarde pas.
   * Les champs non fiables portent alors des valeurs de remplissage, et
   * l'appelant DOIT conserver ce qu'il a déjà : les écrire remettrait tous
   * les prix à zéro.
   */
  stockSeul?: boolean | undefined;
  url?: string | undefined;
  imageUrl?: string | undefined;

  /*
   * ══ CE QUI RATTACHE UNE ANNONCE À SON PARENT ══
   *
   * Sans ces deux champs, dix-sept coloris d'un même support téléphone
   * arrivaient comme dix-sept annonces sans lien, et vingt-six d'entre elles
   * sans aucun produit maître — parce que le rapprochement se faisait par SKU
   * et que Shopify n'en impose pas. Une vente sur l'une d'elles ne
   * décrémentait alors rien du tout.
   */

  /** Identifiant du PARENT chez la plateforme. Null = annonce sans parent. */
  groupRemoteId?: string | undefined;
  /** Titre du parent, sans le suffixe de déclinaison. */
  groupTitle?: string | undefined;
  /** Les valeurs de cette unité : `[{ name: "Couleur", value: "Violet" }]`. */
  optionValues?: Array<{ name: string; value: string }> | undefined;

  /** Identifiants propres à la plateforme, mémorisés pour éviter des relectures. */
  marketplaceData?: Record<string, unknown> | undefined;
}
