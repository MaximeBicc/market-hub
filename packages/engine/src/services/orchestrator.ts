import type {
  AccountId,
  CapabilitySet,
  FulfillmentInput,
  Listing,
  Money,
  Product,
  ProductId,
  TargetResult,
  VariantId,
} from "../domain/types.js";
import type { MarketplaceContext } from "../ports/marketplace.js";
import type {
  AccountRepository,
  CredentialRepository,
  ListingRepository,
  InventoryRepository,
  ProductRepository,
  VariantRepository,
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
    private readonly variants: VariantRepository,
    private readonly inventory: InventoryRepository,
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
    // Copie MUTABLE : c'est elle que l'adaptateur relit, et elle doit
    // refléter un jeton renouvelé au cours de la même invocation.
    const credentials = { ...(await this.credentials.get(accountId)) };
    return {
      account,
      credentials,
      http: this.httpFor?.(account),
      // Fusion, jamais substitution : écrire le jeton dérivé ne doit pas
      // effacer l'ID client et le secret qui permettent de le renouveler.
      // Et mise à jour EN MÉMOIRE autant qu'en base — voir plus bas pourquoi
      // l'oublier condamnait Etsy.
      saveCredentials: async (patch) => {
        Object.assign(credentials, patch);
        await this.credentials.put(accountId, credentials);
      },
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
      /*
       * Retenue DÈS QUE le contexte est résolu, pour que l'échec sache de qui
       * il parle. Le bloc de secours écrivait « unknown » quelle que soit la
       * cause — y compris pour une erreur levée par l'adaptateur, où la
       * plateforme est parfaitement connue. L'écran de résultats retombait
       * alors sur son défaut et affichait « Shopify » sur une erreur d'eBay.
       */
      let marketplace = "unknown";
      try {
        const ctx = await this.ctx(accountId);
        marketplace = ctx.account.marketplace;

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
          marketplace,
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
    /**
     * Répétition : tout vérifier, n'écrire nulle part.
     *
     * Le même chemin que la vraie publication — chargement des variantes,
     * jointure du stock, préconditions de chaque module — arrêté juste avant
     * la première écriture. Le verdict rendu est donc celui qu'aurait donné
     * une vraie tentative, sans brouillon facturé chez Etsy ni offre orpheline
     * chez eBay.
     */
    dryRun?: boolean;
  }): Promise<CommandOutcome> {
    const product = await this.products.get(input.productId);
    if (!product) throw new Error(`Produit inconnu : ${input.productId}`);

    /*
     * CHARGER LES VARIANTES AVANT DE DIFFUSER.
     *
     * C'est ici que « un produit, dix-sept coloris » devient réel pour les
     * adaptateurs. Sans cette lecture, chacun ne verrait qu'un produit nu et
     * créerait dix-sept annonces séparées — ce qui viderait le plafond
     * vendeur eBay avec un seul objet, et présenterait à l'acheteur dix-sept
     * annonces quasi identiques.
     *
     * Les variantes archivées sont écartées : la plateforme ne les renvoie
     * plus, les republier ressusciterait un coloris retiré.
     */
    const actives = (await this.variants.listByProduct(input.productId)).filter(
      (v) => v.status === "active",
    );

    /*
     * LE STOCK DE CHAQUE VARIANTE, joint ici et nulle part ailleurs.
     *
     * Les trois adaptateurs lisent `variant.marketplaceData.stock` pour savoir
     * combien annoncer par coloris. Personne ne l'écrivait : la valeur vivait
     * dans la table d'inventaire, que l'orchestrateur ne consultait pas.
     *
     * Les conséquences n'étaient pas symétriques, ce qui les rendait
     * difficiles à voir : Shopify n'envoyait aucune quantité — dix-sept
     * coloris créés à zéro, invendables ; eBay posait zéro ; Etsy se rabattait
     * sur le stock du PARENT et l'annonçait sur chaque déclinaison, soit
     * deux cent quatre pièces en vente pour douze en stock.
     *
     * Un seul point de jonction, donc un seul endroit où cela peut être faux.
     */
    const variantes = await Promise.all(
      actives.map(async (v) => {
        const stock = (await this.inventory.get(v.id))?.onHand;
        return stock === undefined
          ? v
          : { ...v, marketplaceData: { ...(v.marketplaceData ?? {}), stock } };
      }),
    );

    const aDiffuser: Product = {
      ...product,
      ...(variantes.length > 0 ? { variants: variantes } : {}),
    };

    /*
     * IDEMPOTENCE — la vraie, pas celle qui transite sans servir.
     *
     * La clé d'idempotence est déclinée par compte et passée aux adaptateurs
     * depuis le premier jour. Aucun des trois ne s'en sert : rejouer une
     * création crée un second brouillon chez Etsy, une seconde offre chez
     * eBay. Or rejouer est le geste NATUREL — on publie vers trois comptes,
     * un échoue, on appuie à nouveau, et les deux qui avaient réussi se
     * dupliquent. Chez Etsy chaque publication est facturée.
     *
     * Le garde-fou ne consulte pas un journal mais l'état réel : une annonce
     * existe-t-elle déjà pour ce produit sur ce compte ? Si oui, il n'y a
     * rien à créer, et c'est un SUCCÈS — l'état voulu est atteint.
     */
    const deja = new Map(
      (await this.listings.listByProduct(input.productId)).map((l) => [
        l.accountId,
        l,
      ]),
    );

    const outcome = await this.fanOut(input.accountIds, "listingCreate", async (ctx, adapter) => {
      const existante = deja.get(ctx.account.id);
      if (existante) {
        const url = existante.marketplaceData?.["url"] as string | undefined;
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "success" as const,
          ...(existante.remoteId ? { remoteId: existante.remoteId } : {}),
          ...(url ? { url } : {}),
          marketplaceData: {
            ...(existante.marketplaceData ?? {}),
            alreadyActive: existante.status === "active",
          },
          message:
            "Déjà publié sur ce compte — rien à recréer. Utilisez « prix » ou « stock » pour le mettre à jour.",
        };
      }

      const result = await adapter.createListing(
        { ...ctx, ...(input.dryRun ? { dryRun: true } : {}) },
        aDiffuser,
        // La clé d'idempotence est déclinée par compte : rejouer la commande
        // ne doit pas créer un doublon chez la plateforme.
        `${input.idempotencyKey}:${ctx.account.id}`,
      );

      /*
       * En répétition, on ne consigne RIEN. Enregistrer une annonce qui
       * n'existe pas chez la plateforme ferait croire au garde-fou
       * ci-dessus qu'elle est déjà publiée, et la vraie publication serait
       * ensuite refusée comme un doublon — une vérification qui empêche ce
       * qu'elle devait préparer.
       */
      if (input.dryRun) return result;

      /*
       * CE QU'ON ÉCRIT LOCALEMENT DOIT ÊTRE VRAI.
       *
       * Cette ligne écrivait `status: "active"` alors que les trois
       * adaptateurs créent des BROUILLONS et le disent dans leur message. La
       * base affirmait donc « en ligne » ce qui ne l'était pas, et un
       * `setActive(false)` partait désactiver un objet jamais publié.
       *
       * `pending_remote` est enregistré lui aussi : l'objet existe chez la
       * plateforme, l'oublier reviendrait à le rendre invisible et
       * impilotable. Seuls `failed`, `unsupported` et `manual_required`
       * n'écrivent rien — dans ces trois cas rien n'a été créé.
       */
      const cree =
        (result.status === "success" || result.status === "pending_remote") &&
        Boolean(result.remoteId);

      if (cree) {
        await this.listings.put({
          id: crypto.randomUUID(),
          productId: product.id,
          accountId: ctx.account.id,
          remoteId: result.remoteId!,
          // Brouillon, parce que c'est ce que l'adaptateur a créé.
          status: "draft",
          price: product.price,
          stock: product.stock,
          // Les identifiants secondaires rendus par la plateforme — l'offerId
          // eBay notamment, sans lequel l'annonce serait impilotable.
          ...(result.marketplaceData
            ? { marketplaceData: result.marketplaceData }
            : {}),
        });
      }
      return result;
    });
    await this.report("createListing", input.idempotencyKey, input.productId, outcome);
    return outcome;
  }

  async setPrice(input: {
    productId: ProductId;
    /** L'unité visée, quand le produit en a plusieurs. */
    variantId?: VariantId | undefined;
    accountIds: AccountId[];
    price: Money;
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const outcome = await this.fanOut(input.accountIds, "priceWrite", async (ctx, adapter) => {
      // Même ciblage que pour le stock : l'annonce de CETTE unité, avec repli
      // sur la recherche large pour les annonces pas encore rapprochées.
      const listing = input.variantId
        ? ((await this.listings.findByProductVariantAndAccount(
            input.productId,
            input.variantId,
            ctx.account.id,
          )) ??
          (await this.listings.findByProductAndAccount(
            input.productId,
            ctx.account.id,
          )))
        : await this.listings.findByProductAndAccount(
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
      const unite = input.variantId
        ? await this.variants.get(input.variantId)
        : undefined;
      const r = await adapter.updatePrice(
        ctx,
        listing,
        input.price,
        `${input.idempotencyKey}:${ctx.account.id}`,
        unite,
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
    /**
     * L'unité visée. Sans elle, on écrirait le stock d'un coloris sur
     * l'annonce d'un autre — seize fois faux sur un produit à dix-sept
     * déclinaisons.
     */
    variantId?: VariantId | undefined;
    accountIds: AccountId[];
    stock: number;
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const outcome = await this.fanOut(input.accountIds, "stockWrite", async (ctx, adapter) => {
      /*
       * L'ANNONCE DE CETTE UNITÉ-LÀ, PAS UNE ANNONCE DU PRODUIT.
       *
       * `findByProductAndAccount` s'arrête à la première trouvée. Tant qu'un
       * produit n'avait qu'une annonce par boutique, c'était la bonne. Trois
       * produits du catalogue en portent aujourd'hui deux à trois sur la même
       * boutique — une par coloris — et la quantité du violet partait sur
       * l'annonce du noir. Sans erreur, sans trace, jusqu'à la survente.
       *
       * Le repli sur la recherche large couvre les annonces pas encore
       * rapprochées d'une variante : elles n'ont pas de `variantId`, et les
       * ignorer priverait de stock des annonces bien vivantes.
       */
      const listing = input.variantId
        ? ((await this.listings.findByProductVariantAndAccount(
            input.productId,
            input.variantId,
            ctx.account.id,
          )) ??
          (await this.listings.findByProductAndAccount(
            input.productId,
            ctx.account.id,
          )))
        : await this.listings.findByProductAndAccount(
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
      /*
       * L'unité voyage avec la commande.
       *
       * Le cœur sait QUELLE déclinaison a bougé ; les modules savent comment
       * leur plateforme la désigne — un SKU chez eBay, un identifiant
       * d'inventaire chez Shopify, une combinaison de propriétés chez Etsy.
       * Transmettre l'identité plutôt que la traduire ici est ce qui garde
       * ces trois façons de faire hors du cœur.
       */
      const unite = input.variantId
        ? await this.variants.get(input.variantId)
        : undefined;

      const r = await adapter.updateStock(
        ctx,
        listing,
        input.stock,
        `${input.idempotencyKey}:${ctx.account.id}`,
        unite,
      );
      if (r.status === "success") {
        await this.listings.put({ ...listing, stock: input.stock });
      }
      return r;
    });
    await this.report("setStock", input.idempotencyKey, input.productId, outcome);
    return outcome;
  }

  /**
   * Efface les annonces d'un produit chez les plateformes.
   *
   * Sert à la suppression d'un produit : une annonce laissée en ligne pour un
   * article qu'on ne suit plus est un objet achetable sans stock ni
   * expédition derrière lui.
   *
   * IRRÉVERSIBLE. Ce n'est pas `setActive(false)`, qui couche l'annonce en la
   * conservant — c'est le geste des ruptures de stock, où l'ancienneté et les
   * avis doivent survivre.
   *
   * Une plateforme qui ne sait pas effacer répond « unsupported » : à
   * l'appelant de se rabattre sur le retrait, plutôt que de laisser l'article
   * en vente sans le dire.
   */
  async deleteListings(input: {
    productId: ProductId;
    accountIds: AccountId[];
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const outcome = await this.fanOut(
      input.accountIds,
      "listingDelete",
      async (ctx, adapter) => {
        if (!adapter.deleteListing) {
          return {
            accountId: ctx.account.id,
            marketplace: ctx.account.marketplace,
            status: "unsupported" as const,
            message: `${ctx.account.marketplace} ne sait pas effacer une annonce`,
          };
        }

        const listings = await this.listings.listByProductAndAccount(
          input.productId,
          ctx.account.id,
        );
        if (listings.length === 0) {
          return {
            accountId: ctx.account.id,
            marketplace: ctx.account.marketplace,
            status: "unsupported" as const,
            message: "Aucune annonce pour ce produit sur ce compte",
          };
        }

        const resultats: TargetResult[] = [];
        for (const l of listings) {
          resultats.push(
            await adapter.deleteListing(
              ctx,
              l,
              `${input.idempotencyKey}:${ctx.account.id}:${l.id}`,
            ),
          );
          /*
           * La ligne locale part avec l'annonce distante.
           *
           * La garder décrirait un objet qui n'existe plus, et le prochain
           * relevé ne la corrigerait jamais : une annonce absente du catalogue
           * distant n'est plus jamais relue. C'est exactement l'état qui
           * rendait un article insupprimable.
           */
          if (resultats[resultats.length - 1]!.status === "success") {
            await this.listings.remove(l.id);
          }
        }

        // Un seul verdict pour le compte, et c'est le PIRE qui l'emporte :
        // annoncer « effacé » alors qu'une annonce sur trois est restée en
        // ligne laisserait un article achetable que plus rien ne suit.
        const rate = resultats.find(
          (x) => x.status !== "success" && x.status !== "unsupported",
        );
        return (
          rate ?? {
            accountId: ctx.account.id,
            marketplace: ctx.account.marketplace,
            status: "success",
            ...(listings.length > 1
              ? { message: `${listings.length} annonces effacées` }
              : {}),
          }
        );
      },
    );
    await this.report(
      "deleteListings",
      input.idempotencyKey,
      input.productId,
      outcome,
    );
    return outcome;
  }

  async setActive(input: {
    productId: ProductId;
    accountIds: AccountId[];
    active: boolean;
    /**
     * Les annonces à basculer, quand on ne veut pas toutes les basculer.
     *
     * Sert à REMETTRE en vente exactement ce qu'un épuisement avait couché, et
     * rien d'autre : sans ce filtre, un réapprovisionnement publierait au
     * passage le brouillon jamais relu qui dormait sur le même compte.
     *
     * Absent, le comportement ne change pas : toutes les annonces du produit.
     */
    listingIds?: readonly string[];
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const need: CapabilityKey = input.active
      ? "listingActivate"
      : "listingDeactivate";

    const outcome = await this.fanOut(input.accountIds, need, async (ctx, adapter) => {
      /*
       * TOUTES LES ANNONCES DU PRODUIT, PAS UNE SEULE.
       *
       * Retirer de la vente un article épuisé n'a de sens que si RIEN ne
       * reste achetable. N'en coucher qu'une laisserait les autres coloris en
       * ligne à stock nul — précisément la commande impossible à honorer que
       * cette commande cherche à éviter.
       *
       * Une annonce eBay à déclinaisons ne compte que pour une ligne ici :
       * c'est l'adaptateur qui sait qu'elle se retire d'un seul tenant.
       */
      const toutes = await this.listings.listByProductAndAccount(
        input.productId,
        ctx.account.id,
      );
      const listings = input.listingIds
        ? toutes.filter((l) => input.listingIds!.includes(l.id))
        : toutes;
      if (listings.length === 0) {
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message: "Aucune annonce pour ce produit sur ce compte",
        };
      }

      const resultats: TargetResult[] = [];
      for (const l of listings) {
        const cle = `${input.idempotencyKey}:${ctx.account.id}:${l.id}`;
        resultats.push(
          input.active
            ? await adapter.activateListing(ctx, l, cle)
            : await adapter.deactivateListing(ctx, l, cle),
        );
        const dernier = resultats[resultats.length - 1]!;
        if (dernier.status === "success") {
          await this.listings.put({
            ...l,
            status: input.active ? "active" : "inactive",
            marketplaceData: {
              ...(l.marketplaceData ?? {}),
              ...(dernier.marketplaceData ?? {}),
              ...(dernier.url ? { url: dernier.url } : {}),
            },
          });
        }
      }

      /*
       * Un seul verdict pour le compte, et c'est le PIRE qui l'emporte.
       *
       * Annoncer « réussi » parce que deux annonces sur trois ont suivi
       * laisserait la troisième en vente sans que personne le sache.
       */
      const rate = resultats.find(
        (x) => x.status !== "success" && x.status !== "unsupported",
      );
      // L'état local a déjà été écrit annonce par annonce dans la boucle :
      // le refaire ici n'en couvrirait qu'une, et masquerait les autres.
      return (
        rate ?? {
          ...(resultats[0] ?? {}),
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "success",
          ...(listings.length > 1
            ? { message: `${listings.length} annonces basculées` }
            : {}),
        }
      );
    });
    await this.report("setActive", input.idempotencyKey, input.productId, outcome);
    return outcome;
  }

  /**
   * Marque une commande expédiée.
   *
   * Cible UNIQUE, contrairement aux commandes de catalogue : une commande
   * n'existe que sur la plateforme où elle a été passée. La diffuser vers
   * plusieurs comptes n'aurait aucun sens.
   */
  async fulfillOrder(input: {
    accountId: AccountId;
    fulfillment: FulfillmentInput;
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    const need: CapabilityKey = input.fulfillment.trackingNumber
      ? "trackingWrite"
      : "ordersFulfill";

    const outcome = await this.fanOut([input.accountId], need, (ctx, adapter) =>
      adapter.markShipped(
        ctx,
        input.fulfillment,
        `${input.idempotencyKey}:${ctx.account.id}`,
      ),
    );
    await this.report("fulfillOrder", input.idempotencyKey, null, outcome);
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
