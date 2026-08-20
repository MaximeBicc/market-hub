import type {
  AccountId,
  CapabilitySet,
  Listing,
  Money,
  ProductId,
  TargetResult,
} from "../domain/types.js";
import type { MarketplaceContext } from "../ports/marketplace.js";
import type {
  AccountRepository,
  CredentialRepository,
  ListingRepository,
  ProductRepository,
} from "../ports/repositories.js";
import { MarketplaceRegistry } from "../core/registry.js";

/**
 * ORCHESTRATEUR — les commandes générales.
 *
 * Une commande unique (« passe ce produit à 24,90 € ») s'exécute sur plusieurs
 * comptes, chacun l'adaptant à sa plateforme. L'appelant ne sait pas si la
 * cible est eBay ou Vinted : il reçoit un résultat par cible, avec un statut
 * qui dit ce qui s'est réellement passé.
 *
 * Trois garanties que cette couche apporte, et qui manquaient à la version
 * d'origine du paquet :
 *
 * 1. ISOLATION DES ERREURS. Si l'adaptateur eBay lève une exception, Etsy et
 *    Shopify doivent quand même s'exécuter. Une boucle sans try/catch fait
 *    échouer les cinq cibles à cause d'une seule.
 *
 * 2. RESPECT DES CAPACITÉS. On interroge l'adaptateur avant de l'appeler : une
 *    plateforme qui ne sait pas écrire un prix renvoie `unsupported` sans
 *    consommer d'appel réseau ni de quota.
 *
 * 3. EXÉCUTION SÉQUENTIELLE. Le plan gratuit Cloudflare ne tolère que six
 *    connexions sortantes simultanées ; un Promise.all sur dix comptes échoue
 *    de façon non déterministe.
 */

type CapabilityKey = keyof CapabilitySet;

/**
 * Notification émise après chaque commande, quelle qu'en soit l'origine.
 *
 * Elle vit au niveau de l'orchestrateur et non des routes HTTP, parce que
 * toutes les commandes ne viennent pas d'une requête : la propagation de stock
 * après une vente est déclenchée par le moteur lui-même. Journaliser côté
 * route laisserait l'action la plus importante du système — retirer un article
 * des autres canaux — se dérouler sans aucune trace.
 */
export type OutcomeHook = (
  command: string,
  idempotencyKey: string,
  productId: ProductId | null,
  outcome: CommandOutcome,
) => Promise<void>;

export interface CommandOutcome {
  results: TargetResult[];
  /** Vrai si au moins une cible a abouti réellement. */
  anySuccess: boolean;
  /** Vrai si une cible demande une action humaine (Vinted, par exemple). */
  anyManual: boolean;
}

export class MarketplaceOrchestrator {
  constructor(
    private readonly registry: MarketplaceRegistry,
    private readonly accounts: AccountRepository,
    private readonly credentials: CredentialRepository,
    private readonly products: ProductRepository,
    private readonly listings: ListingRepository,
    /** Fabrique le fetch instrumenté propre à un compte, si l'hôte en fournit un. */
    private readonly httpFor?: (
      account: { id: AccountId; marketplace: string },
    ) => ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
    private readonly onOutcome?: OutcomeHook,
  ) {}

  /**
   * Journalise sans jamais faire échouer la commande : une écriture de trace
   * qui plante ne doit pas annuler une mise en ligne qui, elle, a réussi.
   */
  private async report(
    command: string,
    key: string,
    productId: ProductId | null,
    outcome: CommandOutcome,
  ): Promise<void> {
    if (!this.onOutcome) return;
    try {
      await this.onOutcome(command, key, productId, outcome);
    } catch {
      /* la trace est utile, pas critique */
    }
  }

  private async ctx(accountId: AccountId): Promise<MarketplaceContext> {
    const account = await this.accounts.get(accountId);
    if (!account) throw new Error(`Compte inconnu : ${accountId}`);
    return {
      account,
      credentials: await this.credentials.get(accountId),
      http: this.httpFor?.(account),
    };
  }

