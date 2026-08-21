import { api } from "./api.js";

/**
 * Client du panel d'IA.
 *
 * Les types reproduisent les réponses du serveur, en français comme elles.
 * Traduire en chemin inverserait la charge : chaque champ ajouté côté serveur
 * demanderait une correspondance ici, et la première faute de frappe passerait
 * inaperçue jusqu'à l'affichage.
 */

/* ------------------------------- État ------------------------------- */

export interface PanelHealth {
  fournisseurs: Array<{
    id: "cloudflare" | "gemini" | "groq" | "openrouter";
    configure: boolean;
    modeles: string[];
    appelsAujourdhui: number;
    plafond: number | null;
  }>;
  neurones: {
    consommes: number;
    alloues: number;
    restants: number;
    equivalentUsd: number;
  };
  /** Moteurs de recherche branchés, et s'ils répondent encore ce mois-ci. */
  sourcesDeRecherche: Array<{ id: string; disponible: boolean }>;
  rechercheWeb: {
    /** Le plafond Google se compte au MOIS : 5 000 partages entre les modeles 3.x. */
    consommeesCeMois: number;
    consommeesAujourdhui: number;
    plafondMensuel: number;
    reserveManuelle: number;
  };
}

export interface AnalysableProduct {
  productId: string;
  sku: string;
  title: string;
  costPrice: number | null;
  referencePrice: number;
  onHand: number;
  reserved: number;
  /** Nombre d'annonces rattachées. Zéro = aucune vitrine reliée par SKU. */
  canaux: number;
}

/* ----------------------------- Résultats ---------------------------- */

export interface RunEnvelope<T> {
  runId: string;
  skill: string;
  version: string;
  /** Vrai quand la réponse vient du cache : aucun modèle n'a été appelé. */
  cached: boolean;
  neurons: number;
  provider: string | null;
  model: string | null;
  /**
   * Chaque modèle tenté, dans l'ordre. Affiché repliable : c'est le seul
   * endroit où l'on voit qu'une analyse s'est rabattue du modèle économe vers
   * le modèle lourd, et a donc coûté plusieurs fois plus cher que prévu.
   */
  trace: string[];
  result: T;
}

export interface Velocity {
  perDay: number;
  totalUnits: number;
  totalRevenue: number;
  days: number;
  activeDays: number;
}

export interface Coverage {
  days: number | null;
  onHand: number;
  available: number;
  low: boolean;
}

export interface Trend {
  change: number | null;
  firstHalfUnits: number;
  secondHalfUnits: number;
}

export interface PriceSpread {
  min: number;
  max: number;
  median: number;
  count: number;
}

export interface MarginResult {
  net: number | null;
  margin: number | null;
  marginRate: number | null;
  unknowns: string[];
}

export interface ProductAnalysis {
  produit: { sku: string; titre: string };
  mesures: {
    ventes: Velocity;
    couverture: Coverage;
    tendance: Trend;
    prix: PriceSpread | null;
    marge: MarginResult | null;
  };
  analyse: {
    conclusion: string;
    forces: string[];
    risques: string[];
    actions: string[];
    confidence: number;
  };
  inconnues: string[];
}

export interface PriceAdvice {
  produit: { sku: string; titre: string };
  actuel: { prix: PriceSpread | null; margeMediane: MarginResult | null; ventesParJour: number };
  plancherCentimes: number | null;
  recommandation: {
    direction: "monter" | "baisser" | "maintenir";
    prixCentimes: number | null;
    ajusteAuPlancher: boolean;
    ecartAuPrixActuel: number | null;
    justification: string;
    confidence: number;
  };
  inconnues: string[];
}

export interface RestockAdvice {
  produit: { sku: string; titre: string };
  mesures: { ventes: Velocity; couverture: Coverage; tendance: Trend };
  quantiteCalculee: number | null;
  jusquaRupture: number | null;
  recommandation: {
    urgence: "immediat" | "bientot" | "surveiller" | "aucune";
    justification: string;
    reserves: string[];
    confidence: number;
  };
}

export interface AnomalyReport {
  produit: { sku: string; titre: string };
  rapport: {
    mean: number;
    stdDev: number;
    usable: boolean;
    note?: string;
    anomalies: Array<{ date: string; units: number; z: number; direction: "haut" | "bas" }>;
  };
  explication?: { resume: string; pistes: string[]; confidence: number };
  sansAppelModele: boolean;
}

export interface Observation {
  url: string;
  titre: string | null;
  /** Centimes d'euro, converti sur les taux BCE. Null si non convertible. */
  prixEur: number | null;
  /** Prix tel qu'affiché sur la page, dans sa devise. */
  prixOrigine: number | null;
  devise: string | null;
  source: "internal" | "marketplace_api" | "supplier_api" | "search" | "page";
  observeLe: string;
  fiabilite: number;
  note: string | null;
}

export interface Provenance {
  couches: string[];
  rechercheWebUtilisee: boolean;
  tauxPublicsDu: string | null;
  cache: boolean;
}

