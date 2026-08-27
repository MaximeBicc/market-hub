import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, lte, sql, isNotNull, isNull, lt } from "drizzle-orm";
import type { QueueTask, SyncResource } from "@hub/core";
import {
  aiCache,
  aiEvidence,
  aiFeedback,
  aiJob,
  aiRun,
  eventLog,
  oauthToken,
  shop,
  syncJob,
} from "./db/schema.js";
import type { Env } from "./env.js";
import { d1Repositories } from "./engine/repositories.js";
import { randomId } from "./lib/crypto.js";
import { rattraperTempsReel } from "./lib/temps-reel.js";
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
 *   à 03h40 UTC        catalogue complet, purge des journaux et du cache d'analyses,
 *                      alerte de réautorisation
 *
 * Les expressions cron exactes sont dans wrangler.jsonc et dans le `switch`
 * ci-dessous — volontairement pas répétées ici : une expression cron contient
 * la séquence qui termine un commentaire de bloc.
 */

/**
 * Plafond par tick : garde-fou contre l'épuisement du quota de 10 000
 * opérations de file par jour.
 *
 * Au rythme d'une minute, 20 tâches par tick autorisent en théorie 28 800
 * messages quotidiens — au-delà du quota. Le plafond réel vient donc des
 * intervalles : avec deux ressources relevées toutes les 120 secondes, une
 * boutique produit 1 440 messages par jour, soit sept boutiques avant d'y
 * penser. Ce plafond-ci ne sert qu'à empêcher un pic si beaucoup de tâches
 * deviennent dues en même temps.
 */
const MAX_TASKS_PER_TICK = 20;

export async function handleScheduled(
  event: ScheduledController,
  env: Env,
): Promise<void> {
  /*
   * L'aiguillage se fait sur la CHAÎNE EXACTE du cron déclaré dans
   * wrangler.jsonc. Modifier l'un sans l'autre ne casse rien de visible : le
   * `switch` ne trouve simplement aucune branche, et la synchronisation
   * s'arrête sans le moindre message. Les deux fichiers doivent bouger
   * ensemble — c'est le seul couplage de ce genre dans le dépôt.
   */
  switch (event.cron) {
    // Chaque minute : c'est le plancher que Cloudflare permet, donc la
    // latence minimale d'un relevé pour les plateformes qui ne poussent rien.
    case "* * * * *":
      await enqueueDueJobs(env);
      break;
    case "17 * * * *":
      // Le rattrapage d'abord : sans échéances renseignées, le renouvellement
      // anticipé qui suit ne voit rien à renouveler.
      await backfillExpiries(env);
      await refreshExpiringTokens(env);
      /*
       * Le rattrapage du temps réel vient APRÈS le renouvellement : il parle
       * à Shopify, et un jeton fraîchement renouvelé est celui qui a le plus
       * de chances d'être accepté.
       *
       * Il ne coûte qu'une lecture de base quand tout est déjà abonné.
       */
      await rattraperTempsReel(env);
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
/**
 * Recopie les échéances manquantes hors du chiffré.
 *
 * POURQUOI C'EST NÉCESSAIRE. Les colonnes `access_expires_at` et
 * `refresh_expires_at` ont longtemps été écrites à `null` et jamais mises à
 * jour. Or les deux garde-fous ci-dessous filtrent sur `isNotNull` : ils ne se
 * déclenchaient donc pour AUCUNE boutique reliée par le moteur. Le défaut est
 * corrigé à la source — `D1CredentialRepository.put` renseigne maintenant les
 * deux colonnes — mais une ligne déjà en base reste nulle jusqu'au prochain
 * renouvellement, c'est-à-dire jusqu'à 18 mois pour eBay.
 *
 * Ce rattrapage déchiffre uniquement les lignes restées nulles, recalcule les
 * échéances et les réécrit. Il ne touche à aucune plateforme, ne consomme
 * aucun quota, et devient inopérant dès que tout est renseigné. Le laisser en
 * place le rend aussi auto-réparateur : un futur chemin d'écriture qui
 * oublierait les colonnes serait rattrapé à l'heure suivante.
 */
async function backfillExpiries(env: Env): Promise<void> {
  const db = drizzle(env.DB);
  const repos = d1Repositories(env.DB, env.MASTER_KEY);

  const nulles = await db
    .select({ shopId: oauthToken.shopId })
    .from(oauthToken)
    .where(isNull(oauthToken.accessExpiresAt))
    .limit(20);

  for (const n of nulles) {
    const c = await repos.credentials.get(n.shopId);
    // Réécrire à l'identique suffit : `put` dérive les colonnes du contenu.
    if (c && Object.keys(c).length > 0) await repos.credentials.put(n.shopId, c);
  }
}

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
  const now = Math.floor(Date.now() / 1000);
  const db = drizzle(env.DB);

  await db.delete(eventLog).where(lt(eventLog.at, now - 30 * 86400));

  // Cache d'analyses : les entrées périmées ne sont jamais servies — le filtre
  // d'expiration est dans la requête de lecture — mais elles occupent de la
  // place dans les 5 Go offerts. Une passe par nuit suffit.
  await db.delete(aiCache).where(lt(aiCache.expiresAt, now));

  // Journal des analyses : même durée que le journal d'événements. Les preuves
  // partent avec, sans quoi elles resteraient orphelines.
  const cutoff = now - 30 * 86400;
  const perimes = await db
    .select({ id: aiRun.id })
    .from(aiRun)
    .where(lt(aiRun.startedAt, cutoff))
    .limit(500);

  if (perimes.length > 0) {
    const ids = perimes.map((r) => r.id);
    await db.delete(aiEvidence).where(inArray(aiEvidence.runId, ids));
    await db.delete(aiFeedback).where(inArray(aiFeedback.runId, ids));
    await db.delete(aiRun).where(inArray(aiRun.id, ids));
  }

  // Travaux différés : sept jours suffisent, l'interface ne remonte pas plus
  // loin et un résultat d'analyse vieux d'une semaine est de toute façon faux.
  await db.delete(aiJob).where(lt(aiJob.createdAt, now - 7 * 86400));
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
