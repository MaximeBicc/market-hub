import type {
  CanonicalOrderEvent,
  CapabilitySet,
  FulfillmentInput,
  Listing,
  Money,
  Product,
  RemoteListing,
  TargetResult,
} from "../domain/types.js";
import type {
  MarketplaceAdapter,
  MarketplaceContext,
  PollResult,
} from "../ports/marketplace.js";

/**
 * Adaptateur Shopify — API GraphQL Admin.
 *
 * AUTHENTIFICATION : « client credentials », et non plus jeton permanent.
 *
 * Depuis le 1er janvier 2026, Shopify ne permet plus de créer d'application
 * personnalisée depuis l'administration d'une boutique. Les jetons `shpat_`
 * permanents n'existent que pour les applications créées avant cette date.
 * Toute nouvelle application se crée dans le Dev Dashboard, qui fournit un
 * ID client et un secret — à échanger contre un jeton d'accès valable
 * environ 24 heures.
 *
 * Identifiants attendus : { shopDomain, clientId, clientSecret }
 *   shopDomain    « maboutique.myshopify.com »
 *   clientId      Dev Dashboard → Paramètres → Identifiants
 *   clientSecret  idem
 *
 * L'adaptateur obtient et renouvelle le jeton lui-même, et le mémorise via
 * `saveCredentials`. Sans cette mise en cache, chaque commande consommerait
 * un aller-retour réseau supplémentaire pour redemander un jeton encore valide.
 *
 * DÉBIT : Shopify facture un COÛT par requête GraphQL, pas un nombre de
 * requêtes — un seau percé restitué à 100 points/seconde. Le coût réel
 * revient dans `extensions.cost`, et une requête trop lourde est rejetée
 * même si l'on en a fait très peu. C'est pour cela que les pages sont
 * volontairement petites.
 */

const API_VERSION = "2026-01";

/** Marge de sécurité : on renouvelle avant l'expiration réelle. */
const TOKEN_SKEW_SEC = 300;

function shopDomainOf(ctx: MarketplaceContext): string {
  const d =
    ctx.credentials?.["shopDomain"] ?? ctx.account.externalAccountId ?? "";
  if (!d) throw new Error("Shopify : domaine de boutique manquant");
  return d;
}

/**
 * Obtient un jeton d'accès valide, en le renouvelant si nécessaire.
 *
 * Le jeton dure environ 24 heures. On le conserve chiffré avec les autres
 * identifiants, avec sa date d'expiration : tant qu'il est valable, aucun
 * appel réseau supplémentaire n'est fait.
 */
