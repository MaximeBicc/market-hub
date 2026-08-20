/**
 * @hub/ai — le panel d'IA et son chef d'orchestre.
 *
 * Paquet pur : aucune dépendance à Cloudflare, à D1 ni au Worker. Il expose
 * des ports que l'application implémente, exactement comme `@hub/engine` pour
 * les places de marché. C'est ce qui permet de tester le routage, les budgets
 * et les skills entièrement en mémoire, sans clé et sans réseau.
 */

export type {
  AIMessage,
  AIProvider,
  Capability,
  Catalogue,
  ContentPart,
  DataClass,
  Evidence,
  ExecutionRequest,
  ExecutionResult,
  Impact,
  ListingFacts,
  ModelDescriptor,
  Privacy,
  ProductFacts,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  RouteHint,
  SalesPoint,
  Skill,
  SkillContext,
} from "./domain/types.js";

export type {
  ResultCache,
  RunJournal,
  RunStart,
  RunSuccess,
  UsageEntry,
  UsageLedger,
  UsageRow,
} from "./ports/repositories.js";

export {
  allows,
  emptyUsage,
  estimateInputTokens,
  FREE_LIMITS,
  FREE_NEURONS_PER_DAY,
  neuronsFor,
  neuronsToUsd,
  type DailyUsage,
  type FreeLimits,
} from "./core/budget.js";

export { modelCatalogue, type ModelEnv } from "./core/models.js";
export { route, type RoutingDecision } from "./core/router.js";
export { NoFreeModelError, Orchestrator } from "./core/orchestrator.js";
export { defaultSkills, SkillRegistry } from "./core/registry.js";
export {
  runSkill,
  UnknownSkillError,
  type SkillRunRequest,
  type SkillRunResult,
} from "./core/runtime.js";
export { createAiModule, type AiModule, type AiModuleDeps } from "./core/module.js";

export { ResearchEngine, type ResearchResult } from "./research/engine.js";
export {
  SourceRegistry,
  type Layer,
  type ResearchRequest,
  type SourcePort,
} from "./research/ports.js";
export { canonicalUrl, rankEvidence, usablePrices, type RankedEvidence } from "./research/ranking.js";
export { fetchEcbRates, toEur, type FxRates } from "./research/fx.js";

export {
  BilledFailure,
  TruncatedBeforeAnswerError,
  usageOfFailure,
  type FailureUsage,
} from "./domain/errors.js";

export { CloudflareProvider, type WorkersAIBinding } from "./providers/cloudflare.js";
export { GeminiProvider } from "./providers/gemini.js";
export { groqProvider, openRouterProvider } from "./providers/openai-compatible.js";

export { margin, priceForMargin, relativeGap, spread } from "./tools/economics.js";
export {
  coverage,
  detectAnomalies,
  restockQuantity,
  trend,
  velocity,
  type AnomalyReport,
} from "./tools/series.js";

export { fingerprint } from "./lib/hash.js";
export { sanitize, sanitizeMessages } from "./lib/privacy.js";
export { parseModelJson } from "./lib/json.js";

export type { ProductAnalyzeInput, ProductAnalyzeOutput } from "./skills/product-analyze.js";
export type { PriceRecommendInput, PriceRecommendOutput } from "./skills/price-recommend.js";
export type { RestockInput, RestockOutput } from "./skills/restock-recommend.js";
export type { AnomalyInput, AnomalyOutput } from "./skills/anomaly-detect.js";
export type {
  MarketResearchInput,
  MarketResearchOutput,
  Observation,
} from "./skills/market-research.js";
export type {
  SupplierCandidate,
  SupplierFindInput,
  SupplierFindOutput,
} from "./skills/supplier-find.js";
