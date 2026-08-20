import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type {
  Catalogue,
  DailyUsage,
  ProductFacts,
  ResultCache,
  RunJournal,
  RunStart,
  RunSuccess,
  SalesPoint,
  UsageEntry,
  UsageLedger,
  UsageRow,
} from "@hub/ai";
import { emptyUsage } from "@hub/ai";
import {
  aiCache,
  aiEvidence,
  aiRun,
  aiUsage,
  inventory,
  listing,
  order,
  orderLine,
  product,
  shop,
} from "../db/schema.js";
import { randomId } from "../lib/crypto.js";

/**
 * Implémentation D1 des ports du panel d'IA.
 *
 * Même rôle que `engine/repositories.ts` pour le moteur marketplace : c'est la
 * seule couche qui connaît à la fois le vocabulaire du panel et le schéma SQL.
 * Le paquet `@hub/ai`, lui, ne sait rien de D1 — c'est ce qui permet de tester
 * tout le routage en mémoire.
 */

type DB = DrizzleD1Database<Record<string, never>>;

const seconds = () => Math.floor(Date.now() / 1000);

/** Journée UTC, au format que Cloudflare utilise pour remettre les quotas à zéro. */
const today = () => new Date().toISOString().slice(0, 10);

const parseJsonArray = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------ */
/* Consommation                                                        */
/* ------------------------------------------------------------------ */

export class D1UsageLedger implements UsageLedger {
  constructor(private readonly db: DB) {}

  /**
   * Consommation agrégée du jour, en UNE requête.
   *
   * Le routeur en a besoin pour chaque modèle candidat ; interroger la base
   * par candidat multiplierait les lectures par six sans rien apprendre de
   * neuf, et l'offre gratuite D1 se compte en lignes lues.
   */
  async today(): Promise<DailyUsage> {
    const rows = await this.db
      .select({
        provider: aiUsage.provider,
        requests: sql<number>`sum(${aiUsage.requests})`,
        neurons: sql<number>`sum(${aiUsage.neurons})`,
        searchRequests: sql<number>`sum(${aiUsage.searchRequests})`,
      })
      .from(aiUsage)
      .where(eq(aiUsage.day, today()))
      .groupBy(aiUsage.provider);

    const usage = emptyUsage();
    for (const row of rows) {
      const provider = row.provider as keyof DailyUsage["requests"];
      usage.requests[provider] = row.requests ?? 0;
      usage.searchRequests += row.searchRequests ?? 0;
      // Seuls les neurones Cloudflare comptent pour l'allocation : ceux des
      // autres fournisseurs sont une conversion d'affichage, pas une dépense.
      if (provider === "cloudflare") usage.neurons += row.neurons ?? 0;
    }
    return usage;
  }

  async record(entry: UsageEntry): Promise<void> {
    await this.db
      .insert(aiUsage)
      .values({
        day: today(),
        provider: entry.provider,
        model: entry.model,
        requests: 1,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        neurons: entry.neurons,
        searchRequests: entry.webSearch ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [aiUsage.day, aiUsage.provider, aiUsage.model],
        set: {
          requests: sql`${aiUsage.requests} + 1`,
          inputTokens: sql`${aiUsage.inputTokens} + ${entry.inputTokens}`,
          outputTokens: sql`${aiUsage.outputTokens} + ${entry.outputTokens}`,
          neurons: sql`${aiUsage.neurons} + ${entry.neurons}`,
          searchRequests: sql`${aiUsage.searchRequests} + ${entry.webSearch ? 1 : 0}`,
        },
      });
  }

