import type {
  CapabilitySet,
  CanonicalOrderEvent,
  Listing,
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
