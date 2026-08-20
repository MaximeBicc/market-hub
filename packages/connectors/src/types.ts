import type {
  Money,
  Page,
  Platform,
  UnifiedListing,
  UnifiedOrder,
} from "@hub/core";

/**
 * Contrat unique que chaque place de marché doit remplir.
 *
 * Tout ce qui est spécifique à eBay / Etsy / Shopify / Alibaba est enfermé
 * derrière cette interface. Le planificateur, le consommateur de queue, les
 * routes HTTP et l'interface web n'importent JAMAIS un connecteur concret :
 * ils passent par le registre (voir index.ts).
 */

/** Identifiants applicatifs, injectés depuis les secrets du Worker. */
export interface AppCredentials {
  clientId: string;
  clientSecret: string;
  /** eBay : le « RuName » sert de redirect_uri à la place de l'URL. */
  redirectAlias?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  /** Timestamp Unix en secondes. */
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
}

/** Contexte passé à chaque appel de données. */
export interface SyncContext {
  shopId: string;
  /** Identifiant de la boutique chez la plateforme. */
  externalId: string;
  accessToken: string;
  config: Record<string, unknown>;
  /**
   * fetch instrumenté : compte les sous-requêtes, applique le token bucket du
   * Durable Object, et convertit 401/429/5xx en ConnectorError typée.
   * Les connecteurs ne doivent JAMAIS appeler le fetch global.
   */
  http: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface WebhookEvent {
  /** Identifiant fourni par la plateforme, sert à la déduplication. */
  eventId: string;
  topic: string;
  /** Identifiant de boutique extrait des en-têtes ou du corps. */
  externalShopId: string;
}

/**
 * Limites déclarées par la plateforme. Le Durable Object RateLimiter les lit
 * pour dimensionner le token bucket ; rien n'est codé en dur ailleurs.
 */
export interface PlatformLimits {
  /** Requêtes par seconde soutenues. */
  qps: number;
  /** Requêtes par jour (0 = non plafonné). */
  qpd: number;
  /** Taille du seau (rafale tolérée). */
  burst: number;
}

export interface MarketplaceConnector {
  readonly platform: Platform;
  readonly limits: PlatformLimits;
  /** true si la plateforme pousse des webhooks fiables (sinon : polling seul). */
  readonly supportsWebhooks: boolean;

  /* --- OAuth ------------------------------------------------------- */
  buildAuthUrl(args: {
    creds: AppCredentials;
    state: string;
    redirectUri: string;
    /** PKCE : Etsy l'exige, les autres le tolèrent. */
    codeChallenge: string;
  }): string;

  exchangeCode(args: {
    creds: AppCredentials;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<{ tokens: TokenSet; externalId: string; displayName: string }>;

  refresh(args: {
    creds: AppCredentials;
    refreshToken: string;
  }): Promise<TokenSet>;

  /* --- Lecture ----------------------------------------------------- */

  /**
   * Une page de commandes. Le connecteur DOIT borner la page à ~10 sous-requêtes
   * pour tenir dans le budget de 50 par invocation de Worker.
   */
  fetchOrders(
    ctx: SyncContext,
    cursor: string | null,
  ): Promise<Page<UnifiedOrder>>;

  fetchListings(
    ctx: SyncContext,
    cursor: string | null,
  ): Promise<Page<UnifiedListing>>;

  /* --- Écriture ---------------------------------------------------- */
  updateStock(
    ctx: SyncContext,
    listingExternalId: string,
    quantity: number,
  ): Promise<void>;

  updatePrice(
    ctx: SyncContext,
    listingExternalId: string,
    price: Money,
  ): Promise<void>;

  /* --- Webhooks ---------------------------------------------------- */

  /**
   * Vérifie la signature. Reçoit le corps BRUT (jamais re-sérialisé) :
   * un JSON.parse suivi d'un JSON.stringify casse le HMAC.
   */
  verifyWebhook(args: {
    creds: AppCredentials;
    headers: Headers;
    rawBody: string;
  }): Promise<boolean>;

  parseWebhook(args: {
    headers: Headers;
    rawBody: string;
  }): WebhookEvent | null;

  /** Traduit un webhook déjà vérifié en effet sur le domaine. */
  applyWebhook(
    ctx: SyncContext,
    topic: string,
    rawBody: string,
  ): Promise<{ orders?: UnifiedOrder[]; listings?: UnifiedListing[] }>;
}
