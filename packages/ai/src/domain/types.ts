import type { ResearchRequest } from "../research/ports.js";
import type { ResearchResult } from "../research/engine.js";

/**
 * Vocabulaire du panel d'IA.
 *
 * Ce fichier ne dépend de rien : ni de Cloudflare, ni de D1, ni d'un
 * fournisseur. C'est ce qui permet de tester l'orchestrateur en mémoire, avec
 * de faux modèles, sans clé ni réseau.
 */

/**
 * Sensibilité de la donnée envoyée au modèle. C'est la contrainte la plus
 * forte du routage : elle s'applique AVANT la qualité, avant le budget, avant
 * tout. Un modèle peut être meilleur et gratuit, s'il n'a pas le droit de voir
 * la donnée il n'est pas candidat.
 *
 *   customer — contenu écrit par un acheteur (message, avis, adresse).
 *   internal — nos chiffres : coûts, marges, stocks, ventes.
 *   public   — une requête de recherche marché, un prix affiché sur une annonce.
 */
export type DataClass = "public" | "internal" | "customer";

/**
 * Ce que coûte une erreur, pas ce que coûte l'appel. Une recommandation de
 * prix appliquée à tout un catalogue est « high » ; un étiquetage de message
 * est « low ». Sert à justifier un modèle plus lourd.
 */
export type Impact = "low" | "medium" | "high";

/** Intention de routage, exprimée par la skill et non par le modèle. */
export type RouteHint = "fast" | "balanced" | "deep" | "research";

export type Capability =
  | "classify"
  | "structured"
  | "reasoning"
  | "deep_reasoning"
  | "vision"
  | "web_search";

export type ProviderId = "cloudflare" | "gemini" | "groq" | "openrouter";

/**
 * Ce que le fournisseur a le droit de voir.
 *
 *   trusted_customer — hébergé par Cloudflare, sur notre compte. Le contenu
 *                      ne sert pas à entraîner un modèle tiers.
 *   sanitized_only   — fournisseur externe. Nos chiffres peuvent y aller après
 *                      passage par le nettoyeur, jamais le texte d'un client.
 *   public_only      — ne reçoit que ce qui est déjà public sur le web.
 */
export type Privacy = "trusted_customer" | "sanitized_only" | "public_only";

export interface ModelDescriptor {
  provider: ProviderId;
  model: string;
  capabilities: Capability[];
  privacy: Privacy;
  /**
   * 0–100. Jugement éditorial servant à départager deux modèles également
   * autorisés — ce n'est pas une mesure, et ça se corrige à l'usage.
   */
  quality: number;
  /** 0–100. Idem : ordre de grandeur de la latence ressentie. */
  speed: number;
  /**
   * Prix public affiché par le fournisseur, en dollars par million de jetons.
   *
   * Aucun de ces dollars n'est dépensé : tout le panel tient dans les offres
   * gratuites. Le prix sert exclusivement à CONVERTIR une consommation en
   * neurones Cloudflare (voir `neuronsFor`), donc à savoir combien il reste
   * d'allocation gratuite. Sans lui, on ignorerait qu'une comparaison visuelle
   * coûte dix fois une classification.
   */
  price: { input: number; output: number };
  note: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** Une observation datée et sourcée. Sans URL ni date, elle n'existe pas. */
export interface Evidence {
  url: string;
  title?: string | undefined;
  kind: "internal" | "marketplace_api" | "supplier_api" | "search" | "page";
  observedAt: string;
  snippet?: string | undefined;
  /** Centimes. */
  price?: number | null | undefined;
  currency?: string | null | undefined;
  imageUrls?: string[] | undefined;
  /**
   * Ventes affichées par la page, quand elle en affiche.
   *
   * Etsy publie « 1 240 ventes », eBay « 37 vendus », Amazon parfois « acheté
   * 50 fois le mois dernier ». C'est la seule mesure de volume accessible sans
   * abonnement à un outil d'espionnage — et elle change tout : un concurrent à
   * 3 € qui a vendu deux fois n'est pas un concurrent, un autre à 12 € qui en a
   * vendu mille dit où est le marché.
   *
   * Null quand la page n'en dit rien, ce qui est le cas le plus fréquent.
   */
  salesCount?: number | null | undefined;
  reliability?: number | undefined;
}

export interface ProviderRequest {
  messages: AIMessage[];
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** Demande une réponse JSON stricte quand le fournisseur sait le faire. */
  json?: boolean | undefined;
  webSearch?: boolean | undefined;
}

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Coût réel annoncé par le fournisseur, quand il le donne.
   *
   * Workers AI renvoie `usage.neurons` dans chaque réponse : c'est sa propre
   * comptabilité, celle qui décrémente l'allocation. On la préfère toujours à
   * notre conversion, qui n'est qu'un calcul de repli — et qui deviendrait
   * fausse le jour où Cloudflare change un tarif.
   */
  neurons?: number | undefined;
  /** Renseigné uniquement par les fournisseurs à ancrage web. */
  sources?: Evidence[] | undefined;
}