  /**
   * Exécute une action sur chaque compte, en isolant les échecs.
   * `needs` nomme la capacité requise ; une cible qui ne l'a pas est écartée
   * proprement plutôt que tentée puis échouée.
   */
  private async fanOut(
    accountIds: AccountId[],
    needs: CapabilityKey,
    run: (
      ctx: MarketplaceContext,
      adapter: ReturnType<MarketplaceRegistry["get"]>,
    ) => Promise<TargetResult>,
  ): Promise<CommandOutcome> {
    const results: TargetResult[] = [];

    for (const accountId of accountIds) {
      try {
        const ctx = await this.ctx(accountId);

        if (!ctx.account.enabled) {
          results.push({
            accountId,
            marketplace: ctx.account.marketplace,
            status: "unsupported",
            message: "Compte désactivé",
          });
          continue;
        }

        const adapter = this.registry.get(ctx.account.marketplace);
        const caps = await adapter.capabilities(ctx);

        if (caps[needs] !== true) {
          results.push({
            accountId,
            marketplace: ctx.account.marketplace,
            status: "unsupported",
            message: `${ctx.account.marketplace} ne gère pas « ${needs} »`,
          });
          continue;
        }

        results.push(await run(ctx, adapter));
      } catch (err) {
        // L'échec d'une cible ne doit jamais emporter les autres.
        results.push({
          accountId,
          marketplace: "unknown",
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      results,
      anySuccess: results.some((r) => r.status === "success"),
      anyManual: results.some((r) => r.status === "manual_required"),
    };
  }

  /* ---------------------------------------------------------------- */

  async createListing(input: {
    productId: ProductId;
    accountIds: AccountId[];
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const product = await this.products.get(input.productId);
    if (!product) throw new Error(`Produit inconnu : ${input.productId}`);

    const outcome = await this.fanOut(input.accountIds, "listingCreate", async (ctx, adapter) => {
      const result = await adapter.createListing(
        ctx,
        product,
        // La clé d'idempotence est déclinée par compte : rejouer la commande
        // ne doit pas créer un doublon chez la plateforme.
        `${input.idempotencyKey}:${ctx.account.id}`,
      );

      if (result.status === "success" && result.remoteId) {
        await this.listings.put({
          id: crypto.randomUUID(),
          productId: product.id,
          accountId: ctx.account.id,
          remoteId: result.remoteId,
          status: "active",
          price: product.price,
          stock: product.stock,
        });
      }
      return result;
    });
    await this.report("createListing", input.idempotencyKey, input.productId, outcome);
    return outcome;
  }

  async setPrice(input: {
    productId: ProductId;
    accountIds: AccountId[];
    price: Money;
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const outcome = await this.fanOut(input.accountIds, "priceWrite", async (ctx, adapter) => {
      const listing = await this.listings.findByProductAndAccount(
        input.productId,
        ctx.account.id,
      );
      if (!listing) {
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message: "Aucune annonce pour ce produit sur ce compte",
        };
      }
      const r = await adapter.updatePrice(
        ctx,
        listing,
        input.price,
        `${input.idempotencyKey}:${ctx.account.id}`,
      );
      if (r.status === "success") {
        await this.listings.put({ ...listing, price: input.price });
      }
      return r;
    });
    await this.report("setPrice", input.idempotencyKey, input.productId, outcome);
    return outcome;
  }

  async setStock(input: {
    productId: ProductId;
    accountIds: AccountId[];
    stock: number;
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const outcome = await this.fanOut(input.accountIds, "stockWrite", async (ctx, adapter) => {
      const listing = await this.listings.findByProductAndAccount(
        input.productId,
        ctx.account.id,
      );
      if (!listing) {
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message: "Aucune annonce pour ce produit sur ce compte",
        };
      }
      const r = await adapter.updateStock(
        ctx,
        listing,
        input.stock,
        `${input.idempotencyKey}:${ctx.account.id}`,
      );
      if (r.status === "success") {
        await this.listings.put({ ...listing, stock: input.stock });
      }
      return r;
    });
    await this.report("setStock", input.idempotencyKey, input.productId, outcome);
    return outcome;
  }

  async setActive(input: {
    productId: ProductId;
    accountIds: AccountId[];
    active: boolean;
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const need: CapabilityKey = input.active
      ? "listingActivate"
      : "listingDeactivate";

    const outcome = await this.fanOut(input.accountIds, need, async (ctx, adapter) => {
      const listing = await this.listings.findByProductAndAccount(
        input.productId,
        ctx.account.id,
      );
      if (!listing) {
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message: "Aucune annonce pour ce produit sur ce compte",
        };
      }
      const key = `${input.idempotencyKey}:${ctx.account.id}`;
      const r = input.active
        ? await adapter.activateListing(ctx, listing, key)
        : await adapter.deactivateListing(ctx, listing, key);

      if (r.status === "success") {
        const next: Listing = {
          ...listing,
          status: input.active ? "active" : "inactive",
        };
        await this.listings.put(next);
      }
      return r;
    });
    await this.report("setActive", input.idempotencyKey, input.productId, outcome);
    return outcome;
  }

  /** État des capacités de chaque compte — sert à griser les actions dans l'interface. */
  async capabilitiesFor(accountIds: AccountId[]) {
    const out: Array<{
      accountId: AccountId;
      marketplace: string;
      capabilities: CapabilitySet | null;
      error?: string;
    }> = [];

    for (const accountId of accountIds) {
      try {
        const ctx = await this.ctx(accountId);
        const adapter = this.registry.get(ctx.account.marketplace);
        out.push({
          accountId,
          marketplace: ctx.account.marketplace,
          capabilities: await adapter.capabilities(ctx),
        });
      } catch (err) {
        out.push({
          accountId,
          marketplace: "unknown",
          capabilities: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
}
