import { DurableObject } from "cloudflare:workers";
import {
  hashPassword,
  verifyPassword,
  type PasswordRecord,
} from "../lib/password.js";

/**
 * Un Durable Object par couple (plateforme, boutique).
 *
 * Il rend deux services que rien d'autre ne peut rendre correctement dans un
 * environnement sans état :
 *
 * 1. UN SEUL COMPTEUR DE DÉBIT. Plusieurs invocations du consommateur de queue
 *    tournent en parallèle ; sans point de rendez-vous elles dépasseraient les
 *    quotas des plateformes (Etsy : 10 req/s et 10 000/jour) et se feraient
 *    bannir. Le DO est ce point de rendez-vous : un seul existe par boutique,
 *    partout dans le monde.
 *
 * 2. UN VERROU DE RAFRAÎCHISSEMENT OAUTH. Si deux tâches constatent en même
 *    temps qu'un jeton eBay a expiré, elles déclenchent deux rafraîchissements
 *    concurrents : le second invalide le premier et la boutique tombe en panne.
 *    `withRefreshLock` sérialise l'opération.
 *
 * Plan gratuit : uniquement le backend SQLite (`new_sqlite_classes` dans
 * wrangler.jsonc). 100 000 requêtes/jour, alarmes incluses.
 */

interface BucketState {
  /** Jetons disponibles (réel, fractionnaire). */
  tokens: number;
  /** Dernier remplissage, en millisecondes. */
  refilledAt: number;
  /** Compteur journalier et date UTC associée. */
  dayCount: number;
  daySlot: string;
}

export interface AcquireResult {
  ok: boolean;
  /** Combien de millisecondes attendre avant de retenter. */
  waitMs: number;
  reason?: "qps" | "qpd";
}

export class RateLimiter extends DurableObject {
  /**
   * Tente de consommer `cost` jetons.
   *
   * Retourne `ok: false` plutôt que d'attendre : le budget CPU d'une invocation
   * de Worker gratuite est de 10 ms, on ne bloque jamais. L'appelant remet le
   * message dans la queue avec le délai indiqué (`retry({ delaySeconds })`).
   */
  async acquire(
    cost: number,
    qps: number,
    burst: number,
    qpd: number,
  ): Promise<AcquireResult> {
    const now = Date.now();
    const daySlot = new Date(now).toISOString().slice(0, 10);

    const s: BucketState = (await this.ctx.storage.get<BucketState>("bucket")) ?? {
      tokens: burst,
      refilledAt: now,
      dayCount: 0,
      daySlot,
    };

    // Nouveau jour UTC → le compteur journalier repart de zéro.
    if (s.daySlot !== daySlot) {
      s.daySlot = daySlot;
      s.dayCount = 0;
    }

    if (qpd > 0 && s.dayCount + cost > qpd) {
      const midnight = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1,
      );
      await this.ctx.storage.put("bucket", s);
      return { ok: false, waitMs: midnight - now, reason: "qpd" };
    }

    // Remplissage continu du seau.
    const elapsedSec = (now - s.refilledAt) / 1000;
    s.tokens = Math.min(burst, s.tokens + elapsedSec * qps);
    s.refilledAt = now;

    if (s.tokens < cost) {
      const waitMs = Math.ceil(((cost - s.tokens) / qps) * 1000);
      await this.ctx.storage.put("bucket", s);
      return { ok: false, waitMs, reason: "qps" };
    }

    s.tokens -= cost;
    s.dayCount += cost;
    await this.ctx.storage.put("bucket", s);
    return { ok: true, waitMs: 0 };
  }

  /** Consommation observée, pour l'affichage dans le tableau de bord. */
  async stats(): Promise<BucketState | null> {
    return (await this.ctx.storage.get<BucketState>("bucket")) ?? null;
  }

  /**
   * Verrou coopératif de rafraîchissement OAuth.
   * `blockConcurrencyWhile` garantit qu'aucune autre requête n'entre dans cet
   * objet pendant l'exécution — c'est un mutex sans base de données.
   */
  async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(fn);
  }

  /** Remet le seau à plat — utile après une erreur de configuration. */
  async reset(): Promise<void> {
    await this.ctx.storage.delete("bucket");
  }

  /* ------------------------------------------------------------------ */
  /* Hachage des mots de passe                                          */
  /* ------------------------------------------------------------------ */

  /**
   * POURQUOI LE HACHAGE VIT ICI ET NON DANS LE WORKER.
   *
   * PBKDF2 est délibérément lent : c'est ce qui le rend utile. À 100 000
   * itérations il consomme de l'ordre de 50 ms de CPU — cinq fois le budget
   * de 10 ms qu'un Worker reçoit sur le plan gratuit. La vérification
   * échouerait donc en production, alors qu'elle passe en développement local
   * où la limite n'est pas appliquée : exactement le genre de panne qui ne se
   * découvre qu'après la mise en ligne.
   *
   * Les Durable Objects suivent un modèle différent : 30 secondes de CPU par
   * invocation, y compris sur le plan gratuit. C'est le seul endroit de cette
   * architecture où une opération coûteuse en calcul peut s'exécuter.
   *
   * L'objet sollicité est déjà celui qui limite les tentatives de connexion :
   * aucune infrastructure supplémentaire n'est nécessaire.
   */
  async checkPassword(
    password: string,
    record: PasswordRecord,
  ): Promise<boolean> {
    return verifyPassword(password, record);
  }

  async makePassword(password: string): Promise<PasswordRecord> {
    return hashPassword(password);
  }
}