/** Le seul contrat qu'un fournisseur doit remplir. Trois membres, volontairement. */
export interface AIProvider {
  readonly id: ProviderId;
  /** Faux quand la clé manque : le modèle est alors écarté sans être tenté. */
  configured(): boolean;
  generate(model: ModelDescriptor, request: ProviderRequest): Promise<ProviderResponse>;
}

export interface ExecutionRequest {
  capabilities: Capability[];
  dataClass: DataClass;
  messages: AIMessage[];
  impact?: Impact | undefined;
  hint?: RouteHint | undefined;
  json?: boolean | undefined;
  webSearch?: boolean | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** Vrai pour un travail déclenché par le cron : consomme le budget réduit. */
  automatic?: boolean | undefined;
  prefer?: ProviderId[] | undefined;
}

export interface ExecutionResult {
  text: string;
  parsed: unknown;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Coût converti en neurones Cloudflare, y compris pour les autres fournisseurs. */
  neurons: number;
  sources: Evidence[];
  /** Chaque tentative, dans l'ordre. C'est ce qu'on lit quand une skill dérape. */
  trace: string[];
}

/**
 * Une skill : des instructions métier et de l'orchestration. Rien d'autre.
 *
 * Elle n'a pas le droit d'appeler une place de marché, d'écrire en base, ni de
 * décider seule d'une mutation. Elle lit un contexte résolu côté serveur,
 * calcule ce qui est calculable, demande au modèle d'interpréter le reste, et
 * renvoie une recommandation.
 */
export interface Skill<I = unknown, O = unknown> {
  name: string;
  version: string;
  description: string;
  dataClass: DataClass;
  impact: Impact;
  /** 0 désactive le cache. Sinon, durée de validité du résultat en secondes. */
  cacheTtl: number;
  /**
   * Durée de validité ajustée au résultat obtenu.
   *
   * Une même skill peut produire une réponse solide et une réponse creuse, et
   * les garder aussi longtemps l'une que l'autre est une faute. Une recherche
   * marché qui n'a rien trouvé parce qu'une clé manquait doit expirer vite :
   * sinon, après avoir corrigé la configuration, on revoit le même vide
   * pendant des heures et l'on croit la correction sans effet.
   *
   * Absente, `cacheTtl` s'applique tel quel.
   */
  cacheTtlFor?(result: O): number;
  execute(input: I, ctx: SkillContext): Promise<O>;
}

export interface SkillContext {
  /** Les faits métier, résolus côté serveur depuis des identifiants. */
  catalogue: Catalogue;
  run(request: ExecutionRequest): Promise<ExecutionResult>;
  /**
   * Collecte de preuves externes : nos données, les API officielles, puis le
   * web en dernier recours. Une skill ne cherche jamais elle-même — elle
   * demande, et le moteur décide jusqu'où descendre.
   */
  research(request: ResearchRequest): Promise<ResearchResult>;
  /** Horloge injectée : une skill qui lit `Date.now()` n'est pas testable. */
  now(): number;
}

/* ------------------------------------------------------------------ */
/* Faits métier — résolus côté serveur, jamais envoyés par le navigateur */
/* ------------------------------------------------------------------ */

export interface ListingFacts {
  shopId: string;
  shopName: string;
  platform: string;
  externalId: string;
  /** Centimes. */
  price: number;
  currency: string;
  quantity: number;
  status: string;
  url: string | null;
  imageUrl: string | null;
}

export interface ProductFacts {
  productId: string;
  sku: string;
  title: string;
  description: string | null;
  /** Centimes. Null quand le prix d'achat n'a jamais été saisi. */
  costPrice: number | null;
  /** Centimes. Prix de vente de référence. */
  referencePrice: number;
  images: string[];
  tags: string[];
  listings: ListingFacts[];
  onHand: number;
  reserved: number;
}

export interface SalesPoint {
  /** AAAA-MM-JJ, UTC. */
  date: string;
  units: number;
  /** Centimes. */
  revenue: number;
}

/**
 * Port de lecture des faits métier.
 *
 * Le navigateur envoie un identifiant, jamais un chiffre. Sans cette règle,
 * n'importe qui pourrait annoncer un prix d'achat de 1 centime et obtenir une
 * recommandation de prix absurde mais parfaitement argumentée.
 */
export interface Catalogue {
  product(productId: string): Promise<ProductFacts | undefined>;
  salesSeries(productId: string, days: number): Promise<SalesPoint[]>;
  /** Tous les produits, pour les analyses de portefeuille et l'autonomie. */
  portfolio(): Promise<ProductFacts[]>;
}
