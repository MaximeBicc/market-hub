import { Hono } from "hono";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { NoFreeModelError, UnknownSkillError } from "@hub/ai";
import type { Env } from "../env.js";
import { authenticate } from "../lib/session.js";
import { buildAi } from "../ai/module.js";
import {
  aiFeedback,
  aiJob,
  aiRun,
  inventory,
  listing,
  product,
} from "../db/schema.js";
import { randomId } from "../lib/crypto.js";

/**
 * Panel d'IA — surface HTTP.
 *
 * TROIS PRINCIPES, dont aucun n'est négociable :
 *
 * 1. AUCUNE CLÉ NE SORT D'ICI. Ni entière, ni tronquée, ni « juste pour
 *    vérifier ». L'écran de réglages apprend qu'un fournisseur est configuré,
 *    jamais avec quoi.
 *
 * 2. LE NAVIGATEUR ENVOIE DES IDENTIFIANTS, PAS DES CHIFFRES. Prix d'achat,
 *    stock, ventes : tout est relu côté serveur depuis la base. Sans cette
 *    règle, il suffirait de poster un prix d'achat de un centime pour obtenir
 *    une recommandation de prix absurde et parfaitement argumentée.
 *
 * 3. QUOTA ÉPUISÉ N'EST PAS UNE PANNE. Le panel n'a aucun fournisseur payant
 *    et donc aucun repli à déclencher : on répond 429 avec un message clair,
 *    l'interface l'affiche, la journée reprend demain.
 */

export const ai = new Hono<{ Bindings: Env }>();

ai.use("*", async (c, next) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  await next();
});

const seconds = () => Math.floor(Date.now() / 1000);

/**
 * Enveloppe d'une demande d'analyse.
 *
 * `input` reste libre : chaque skill valide ce qui la concerne, et un schéma
 * central devrait être modifié à chaque skill ajoutée — exactement le couplage
 * que le registre existe pour éviter.
 */
const RunRequest = z.object({
  skill: z.string().min(1).max(80),
  input: z.record(z.string(), z.unknown()).default({}),
  bypassCache: z.boolean().optional(),
});

/** Traduit une erreur du panel en réponse HTTP compréhensible. */
function explain(error: unknown): { status: 404 | 422 | 429 | 500; body: Record<string, unknown> } {
  if (error instanceof UnknownSkillError) {
    return { status: 404, body: { error: "skill_inconnue", message: error.message } };
  }
  if (error instanceof NoFreeModelError) {
    return {
      status: 429,
      body: {
        error: "quota_gratuit_epuise",
        message:
          "Aucun modèle gratuit n'est disponible pour le moment. Les quotas repartent à zéro à minuit UTC.",
        // La trace dit précisément ce qui a bloqué : allocation de neurones,
        // plafond d'un fournisseur, clé absente. Sans elle, « quota épuisé »
        // ne se diagnostique pas.
        trace: error.trace,
      },
    };
  }
  const message = String(error);
  if (message.includes("PRODUIT_INTROUVABLE")) {
    return { status: 404, body: { error: "produit_introuvable" } };
  }
  return { status: 500, body: { error: "echec_analyse", message: message.slice(0, 300) } };
}

/* ------------------------------------------------------------------ */
/* État du panel                                                       */
/* ------------------------------------------------------------------ */

/** Ce qui est configuré, ce qui reste de gratuit aujourd'hui. Jamais une clé. */
ai.get("/health", async (c) => c.json(await buildAi(c.env).health()));

/** Catalogue des modèles : capacités et confidentialité, ni prix ni note interne. */
ai.get("/models", (c) => c.json({ modeles: buildAi(c.env).catalogue() }));

/** Skills disponibles, telles que l'interface doit les proposer. */
ai.get("/skills", (c) => c.json({ skills: buildAi(c.env).registry.list() }));

/**
 * Produits analysables.
 *
 * Ce sont les lignes de la table `product`, pas les annonces : le panel
 * raisonne sur l'article, pas sur ses vitrines. Une annonce synchronisée
 * rejoint son produit par SKU lors de la synchronisation ; celles dont le SKU
 * ne correspond à rien restent sans produit et n'apparaissent pas ici.
 */
ai.get("/products", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      productId: product.id,
      sku: product.sku,
      title: product.title,
      costPrice: product.costPrice,
      referencePrice: product.priceAmount,
      onHand: inventory.onHand,
      reserved: inventory.reserved,
      canaux: sql<number>`(SELECT count(*) FROM ${listing} WHERE ${listing.productId} = ${product.id})`,
    })
    .from(product)
    .leftJoin(inventory, eq(inventory.productId, product.id))
    .orderBy(product.title)
    .limit(300);

  return c.json({
    produits: rows.map((r) => ({
      ...r,
      onHand: r.onHand ?? 0,
      reserved: r.reserved ?? 0,
    })),
  });
});

/* ------------------------------------------------------------------ */
/* Exécution                                                           */
/* ------------------------------------------------------------------ */