export interface MarketResearch {
  produit: { sku: string; titre: string };
  requete: string;
  observations: Observation[];
  marche: PriceSpread | null;
  notre: { prixMedianEur: number | null; ecartAuMarche: number | null };
  lecture: {
    position: "au-dessus" | "dans le marché" | "en dessous" | "indéterminée";
    resume: string;
    confidence: number;
  };
  provenance: Provenance;
  avertissements: string[];
}

export interface SupplierCandidate {
  url: string;
  nom: string | null;
  prixUnitaireEur: number | null;
  devise: string | null;
  moq: number | null;
  portConnu: boolean;
  fiabilite: number;
  observeLe: string;
  pourquoi: string | null;
}

export interface SupplierSearch {
  produit: { sku: string; titre: string };
  requete: string;
  candidats: SupplierCandidate[];
  fourchette: PriceSpread | null;
  prixAchatActuel: number | null;
  lecture: { resume: string; reserves: string[]; confidence: number };
  provenance: Provenance;
  avertissements: string[];
}

/**
 * Le site d'où vient une observation, en clair.
 *
 * Affiché partout où un prix l'est : c'est le domaine, bien plus que le titre
 * de la page, qui dit si le prix est comparable au nôtre. « 3,74 € sur
 * etsy.com » et « 3,74 € sur amazon.fr » ne racontent pas la même histoire, et
 * un prix de brocante sur leboncoin n'a rien à voir avec du neuf en boutique.
 *
 * Le « www. » saute : il n'apporte rien et vole de la place sur un téléphone.
 */
export function domaine(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 30);
  }
}

/** Les sites distincts consultés, du plus fréquent au moins. */
export function sitesConsultes(observations: Observation[]): string[] {
  const compte = new Map<string, number>();
  for (const o of observations) {
    if (o.source === "internal") continue;
    const d = domaine(o.url);
    compte.set(d, (compte.get(d) ?? 0) + 1);
  }
  return [...compte.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

/** Une preuve interne n'est pas un lien : c'est une référence à notre base. */
export const estLienExterne = (url: string): boolean => /^https?:\/\//i.test(url);

/** Date d'observation, format court. */
export function observeeLe(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date inconnue";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" }).format(d);
}

/** Réponse du serveur quand plus aucun modèle gratuit n'est disponible. */
export interface QuotaExhausted {
  error: "quota_gratuit_epuise";
  message: string;
  trace: string[];
}

/* ------------------------------ Appels ------------------------------ */

export const SKILLS = {
  analyse: "product.analyze",
  prix: "product.price.recommend",
  reappro: "product.restock.recommend",
  anomalies: "metrics.anomaly.detect",
  marche: "market.price.research",
  fournisseurs: "supplier.find",
} as const;

export type SkillKey = keyof typeof SKILLS;

export const SKILL_LABELS: Record<SkillKey, { titre: string; detail: string }> = {
  analyse: {
    titre: "Analyser",
    detail: "Ventes, stock, marge et prix par canal, interprétés ensemble.",
  },
  prix: {
    titre: "Conseiller un prix",
    detail: "Prix unique cohérent, jamais en dessous du seuil de marge.",
  },
  reappro: {
    titre: "Réapprovisionner",
    detail: "Quantité à commander et urgence, calculées sur le rythme réel.",
  },
  anomalies: {
    titre: "Chercher des anomalies",
    detail: "Jours de vente hors norme, et pistes à vérifier.",
  },
  marche: {
    titre: "Comparer au marché",
    detail: "À quel prix ce produit se vend ailleurs, avec la source de chaque prix.",
  },
  fournisseurs: {
    titre: "Trouver des fournisseurs",
    detail: "Qui le fournit, à quel prix unitaire, et sur quelle page c'est écrit.",
  },
};

/**
 * Skills qui vont chercher dehors.
 *
 * Distinguées parce qu'elles se comportent différemment sans clé Gemini : elles
 * répondent quand même, mais uniquement sur nos propres données. L'écran doit
 * le dire avant le clic, pas après.
 */
export const SKILLS_EXTERIEURES: SkillKey[] = ["marche", "fournisseurs"];

/* ------------------------- Travaux différés ------------------------- */

export type JobStatus = "queued" | "running" | "success" | "failed";

