import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
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
  ProductRepository,
  SalesEventRepository,
} from "@hub/engine";
import {
  inventory,
  listing,
  oauthToken,
  product,
  salesEvent,
  shop,
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

  async findByRemoteId(accountId: AccountId, remoteId: string) {
    const rows = await this.db
      .select()
      .from(listing)
      .where(and(eq(listing.shopId, accountId), eq(listing.externalId, remoteId)))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async listByProduct(productId: ProductId) {
    const rows = await this.db
      .select()
      .from(listing)
      .where(eq(listing.productId, productId));
    return rows.map((r) => this.map(r));
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

export class D1InventoryRepository implements InventoryRepository {
  constructor(private readonly db: DB) {}

  async get(productId: ProductId) {
    const rows = await this.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          productId: r.productId,
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
          eq(inventory.productId, next.productId),
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
        productId: item.productId,
        onHand: item.onHand,
        reserved: item.reserved,
        version: item.version,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: inventory.productId,
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

  async put(accountId: AccountId, credentials: Record<string, string>) {
    const ciphertext = await encryptJson(this.masterKey, credentials);
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .insert(oauthToken)
      .values({
        shopId: accountId,
        ciphertext,
        keyVersion: 1,
        accessExpiresAt: null,
        refreshExpiresAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: oauthToken.shopId,
        set: { ciphertext, updatedAt: now },
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
    inventory: new D1InventoryRepository(d),
    salesEvents: new D1SalesEventRepository(d),
    credentials: new D1CredentialRepository(d, masterKey),
  };
}

export { randomId };