async function accessToken(ctx: MarketplaceContext): Promise<string> {
  const c = ctx.credentials ?? {};
  const now = Math.floor(Date.now() / 1000);

  const cached = c["accessToken"];
  const expiresAt = Number(c["accessTokenExpiresAt"] ?? 0);
  if (cached && expiresAt > now + TOKEN_SKEW_SEC) return cached;

  const clientId = c["clientId"] ?? "";
  const clientSecret = c["clientSecret"] ?? "";
  if (!clientId || !clientSecret) {
    // Cas d'une application créée avant 2026 : le jeton permanent reste
    // valable, il n'y a simplement rien à renouveler.
    if (cached) return cached;
    throw new Error(
      "Shopify : identifiants manquants (clientId et clientSecret requis)",
    );
  }

  const res = await fetch(
    `https://${shopDomainOf(ctx)}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      res.status === 401 || res.status === 400
        ? "identifiants refusés. Vérifiez l'ID client, le secret, et que l'application est bien installée sur la boutique."
        : `échange de jeton refusé (${res.status}) ${body.slice(0, 150)}`,
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) throw new Error("Shopify : jeton absent de la réponse");

  await ctx.saveCredentials?.({
    accessToken: json.access_token,
    accessTokenExpiresAt: String(now + (json.expires_in ?? 86_400)),
    ...(json.scope ? { scope: json.scope } : {}),
  });

  return json.access_token;
}

/**
 * Shopify n'a pas UNE forme d'erreur, il en a deux.
 *
 * Erreur GraphQL (requête acceptée mais invalide) : `errors` est un TABLEAU
 * d'objets. Erreur d'authentification ou d'autorisation : `errors` est une
 * simple CHAÎNE, par exemple « [API] Invalid API key or access token ».
 *
 * Supposer le tableau fait planter le code sur le cas d'erreur le plus
 * fréquent — un jeton invalide — et remplace un message clair par une erreur
 * interne incompréhensible.
 */
interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }> | string;
}

/** Erreurs métier renvoyées dans le corps d'une mutation Shopify. */
interface UserError {
  field?: string[] | null;
  message: string;
}

export class ShopifyAdapter implements MarketplaceAdapter {
  readonly id = "shopify";

  capabilities(): CapabilitySet {
    return {
      listingCreate: true,
      listingUpdate: true,
      listingActivate: true,
      listingDeactivate: true,
      stockRead: true,
      stockWrite: true,
      priceRead: true,
      priceWrite: true,
      ordersRead: true,
      ordersFulfill: true,
      trackingWrite: true,
      // Shopify pousse des webhooks fiables ET permet le relevé : on garde
      // les deux, le relevé servant de filet si un webhook se perd.
      inboundSales: "both",
    };
  }

  /* ---------------------------------------------------------------- */

  private async gql<T>(
    ctx: MarketplaceContext,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const token = await accessToken(ctx);
    const http = ctx.http ?? fetch;

    const res = await http(
      `https://${shopDomainOf(ctx)}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    // Le fetch instrumenté lève déjà sur un code HTTP anormal, mais le fetch
    // nu utilisé lors d'un test de connexion ne le fait pas : on vérifie ici.
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = body.slice(0, 200).trim();
      throw new Error(
        res.status === 401 || res.status === 403
          ? "jeton refusé (401). Vérifiez le jeton d'accès Admin API et les portées accordées."
          : `réponse ${res.status}${detail ? ` — ${detail}` : ""}`,
      );
    }

    const json = (await res.json()) as GqlResponse<T>;

    if (typeof json.errors === "string") {
      throw new Error(json.errors);
    }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      const throttled = json.errors.some(
        (e) => e.extensions?.code === "THROTTLED",
      );
      throw new Error(
        `${throttled ? "Débit Shopify saturé — " : ""}${json.errors
          .map((e) => e.message)
          .join(" ; ")}`,
      );
    }
    if (!json.data) throw new Error("réponse sans données");
    return json.data;
  }

  /**
   * Les mutations Shopify n'échouent pas en HTTP : elles répondent 200 avec
   * un tableau `userErrors`. Ne pas le lire ferait passer un refus (prix
   * invalide, SKU en double) pour une réussite.
   */
  private assertNoUserErrors(errors: UserError[] | undefined, what: string) {
    if (errors && errors.length > 0) {
      throw new Error(
        `Shopify — ${what} : ${errors
          .map((e) => `${e.field?.join(".") ?? ""} ${e.message}`.trim())
          .join(" ; ")}`,
      );
    }
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
    const d = await this.gql<{ shop: { name: string; myshopifyDomain: string } }>(
      ctx,
      `query { shop { name myshopifyDomain } }`,
    );
    if (!d.shop?.myshopifyDomain) {
      throw new Error("Shopify : la boutique n'a pas répondu");
    }
  }

  /**
   * Emplacement de stock par défaut.
   *
   * Shopify rattache tout inventaire à un emplacement ; sans lui, aucune
   * écriture de stock n'est possible. On prend le premier emplacement actif,
   * sauf si le compte en désigne un explicitement — utile pour une boutique
   * qui gère plusieurs entrepôts.
   */
  private async primaryLocationId(ctx: MarketplaceContext): Promise<string> {
    const configured = ctx.credentials?.["locationId"];
    if (configured) return configured;

    const d = await this.gql<{
      locations: {
        nodes: Array<{ id: string | null; isActive: boolean }>;
      } | null;
    }>(ctx, `query { locations(first: 10) { nodes { id isActive } } }`);

    const nodes = d.locations?.nodes ?? [];
    // Un emplacement actif d'abord, à défaut n'importe lequel qui ait un
    // identifiant. Une boutique dont l'unique emplacement est marqué inactif
    // porte quand même du stock : refuser d'écrire dans ce cas ne protège de
    // rien et laisse le stock diverger en silence.
    const choisi =
      nodes.find((l) => l.isActive && l.id) ?? nodes.find((l) => l.id);

    if (!choisi?.id) {
      throw new Error(
        "Shopify : aucun emplacement de stock lisible. L'application a-t-elle la portée « read_locations » ?",
      );
    }

    // Mémorisé avec les identifiants. Deux raisons : la valeur est stable, et
    // la relire avant chaque écriture coûte une requête par propagation. Sans
    // ce cache, une lecture qui échoue une fois bloque l'écriture de stock —
    // c'est précisément le mode de panne observé en production, où la
    // propagation échouait sur un `locationId` nul.
    await ctx.saveCredentials?.({ locationId: choisi.id });
    return choisi.id;
  }

  /* ---------------------------------------------------------------- */

  async createListing(
    ctx: MarketplaceContext,
    product: Product,
    // Shopify n'offre pas de clé d'idempotence native sur ces mutations :
    // le paramètre est accepté pour respecter le contrat, la protection
    // contre les doublons se fait en amont, dans le journal de commandes.
    _idempotencyKey: string,
  ): Promise<TargetResult> {
    // Depuis l'API 2024-04, `productCreate` n'accepte plus les variantes :
    // il faut créer le produit, puis mettre à jour sa variante par défaut.
    const created = await this.gql<{
      productCreate: {
        product: { id: string; variants: { nodes: Array<{ id: string }> } };
        userErrors: UserError[];
      };
    }>(
      ctx,
      `mutation Create($input: ProductInput!) {
        productCreate(input: $input) {
          product { id variants(first: 1) { nodes { id } } }
          userErrors { field message }
        }
      }`,
      {
        input: {
          title: product.title,
          descriptionHtml: product.description ?? "",
          // Créé en brouillon : publier automatiquement une annonce que
          // personne n'a relue est le genre d'automatisme qu'on regrette.
          status: "DRAFT",
          tags: product.tags ?? [],
        },
      },
    );
    this.assertNoUserErrors(created.productCreate.userErrors, "création du produit");

    const productId = created.productCreate.product.id;
    const variantId = created.productCreate.product.variants.nodes[0]?.id;
    if (!variantId) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "pending_remote",
        remoteId: productId,
        message: "Produit créé, variante par défaut introuvable",
      };
    }

    const updated = await this.gql<{
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string; inventoryItem: { id: string } }>;
        userErrors: UserError[];
      };
    }>(
      ctx,
      `mutation Variant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id inventoryItem { id } }
          userErrors { field message }
        }
      }`,
      {
        productId,
        variants: [
          {
            id: variantId,
            price: (product.price.amount / 100).toFixed(2),
            inventoryItem: { sku: product.sku, tracked: true },
          },
        ],
      },
    );
    this.assertNoUserErrors(
      updated.productVariantsBulkUpdate.userErrors,
      "mise à jour de la variante",
    );

    // L'identifiant retenu est celui de la VARIANTE : c'est lui que portent
    // les lignes de commande, donc lui qui permet de rattacher une vente.
    return this.ok(
      ctx,
      variantId,
      "Créé en brouillon — à publier depuis l'admin Shopify après relecture",
    );
  }

  async updatePrice(
    ctx: MarketplaceContext,
    listing: Listing,
    price: Money,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const productId = listing.marketplaceData?.["productId"] as string | undefined;
    if (!productId) {
      // `productVariantsBulkUpdate` exige le produit parent : sans lui, on ne
      // peut rien écrire. Il est mémorisé à la synchronisation du catalogue.
      const found = await this.gql<{
        productVariant: { product: { id: string } } | null;
      }>(
        ctx,
        `query Parent($id: ID!) { productVariant(id: $id) { product { id } } }`,
        { id: listing.remoteId },
      );
      const parent = found.productVariant?.product.id;
      if (!parent) throw new Error("Shopify : variante introuvable");
      return this.applyPrice(ctx, parent, listing.remoteId!, price);
    }
    return this.applyPrice(ctx, productId, listing.remoteId!, price);
  }

  private async applyPrice(
    ctx: MarketplaceContext,
    productId: string,
    variantId: string,
    price: Money,
  ): Promise<TargetResult> {
    const d = await this.gql<{
      productVariantsBulkUpdate: { userErrors: UserError[] };
    }>(
      ctx,
      `mutation Price($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
      {
        productId,
        variants: [{ id: variantId, price: (price.amount / 100).toFixed(2) }],
      },
    );
    this.assertNoUserErrors(d.productVariantsBulkUpdate.userErrors, "prix");
    return this.ok(ctx, variantId);
  }

  async updateStock(
    ctx: MarketplaceContext,
    listing: Listing,
    stock: number,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    let inventoryItemId = listing.marketplaceData?.["inventoryItemId"] as
      | string
      | undefined;

    if (!inventoryItemId) {
      const d = await this.gql<{
        productVariant: { inventoryItem: { id: string } } | null;
      }>(
        ctx,
        `query Inv($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`,
        { id: listing.remoteId },
      );
      inventoryItemId = d.productVariant?.inventoryItem.id;
      if (!inventoryItemId) {
        throw new Error("Shopify : article d'inventaire introuvable");
      }
    }

    const locationId = await this.primaryLocationId(ctx);

    const d = await this.gql<{
      inventorySetQuantities: { userErrors: UserError[] };
    }>(
      ctx,
      `mutation Stock($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { field message } }
      }`,
      {
        input: {
          name: "available",
          reason: "correction",
          // Sans cette option, Shopify refuse l'écriture si la quantité a
          // changé entre-temps. Notre source de vérité est le stock central,
          // donc on impose la valeur plutôt que de négocier.
          ignoreCompareQuantity: true,
          quantities: [{ inventoryItemId, locationId, quantity: stock }],
        },
      },
    );
    this.assertNoUserErrors(d.inventorySetQuantities.userErrors, "stock");
    return this.ok(ctx, listing.remoteId);
  }

  async activateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    return this.setStatus(ctx, listing, "ACTIVE");
  }

  async deactivateListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    return this.setStatus(ctx, listing, "DRAFT");
  }

  private async setStatus(
    ctx: MarketplaceContext,
    listing: Listing,
    status: "ACTIVE" | "DRAFT",
  ): Promise<TargetResult> {
    let productId = listing.marketplaceData?.["productId"] as string | undefined;
    if (!productId) {
      const found = await this.gql<{
        productVariant: { product: { id: string } } | null;
      }>(
        ctx,
        `query Parent($id: ID!) { productVariant(id: $id) { product { id } } }`,
        { id: listing.remoteId },
      );
      productId = found.productVariant?.product.id;
      if (!productId) throw new Error("Shopify : produit introuvable");
    }

    const d = await this.gql<{ productUpdate: { userErrors: UserError[] } }>(
      ctx,
      `mutation Status($input: ProductInput!) {
        productUpdate(input: $input) { userErrors { field message } }
      }`,
      { input: { id: productId, status } },
    );
    this.assertNoUserErrors(d.productUpdate.userErrors, "statut");
    return this.ok(ctx, listing.remoteId);
  }

  /* ---------------------------------------------------------------- */
  /* Expédition                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Shopify n'expédie pas une commande directement : il faut passer par ses
   * « fulfillment orders », qui découpent la commande par lieu d'expédition.
   * On récupère donc ceux qui restent ouverts, puis on les remplit.
   */
  async markShipped(
    ctx: MarketplaceContext,
    input: FulfillmentInput,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const d = await this.gql<{
      order: {
        fulfillmentOrders: {
          nodes: Array<{ id: string; status: string }>;
        };
      } | null;
    }>(
      ctx,
      `query FO($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 10, query: "status:open OR status:in_progress") {
            nodes { id status }
          }
        }
      }`,
      { id: input.remoteOrderId },
    );

    const open = d.order?.fulfillmentOrders.nodes ?? [];
    if (open.length === 0) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "success",
        remoteId: input.remoteOrderId,
        message: "Rien à expédier : la commande est déjà entièrement traitée",
      };
    }

    const trackingInfo =
      input.trackingNumber || input.trackingUrl || input.carrier
        ? {
            ...(input.trackingNumber ? { number: input.trackingNumber } : {}),
            ...(input.carrier ? { company: input.carrier } : {}),
            ...(input.trackingUrl ? { url: input.trackingUrl } : {}),
          }
        : undefined;

    const res = await this.gql<{
      fulfillmentCreate: {
        fulfillment: { id: string } | null;
        userErrors: UserError[];
      };
    }>(
      ctx,
      `mutation Ship($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id }
          userErrors { field message }
        }
      }`,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: open.map((fo) => ({
            fulfillmentOrderId: fo.id,
          })),
          ...(trackingInfo ? { trackingInfo } : {}),
          notifyCustomer: input.notifyBuyer ?? true,
        },
      },
    );
    this.assertNoUserErrors(res.fulfillmentCreate.userErrors, "expédition");

    return this.ok(
      ctx,
      res.fulfillmentCreate.fulfillment?.id ?? input.remoteOrderId,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Ventes entrantes                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Lit le catalogue par VARIANTES et non par produits.
   *
   * Un produit Shopify porte plusieurs variantes (tailles, coloris), et c'est
   * la variante qui a un SKU, un prix et un stock. Lire au niveau produit
   * ferait perdre la granularité sur laquelle repose tout le rapprochement.
   *
   * L'identifiant produit parent est mémorisé dans `marketplaceData` : les
   * écritures de prix et de statut en ont besoin, et le relire à chaque fois
   * coûterait une requête supplémentaire par annonce.
   */
  async fetchListings(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<{ items: RemoteListing[]; cursor?: string | undefined }> {
    const d = await this.gql<{
      productVariants: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          sku: string | null;
          title: string;
          price: string;
          inventoryQuantity: number | null;
          inventoryItem: { id: string } | null;
          product: {
            id: string;
            title: string;
            status: string;
            onlineStoreUrl: string | null;
            featuredMedia: { preview: { image: { url: string } | null } | null } | null;
          } | null;
        }>;
      };
    }>(
      ctx,
      `query Catalogue($cursor: String) {
        productVariants(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id sku title price inventoryQuantity
            inventoryItem { id }
            product {
              id title status onlineStoreUrl
              featuredMedia { preview { image { url } } }
            }
          }
        }
      }`,
      { cursor: cursor ?? null },
    );

    const currency = ctx.credentials?.["currency"] ?? "EUR";

    const items: RemoteListing[] = d.productVariants.nodes.map((v) => {
      const qty = v.inventoryQuantity ?? 0;
      const active = v.product?.status === "ACTIVE";
      return {
        remoteId: v.id,
        sku: v.sku || null,
        // « Default Title » est le libellé d'une variante unique : l'afficher
        // ferait apparaître « Sac — Default Title » dans toute l'interface.
        title:
          v.title && v.title !== "Default Title"
            ? `${v.product?.title ?? ""} — ${v.title}`
            : (v.product?.title ?? v.sku ?? v.id),
        price: {
          amount: Math.round(Number(v.price) * 100),
          currency,
        },
        stock: qty,
        status: active ? (qty > 0 ? "active" : "sold") : "draft",
        url: v.product?.onlineStoreUrl ?? undefined,
        imageUrl: v.product?.featuredMedia?.preview?.image?.url ?? undefined,
        marketplaceData: {
          productId: v.product?.id,
          inventoryItemId: v.inventoryItem?.id,
        },
      };
    });

    return {
      items,
      cursor: d.productVariants.pageInfo.hasNextPage
        ? (d.productVariants.pageInfo.endCursor ?? undefined)
        : undefined,
    };
  }

  async pollOrderEvents(
    ctx: MarketplaceContext,
    cursor?: string,
  ): Promise<PollResult> {
    const d = await this.gql<{
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          createdAt: string;
          displayFinancialStatus: string;
          cancelledAt: string | null;
          lineItems: {
            nodes: Array<{
              quantity: number;
              sku: string | null;
              variant: { id: string } | null;
            }>;
          };
        }>;
      };
    }>(
      ctx,
      // Page volontairement petite : le coût GraphQL de Shopify croît avec
      // le nombre de nœuds demandés, et une requête trop lourde est rejetée.
      `query Orders($cursor: String) {
        orders(first: 25, after: $cursor, sortKey: PROCESSED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id createdAt displayFinancialStatus cancelledAt
            lineItems(first: 25) {
              nodes { quantity sku variant { id } }
            }
          }
        }
      }`,
      { cursor: cursor ?? null },
    );

    const events: CanonicalOrderEvent[] = d.orders.nodes.map((o) => ({
      marketplace: "shopify",
      accountId: ctx.account.id,
      remoteOrderId: o.id,
      // Le relevé n'a pas d'identifiant d'événement propre : on en fabrique un
      // stable à partir de la commande et de son état, afin que la même
      // commande relue deux fois soit vue comme un doublon.
      eventId: `poll:${o.id}:${o.cancelledAt ? "cancelled" : o.displayFinancialStatus}`,
      kind: o.cancelledAt
        ? "cancelled"
        : o.displayFinancialStatus === "REFUNDED"
          ? "returned"
          : "paid",
      occurredAt: o.createdAt,
      lines: o.lineItems.nodes.map((l) => ({
        sku: l.sku ?? undefined,
        quantity: l.quantity,
        remoteListingId: l.variant?.id ?? undefined,
      })),
      raw: o,
    }));

    return {
      events,
      cursor: d.orders.pageInfo.hasNextPage
        ? (d.orders.pageInfo.endCursor ?? undefined)
        : undefined,
    };
  }

  /**
   * Accès brut à l'API GraphQL, pour ce qui ne fait pas partie du contrat
   * commun — l'abonnement aux webhooks, notamment.
   *
   * Exposé plutôt que dupliqué : l'obtention du jeton, son renouvellement et
   * la lecture des DEUX formes d'erreur de Shopify vivent à un seul endroit,
   * et une opération hors contrat n'a aucune raison de les réécrire.
   */
  async rawGql<T>(
    ctx: MarketplaceContext,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    return this.gql<T>(ctx, query, variables);
  }

  /**
   * Les sujets qui obligent à relire le catalogue.
   *
   * `inventory_levels/update` est LE sujet qui répond au besoin : Shopify le
   * pousse dès qu'une quantité change, y compris quand elle est modifiée à la
   * main dans l'administration. C'est ce qui fait passer la détection de
   * quinze minutes à quelques secondes.
   */
  webhookResync(request: Request): string[] {
    const topic = request.headers.get("X-Shopify-Topic") ?? "";
    if (
      topic.startsWith("inventory_levels/") ||
      topic.startsWith("inventory_items/") ||
      topic.startsWith("products/")
    ) {
      return ["inventory"];
    }
    return [];
  }

  /**
   * Vérifie la signature HMAC puis traduit le webhook.
   *
   * Le corps BRUT est indispensable : un `JSON.parse` suivi d'un
   * `JSON.stringify` réordonne les clés et change les espaces, ce qui invalide
   * la signature. C'est l'erreur la plus courante sur les webhooks Shopify.
   */
  async verifyAndParseWebhook(
    ctx: MarketplaceContext,
    request: Request,
    rawBody: string,
  ): Promise<CanonicalOrderEvent[]> {
    const received = request.headers.get("X-Shopify-Hmac-Sha256");
    // Un webhook créé PAR L'APPLICATION est signé avec le secret client de
    // l'application, pas avec un secret propre à l'abonnement. Le repli évite
    // de redemander une valeur qu'on possède déjà — et c'est exactement ce
    // qu'il fallait pour activer le temps réel sans nouveau champ à saisir.
    const secret =
      ctx.credentials?.["webhookSecret"] || ctx.credentials?.["clientSecret"] || "";
    if (!received || !secret) {
      throw new Error("Shopify : signature ou secret de webhook manquant");
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(rawBody),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

    // Comparaison à temps constant : une comparaison naïve s'arrête au premier
    // octet différent, et le temps de réponse révèle alors la signature
    // attendue octet par octet.
    if (expected.length !== received.length) {
      throw new Error("Shopify : signature invalide");
    }
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
    }
    if (diff !== 0) throw new Error("Shopify : signature invalide");

    const topic = request.headers.get("X-Shopify-Topic") ?? "";
    const eventId = request.headers.get("X-Shopify-Webhook-Id") ?? "";
    if (!topic.startsWith("orders/") && !topic.startsWith("refunds/")) return [];

    const o = JSON.parse(rawBody) as Record<string, any>;

    const kind: CanonicalOrderEvent["kind"] = topic.startsWith("refunds/")
      ? "returned"
      : topic === "orders/cancelled"
        ? "cancelled"
        : "paid";

    return [
      {
        marketplace: "shopify",
        accountId: ctx.account.id,
        remoteOrderId: `gid://shopify/Order/${o.id ?? o.order_id}`,
        eventId: eventId || `${topic}:${o.id ?? o.order_id}`,
        kind,
        occurredAt: o.created_at ?? new Date().toISOString(),
        lines: (o.line_items ?? []).map((l: any) => ({
          sku: l.sku ?? undefined,
          quantity: l.quantity,
          remoteListingId: l.variant_id
            ? `gid://shopify/ProductVariant/${l.variant_id}`
            : undefined,
        })),
        raw: o,
      },
    ];
  }
}

