import type {
  CanonicalOrderEvent,
  CapabilitySet,
  FulfillmentInput,
  Listing,
  Money,
  Product,
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
 * AUTHENTIFICATION : jeton d'application personnalisée, pas OAuth.
 * Pour une boutique que l'on possède, une « custom app » créée dans
 * l'admin Shopify donne un jeton permanent qui n'expire jamais. OAuth
 * n'a de sens que pour une application distribuée à des tiers ; ici il
 * ajouterait un cycle de rafraîchissement à maintenir pour rien.
 *
 * Identifiants attendus : { shopDomain, accessToken }
 *   shopDomain   « maboutique.myshopify.com »
 *   accessToken  jeton Admin API commençant par « shpat_ »
 *
 * DÉBIT : Shopify facture un COÛT par requête GraphQL, pas un nombre de
 * requêtes — un seau percé restitué à 100 points/seconde. Le coût réel
 * revient dans `extensions.cost`, et une requête trop lourde est rejetée
 * même si l'on en a fait très peu. C'est pour cela que les pages sont
 * volontairement petites.
 */

const API_VERSION = "2026-01";

interface ShopifyCreds {
  shopDomain: string;
  accessToken: string;
}

function creds(ctx: MarketplaceContext): ShopifyCreds {
  const c = ctx.credentials ?? {};
  const shopDomain = c["shopDomain"] ?? ctx.account.externalAccountId ?? "";
  const accessToken = c["accessToken"] ?? "";
  if (!shopDomain || !accessToken) {
    throw new Error(
      "Shopify : identifiants manquants (shopDomain et accessToken requis)",
    );
  }
  return { shopDomain, accessToken };
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
    const { shopDomain, accessToken } = creds(ctx);
    const http = ctx.http ?? fetch;

    const res = await http(
      `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
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
      locations: { nodes: Array<{ id: string; isActive: boolean }> };
    }>(ctx, `query { locations(first: 5) { nodes { id isActive } } }`);

    const first = d.locations.nodes.find((l) => l.isActive);
    if (!first) throw new Error("Shopify : aucun emplacement de stock actif");
    return first.id;
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
    const secret = ctx.credentials?.["webhookSecret"] ?? "";
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
