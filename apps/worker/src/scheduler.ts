import { drizzle } from "drizzle-orm/d1";
import { and, eq, lte, sql, isNotNull, lt } from "drizzle-orm";
import type { QueueTask, SyncResource } from "@hub/core";
import { syncJob, shop, oauthToken, eventLog } from "./db/schema.js";
import type { Env } from "./env.js";
import { randomId } from "./lib/crypto.js";
import { sendPushToUser } from "./lib/push.js";

/**
 * ORDONNANCEUR — déclenché par les cron triggers.
 *
 * Règle absolue : le cron n'appelle JAMAIS une API de place de marché.
 * Il dispose de 10 ms de CPU et de 50 sous-requêtes ; une synchronisation
 * complète en demanderait des centaines. Il se contente de lire quelles tâches
 * sont dues et de les empiler dans la Queue, où chaque message obtiendra sa
 * propre invocation — et donc son propre budget de 50 sous-requêtes.
 *
 * Trois horaires, trois rôles (plan gratuit : 5 déclencheurs maximum) :
 *   toutes les 5 min   commandes et stock des boutiques dues
 *   à h+17             rafraîchissement préventif des jetons OAuth
 *   à 03h40 UTC        catalogue complet, purge du journal, alerte de réautorisation
 *
 * Les expressions cron exactes sont dans wrangler.jsonc et dans le `switch`
 * ci-dessous — volontairement pas répétées ici : une expression cron contient
 * la séquence qui termine un commentaire de bloc.
 */

/** Plafond par tick : garde-fou contre l'épuisement du quota de 10 000 ops/jour. */
const MAX_TASKS_PER_TICK = 20;

export async function handleScheduled(
  event: ScheduledController,
  env: Env,
): Promise<void> {
  switch (event.cron) {
    case "*/5 * * * *":
      await enqueueDueJobs(env);
      break;
    case "17 * * * *":
      await refreshExpiringTokens(env);
      break;
    case "40 3 * * *":
      await enqueueDueJobs(env, true);
      await purgeOldLogs(env);
      await warnAboutReauth(env);
      break;
  }
}

/** Empile les tâches dues. `force` inclut aussi le catalogue complet. */
async function enqueueDueJobs(env: Env, force = false): Promise<void> {
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);

  const due = await db
    .select({
      id: syncJob.id,
      shopId: syncJob.shopId,
      resource: syncJob.resource,
      cursor: syncJob.cursor,
      intervalSec: syncJob.intervalSec,
      failureCount: syncJob.failureCount,
    })
    .from(syncJob)
    .innerJoin(shop, eq(shop.id, syncJob.shopId))
    .where(
      and(
        eq(syncJob.enabled, 1),
        eq(shop.status, "active"),
        force ? sql`1=1` : lte(syncJob.nextRunAt, now),
      ),
    )
    .limit(MAX_TASKS_PER_TICK);

  if (due.length === 0) return;

  // sendBatch = UNE sous-requête pour jusqu'à 100 messages.
  const messages = due.map((j) => ({
    body: {
      kind: "sync",
      shopId: j.shopId,
      resource: j.resource as SyncResource,
      cursor: j.cursor,
      depth: 0,
    } satisfies QueueTask,
  }));
  await env.SYNC_QUEUE.sendBatch(messages);

  // Replanification immédiate : si le traitement échoue, le consommateur
  // ramènera nextRunAt en arrière. On évite ainsi d'empiler deux fois la même
  // tâche quand un tick est plus lent que prévu.
  await db.batch(
    due.map((j) =>
      db
        .update(syncJob)
        .set({
          lastRunAt: now,
          nextRunAt: now + backoff(j.intervalSec, j.failureCount),
        })
        .where(eq(syncJob.id, j.id)),
    ) as never,
  );
}

/** Repli exponentiel plafonné à 6 h : une boutique en panne ne sature pas la queue. */
function backoff(intervalSec: number, failures: number): number {
  if (failures === 0) return intervalSec;
  return Math.min(intervalSec * 2 ** failures, 6 * 3600);
}

/**
 * Rafraîchit les jetons dont l'accès expire dans moins de 2 h.
 * Passe par la Queue : le rafraîchissement est un appel réseau, donc jamais
 * dans le cron lui-même.
 */
async function refreshExpiringTokens(env: Env): Promise<void> {
  const db = drizzle(env.DB);
  const horizon = Math.floor(Date.now() / 1000) + 2 * 3600;

  const soon = await db
    .select({ shopId: oauthToken.shopId })
    .from(oauthToken)
    .innerJoin(shop, eq(shop.id, oauthToken.shopId))
    .where(
      and(
        eq(shop.status, "active"),
        isNotNull(oauthToken.accessExpiresAt),
        lt(oauthToken.accessExpiresAt, horizon),
      ),
    )
    .limit(20);

  if (soon.length === 0) return;

  // Une synchronisation « inventory » légère force le passage par
  // getValidAccessToken(), qui rafraîchit au besoin. Un seul chemin de code
  // pour le rafraîchissement, donc un seul endroit où il peut être faux.
  await env.SYNC_QUEUE.sendBatch(
    soon.map((s) => ({
      body: {
        kind: "sync",
        shopId: s.shopId,
        resource: "inventory" as const,
        cursor: null,
        depth: 0,
      } satisfies QueueTask,
    })),
  );
}

/** Le journal est utile 30 jours ; au-delà il ne fait que consommer les 5 Go. */
async function purgeOldLogs(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  const db = drizzle(env.DB);
  await db.delete(eventLog).where(lt(eventLog.at, cutoff));
}

/**
 * Alerte de réautorisation.
 *
 * Le scénario qu'on veut absolument éviter : le refresh_token Etsy atteint ses
 * 90 jours pendant des vacances, et toute la synchronisation Etsy meurt en
 * silence. À 14 jours de l'échéance, on envoie une notification push.
 */
async function warnAboutReauth(env: Env): Promise<void> {
  const db = drizzle(env.DB);
  const horizon = Math.floor(Date.now() / 1000) + 14 * 86400;

  const expiring = await db
    .select({ name: shop.displayName, platform: shop.platform })
    .from(oauthToken)
    .innerJoin(shop, eq(shop.id, oauthToken.shopId))
    .where(
      and(
        isNotNull(oauthToken.refreshExpiresAt),
        lt(oauthToken.refreshExpiresAt, horizon),
      ),
    );

  for (const e of expiring) {
    await db.insert(eventLog).values({
      id: randomId(),
      at: Math.floor(Date.now() / 1000),
      level: "warn",
      scope: `auth:${e.platform}`,
      shopId: null,
      message: `Réautorisation requise sous 14 jours : ${e.name}`,
      data: null,
    });
  }

  if (expiring.length > 0) {
    await sendPushToUser(env, {
      title: "Reconnexion nécessaire",
      body: `${expiring.map((e) => e.name).join(", ")} : l'autorisation expire bientôt.`,
      url: "/settings/shops",
      tag: "reauth",
    });
  }
}
