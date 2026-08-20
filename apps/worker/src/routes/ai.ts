import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Env } from "../env.js";
import { authenticate } from "../lib/session.js";

/**
 * Proxy Claude.
 *
 * DEUX RAISONS D'ÊTRE, et la première n'est pas négociable :
 *
 * 1. La clé API ne doit JAMAIS atteindre le navigateur. Une clé dans un bundle
 *    JavaScript est publique, point final — même derrière une authentification,
 *    même « juste pour tester ». Elle vit dans les secrets du Worker et n'en sort pas.
 *
 * 2. C'est le SEUL poste payant de l'architecture. Tout le reste tient dans les
 *    offres gratuites ; les appels LLM sont facturés au jeton. Le garde-fou
 *    ci-dessous plafonne la dépense mensuelle : sans lui, une boucle mal écrite
 *    peut coûter cher pendant la nuit.
 *
 * Modèle : claude-opus-5, avec réflexion adaptative. Le prompt système est
 * stable et mis en cache — sur des appels répétés, les jetons d'entrée
 * rejoués coûtent environ un dixième du prix normal.
 */

export const ai = new Hono<{ Bindings: Env }>();

/** Plafond mensuel de jetons de sortie. À ~25 $/M, 200 000 jetons ≈ 5 $/mois. */
const MONTHLY_OUTPUT_TOKEN_BUDGET = 200_000;

ai.use("*", async (c, next) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  await next();
});

/** Compteur mensuel dans KV. Approximatif mais suffisant pour éviter la surprise. */
async function checkBudget(env: Env): Promise<{ ok: boolean; used: number }> {
  const slot = new Date().toISOString().slice(0, 7); // "2026-08"
  const used = Number((await env.CACHE.get(`ai:tokens:${slot}`)) ?? "0");
  return { ok: used < MONTHLY_OUTPUT_TOKEN_BUDGET, used };
}

async function recordUsage(env: Env, outputTokens: number): Promise<void> {
  const slot = new Date().toISOString().slice(0, 7);
  const key = `ai:tokens:${slot}`;
  const used = Number((await env.CACHE.get(key)) ?? "0");
  await env.CACHE.put(key, String(used + outputTokens), {
    expirationTtl: 70 * 86400,
  });
}

function client(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * Prompt système figé — il ne doit contenir NI date, NI identifiant, NI rien
 * de variable, sinon le cache est invalidé à chaque appel et l'économie
 * disparaît sans qu'aucune erreur ne le signale.
 */
const SYSTEM = `Tu assistes un vendeur qui gère plusieurs boutiques en ligne (Shopify, Etsy, eBay).
Tu rédiges en français, dans un registre commercial sobre : pas de superlatifs creux,
pas d'emphase artificielle. Tu respectes les contraintes de longueur données.
Tu n'inventes jamais de caractéristique produit qui ne figure pas dans les données fournies.`;

const ListingCopy = z.object({
  title: z.string().describe("Titre optimisé, 60 caractères maximum"),
  description: z.string().describe("Description en 3 à 5 phrases"),
  bullets: z.array(z.string()).describe("3 à 5 arguments courts"),
  tags: z.array(z.string()).describe("Jusqu'à 13 mots-clés, style Etsy"),
});

/** Génère une fiche produit à partir des données brutes d'une annonce. */
ai.post("/listing-copy", async (c) => {
  const budget = await checkBudget(c.env);
  if (!budget.ok) {
    return c.json(
      { error: "budget_exceeded", used: budget.used, limit: MONTHLY_OUTPUT_TOKEN_BUDGET },
      429,
    );
  }

  const input = await c.req.json<{
    title: string;
    attributes?: Record<string, string>;
    audience?: string;
  }>();

  const response = await client(c.env).messages.parse({
    model: "claude-opus-5",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(ListingCopy) },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Produit : ${input.title}
Attributs : ${JSON.stringify(input.attributes ?? {})}
Cible : ${input.audience ?? "grand public"}`,
      },
    ],
  });

  await recordUsage(c.env, response.usage.output_tokens);
  return c.json({ copy: response.parsed_output, usage: response.usage });
});

const PriceAdvice = z.object({
  recommendation: z.enum(["raise", "lower", "hold"]),
  suggestedPrice: z.number().describe("Prix conseillé en centimes"),
  reasoning: z.string().describe("Deux phrases maximum"),
  confidence: z.enum(["low", "medium", "high"]),
});

/**
 * Conseil de prix multi-canal. Le modèle ne voit que les données fournies :
 * aucun accès réseau, aucune place de marché interrogée depuis ici.
 */
ai.post("/price-advice", async (c) => {
  const budget = await checkBudget(c.env);
  if (!budget.ok) return c.json({ error: "budget_exceeded" }, 429);

  const input = await c.req.json<{
    sku: string;
    listings: Array<{ platform: string; price: number; quantity: number }>;
    costPrice?: number;
    salesLast30d?: number;
  }>();

  const response = await client(c.env).messages.parse({
    model: "claude-opus-5",
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(PriceAdvice) },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `SKU ${input.sku}. Tous les montants sont en centimes.
Présences : ${JSON.stringify(input.listings)}
Prix d'achat : ${input.costPrice ?? "inconnu"}
Ventes sur 30 jours : ${input.salesLast30d ?? "inconnu"}

Recommande un prix unique cohérent entre les canaux.`,
      },
    ],
  });

  await recordUsage(c.env, response.usage.output_tokens);
  return c.json({ advice: response.parsed_output, usage: response.usage });
});

/** Consommation du mois — affichée dans les réglages. */
ai.get("/usage", async (c) => {
  const b = await checkBudget(c.env);
  return c.json({
    outputTokensUsed: b.used,
    limit: MONTHLY_OUTPUT_TOKEN_BUDGET,
    estimatedCostUsd: ((b.used / 1_000_000) * 25).toFixed(2),
  });
});