  async breakdown(day = today()): Promise<UsageRow[]> {
    const rows = await this.db.select().from(aiUsage).where(eq(aiUsage.day, day));
    return rows.map((r) => ({
      day: r.day,
      provider: r.provider as UsageRow["provider"],
      model: r.model,
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      neurons: r.neurons,
      webSearch: r.searchRequests > 0,
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

export class D1ResultCache implements ResultCache {
  constructor(private readonly db: DB) {}

  async get(key: string): Promise<unknown | undefined> {
    const rows = await this.db
      .select({ value: aiCache.value })
      .from(aiCache)
      // Le filtre d'expiration est dans la requête, pas après : une entrée
      // périmée ne doit jamais être servie, même si la purge n'est pas encore
      // passée. La purge nocturne récupère l'espace, elle ne garantit rien.
      .where(and(eq(aiCache.key, key), gte(aiCache.expiresAt, seconds())))
      .limit(1);

    if (!rows[0]) return undefined;
    try {
      return JSON.parse(rows[0].value) as unknown;
    } catch {
      return undefined;
    }
  }

  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.db
      .insert(aiCache)
      .values({
        key,
        value: JSON.stringify(value),
        expiresAt: seconds() + ttlSeconds,
      })
      .onConflictDoUpdate({
        target: aiCache.key,
        set: { value: JSON.stringify(value), expiresAt: seconds() + ttlSeconds },
      });
  }

  async purge(): Promise<number> {
    const result = await this.db.delete(aiCache).where(lt(aiCache.expiresAt, seconds()));
    return result.meta.changes ?? 0;
  }
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

export class D1RunJournal implements RunJournal {
  constructor(private readonly db: DB) {}

  async start(run: RunStart): Promise<void> {
    await this.db.insert(aiRun).values({
      id: run.id,
      skill: run.skill,
      skillVersion: run.skillVersion,
      status: "running",
      dataClass: run.dataClass,
      impact: run.impact,
      automatic: run.automatic ? 1 : 0,
      inputHash: run.inputHash,
      startedAt: seconds(),
    });
  }

  async succeed(run: RunSuccess): Promise<void> {
    const now = seconds();
    // Tableau laissé vide à la déclaration : Drizzle type différemment un
    // `update` et un `insert`, et initialiser avec l'un rendrait l'autre
    // inassignable. `db.batch` les accepte pourtant ensemble.
    const writes = [];

    writes.push(
      this.db
        .update(aiRun)
        .set({
          status: "success",
          provider: run.provider,
          model: run.model,
          confidence: run.confidence,
          neurons: run.neurons,
          sourceCount: run.evidence.length,
          finishedAt: now,
        })
        .where(eq(aiRun.id, run.id)),
    );

    // Plafond volontaire : une recherche large peut ramener des dizaines de
    // sources, et les écrire toutes consommerait le quota d'écritures D1 pour
    // des preuves que personne ne lira. Les vingt premières sont déjà
    // classées par fiabilité.
    for (const source of run.evidence.slice(0, 20)) {
      writes.push(
        this.db.insert(aiEvidence).values({
          id: randomId(),
          runId: run.id,
          url: source.url,
          title: source.title ?? null,
          kind: source.kind,
          observedAt: source.observedAt,
          snippet: source.snippet ?? null,
          price: source.price ?? null,
          currency: source.currency ?? null,
          reliability: source.reliability ?? null,
        }),
      );
    }

    await this.db.batch(writes as never);
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db
      .update(aiRun)
      .set({ status: "failed", error: error.slice(0, 500), finishedAt: seconds() })
      .where(eq(aiRun.id, id));
  }
}

/* ------------------------------------------------------------------ */
/* Faits métier                                                        */
/* ------------------------------------------------------------------ */

/**
 * Résolution des faits métier depuis la base.
 *
 * C'est la pièce qui empêche le navigateur de mentir. La PWA envoie un
 * identifiant de produit ; le prix d'achat, le stock et les ventes sont lus
 * ici, côté serveur. Sans cette règle, il suffirait de poster un prix d'achat
 * de un centime pour obtenir une recommandation de prix absurde mais
 * parfaitement argumentée.
 */
export class D1Catalogue implements Catalogue {
  constructor(private readonly db: DB) {}

  async product(productId: string): Promise<ProductFacts | undefined> {
    const [row] = await this.db
      .select()
      .from(product)
      .where(eq(product.id, productId))
      .limit(1);
    if (!row) return undefined;

    const [stock] = await this.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId))
      .limit(1);

    return this.withListings(row, stock);
  }

  async salesSeries(productId: string, days: number): Promise<SalesPoint[]> {
    const [row] = await this.db
      .select({ sku: product.sku })
      .from(product)
      .where(eq(product.id, productId))
      .limit(1);
    if (!row) return [];

    const now = seconds();
    const from = now - days * 86_400;

    const rows = await this.db
      .select({
        date: sql<string>`date(${order.placedAt}, 'unixepoch')`,
        units: sql<number>`coalesce(sum(${orderLine.quantity}), 0)`,
        revenue: sql<number>`coalesce(sum(${orderLine.quantity} * ${orderLine.unitPriceAmount}), 0)`,
      })
      .from(orderLine)
      .innerJoin(order, eq(order.id, orderLine.orderId))
      .where(
        and(
          eq(orderLine.sku, row.sku),
          gte(order.placedAt, from),
          // Annulé et remboursé ne sont pas des ventes. Les compter gonflerait
          // la vitesse d'écoulement et ferait recommander un réassort inutile.
          sql`${order.status} NOT IN ('cancelled', 'refunded')`,
        ),
      )
      .groupBy(sql`date(${order.placedAt}, 'unixepoch')`);

    // SQL ne renvoie que les journées ayant eu une vente. Une série trouée
    // fausserait la moyenne, l'écart-type et donc la détection d'anomalies :
    // trois ventes en trente jours n'ont pas le même sens que trois ventes en
    // trois jours.
    const found = new Map(rows.map((r) => [r.date, r]));
    const series: SalesPoint[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date((now - i * 86_400) * 1000).toISOString().slice(0, 10);
      const hit = found.get(date);
      series.push({
        date,
        units: hit?.units ?? 0,
        revenue: hit?.revenue ?? 0,
      });
    }
    return series;
  }

  async portfolio(): Promise<ProductFacts[]> {
    const rows = await this.db.select().from(product).limit(500);
    const stocks = await this.db.select().from(inventory);
    const byProduct = new Map(stocks.map((s) => [s.productId, s]));

    return Promise.all(rows.map((r) => this.withListings(r, byProduct.get(r.id))));
  }

  /** Assemble un produit avec ses annonces et son stock vivant. */
  private async withListings(
    row: typeof product.$inferSelect,
    stock: typeof inventory.$inferSelect | undefined,
  ): Promise<ProductFacts> {
    const listings = await this.db
      .select({
        shopId: listing.shopId,
        shopName: shop.displayName,
        platform: shop.platform,
        externalId: listing.externalId,
        price: listing.priceAmount,
        currency: listing.priceCurrency,
        quantity: listing.quantity,
        status: listing.status,
        url: listing.url,
        imageUrl: listing.imageUrl,
      })
      .from(listing)
      .innerJoin(shop, eq(shop.id, listing.shopId))
      .where(eq(listing.productId, row.id));

    return {
      productId: row.id,
      sku: row.sku,
      title: row.title,
      description: row.description,
      costPrice: row.costPrice,
      referencePrice: row.priceAmount,
      images: parseJsonArray(row.images),
      tags: parseJsonArray(row.tags),
      // Le stock vivant fait foi ; `product.stock` n'est qu'une valeur de
      // référence à la création d'une annonce.
      onHand: stock?.onHand ?? row.stock,
      reserved: stock?.reserved ?? 0,
      listings,
    };
  }
}

/** Assemble les quatre dépôts d'un coup, pour le câblage du module. */
export function aiRepositories(database: D1Database) {
  const db = drizzle(database);
  return {
    ledger: new D1UsageLedger(db),
    cache: new D1ResultCache(db),
    journal: new D1RunJournal(db),
    catalogue: new D1Catalogue(db),
  };
}
