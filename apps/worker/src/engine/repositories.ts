import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import type {
  AccountId,
  AccountRepository,
  CanonicalOrderEvent,
  CredentialRepository,
  InventoryItem,
  InventoryRepository,
  Listing,
  ListingRepository,
  MarketplaceAccount,
  Product,
  ProductId,
  Variant,
  VariantId,
  ProductRepository,
  VariantRepository,
  SalesEventRepository,
} from "@hub/engine";
import {
  inventory,
  listing,
  oauthToken,
  product,
  salesEvent,
  shop,
  variant,
} from "../db/schema.js";
import { contentHash, randomId } from "../lib/crypto.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";

/**
 * Implémentation D1 des ports du moteur.
 *
 * C'est la seule couche qui connaît à la fois le modèle canonique et le schéma
 * SQL. Le moteur, lui, ne sait rien de D1 — c'est ce qui permet de le tester
 * entièrement en mémoire.
 */

type DB = DrizzleD1Database<Record<string, never>>;

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/* ------------------------------------------------------------------ */

export class D1AccountRepository implements AccountRepository {
  constructor(private readonly db: DB) {}

  private map(row: typeof shop.$inferSelect): MarketplaceAccount {
    return {
      id: row.id,
      marketplace: row.platform,
      slug: row.slug ?? `${row.platform}_${row.id.slice(0, 6)}`,
      displayName: row.displayName,
      // Une boutique « à reconnecter » ou « en pause » reste en base mais ne
      // doit plus recevoir de commandes : l'orchestrateur l'écartera.
      enabled: row.status === "active",
      externalAccountId: row.externalId,
    };
  }

  async get(id: AccountId) {
    const rows = await this.db.select().from(shop).where(eq(shop.id, id)).limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async listEnabled() {
    const rows = await this.db
      .select()
      .from(shop)
      .where(eq(shop.status, "active"));
    return rows.map((r) => this.map(r));
  }

  async put(account: MarketplaceAccount) {
    await this.db
      .insert(shop)
      .values({
        id: account.id,
        platform: account.marketplace,
        externalId: account.externalAccountId ?? account.id,
        displayName: account.displayName,
        slug: account.slug,
        status: account.enabled ? "active" : "paused",
        config: "{}",
        connectedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: shop.id,
        set: {
          displayName: account.displayName,
          slug: account.slug,
          status: account.enabled ? "active" : "paused",
        },
      });
  }
}

/* ------------------------------------------------------------------ */

export class D1ProductRepository implements ProductRepository {
  constructor(private readonly db: DB) {}

  private map(row: typeof product.$inferSelect): Product {
    return {
      id: row.id,
      sku: row.sku,
      title: row.title,
      description: row.description ?? undefined,
      price: { amount: row.priceAmount, currency: row.priceCurrency },
      stock: row.stock,
      images: parseJson<string[]>(row.images, []),
      tags: parseJson<string[]>(row.tags, []),
      materials: row.material
        ? row.material.split(",").map((m) => m.trim()).filter(Boolean)
        : undefined,
      /*
       * LES AXES DE VARIATION — colonne remplie par la synchronisation et que
       * personne ne relisait.
       *
       * Sans eux, un produit à dix-sept coloris arrivait chez l'adaptateur
       * avec ses variantes mais SANS ses axes. Shopify retombait alors sur son
       * chemin historique, créait UN article à UNE variante, et renvoyait
       * « succès ». Seize coloris disparaissaient sans que rien ne le signale.
       */
      options: parseJson<Product["options"]>(row.options, []),
      // Les déclarations obligatoires. `?? undefined` et non `?? "new"` : une
      // valeur absente doit rester absente, pour que l'adaptateur refuse au
      // lieu d'inventer.
      condition: (row.condition ?? undefined) as Product["condition"],
      whoMade: (row.whoMade ?? undefined) as Product["whoMade"],
      whenMade: (row.whenMade ?? undefined) as Product["whenMade"],
      weightGrams: row.weightGrams ?? undefined,
      marketplaceData: parseJson<Record<string, unknown>>(row.marketplaceData, {}),
    };
  }

