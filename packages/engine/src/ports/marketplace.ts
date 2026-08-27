import type {
  Variant,
  SignalWebhook,
  CapabilitySet,
  CanonicalOrderEvent,
  FulfillmentInput,
  Listing,
  RemoteListing,
  CategorySuggestion,
  RemoteSetting,
  MarketplaceAccount,
  MarketplaceId,
  Money,
  Product,
  TargetResult,
} from "../domain/types.js";

/**
 * Contrat unique que chaque plateforme doit remplir.
 *
 * Ajouter une marketplace = un fichier d'adaptateur + une ligne dans le
 * registre. Aucun autre fichier du dépôt ne doit importer un adaptateur
 * concret : tout passe par le registre.
 */

export interface MarketplaceContext {
  account: MarketplaceAccount;
  credentials?: Record<string, string> | undefined;
  /**
   * fetch instrumenté fourni par l'hôte : il compte les sous-requêtes,
   * applique le token bucket de la plateforme et traduit les codes HTTP en
   * erreurs typées. Un adaptateur ne doit JAMAIS appeler le fetch global —
   * il contournerait la limitation de débit et exposerait le compte à un
   * bannissement.
   */
  http?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;

  /**
   * Persiste des identifiants DÉRIVÉS : jeton court, date d'expiration,
   * jeton de rafraîchissement renouvelé.
   *
   * Nécessaire parce que la plupart des plateformes ont abandonné les jetons
   * permanents. Shopify, depuis janvier 2026, ne délivre plus que des jetons
   * valables 24 heures obtenus par `client_credentials` ; eBay expire en
   * 2 heures, Etsy en 1 heure. Sans ce rappel, l'adaptateur devrait
   * redemander un jeton à chaque invocation — un aller-retour réseau gaspillé
   * sur chaque commande, et un quota consommé pour rien.
   *
   * Le patch est fusionné avec les identifiants existants, jamais substitué :
   * l'ID client et le secret doivent survivre à l'écriture du jeton.
   */
  saveCredentials?:
    | ((patch: Record<string, string>) => Promise<void>)
    | undefined;
}

export interface PollResult {
  events: CanonicalOrderEvent[];
  cursor?: string | undefined;
}

export interface MarketplaceAdapter {
  readonly id: MarketplaceId;

  /** Ce que cet adaptateur sait faire, éventuellement selon le compte. */
  capabilities(ctx: MarketplaceContext): Promise<CapabilitySet> | CapabilitySet;

  /** Vérifie que les identifiants fonctionnent. Doit lever en cas d'échec. */
  testConnection(ctx: MarketplaceContext): Promise<void>;

  createListing(
    ctx: MarketplaceContext,
    product: Product,
    idempotencyKey: string,
  ): Promise<TargetResult>;

  /**
   * Écrire le prix d'une unité vendable.
   *
   * Même règle que pour le stock : `unite` dit LAQUELLE, et le module traduit.
   * Un prix appliqué à toutes les déclinaisons se voit moins vite qu'un stock
   * faux — personne ne survend — mais il se voit à la première commande au
   * mauvais tarif, et il faut alors l'honorer.
   */
  updatePrice(
    ctx: MarketplaceContext,
    listing: Listing,
    price: Money,
    idempotencyKey: string,
    unite?: Variant,
  ): Promise<TargetResult>;

  /**
   * Écrire le stock d'une unité vendable.
   *
   * `unite` porte l'identité de la déclinaison visée — son SKU, ses valeurs
   * d'option, sa clé normalisée. Le cœur ne sait pas comment chaque
   * plateforme désigne une déclinaison ; il dit simplement LAQUELLE, et le
   * module traduit.
   *
   * Elle est facultative parce qu'un produit sans déclinaison n'en a pas
   * besoin. Un module qui reçoit une annonce à plusieurs unités SANS elle
   * doit refuser plutôt que d'en choisir une : c'est ainsi qu'on écrit la
   * quantité du violet sur l'annonce du noir.
   */
  updateStock(
    ctx: MarketplaceContext,
    listing: Listing,
    stock: number,
    idempotencyKey: string,
    unite?: Variant,
  ): Promise<TargetResult>;

  activateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    idempotencyKey: string,
  ): Promise<TargetResult>;

  deactivateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    idempotencyKey: string,
  ): Promise<TargetResult>;

  /**
   * Marque une commande expédiée, avec éventuellement un numéro de suivi.
   *
   * Volontairement OBLIGATOIRE et non optionnelle : chaque adaptateur doit
   * prendre position explicitement. Une méthode absente se remarque moins
   * qu'un `manual_required` assumé, et c'est ainsi qu'une plateforme se
   * retrouve sans expédition sans que personne s'en aperçoive.
   */
  markShipped(
    ctx: MarketplaceContext,
    input: FulfillmentInput,
    idempotencyKey: string,
  ): Promise<TargetResult>;

  /**
   * Lit les réglages du compte marchand dont la publication dépend.
   *
   * Optionnelle : Shopify n'en a aucun — c'est pour cela qu'il publie déjà.
   * Là où elle existe, elle évite de faire recopier des identifiants
   * numériques : le vendeur choisit « Colissimo 48 h » dans une liste.
   */
  listSettings?(ctx: MarketplaceContext): Promise<RemoteSetting[]>;

  /**
   * Cherche une catégorie à partir d'un texte libre.
   *
   * Optionnelle : Shopify n'a pas de catégorie imposée. Là où elle existe,
   * elle remplace la saisie d'un identifiant numérique à rallonge, qu'il
   * faudrait sinon aller déterrer dans un référentiel de plusieurs dizaines
   * de milliers d'entrées — et dont une faute de frappe ne se voit qu'au
   * refus de publication, des jours plus tard.
   */
  searchCategories?(
    ctx: MarketplaceContext,
    query: string,
  ): Promise<CategorySuggestion[]>;

  /**
   * Lit une page du catalogue existant chez la plateforme.
   *
   * Optionnelle : Vinted ne sait rien lire sans accès Pro. Mais sans elle, on
   * ne peut relier qu'une boutique VIDE — or une boutique qu'on relie a
   * presque toujours déjà des produits, et c'est précisément leur stock qu'on
   * veut surveiller.
   */
  /**
   * @param options `stockSeul` autorise le module à ne rendre QUE les
   * quantités, en économisant les appels dédiés au prix et au statut. Le
   * module reste libre de tout rendre : le drapeau est une permission, pas
   * un ordre, et un module qui l'ignore reste correct.
   */
  fetchListings?(
    ctx: MarketplaceContext,
    cursor?: string,
    options?: { stockSeul?: boolean },
  ): Promise<{ items: RemoteListing[]; cursor?: string | undefined }>;

  /** Relevé des ventes, pour les plateformes sans webhook fiable. */
  pollOrderEvents?(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<PollResult>;

  /**
   * Ce qu'un webhook DÉJÀ VÉRIFIÉ oblige à relire, au-delà des ventes.
   *
   * Un changement de stock n'est pas une vente : il n'entre pas dans le
   * modèle d'événement canonique, qui décrit des commandes. Plutôt que
   * d'inventer un second modèle par plateforme, le webhook sert ici de
   * DÉCLENCHEUR : il dit « quelque chose a bougé sur cette ressource », et
   * c'est la synchronisation habituelle — avec son rapprochement de stock
   * déjà éprouvé — qui va lire ce qui a changé.
   *
   * Un aller-retour de plus, mais une seule logique de stock dans tout
   * l'outil. Et chaque plateforme qui gagnera un webhook plus tard se
   * branchera ici sans rien réécrire.
   *
   * Renvoie des noms de ressources : « inventory », « orders », « listings ».
   * N'est appelé QU'APRÈS vérification de la signature — sinon n'importe qui
   * pourrait déclencher des synchronisations et vider les quotas.
   */
  /**
   * Ce qu'une notification apprend, traduit en signaux normalisés.
   *
   * Le corps BRUT est passé plutôt que l'objet analysé : la vérification de
   * signature s'est déjà faite dessus, et le réanalyser deux fois pour deux
   * usages coûterait autant qu'un appel réseau.
   */
  webhookSignaux?(request: Request, rawBody: string): SignalWebhook[];

  /**
   * Vérifie la signature d'un webhook et le traduit en événements canoniques.
   * Reçoit la requête brute : re-sérialiser le corps casserait la signature.
   */
  verifyAndParseWebhook?(
    ctx: MarketplaceContext,
    request: Request,
    rawBody: string,
  ): Promise<CanonicalOrderEvent[]>;
}
