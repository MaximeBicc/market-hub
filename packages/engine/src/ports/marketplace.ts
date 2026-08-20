import type {
  CapabilitySet,
  CanonicalOrderEvent,
  FulfillmentInput,
  Listing,
  RemoteListing,
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

  updatePrice(
    ctx: MarketplaceContext,
    listing: Listing,
    price: Money,
    idempotencyKey: string,
  ): Promise<TargetResult>;

  updateStock(
    ctx: MarketplaceContext,
    listing: Listing,
    stock: number,
    idempotencyKey: string,
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
   * Lit une page du catalogue existant chez la plateforme.
   *
   * Optionnelle : Vinted ne sait rien lire sans accès Pro. Mais sans elle, on
   * ne peut relier qu'une boutique VIDE — or une boutique qu'on relie a
   * presque toujours déjà des produits, et c'est précisément leur stock qu'on
   * veut surveiller.
   */
  fetchListings?(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<{ items: RemoteListing[]; cursor?: string | undefined }>;

  /** Relevé des ventes, pour les plateformes sans webhook fiable. */
  pollOrderEvents?(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<PollResult>;

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