export interface JobState<T = unknown> {
  jobId: string;
  skill: string;
  status: JobStatus;
  result: RunEnvelope<T> | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/**
 * Lance une analyse et rend la main immédiatement.
 *
 * Le serveur empile le travail et renvoie un identifiant. C'est ce qui permet
 * de fermer l'application : le travail continue sur Cloudflare, et le résultat
 * attend le retour. Un appel direct, lui, mourrait avec l'onglet — et sur
 * iPhone, verrouiller l'écran suffit à suspendre la page.
 */
export function startJob(
  skill: string,
  input: Record<string, unknown>,
  bypassCache = false,
): Promise<{ jobId: string; status: JobStatus }> {
  return api.post<{ jobId: string; status: JobStatus }>("/ai/jobs", {
    skill,
    input,
    bypassCache,
  });
}

export function readJob<T>(jobId: string): Promise<JobState<T>> {
  return api.get<JobState<T>>(`/ai/jobs/${jobId}`);
}

export const isTerminal = (status: JobStatus): boolean =>
  status === "success" || status === "failed";

/* --------------------- Mémoire locale des travaux -------------------- */

/**
 * Les travaux en cours, retenus par le navigateur.
 *
 * Sans cette mémoire, « partir et revenir » ne fonctionne pas : à la
 * réouverture de l'application, l'identifiant du travail serait perdu et le
 * résultat resterait invisible alors qu'il existe sur le serveur.
 *
 * On y garde aussi les travaux TERMINÉS, jusqu'à ce que l'utilisateur les
 * écarte. Un résultat qui disparaît dès qu'on quitte l'écran ne vaut guère
 * mieux que pas de résultat du tout.
 */
const CLE = "markethub:ia:travaux";
const MAX_MEMORISES = 8;

export interface RememberedJob {
  jobId: string;
  skill: SkillKey;
  productId: string;
  productTitle: string;
  /** Millisecondes, horloge du navigateur. Sert à afficher la durée écoulée. */
  startedAt: number;
}

export function rememberedJobs(): RememberedJob[] {
  try {
    const raw = window.localStorage.getItem(CLE);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v): v is RememberedJob =>
        typeof v === "object" && v !== null && typeof (v as RememberedJob).jobId === "string",
    );
  } catch {
    // Stockage indisponible (navigation privée) ou contenu corrompu : on
    // repart de zéro plutôt que de faire échouer l'écran.
    return [];
  }
}

function write(jobs: RememberedJob[]): void {
  try {
    window.localStorage.setItem(CLE, JSON.stringify(jobs.slice(0, MAX_MEMORISES)));
  } catch {
    /* Stockage plein ou refusé : l'écran reste utilisable dans la session. */
  }
}

export function rememberJob(job: RememberedJob): RememberedJob[] {
  const jobs = [job, ...rememberedJobs().filter((j) => j.jobId !== job.jobId)];
  write(jobs);
  return jobs.slice(0, MAX_MEMORISES);
}

export function forgetJob(jobId: string): RememberedJob[] {
  const jobs = rememberedJobs().filter((j) => j.jobId !== jobId);
  write(jobs);
  return jobs;
}

/** Durée écoulée, en toutes lettres. « 8 s », « 2 min ». */
export function elapsed(sinceMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (s < 90) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

/**
 * Message à afficher pour un échec d'analyse.
 *
 * Le quota gratuit épuisé mérite un traitement à part : ce n'est pas une
 * panne, il n'y a rien à réparer et rien à réessayer avant minuit UTC. Le
 * confondre avec une erreur pousserait à chercher un problème inexistant —
 * ou pire, à vouloir « débloquer » la situation en payant.
 */
export function describeFailure(error: unknown): { titre: string; detail: string } {
  const message = String(error instanceof Error ? error.message : error);

  // Deux origines, un seul message : l'échec HTTP d'une requête directe, et le
  // champ `error` d'un travail différé, que le consommateur remplit avec le
  // même vocabulaire.
  if (message.startsWith("429") || message.includes("quota_gratuit_epuise")) {
    // `api.post` remonte le corps brut après le code : on y retrouve la trace
    // du routeur, qui dit lequel des plafonds a été atteint.
    const trace = message.match(/"trace":\[(.*?)\]/)?.[1] ?? "";
    return {
      titre: "Quota gratuit épuisé",
      detail:
        "Aucun modèle gratuit n'est disponible pour le moment. Les allocations repartent à zéro à minuit UTC." +
        (trace ? ` Détail : ${trace.replace(/"/g, "").slice(0, 300)}` : ""),
    };
  }
  if (message.includes("PRODUIT_INTROUVABLE") || message.includes("produit_introuvable")) {
    return { titre: "Produit introuvable", detail: "Il a peut-être été supprimé entre-temps." };
  }
  return { titre: "L'analyse a échoué", detail: message.slice(0, 300) };
}

/* ------------------------------ Format ------------------------------ */

/**
 * Confiance en mots plutôt qu'en pourcentage.
 *
 * « 0,73 » suggère une précision que le nombre n'a pas : il vient du modèle
 * lui-même, qui s'auto-évalue avec le même aplomb qu'il ait raison ou tort.
 * Trois niveaux disent l'essentiel sans faire croire à une mesure.
 */
export function confidenceLabel(value: number): { texte: string; classe: string } {
  if (value >= 0.7) return { texte: "confiance élevée", classe: "pill pill--ok" };
  if (value >= 0.4) return { texte: "confiance moyenne", classe: "pill pill--warn" };
  return { texte: "confiance faible", classe: "pill pill--stop" };
}

export function percent(fraction: number | null): string {
  if (fraction === null) return "—";
  const value = Math.round(fraction * 100);
  return `${value > 0 ? "+" : ""}${value} %`;
}

/** Un nombre de jours, ou l'explication de son absence. */
export function days(value: number | null): string {
  return value === null ? "aucune vente" : `${value} j`;
}