  async get(id: ProductId) {
    const rows = await this.db
      .select()
      .from(product)
      .where(eq(product.id, id))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async findBySku(sku: string) {
    const rows = await this.db
      .select()
      .from(product)
      .where(eq(product.sku, sku))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async put(p: Product) {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .insert(product)
      .values({
        id: p.id,
        sku: p.sku,
        title: p.title,
        description: p.description ?? null,
        priceAmount: p.price.amount,
        priceCurrency: p.price.currency,
        stock: p.stock,
        images: JSON.stringify(p.images ?? []),
        tags: JSON.stringify(p.tags ?? []),
        marketplaceData: JSON.stringify(p.marketplaceData ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: product.id,
        set: {
          title: p.title,
          description: p.description ?? null,
          priceAmount: p.price.amount,
          priceCurrency: p.price.currency,
          stock: p.stock,
          images: JSON.stringify(p.images ?? []),
          tags: JSON.stringify(p.tags ?? []),
          marketplaceData: JSON.stringify(p.marketplaceData ?? {}),
          updatedAt: now,
        },
      });
  }
}

/* ------------------------------------------------------------------ */

export class D1ListingRepository implements ListingRepository {
  constructor(private readonly db: DB) {}

  private map(row: typeof listing.$inferSelect): Listing {
    return {
      id: row.id,
      productId: row.productId ?? "",
      accountId: row.shopId,
      remoteId: row.externalId,
      status: row.status as Listing["status"],
      price: { amount: row.priceAmount, currency: row.priceCurrency },
      stock: row.quantity,
      marketplaceData: parseJson<Record<string, unknown>>(row.marketplaceData, {}),
    };
  }

  async findByProductAndAccount(productId: ProductId, accountId: AccountId) {
    const rows = await this.db
      .select()
      .from(listing)
      .where(and(eq(listing.productId, productId), eq(listing.shopId, accountId)))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async findByProductVariantAndAccount(
    productId: ProductId,
    variantId: VariantId,
    accountId: AccountId,
  ) {
    const rows = await this.db
      .select()
      .from(listing)
      .where(
        and(
          eq(listing.productId, productId),
          eq(listing.variantId, variantId),
          eq(listing.shopId, accountId),
        ),
      )
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async listByProductAndAccount(productId: ProductId, accountId: AccountId) {
    const rows = await this.db
      .select()
      .from(listing)
      .where(and(eq(listing.productId, productId), eq(listing.shopId, accountId)));
    return rows.map((r) => this.map(r));
  }

  async findByRemoteId(accountId: AccountId, remoteId: string) {
    const rows = await this.db
      .select()
      .from(listing)
      .where(and(eq(listing.shopId, accountId), eq(listing.externalId, remoteId)))
      .limit(1);
    if (rows[0]) return this.map(rows[0]);

    /*
     * UNE ANNONCE EBAY PORTE DEUX NOMS.
     *
     * Chez eBay, l'identifiant stable est le SKU — c'est lui qu'on garde en
     * `externalId`, parce que l'identifiant d'annonce n'existe qu'une fois
     * publiée et change à chaque republication.
     *
     * Mais les NOTIFICATIONS de vente, elles, ne parlent que par
     * `listingId`. Sans ce repli, une vente eBay ne retrouverait aucune
     * annonce et ne décrémenterait rien — exactement le défaut qu'on a déjà
     * payé sur les variantes Shopify sans SKU.
     *
     * L'identifiant est mémorisé par le relevé de catalogue, dans les données
     * propres à la plateforme.
     */
    const parAnnonce = await this.db
      .select()
      .from(listing)
      .where(
        and(
          eq(listing.shopId, accountId),
          sql`json_extract(${listing.marketplaceData}, '$.listingId') = ${remoteId}`,
        ),
      )
      .limit(1);
    return parAnnonce[0] ? this.map(parAnnonce[0]) : undefined;
  }

  async listByProduct(productId: ProductId) {
    const rows = await this.db
      .select()
      .from(listing)
      .where(eq(listing.productId, productId));
    return rows.map((r) => this.map(r));
  }

  async remove(id: string) {
    await this.db.delete(listing).where(eq(listing.id, id));
  }

  async put(l: Listing) {
    const now = Math.floor(Date.now() / 1000);
    // L'empreinte reste calculée ici : c'est elle qui évite de réécrire une
    // ligne inchangée, et donc de brûler le quota d'écritures de D1.
    const hash = await contentHash({
      p: l.price.amount,
      c: l.price.currency,
      q: l.stock,
      s: l.status,
    });

    await this.db
      .insert(listing)
      .values({
        id: l.id,
        shopId: l.accountId,
        productId: l.productId || null,
        externalId: l.remoteId ?? l.id,
        sku: null,
        title: "",
        priceAmount: l.price.amount,
        priceCurrency: l.price.currency,
        quantity: l.stock,
        status: l.status,
        url: null,
        imageUrl: null,
        marketplaceData: JSON.stringify(l.marketplaceData ?? {}),
        contentHash: hash,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [listing.shopId, listing.externalId],
        set: {
          productId: l.productId || null,
          priceAmount: l.price.amount,
          priceCurrency: l.price.currency,
          quantity: l.stock,
          status: l.status,
          marketplaceData: JSON.stringify(l.marketplaceData ?? {}),
          contentHash: hash,
          syncedAt: now,
        },
      });
  }
}

/* ------------------------------------------------------------------ */

/**
 * Les variantes.
 *
 * `findByOptionKey` est ce qui permet de retrouver une variante SANS SKU d'un
 * passage de synchronisation à l'autre : Shopify n'impose pas de SKU, et la
 * majorité du catalogue n'en a pas. Sans cette clé dérivée des déclinaisons,
 * chaque passage recréerait la variante et son stock repartirait de zéro.
 */
export class D1VariantRepository implements VariantRepository {
  constructor(private readonly db: DB) {}

  private map(r: typeof variant.$inferSelect): Variant {
    return {
      id: r.id,
      productId: r.productId,
      sku: r.sku ?? undefined,
      optionValues: parseJson<string[]>(r.optionValues, []),
      optionKey: r.optionKey,
      price: { amount: r.priceAmount, currency: r.priceCurrency },
      imageUrl: r.imageUrl ?? undefined,
      position: r.position,
      status: r.status === "archived" ? "archived" : "active",
      marketplaceData: parseJson<Record<string, unknown>>(r.marketplaceData, {}),
    };
  }

  async get(id: VariantId) {
    const rows = await this.db.select().from(variant).where(eq(variant.id, id)).limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async findBySku(sku: string) {
    const rows = await this.db
      .select()
      .from(variant)
      .where(eq(variant.sku, sku))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async findByOptionKey(productId: ProductId, optionKey: string) {
    const rows = await this.db
      .select()
      .from(variant)
      .where(and(eq(variant.productId, productId), eq(variant.optionKey, optionKey)))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async listByProduct(productId: ProductId) {
    const rows = await this.db
      .select()
      .from(variant)
      .where(eq(variant.productId, productId))
      .orderBy(variant.position);
    return rows.map((r) => this.map(r));
  }

  async put(v: Variant) {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .insert(variant)
      .values({
        id: v.id,
        productId: v.productId,
        sku: v.sku ?? null,
        optionKey: v.optionKey,
        optionValues: JSON.stringify(v.optionValues),
        priceAmount: v.price.amount,
        priceCurrency: v.price.currency,
        imageUrl: v.imageUrl ?? null,
        position: v.position,
        status: v.status,
        marketplaceData: JSON.stringify(v.marketplaceData ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: variant.id,
        set: {
          sku: v.sku ?? null,
          optionValues: JSON.stringify(v.optionValues),
          priceAmount: v.price.amount,
          status: v.status,
          updatedAt: now,
        },
      });
  }
}

export class D1InventoryRepository implements InventoryRepository {
  constructor(private readonly db: DB) {}

  async get(variantId: VariantId) {
    const rows = await this.db
      .select()
      .from(inventory)
      .where(eq(inventory.variantId, variantId))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          variantId: r.variantId,
          onHand: r.onHand,
          reserved: r.reserved,
          version: r.version,
        }
      : undefined;
  }

  /**
   * Verrouillage optimiste en une seule requête.
   *
   * La clause `WHERE version = expected` est ce qui rend l'opération sûre :
   * si une autre vente a modifié la ligne entre notre lecture et notre
   * écriture, aucune ligne n'est touchée et l'appelant recommence. Lire puis
   * écrire en deux requêtes séparées laisserait une fenêtre où deux ventes
   * simultanées s'écraseraient.
   */
  async compareAndSet(next: InventoryItem, expectedVersion: number) {
    // `returning()` plutôt qu'un compteur de lignes modifiées : la forme du
    // résultat d'un UPDATE varie selon le pilote, et s'y fier à tort ferait
    // croire à une réussite systématique — le verrouillage optimiste
    // deviendrait décoratif, et deux ventes simultanées s'écraseraient sans
    // que rien ne le signale. Une ligne rendue prouve l'écriture ; aucune
    // ligne prouve que la version avait bougé.
    const rows = await this.db
      .update(inventory)
      .set({
        onHand: next.onHand,
        reserved: next.reserved,
        version: next.version,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(
        and(
          eq(inventory.variantId, next.variantId),
          eq(inventory.version, expectedVersion),
        ),
      )
      .returning({ version: inventory.version });

    return rows.length > 0;
  }

  async put(item: InventoryItem) {
    await this.db
      .insert(inventory)
      .values({
        variantId: item.variantId,
        onHand: item.onHand,
        reserved: item.reserved,
        version: item.version,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: inventory.variantId,
        set: {
          onHand: item.onHand,
          reserved: item.reserved,
          version: item.version,
          updatedAt: Math.floor(Date.now() / 1000),
        },
      });
  }
}

/* ------------------------------------------------------------------ */

export class D1SalesEventRepository implements SalesEventRepository {
  constructor(private readonly db: DB) {}

  async has(accountId: AccountId, eventId: string) {
    const rows = await this.db
      .select({ id: salesEvent.id })
      .from(salesEvent)
      .where(
        and(eq(salesEvent.accountId, accountId), eq(salesEvent.eventId, eventId)),
      )
      .limit(1);
    return rows.length > 0;
  }

  async mark(event: CanonicalOrderEvent) {
    const id = await contentHash({ a: event.accountId, e: event.eventId });
    await this.db
      .insert(salesEvent)
      .values({
        id,
        accountId: event.accountId,
        eventId: event.eventId,
        marketplace: event.marketplace,
        remoteOrderId: event.remoteOrderId,
        kind: event.kind,
        occurredAt: event.occurredAt,
        receivedAt: Math.floor(Date.now() / 1000),
        unmatchedLines: 0,
      })
      .onConflictDoNothing();
  }
}

/* ------------------------------------------------------------------ */

/**
 * Identifiants d'accès, réutilisant la table `oauth_token` déjà chiffrée.
 *
 * Le moteur manipule un simple dictionnaire `{clé: valeur}` ; le chiffrement
 * AES-GCM et la clé maître restent invisibles pour lui. Une fuite de la base
 * seule ne donne accès à aucun compte marchand.
 */
export class D1CredentialRepository implements CredentialRepository {
  constructor(
    private readonly db: DB,
    private readonly masterKey: string,
  ) {}

  async get(accountId: AccountId) {
    const rows = await this.db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.shopId, accountId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;

    const decoded = await decryptJson<Record<string, unknown>>(
      this.masterKey,
      row.ciphertext,
    );
    // Tout est ramené à des chaînes : le contrat du port est Record<string,string>.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(decoded)) {
      if (typeof v === "string") out[k] = v;
      else if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  }

  /**
   * Recopie les échéances hors du chiffré, dans les colonnes indexées.
   *
   * POURQUOI CETTE DUPLICATION. Les dates vivent dans les identifiants, donc
   * dans le blob chiffré : les interroger obligerait à déchiffrer chaque
   * boutique à chaque passage du cron. Les colonnes existent pour être
   * indexées et filtrées sans clé. Elles ne sont pas la vérité — le chiffré
   * l'est — mais son reflet interrogeable.
   *
   * CE QUE COÛTAIT LEUR ABSENCE. Elles étaient écrites à `null`, et l'union
   * de mise à jour ne les touchait pas : elles restaient nulles à vie. Or
   * `refreshExpiringTokens` et `warnAboutReauth` filtrent sur `isNotNull`.
   * Les deux garde-fous ne se déclenchaient donc JAMAIS pour une boutique
   * reliée par le moteur. Conséquence concrète : le jeton Etsy meurt au bout
   * de 90 jours, la boutique cesse de synchroniser, et aucune alerte ne
   * part — la panne silencieuse que tout le reste du code cherche à éviter.
   */
  private echeances(c: Record<string, string>): {
    acces: number | null;
    rafraichissement: number | null;
  } {
    const nombre = (v: string | undefined): number | null => {
      const n = Number(v);
      return v && Number.isFinite(n) && n > 0 ? n : null;
    };

    // eBay donne l'échéance du rafraîchissement ; Etsy donne la date
    // d'obtention et une fenêtre de 90 jours qui repart à chaque rotation.
    const obtenu = nombre(c["refreshTokenObtainedAt"]);
    return {
      acces: nombre(c["accessTokenExpiresAt"]),
      rafraichissement:
        nombre(c["refreshTokenExpiresAt"]) ??
        (obtenu === null ? null : obtenu + 90 * 86400),
    };
  }

  /**
   * ÉCRIRE DES IDENTIFIANTS SANS EFFACER LES AUTRES.
   *
   * Cette méthode FUSIONNE avec ce qui est déjà en coffre. Elle remplaçait, et
   * ce choix a produit le même défaut trois fois de suite, à trois endroits
   * écrits par des mains différentes : le renouvellement de jeton, la
   * connexion Shopify, puis les retours OAuth d'eBay et d'Etsy.
   *
   * Le scénario est toujours le même et ne se voit jamais tout de suite. Une
   * boutique se reconnecte, le retour OAuth écrit les six champs qu'il
   * connaît — identifiant, secret, jetons — et fait disparaître les huit
   * autres que l'usage avait déposés : l'abonnement aux notifications, le
   * numéro de vendeur appris au premier webhook, le secret de signature. La
   * connexion « réussit », et la boutique cesse silencieusement de recevoir
   * ses ventes en temps réel.
   *
   * Trois occurrences indépendantes ne sont plus des étourderies : c'est la
   * primitive qui a la mauvaise forme. Aucun des vingt-deux appels ne
   * cherchait à SUPPRIMER une clé — tous passaient déjà l'objet complet ou un
   * `{ ...courant, ...correctif }`. Fusionner ne change donc rien pour eux, et
   * rend le défaut impossible pour le vingt-troisième.
   */
  async put(accountId: AccountId, credentials: Record<string, string>) {
    const anciens = (await this.get(accountId)) ?? {};
    const fusionnes = { ...anciens, ...credentials };

    const ciphertext = await encryptJson(this.masterKey, fusionnes);
    const now = Math.floor(Date.now() / 1000);
    /*
     * Les échéances se lisent sur le RÉSULTAT, pas sur le correctif : un
     * patch d'un seul champ n'en porte aucune, et les calculer sur lui
     * remettrait les deux dates à zéro à chaque petite écriture.
     */
    const { acces, rafraichissement } = this.echeances(fusionnes);

    await this.db
      .insert(oauthToken)
      .values({
        shopId: accountId,
        ciphertext,
        keyVersion: 1,
        accessExpiresAt: acces,
        refreshExpiresAt: rafraichissement,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: oauthToken.shopId,
        // Les échéances font partie de la mise à jour : les omettre était
        // exactement le défaut — un jeton renouvelé laissait une date périmée,
        // ou nulle à jamais.
        set: {
          ciphertext,
          accessExpiresAt: acces,
          refreshExpiresAt: rafraichissement,
          updatedAt: now,
        },
      });
  }
}

/* ------------------------------------------------------------------ */

export function d1Repositories(db: D1Database, masterKey: string) {
  const d = drizzle(db);
  return {
    accounts: new D1AccountRepository(d),
    products: new D1ProductRepository(d),
    listings: new D1ListingRepository(d),
    variants: new D1VariantRepository(d),
    inventory: new D1InventoryRepository(d),
    salesEvents: new D1SalesEventRepository(d),
    credentials: new D1CredentialRepository(d, masterKey),
  };
}

export { randomId };