/**
 * Analyse immédiate.
 *
 * Convient aux skills du premier lot : elles font un seul appel de modèle et
 * répondent en quelques secondes. Une recherche marché, qui enchaîne plusieurs
 * appels et une recherche web, devra passer par `/jobs`.
 */
ai.post("/run", async (c) => {
  const parsed = RunRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "requete_invalide" }, 422);

  try {
    return c.json(await buildAi(c.env).run(parsed.data));
  } catch (error) {
    const { status, body } = explain(error);
    return c.json(body, status);
  }
});

/**
 * Analyse différée.
 *
 * Passe par la file d'attente existante et non par une seconde file : le
 * consommateur répartit déjà par type de tâche, et le quota gratuit de 10 000
 * opérations par jour est commun à toutes les files. En ouvrir une deuxième
 * aurait ajouté une liaison et un point de panne pour le même budget.
 */
ai.post("/jobs", async (c) => {
  const parsed = RunRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "requete_invalide" }, 422);

  const module = buildAi(c.env);
  if (!module.registry.get(parsed.data.skill)) {
    return c.json({ error: "skill_inconnue" }, 404);
  }

  const id = randomId();
  await drizzle(c.env.DB).insert(aiJob).values({
    id,
    skill: parsed.data.skill,
    status: "queued",
    automatic: 0,
    input: JSON.stringify(parsed.data.input),
    createdAt: seconds(),
  });

  await c.env.SYNC_QUEUE.send({ kind: "ai", jobId: id });
  return c.json({ jobId: id, status: "queued" }, 202);
});

ai.get("/jobs/:id", async (c) => {
  const [row] = await drizzle(c.env.DB)
    .select()
    .from(aiJob)
    .where(eq(aiJob.id, c.req.param("id")))
    .limit(1);

  if (!row) return c.json({ error: "job_introuvable" }, 404);

  return c.json({
    jobId: row.id,
    skill: row.skill,
    status: row.status,
    result: row.result ? (JSON.parse(row.result) as unknown) : null,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
});

/**
 * Travaux encore en cours.
 *
 * Le navigateur retient ses propres identifiants, mais il peut les perdre :
 * cache vidé, autre appareil, réinstallation de la PWA. Cette route est le
 * filet — elle permet de retrouver un travail lancé depuis le téléphone et de
 * le consulter depuis l'ordinateur.
 */
ai.get("/jobs", async (c) => {
  const rows = await drizzle(c.env.DB)
    .select({
      jobId: aiJob.id,
      skill: aiJob.skill,
      status: aiJob.status,
      input: aiJob.input,
      createdAt: aiJob.createdAt,
    })
    .from(aiJob)
    .where(inArray(aiJob.status, ["queued", "running"]))
    .orderBy(desc(aiJob.createdAt))
    .limit(20);

  return c.json({
    jobs: rows.map((r) => ({
      jobId: r.jobId,
      skill: r.skill,
      status: r.status,
      input: JSON.parse(r.input) as Record<string, unknown>,
      createdAt: r.createdAt,
    })),
  });
});

/* ------------------------------------------------------------------ */
/* Historique et retour                                                */
/* ------------------------------------------------------------------ */

/** Dernières analyses calculées. Les réponses servies du cache n'y figurent pas. */
ai.get("/runs", async (c) => {
  const rows = await drizzle(c.env.DB)
    .select({
      id: aiRun.id,
      skill: aiRun.skill,
      status: aiRun.status,
      provider: aiRun.provider,
      model: aiRun.model,
      confidence: aiRun.confidence,
      neurons: aiRun.neurons,
      startedAt: aiRun.startedAt,
      finishedAt: aiRun.finishedAt,
      error: aiRun.error,
    })
    .from(aiRun)
    .orderBy(desc(aiRun.startedAt))
    .limit(50);

  return c.json({ runs: rows });
});

const Feedback = z.object({
  runId: z.string().min(1),
  verdict: z.enum(["utile", "partiel", "inutile"]),
  reason: z.string().max(500).optional(),
});

/**
 * Retour de l'utilisateur sur une analyse.
 *
 * C'est la seule mesure de qualité qui ne vienne pas du modèle lui-même. Un
 * modèle annonce sa propre confiance avec le même aplomb qu'il ait raison ou
 * tort ; seul ce bouton dit si la recommandation a servi.
 */
ai.post("/feedback", async (c) => {
  const parsed = Feedback.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "requete_invalide" }, 422);

  const db = drizzle(c.env.DB);
  const [run] = await db
    .select({ id: aiRun.id })
    .from(aiRun)
    .where(eq(aiRun.id, parsed.data.runId))
    .limit(1);
  if (!run) return c.json({ error: "analyse_introuvable" }, 404);

  await db.insert(aiFeedback).values({
    id: randomId(),
    runId: parsed.data.runId,
    verdict: parsed.data.verdict,
    reason: parsed.data.reason ?? null,
    at: seconds(),
  });

  return c.json({ ok: true });
});
