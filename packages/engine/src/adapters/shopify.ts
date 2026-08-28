import type {
  CanonicalOrderEvent,
  CapabilitySet,
  FulfillmentInput,
  Listing,
  Money,
  OptionAxis,
  Product,
  RemoteListing,
  TargetResult,
  Variant,
  SignalWebhook,
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

/*
 * LIMITES DE SHOPIFY SUR LES DÉCLINAISONS — ce sont les siennes, pas les
 * nôtres. Les dépasser ne se rattrape pas côté client : la mutation est
 * refusée en bloc, et le produit reste sans aucune variante.
 */
/** Trois axes maximum (« Couleur », « Taille », « Matière »). */
const MAX_AXES = 3;
/** 2048 variantes maximum par produit. */
const MAX_VARIANTES = 2048;
/**
 * Taille d'un lot de création.
 *
 * Le budget est de 40 sous-requêtes par invocation et chaque appel en
 * consomme 2 : un produit à 2048 variantes tient en 9 lots (18 sous-requêtes),
 * ce qui laisse la place à la création du produit et à la lecture de
 * l'emplacement de stock. Des lots plus petits seraient plus sûrs vis-à-vis du
 * coût GraphQL, mais épuiseraient le budget avant la fin.
 */
const LOT_VARIANTES = 250;

/** Séparateur de clé interne — le caractère de contrôle « unit separator ». */
const SEP_OPTIONS = String.fromCharCode(31);

/** Prix Shopify : une chaîne décimale. Nos montants sont en centimes. */
function prixShopify(m: Money): string {
  return (m.amount / 100).toFixed(2);
}

/**
 * Le stock d'UNE variante — s'il est connu.
 *
 * `Variant` ne porte pas de quantité : le stock central est compté par
 * variante dans `InventoryItem`, et le contrat `createListing` ne reçoit que
 * le produit. L'appelant qui charge les variantes peut joindre la quantité
 * dans `marketplaceData` ; quand il ne le fait pas, on n'invente RIEN.
 *
 * Répartir `product.stock` entre les variantes serait le pire des choix : un
 * parent à dix-sept coloris verrait chaque coloris hériter du total, soit
 * dix-sept fois le stock réel mis en vente.
 */
function stockDeVariante(v: Variant): number | undefined {
  const brut = v.marketplaceData?.["stock"] ?? v.marketplaceData?.["onHand"];
  if (typeof brut !== "number" || !Number.isFinite(brut) || brut < 0) {
    return undefined;
  }
  return Math.trunc(brut);
}

/**
 * Clé de comparaison d'une combinaison d'options.
 *
 * Shopify renormalise ce qu'on lui envoie — espaces rognés, casse parfois
 * retouchée. Comparer les chaînes brutes ferait échouer le rapprochement entre
 * ce qu'on a demandé et ce qui a été créé, et on perdrait le lien entre nos
 * variantes locales et leurs identifiants distants.
 */
function cleOptions(valeurs: readonly string[]): string {
  // Séparateur non imprimable : sans lui, « rouge » + « xl » et « rougex » +
  // « l » donneraient la même clé, et deux variantes distinctes se
  // confondraient au moment du rapprochement.
  return valeurs.map((v) => v.trim().toLowerCase()).join(SEP_OPTIONS);
}

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

/**
 * L'objet visé n'existe plus chez Shopify.
 *
 * Shopify ne code pas ce cas : il le dit en anglais, dans `message`. Les deux
 * formulations relevées sont « Product does not exist » (mutation sur un
 * identifiant effacé) et « … not found ».
 */
function estIntrouvable(e: UserError): boolean {
  return /does not exist|not found/i.test(e.message);
}

export class ShopifyAdapter implements MarketplaceAdapter {
  readonly id = "shopify";

  capabilities(): CapabilitySet {
    return {
      listingCreate: true,
      listingUpdate: true,
      listingActivate: true,
      listingDeactivate: true,
      listingDelete: true,
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

  /**
   * LES PHOTOS PARTENT PAR LEUR ADRESSE.
   *
   * Shopify TÉLÉCHARGE l'image et en héberge sa propre copie — l'URL source
   * peut disparaître ensuite. C'est ce qui évite d'avoir à stocker quoi que
   * ce soit de notre côté quand la photo vient déjà d'ailleurs.
   *
   * Deux pièges documentés : le téléchargement est ASYNCHRONE, donc un
   * `userErrors` vide ne prouve pas que la photo est passée ; et le
   * récupérateur de Shopify est anonyme, donc une URL protégée contre les
   * liens directs échouera silencieusement.
   *
   * Les visuels PROPRES AUX VARIANTES sont joints à la même liste. Ils ne
   * sont pas rattachés à leur variante — le champ qui le permettrait n'a pas
   * été vérifié sur cette version d'API, et une supposition ferait rejeter
   * tout le lot. Sans ce versement, la photo du coloris violet n'existerait
   * nulle part chez Shopify et il faudrait la retéléverser à la main.
   */
  private mediaDe(
    product: Product,
    variantes: readonly Variant[],
  ): Array<{ originalSource: string; mediaContentType: string; alt: string }> {
    const vues = new Set<string>();
    const urls: string[] = [];
    for (const url of [
      ...(product.images ?? []),
      ...variantes.map((v) => v.imageUrl ?? ""),
    ]) {
      if (!url || vues.has(url)) continue;
      vues.add(url);
      urls.push(url);
    }
    return urls.slice(0, 250).map((url) => ({
      originalSource: url,
      mediaContentType: "IMAGE",
      alt: product.title.slice(0, 512),
    }));
  }

  /** Refus explicite : la plateforme ne peut pas, quelqu'un doit trancher. */
  private manuel(ctx: MarketplaceContext, message: string): TargetResult {
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "manual_required",
      message,
    };
  }

  async createListing(
    ctx: MarketplaceContext,
    product: Product,
    // Shopify n'offre pas de clé d'idempotence native sur ces mutations :
    // le paramètre est accepté pour respecter le contrat, la protection
    // contre les doublons se fait en amont, dans le journal de commandes.
    _idempotencyKey: string,
  ): Promise<TargetResult> {
    /*
     * UN PRODUIT, TOUTES SES DÉCLINAISONS, EN UNE FOIS.
     *
     * Créer dix-sept coloris comme dix-sept produits séparés serait une faute
     * de modèle : chez Shopify, ce sont dix-sept VARIANTES d'un même produit,
     * et c'est la variante que portent les lignes de commande. Publier à plat
     * casserait le rapprochement des ventes et afficherait dix-sept fiches
     * concurrentes dans la boutique.
     *
     * `archived` est exclu : la variante n'existe plus chez la plateforme
     * d'origine, la recréer ici ressusciterait un coloris retiré. L'ordre
     * d'affichage est celui de `position` — il détermine quelle variante
     * devient l'identifiant de rattachement.
     */
    const axes = (product.options ?? []).filter(
      (a) => a.name.trim() !== "" && a.values.length > 0,
    );
    const variantes = (product.variants ?? [])
      .filter((v) => v.status !== "archived")
      .sort((a, b) => a.position - b.position);

    // Sans axe ou sans variante, il n'y a rien à décliner : on reste sur le
    // chemin historique, qui crée un produit à variante unique. Ce cas couvre
    // tout le catalogue importé avant l'arrivée des déclinaisons, et il ne
    // doit surtout pas changer de comportement.
    if (axes.length > 0 && variantes.length > 0) {
      return this.creerAvecVariantes(ctx, product, axes, variantes);
    }

    // Depuis l'API 2024-04, `productCreate` n'accepte plus les variantes :
    // il faut créer le produit, puis mettre à jour sa variante par défaut.
    const media = this.mediaDe(product, []);

    const created = await this.gql<{
      productCreate: {
        product: { id: string; variants: { nodes: Array<{ id: string }> } };
        userErrors: UserError[];
      };
    }>(
      ctx,
      `mutation Create($input: ProductInput!, $media: [CreateMediaInput!]) {
        productCreate(input: $input, media: $media) {
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
        media,
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

    /*
     * À PARTIR D'ICI, LE PRODUIT EXISTE CHEZ SHOPIFY.
     *
     * Ce qui suit peut échouer — SKU en double, débit saturé, budget de
     * sous-requêtes épuisé. Laisser l'exception remonter faisait rapporter
     * « échec » et n'écrivait rien localement : le produit restait chez
     * Shopify, inconnu de l'outil, et le prochain essai en créait un second.
     *
     * On renvoie donc `pending_remote` avec l'identifiant : l'orchestrateur
     * l'enregistre, l'objet cesse d'être orphelin, et le message dit ce qu'il
     * reste à finir.
     */
    let updated: {
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string; inventoryItem: { id: string } }>;
        userErrors: UserError[];
      };
    };
    try {
      updated = await this.gql<{
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
            price: prixShopify(product.price),
            inventoryItem: { sku: product.sku, tracked: true },
          },
        ],
      },
    );
    } catch (err) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "pending_remote",
        remoteId: productId,
        marketplaceData: { productId },
        message: `Produit créé chez Shopify, mais SKU et prix non écrits (${err instanceof Error ? err.message : "échec"}). À finir depuis l'admin — ne relancez pas, il serait créé en double.`,
      };
    }

    this.assertNoUserErrors(
      updated.productVariantsBulkUpdate.userErrors,
      "mise à jour de la variante",
    );

    // L'identifiant retenu est celui de la VARIANTE : c'est lui que portent
    // les lignes de commande, donc lui qui permet de rattacher une vente.
    /*
     * LE STOCK, qui n'était jamais écrit.
     *
     * La variante était marquée `tracked: true` sans quantité : le produit
     * arrivait donc chez Shopify à zéro, invendable, et le rapprochement
     * voyait ensuite un écart qu'il « corrigeait » en adoptant ce zéro.
     *
     * L'échec est volontairement NON BLOQUANT : le produit existe déjà, et le
     * signaler vaut mieux que de faire croire que rien n'a été créé. Le
     * rapprochement de stock repassera de toute façon dans les deux minutes.
     */
    let noteStock = "";
    if (product.stock > 0) {
      try {
        await this.updateStock(
          ctx,
          {
            id: "",
            productId: product.id,
            accountId: ctx.account.id,
            remoteId: variantId,
            status: "draft",
            price: product.price,
            stock: product.stock,
            marketplaceData: {
              productId,
              inventoryItemId:
                updated.productVariantsBulkUpdate.productVariants[0]
                  ?.inventoryItem.id,
            },
          },
          product.stock,
        );
      } catch (err) {
        noteStock = ` · stock non écrit (${err instanceof Error ? err.message : "échec"})`;
      }
    }

    return {
      ...this.ok(
        ctx,
        variantId,
        `Créé en brouillon — à publier depuis l'admin Shopify après relecture${noteStock}`,
      ),
      marketplaceData: {
        productId,
        inventoryItemId:
          updated.productVariantsBulkUpdate.productVariants[0]?.inventoryItem.id,
      },
    };
  }

  /**
   * Crée le produit ET toutes ses déclinaisons, en deux temps.
   *
   * Shopify propose bien `productSet`, qui fait tout en un seul appel — mais
   * il REMPLACE les listes qu'on lui donne : options, variantes, médias. Le
   * jour où il servirait à mettre à jour un produit existant, tout ce qui
   * n'aurait pas été renvoyé serait supprimé chez Shopify. Pour une CRÉATION,
   * `productCreate` puis `productVariantsBulkCreate` coûte un appel de plus et
   * ne peut rien détruire : c'est le bon compromis ici.
   *
   * Deux pièges de forme, qui ne se voient qu'à l'exécution :
   *   — dans `productOptions`, la clé des valeurs est `values`, pas
   *     `optionValues` (ce dernier nom n'existe qu'à la création des VARIANTES);
   *   — le SKU d'une variante vit dans `inventoryItem.sku`, jamais au niveau
   *     de la variante elle-même.
   */
  private async creerAvecVariantes(
    ctx: MarketplaceContext,
    product: Product,
    axes: OptionAxis[],
    variantes: Variant[],
  ): Promise<TargetResult> {
    /*
     * TOUT CE QUI PEUT ÊTRE REFUSÉ EST VÉRIFIÉ AVANT LA MOINDRE ÉCRITURE.
     *
     * `productVariantsBulkCreate` rejette le LOT ENTIER sur une seule entrée
     * invalide. Découvrir le problème après `productCreate` laisserait un
     * produit sans aucune variante chez Shopify — invendable, et à nettoyer à
     * la main. Ces refus sont donc rendus en `manual_required` : la plateforme
     * ne peut pas décider à la place du vendeur, et rien n'a été créé.
     */
    if (axes.length > MAX_AXES) {
      return this.manuel(
        ctx,
        `Shopify n'accepte que ${MAX_AXES} axes de déclinaison ; ce produit en a ${axes.length} (${axes
          .map((a) => a.name)
          .join(", ")}). Rien n'a été créé.`,
      );
    }
    if (variantes.length > MAX_VARIANTES) {
      return this.manuel(
        ctx,
        `Shopify n'accepte que ${MAX_VARIANTES} variantes par produit ; ce produit en a ${variantes.length}. Rien n'a été créé.`,
      );
    }

    const incomplete = variantes.find(
      (v) =>
        v.optionValues.length !== axes.length ||
        v.optionValues.some((x) => x.trim() === ""),
    );
    if (incomplete) {
      return this.manuel(
        ctx,
        `La variante « ${incomplete.optionKey || incomplete.id} » ne porte pas une valeur par axe (${axes.length} attendue(s), ${incomplete.optionValues.length} fournie(s)). Shopify refuserait le produit entier. Rien n'a été créé.`,
      );
    }

    // Deux variantes sur la même combinaison : Shopify refuse le lot. Le
    // signaler ici nomme le doublon ; le laisser passer rendrait un message
    // d'API générique sur un produit déjà à moitié créé.
    const parCombinaison = new Map<string, Variant>();
    for (const v of variantes) {
      const cle = cleOptions(v.optionValues);
      if (parCombinaison.has(cle)) {
        return this.manuel(
          ctx,
          `Deux variantes portent la même combinaison « ${v.optionValues.join(" / ")} ». Shopify n'en accepte qu'une. Rien n'a été créé.`,
        );
      }
      parCombinaison.set(cle, v);
    }

    /*
     * Les valeurs déclarées sur l'axe, PLUS celles réellement portées par les
     * variantes.
     *
     * Une valeur utilisée par une variante mais absente de son axe fait
     * échouer la création de cette variante — et donc du lot. L'union évite ce
     * refus sans jamais inventer de valeur : tout ce qui est envoyé vient du
     * produit. L'ordre déclaré sur l'axe est conservé, il fixe l'affichage.
     */
    const valeursParAxe = axes.map((axe, i) => {
      const vues = new Set<string>();
      const ordre: string[] = [];
      for (const brut of [
        ...axe.values,
        ...variantes.map((v) => v.optionValues[i] ?? ""),
      ]) {
        const val = brut.trim();
        if (val === "") continue;
        const cle = val.toLowerCase();
        if (vues.has(cle)) continue;
        vues.add(cle);
        ordre.push(val);
      }
      return ordre;
    });

    const created = await this.gql<{
      productCreate: {
        product: { id: string } | null;
        userErrors: UserError[];
      };
    }>(
      ctx,
      `mutation CreateDecline($input: ProductInput!, $media: [CreateMediaInput!]) {
        productCreate(input: $input, media: $media) {
          product { id }
          userErrors { field message }
        }
      }`,
      {
        input: {
          title: product.title,
          descriptionHtml: product.description ?? "",
          // Brouillon, toujours. Publier engage une vente que personne n'a
          // relue — et sur les autres places, une mise en ligne facturée.
          status: "DRAFT",
          tags: product.tags ?? [],
          productOptions: axes.map((axe, i) => ({
            name: axe.name,
            position: i + 1,
            // `values`, et non `optionValues` : la faute la plus coûteuse ici,
            // parce que Shopify refuse la requête sans dire quel nom il attend.
            values: (valeursParAxe[i] ?? []).map((name) => ({ name })),
          })),
        },
        media: this.mediaDe(product, variantes),
      },
    );
    this.assertNoUserErrors(
      created.productCreate.userErrors,
      "création du produit à déclinaisons",
    );

    const productId = created.productCreate.product?.id;
    if (!productId) {
      throw new Error(
        "Shopify : produit créé sans identifiant renvoyé — rien à rattacher",
      );
    }

    /*
     * À PARTIR D'ICI, LE PRODUIT EXISTE CHEZ SHOPIFY.
     *
     * Tout échec ultérieur se rend en `pending_remote` AVEC l'identifiant :
     * l'orchestrateur l'enregistre, l'objet cesse d'être orphelin, et un
     * nouvel essai ne créera pas un second produit.
     */
    let locationId: string | undefined;
    let noteStock = "";
    try {
      locationId = await this.primaryLocationId(ctx);
    } catch (err) {
      // Non bloquant : mieux vaut des variantes créées sans quantité que pas
      // de variantes du tout. Le rapprochement de stock repassera.
      noteStock = ` · stock non écrit (${err instanceof Error ? err.message : "emplacement illisible"})`;
    }

    const sansStock = variantes.filter(
      (v) => stockDeVariante(v) === undefined,
    ).length;
    if (locationId && sansStock > 0) {
      noteStock = ` · quantité inconnue pour ${sansStock} variante(s), laissée au prochain rapprochement`;
    }

    /** Une entrée de `ProductVariantsBulkInput`. */
    const entree = (v: Variant) => {
      const quantite = stockDeVariante(v);
      return {
        // À la création des variantes, la clé EST `optionValues`, et chaque
        // valeur se rattache à son axe par `optionName`. C'est l'inverse du
        // vocabulaire de `productOptions` — l'API n'est pas symétrique.
        optionValues: v.optionValues.map((valeur, i) => ({
          optionName: axes[i]?.name ?? "",
          name: valeur.trim(),
        })),
        price: prixShopify(v.price),
        // Le SKU appartient à l'article d'inventaire, pas à la variante.
        inventoryItem: { tracked: true, ...(v.sku ? { sku: v.sku } : {}) },
        // Le stock de CHAQUE variante, écrit dans le même appel : une
        // quantité par variante, pas un total réparti au hasard. Le champ est
        // `availableQuantity` et il n'y a pas de champ `name` ici — contraire
        // à `productSet`, où c'est `{ name: "available", quantity }`.
        ...(locationId && quantite !== undefined
          ? {
              inventoryQuantities: [
                { locationId, availableQuantity: quantite },
              ],
            }
          : {}),
      };
    };

    type ReponseLot = {
      productVariantsBulkCreate: {
        productVariants: Array<{
          id: string;
          selectedOptions: Array<{ name: string; value: string }>;
          inventoryItem: { id: string } | null;
        }> | null;
        userErrors: UserError[];
      };
    };

    /** Ce que Shopify a réellement créé, indexé par combinaison d'options. */
    const distantes = new Map<string, { id: string; inventoryItemId?: string }>();

    const partiel = (raison: string): TargetResult => ({
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "pending_remote",
      remoteId: productId,
      marketplaceData: {
        productId,
        variants: [...distantes.entries()].map(([, d]) => ({ id: d.id })),
      },
      message: `Produit créé chez Shopify avec ${distantes.size}/${variantes.length} variantes, puis ${raison}. À finir depuis l'admin — ne relancez pas, il serait créé en double.`,
    });

    for (let i = 0; i < variantes.length; i += LOT_VARIANTES) {
      const lot = variantes.slice(i, i + LOT_VARIANTES);
      let res: ReponseLot;
      try {
        res = await this.gql<ReponseLot>(
          ctx,
          `mutation Variantes(
             $productId: ID!,
             $variants: [ProductVariantsBulkInput!]!,
             $strategy: ProductVariantsBulkCreateStrategy
           ) {
            productVariantsBulkCreate(
              productId: $productId, variants: $variants, strategy: $strategy
            ) {
              productVariants {
                id
                selectedOptions { name value }
                inventoryItem { id }
              }
              userErrors { field message }
            }
          }`,
          {
            productId,
            variants: lot.map(entree),
            // Au PREMIER lot seulement. `productCreate` a fabriqué une
            // variante par défaut « Default Title » ; sans cette stratégie
            // elle traîne à côté des vraies déclinaisons, achetable et sans
            // SKU. Aux lots suivants elle n'existe plus, et redemander sa
            // suppression ferait échouer l'appel.
            strategy: i === 0 ? "REMOVE_STANDALONE_VARIANT" : "DEFAULT",
          },
        );
        this.assertNoUserErrors(
          res.productVariantsBulkCreate.userErrors,
          "création des variantes",
        );
      } catch (err) {
        return partiel(err instanceof Error ? err.message : "échec");
      }

      for (const pv of res.productVariantsBulkCreate.productVariants ?? []) {
        // On retrouve NOTRE variante par sa combinaison d'options, pas par
        // l'ordre du tableau : Shopify ne garantit pas de renvoyer les
        // variantes dans l'ordre où on les a envoyées.
        const cle = cleOptions((pv.selectedOptions ?? []).map((o) => o.value));
        distantes.set(cle, {
          id: pv.id,
          ...(pv.inventoryItem ? { inventoryItemId: pv.inventoryItem.id } : {}),
        });
      }
    }

    /*
     * CE QUE LE RAPPROCHEMENT LOCAL A BESOIN DE SAVOIR.
     *
     * `optionKey` est notre identité de repli quand le SKU manque — et il
     * manque presque toujours chez Shopify. Rendre la liste { id, optionKey }
     * permet de coller chaque variante locale à son identifiant distant sans
     * relire le catalogue.
     */
    const rendu: Array<{
      id: string;
      optionKey: string;
      sku?: string;
      inventoryItemId?: string;
    }> = [];
    for (const v of variantes) {
      const d = distantes.get(cleOptions(v.optionValues));
      if (!d) continue;
      rendu.push({
        id: d.id,
        optionKey: v.optionKey,
        ...(v.sku ? { sku: v.sku } : {}),
        ...(d.inventoryItemId ? { inventoryItemId: d.inventoryItemId } : {}),
      });
    }

    if (rendu.length === 0) {
      return partiel("aucune variante n'a pu être rattachée");
    }

    // L'identifiant retenu est celui de la PREMIÈRE variante : c'est un
    // identifiant de variante que portent les lignes de commande, donc le seul
    // qui permette de rattacher une vente. Le produit parent, lui, voyage dans
    // `marketplaceData`.
    const premiere = rendu[0]!;
    const manquantes = variantes.length - rendu.length;

    const marketplaceData = {
      productId,
      ...(premiere.inventoryItemId
        ? { inventoryItemId: premiere.inventoryItemId }
        : {}),
      variants: rendu,
    };

    if (manquantes > 0) {
      return {
        accountId: ctx.account.id,
        marketplace: ctx.account.marketplace,
        status: "pending_remote",
        remoteId: premiere.id,
        marketplaceData,
        message: `Créé en brouillon, mais ${manquantes} variante(s) sur ${variantes.length} n'ont pas été rattachées — à vérifier dans l'admin Shopify${noteStock}`,
      };
    }

    return {
      ...this.ok(
        ctx,
        premiere.id,
        `Créé en brouillon avec ${rendu.length} variante(s) — à publier depuis l'admin Shopify après relecture${noteStock}`,
      ),
      marketplaceData,
    };
  }

  async updatePrice(
    ctx: MarketplaceContext,
    listing: Listing,
    price: Money,
    _idempotencyKey?: string,
    unite?: Variant,
  ): Promise<TargetResult> {
    /*
     * Chez Shopify le prix vit sur la VARIANTE, pas sur le produit.
     *
     * `remoteId` porte la première : suffisant pour une annonce synchronisée,
     * qui a une ligne par coloris, faux pour une annonce créée par l'outil
     * dont une seule ligne porte les dix-sept variantes distantes.
     */
    let variantId = listing.remoteId;
    const declinaisons = listing.marketplaceData?.["variants"];
    if (Array.isArray(declinaisons) && declinaisons.length > 1) {
      if (!unite) {
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message:
            "Annonce à déclinaisons : impossible d'écrire un prix sans savoir quel coloris est visé.",
        };
      }
      const lignes = declinaisons as Array<{
        id?: string;
        optionKey?: string;
        sku?: string;
      }>;
      const trouvee =
        lignes.find((l) => l.optionKey && l.optionKey === unite.optionKey) ??
        (unite.sku ? lignes.find((l) => l.sku === unite.sku) : undefined);
      if (!trouvee?.id) {
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message: `Déclinaison « ${unite.optionKey || unite.sku || unite.id} » introuvable dans l'annonce Shopify. Relancez une synchronisation du catalogue.`,
        };
      }
      variantId = trouvee.id;
    }

    const productId = listing.marketplaceData?.["productId"] as string | undefined;
    if (!productId) {
      // `productVariantsBulkUpdate` exige le produit parent : sans lui, on ne
      // peut rien écrire. Il est mémorisé à la synchronisation du catalogue.
      const found = await this.gql<{
        productVariant: { product: { id: string } } | null;
      }>(
        ctx,
        `query Parent($id: ID!) { productVariant(id: $id) { product { id } } }`,
        { id: variantId },
      );
      const parent = found.productVariant?.product.id;
      if (!parent) throw new Error("Shopify : variante introuvable");
      return this.applyPrice(ctx, parent, variantId!, price);
    }
    return this.applyPrice(ctx, productId, variantId!, price);
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
        variants: [{ id: variantId, price: prixShopify(price) }],
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
    unite?: Variant,
  ): Promise<TargetResult> {
    /*
     * CHAQUE DÉCLINAISON A SON PROPRE ARTICLE D'INVENTAIRE.
     *
     * `marketplaceData.inventoryItemId` est celui de la PREMIÈRE variante —
     * pratique pour une annonce qui n'en a qu'une, faux dès qu'il y en a
     * dix-sept : le stock du violet irait sur le noir, et les seize autres
     * resteraient à zéro sans erreur ni message.
     *
     * La liste complète vit dans `marketplaceData.variants`. Il suffit d'y
     * retrouver l'unité que le cœur désigne — par sa clé d'options d'abord,
     * qui existe toujours, par son SKU ensuite, que Shopify n'impose pas.
     */
    const declinaisons = listing.marketplaceData?.["variants"];
    let inventoryItemId: string | undefined;

    if (Array.isArray(declinaisons) && declinaisons.length > 1) {
      if (!unite) {
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message:
            "Annonce à déclinaisons : impossible d'écrire un stock sans savoir quel coloris est visé.",
        };
      }

      const lignes = declinaisons as Array<{
        optionKey?: string;
        sku?: string;
        inventoryItemId?: string;
      }>;
      const trouvee =
        lignes.find((l) => l.optionKey && l.optionKey === unite.optionKey) ??
        (unite.sku ? lignes.find((l) => l.sku === unite.sku) : undefined);

      if (!trouvee?.inventoryItemId) {
        // Refuser nommément vaut mieux qu'écrire sur la première venue : une
        // déclinaison ajoutée chez Shopify après la création n'est pas dans
        // cette liste, et l'inventer serait pire que de le dire.
        return {
          accountId: ctx.account.id,
          marketplace: ctx.account.marketplace,
          status: "unsupported",
          message: `Déclinaison « ${unite.optionKey || unite.sku || unite.id} » introuvable dans l'annonce Shopify. Relancez une synchronisation du catalogue.`,
        };
      }
      inventoryItemId = trouvee.inventoryItemId;
    }

    inventoryItemId ??= listing.marketplaceData?.["inventoryItemId"] as
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

  /**
   * Efface le produit chez Shopify.
   *
   * Le produit, PAS la variante : Shopify n'expose pas de suppression de
   * variante isolée, et un produit dont on aurait ôté toutes les déclinaisons
   * resterait de toute façon une coquille en ligne. Effacer le parent emporte
   * ses variantes — c'est bien ce qu'on veut quand le produit disparaît du
   * stock.
   *
   * Conséquence directe : sur un article à dix-sept coloris, la première
   * annonce effacée emporte les seize autres. Les appels suivants trouvent un
   * produit déjà absent et le comptent pour un succès — ce que fait déjà
   * `estIntrouvable`.
   */
  async deleteListing(
    ctx: MarketplaceContext,
    listing: Listing,
    _idempotencyKey?: string,
  ): Promise<TargetResult> {
    const productId = await this.produitParent(ctx, listing);
    if (!productId) {
      return this.ok(
        ctx,
        listing.remoteId,
        "Produit déjà absent de Shopify — rien à effacer.",
      );
    }

    const d = await this.gql<{
      productDelete: {
        deletedProductId: string | null;
        userErrors: UserError[];
      };
    }>(
      ctx,
      `mutation Effacer($input: ProductDeleteInput!) {
        productDelete(input: $input) { deletedProductId userErrors { field message } }
      }`,
      { input: { id: productId } },
    );

    if ((d.productDelete.userErrors ?? []).some(estIntrouvable)) {
      return this.ok(
        ctx,
        listing.remoteId,
        "Produit déjà absent de Shopify — rien à effacer.",
      );
    }
    this.assertNoUserErrors(d.productDelete.userErrors, "suppression");
    return this.ok(ctx, listing.remoteId, "Annonce effacée chez Shopify.");
  }

  /**
   * L'identifiant du produit parent d'une annonce, ou `undefined` s'il a
   * disparu. Mémorisé à la création ; retrouvé par la variante sinon.
   */
  private async produitParent(
    ctx: MarketplaceContext,
    listing: Listing,
  ): Promise<string | undefined> {
    const connu = listing.marketplaceData?.["productId"] as string | undefined;
    if (connu) return connu;
    const found = await this.gql<{
      productVariant: { product: { id: string } } | null;
    }>(
      ctx,
      `query Parent($id: ID!) { productVariant(id: $id) { product { id } } }`,
      { id: listing.remoteId },
    );
    return found.productVariant?.product.id;
  }

  private async setStatus(
    ctx: MarketplaceContext,
    listing: Listing,
    status: "ACTIVE" | "DRAFT",
  ): Promise<TargetResult> {
    /*
     * UN PRODUIT DÉJÀ DISPARU N'EST PAS UN ÉCHEC — quand on cherchait à le
     * retirer.
     *
     * Le cas est banal : quelqu'un efface le produit depuis l'administration
     * Shopify. L'annonce reste alors chez nous, marquée « active », et pointe
     * sur un identifiant que Shopify ne connaît plus. Toute tentative de
     * retrait répondait « id Product does not exist », donc « échec », et la
     * suppression du produit — qui commence par retirer partout — était
     * refusée. DÉFINITIVEMENT : rien ne nettoie une annonce dont la
     * contrepartie distante a disparu, si bien que l'article restait
     * insupprimable à vie.
     *
     * L'état voulu est pourtant atteint : l'article n'est plus en vente. On
     * répond donc « réussi ».
     *
     * Dans l'autre sens — REMETTRE en vente — l'absence reste un échec : on ne
     * peut pas republier ce qui n'existe plus, et le dire serait mentir.
     */
    const disparu = (): TargetResult | null =>
      status === "DRAFT"
        ? this.ok(
            ctx,
            listing.remoteId,
            "Produit absent de Shopify — il n'y avait plus rien à retirer de la vente.",
          )
        : null;

    const productId = await this.produitParent(ctx, listing);
    if (!productId) {
      const acquis = disparu();
      if (acquis) return acquis;
      throw new Error("Shopify : produit introuvable");
    }

    const d = await this.gql<{ productUpdate: { userErrors: UserError[] } }>(
      ctx,
      `mutation Status($input: ProductInput!) {
        productUpdate(input: $input) { userErrors { field message } }
      }`,
      { input: { id: productId, status } },
    );

    // « Product does not exist » : le même cas, vu depuis la mutation.
    if ((d.productUpdate.userErrors ?? []).some(estIntrouvable)) {
      const acquis = disparu();
      if (acquis) return acquis;
    }

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
          selectedOptions: Array<{ name: string; value: string }>;
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
            # Les déclinaisons de CETTE unité : « Couleur = Violet ». Sans
            # elles, dix-sept coloris arrivaient comme dix-sept annonces sans
            # lien, dont aucune ne portait de SKU.
            selectedOptions { name value }
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
      // « Default Title » est le libellé que Shopify donne à la variante unique
      // d'un produit sans déclinaison : ce n'est pas une vraie option.
      const declinaisons = (v.selectedOptions ?? []).filter(
        (o) => o.value && o.value !== "Default Title",
      );

      return {
        remoteId: v.id,
        sku: v.sku || null,
        // Le PARENT. C'est lui qui recolle les variantes entre elles.
        groupRemoteId: v.product?.id,
        groupTitle: v.product?.title,
        optionValues: declinaisons,
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
  indiceCompte(request: Request): string | null {
    // Shopify nomme la boutique dans un en-tête dédié, sous la forme exacte
    // que porte notre `externalId` : « xxxxx.myshopify.com ».
    return request.headers.get("X-Shopify-Shop-Domain");
  }

  webhookSignaux(request: Request, rawBody: string): SignalWebhook[] {
    const topic = request.headers.get("X-Shopify-Topic") ?? "";

    /*
     * `inventory_levels/update` PORTE DÉJÀ LA RÉPONSE.
     *
     * Shopify envoie l'article d'inventaire exact et sa nouvelle quantité :
     *
     *   { "inventory_item_id": 56365219053906, "available": 12, ... }
     *
     * Le traduire en « relis ton inventaire » revenait à recevoir une adresse
     * précise et repartir fouiller la ville — un catalogue entier relu, page
     * par page, pour une variante qui a bougé de deux unités.
     */
    if (topic.startsWith("inventory_levels/")) {
      try {
        const corps = JSON.parse(rawBody) as {
          inventory_item_id?: number | string;
          available?: number;
        };
        const ref = corps.inventory_item_id;
        const dispo = corps.available;
        if (ref !== undefined && typeof dispo === "number") {
          return [
            {
              type: "stock",
              /*
               * Shopify envoie l'identifiant NUMÉRIQUE dans ses webhooks et
               * l'identifiant GraphQL partout ailleurs. On rend la forme
               * longue, la seule mémorisée de notre côté — sans quoi la
               * correspondance ne se ferait jamais et le signal serait perdu
               * en silence.
               */
              refDistante: `gid://shopify/InventoryItem/${ref}`,
              disponible: Math.max(0, dispo),
            },
          ];
        }
      } catch {
        // Corps illisible : on retombe sur la relecture, qui marche toujours.
      }
      return [{ type: "relire", resource: "inventory" }];
    }

    // Un changement de titre, de photo ou de prix n'a pas de raccourci : il
    // touche la fiche entière, et c'est le catalogue qu'il faut relire.
    if (topic.startsWith("products/") || topic.startsWith("inventory_items/")) {
      return [{ type: "relire", resource: "inventory" }];
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