/* ------------------------------------------------------------------ */
/* Abonnement aux webhooks                                             */
/* ------------------------------------------------------------------ */

/**
 * Les sujets auxquels s'abonner, et pourquoi chacun.
 *
 * `INVENTORY_LEVELS_UPDATE` est celui qui compte : Shopify le pousse dès
 * qu'une quantité bouge, y compris quand elle est saisie à la main dans
 * l'administration. C'est lui qui fait tomber la détection de quinze minutes
 * à quelques secondes.
 *
 * Les sujets de commande servent la propagation vers les autres canaux, et
 * `REFUNDS_CREATE` restitue le stock d'un article remboursé — sans lui, une
 * unité rendue reste invendable jusqu'au prochain rapprochement.
 */
export const SHOPIFY_WEBHOOK_TOPICS = [
  "INVENTORY_LEVELS_UPDATE",
  "PRODUCTS_UPDATE",
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
] as const;

export interface WebhookSyncReport {
  crees: string[];
  dejaLa: string[];
  echecs: Array<{ topic: string; message: string }>;
}

/**
 * Déclare nos webhooks chez Shopify, sans jamais en créer deux fois le même.
 *
 * Shopify n'a pas d'opération « créer ou remplacer » : recréer un abonnement
 * déjà présent le duplique, et chaque événement arrive alors en double. On
 * lit donc d'abord ce qui existe, et on ne crée que ce qui manque.
 *
 * Un abonnement pointant vers une AUTRE adresse pour le même sujet est laissé
 * intact : il appartient peut-être à une autre application installée sur la
 * boutique, et le supprimer casserait son fonctionnement.
 *
 * Demande la portée `write_webhooks` sur l'application. Sans elle, Shopify
 * refuse — et le message est explicite, contrairement à la plupart de ses
 * refus.
 */
