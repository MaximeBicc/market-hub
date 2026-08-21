import type {
  AIProvider,
  Catalogue,
  ModelDescriptor,
  ProductFacts,
  ProviderRequest,
  ProviderResponse,
  SalesPoint,
} from "../domain/types.js";
import type {
  ResultCache,
  RunJournal,
  RunStart,
  RunSuccess,
  UsageEntry,
  UsageLedger,
  UsageRow,
} from "../ports/repositories.js";
import { emptyUsage, type DailyUsage } from "../core/budget.js";

/**
 * Implémentations en mémoire des ports du panel.
 *
 * Elles servent aux tests, et à rien d'autre : aucun code de production ne les
 * importe. Leur existence est ce qui permet d'éprouver le routage, les budgets
 * et les skills sans clé, sans réseau et sans base — donc sans consommer une
 * seule unité d'une offre gratuite pour lancer une suite de tests.
 */

export class MemoryLedger implements UsageLedger {
  readonly entries: UsageEntry[] = [];
  private usage: DailyUsage;

  constructor(initial: Partial<DailyUsage> = {}) {
    this.usage = { ...emptyUsage(), ...initial };
  }

  async today(): Promise<DailyUsage> {
    // Copie : l'orchestrateur tient sa propre comptabilité pendant l'exécution
    // et ne doit pas modifier l'état du registre par effet de bord.
    return {
      neurons: this.usage.neurons,
      requests: { ...this.usage.requests },
      searchRequests: this.usage.searchRequests,
    };
  }

  async record(entry: UsageEntry): Promise<void> {
    this.entries.push(entry);
    this.usage.requests[entry.provider] = (this.usage.requests[entry.provider] ?? 0) + 1;
    if (entry.provider === "cloudflare") this.usage.neurons += entry.neurons;
    if (entry.webSearch) this.usage.searchRequests += 1;
  }

  async breakdown(): Promise<UsageRow[]> {
    return this.entries.map((e) => ({ ...e, day: "2026-08-20", requests: 1 }));
  }
}

export class MemoryCache implements ResultCache {
  readonly store = new Map<string, unknown>();
  /** Durees de vie demandees, dans l'ordre. Sert a verifier qu'un echec expire vite. */
  readonly ttls: number[] = [];
  hits = 0;

  async get(key: string): Promise<unknown | undefined> {
    const value = this.store.get(key);
    if (value !== undefined) this.hits++;
    return value;
  }

  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, value);
    this.ttls.push(ttlSeconds);
  }

  async purge(): Promise<number> {
    return 0;
  }
}

export class MemoryJournal implements RunJournal {
  readonly started: RunStart[] = [];
  readonly succeeded: RunSuccess[] = [];
  readonly failed: Array<{ id: string; error: string }> = [];

  async start(run: RunStart): Promise<void> {
    this.started.push(run);
  }
  async succeed(run: RunSuccess): Promise<void> {
    this.succeeded.push(run);
  }
  async fail(id: string, error: string): Promise<void> {
    this.failed.push({ id, error });
  }
}

/** Fournisseur scriptable : répond, ou échoue, selon ce qu'on lui a demandé. */
export class ScriptedProvider implements AIProvider {
  readonly calls: Array<{ model: string; request: ProviderRequest }> = [];

  constructor(
    readonly id: AIProvider["id"],
    private readonly script: (
      model: ModelDescriptor,
      request: ProviderRequest,
    ) => ProviderResponse | Error,
    private readonly ready = true,
  ) {}

  configured(): boolean {
    return this.ready;
  }

  async generate(model: ModelDescriptor, request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push({ model: model.model, request });
    const outcome = this.script(model, request);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

/** Réponse toute faite, avec une consommation plausible. */
export const reply = (text: string, tokens = { input: 800, output: 200 }): ProviderResponse => ({
  text,
  inputTokens: tokens.input,
  outputTokens: tokens.output,
});

export class MemoryCatalogue implements Catalogue {
  constructor(
    private readonly products: ProductFacts[] = [],
    private readonly series: Record<string, SalesPoint[]> = {},
  ) {}

  async product(productId: string): Promise<ProductFacts | undefined> {
    return this.products.find((p) => p.productId === productId);
  }

  async salesSeries(productId: string): Promise<SalesPoint[]> {
    return this.series[productId] ?? [];
  }

  async portfolio(): Promise<ProductFacts[]> {
    return this.products;
  }
}

/** Produit de test : une lampe vendue sur deux plateformes. */
export function sampleProduct(over: Partial<ProductFacts> = {}): ProductFacts {
  return {
    productId: "prod-1",
    sku: "LAMPE-01",
    title: "Lampe de bureau articulée",
    description: null,
    costPrice: 1_200,
    referencePrice: 3_490,
    images: [],
    tags: ["bureau"],
    onHand: 40,
    reserved: 5,
    listings: [
      {
        shopId: "s1",
        shopName: "Boutique Shopify",
        platform: "shopify",
        externalId: "e1",
        price: 3_490,
        currency: "EUR",
        quantity: 20,
        status: "active",
        url: null,
        imageUrl: null,
      },
      {
        shopId: "s2",
        shopName: "Boutique Etsy",
        platform: "etsy",
        externalId: "e2",
        price: 3_690,
        currency: "EUR",
        quantity: 15,
        status: "active",
        url: null,
        imageUrl: null,
      },
    ],
    ...over,
  };
}

/** Série de ventes régulière, avec pics optionnels à des positions données. */
export function sampleSeries(
  days: number,
  base = 3,
  spikes: Record<number, number> = {},
): SalesPoint[] {
  return Array.from({ length: days }, (_, i) => {
    const units = spikes[i] ?? base;
    return {
      date: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`,
      units,
      revenue: units * 3_490,
    };
  });
}
