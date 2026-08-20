import type { DailyUsage } from "../core/budget.js";
import type { DataClass, Evidence, Impact, ProviderId } from "../domain/types.js";

/**
 * Ce que le panel attend de la persistance.
 *
 * Trois ports, trois responsabilités qui ne se mélangent pas : compter,
 * mémoriser, tracer. Le paquet n'importe ni D1 ni KV — c'est le Worker qui
 * fournit les implémentations, et les tests qui fournissent des versions en
 * mémoire.
 */

/* ------------------------------------------------------------------ */
/* Compter — le registre de consommation                               */
/* ------------------------------------------------------------------ */

export interface UsageEntry {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Coût converti, y compris pour les fournisseurs hors Cloudflare. */
  neurons: number;
  webSearch: boolean;
}

export interface UsageRow extends UsageEntry {
  /** AAAA-MM-JJ, UTC — la journée telle que Cloudflare la remet à zéro. */
  day: string;
  requests: number;
}

export interface UsageLedger {
  /**
   * Consommation du jour, agrégée. Lue UNE fois par exécution : le routeur en
   * a besoin pour chaque modèle candidat, et interroger la base par candidat
   * gaspillerait le quota de lectures D1 sans rien apporter.
   */
  today(): Promise<DailyUsage>;
  record(entry: UsageEntry): Promise<void>;
  /** Détail par modèle, pour l'écran de réglages. */
  breakdown(day?: string): Promise<UsageRow[]>;
}

/* ------------------------------------------------------------------ */
/* Mémoriser — le cache de résultats                                   */
/* ------------------------------------------------------------------ */

/**
 * Cache des résultats de skills.
 *
 * Volontairement en base plutôt qu'en KV : l'offre gratuite KV plafonne à
 * 1 000 écritures par jour, partagées avec le reste de l'application, alors
 * que D1 en autorise 100 000. Chaque exécution de skill écrivant une entrée,
 * le cache aurait consommé à lui seul tout le quota KV.
 */
export interface ResultCache {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Supprime les entrées expirées. Appelé par le cron quotidien. */
  purge(): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Tracer — le journal des exécutions                                  */
/* ------------------------------------------------------------------ */

export interface RunStart {
  id: string;
  skill: string;
  skillVersion: string;
  dataClass: DataClass;
  impact: Impact;
  /** Empreinte de l'entrée : permet de repérer deux demandes identiques. */
  inputHash: string;
  automatic: boolean;
}

export interface RunSuccess {
  id: string;
  provider: ProviderId | null;
  model: string | null;
  confidence: number | null;
  neurons: number;
  evidence: Evidence[];
}

export interface RunJournal {
  start(run: RunStart): Promise<void>;
  succeed(run: RunSuccess): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}