export async function shopifyEnsureWebhooks(
  adapter: ShopifyAdapter,
  ctx: MarketplaceContext,
  callbackUrl: string,
): Promise<WebhookSyncReport> {
  if (!/^https:\/\//i.test(callbackUrl)) {
    throw new Error("Shopify : l'adresse de rappel doit être en HTTPS");
  }

  const existants = await adapter.rawGql<{
    webhookSubscriptions: {
      nodes: Array<{
        id: string;
        topic: string;
        endpoint: { callbackUrl?: string } | null;
      }>;
    };
  }>(
    ctx,
    `query { webhookSubscriptions(first: 100) {
       nodes {
         id topic
         endpoint { ... on WebhookHttpEndpoint { callbackUrl } }
       }
     } }`,
  );

  const deja = new Set(
    existants.webhookSubscriptions.nodes
      .filter((n) => n.endpoint?.callbackUrl === callbackUrl)
      .map((n) => n.topic),
  );

  const rapport: WebhookSyncReport = { crees: [], dejaLa: [], echecs: [] };

  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (deja.has(topic)) {
      rapport.dejaLa.push(topic);
      continue;
    }
    try {
      const r = await adapter.rawGql<{
        webhookSubscriptionCreate: {
          webhookSubscription: { id: string } | null;
          userErrors: Array<{ field?: string[] | null; message: string }>;
        };
      }>(
        ctx,
        `mutation Sub($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
           webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
             webhookSubscription { id }
             userErrors { field message }
           }
         }`,
        { topic, sub: { callbackUrl, format: "JSON" } },
      );

      const erreurs = r.webhookSubscriptionCreate.userErrors;
      if (erreurs.length > 0) {
        rapport.echecs.push({
          topic,
          message: erreurs.map((e) => e.message).join(" ; "),
        });
      } else {
        rapport.crees.push(topic);
      }
    } catch (err) {
      // L'échec d'un sujet ne doit pas empêcher les autres : mieux vaut le
      // temps réel sur cinq sujets sur six que rien du tout.
      rapport.echecs.push({
        topic,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return rapport;
}
