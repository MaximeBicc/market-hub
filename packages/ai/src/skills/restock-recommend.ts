import type { Skill } from "../domain/types.js";
import { coverage, restockQuantity, trend, velocity } from "../tools/series.js";
import { oneOf, ratio, stringList } from "../lib/json.js";
import { JSON_HINT, productSummary, SYSTEM_RULES } from "./shared.js";

export interface RestockInput {
  productId: string;
  /** Délai fournisseur en jours. 21 par défaut — ordre de grandeur import. */
  leadTimeDays?: number;
  /** Couverture visée après réception, en jours. 30 par défaut. */
  coverTargetDays?: number;
  days?: number;
}

export type Urgency = "immediat" | "bientot" | "surveiller" | "aucune";

export interface RestockOutput {
  produit: { sku: string; titre: string };
  mesures: {
    ventes: ReturnType<typeof velocity>;
    couverture: ReturnType<typeof coverage>;
    tendance: ReturnType<typeof trend>;
  };
  /** Quantité calculée. Null quand l'historique ne permet pas de conclure. */
  quantiteCalculee: number | null;
  /** Jours restants avant rupture si l'on ne commande pas. */
  jusquaRupture: number | null;
  recommandation: {
    urgence: Urgency;
    justification: string;
    reserves: string[];
    confidence: number;
  };
}

/**
 * Réapprovisionnement.
 *
 * La quantité vient d'une formule, pas du modèle : rythme de vente × (délai
 * fournisseur + couverture visée) − stock disponible. Le modèle n'intervient
 * que pour qualifier l'urgence et signaler ce qui devrait faire hésiter — une
 * tendance qui s'effondre, un historique trop court, une saisonnalité.
 *
 * Sans rythme de vente établi, la skill renvoie `null` et le dit. Proposer une
 * quantité « raisonnable » sur un produit sans historique reviendrait à faire
 * immobiliser de la trésorerie sur une intuition.
 */
export const restockRecommend: Skill<RestockInput, RestockOutput> = {
  name: "product.restock.recommend",
  version: "1.0.0",
  description: "Calcule la quantité à recommander et qualifie l'urgence du réapprovisionnement.",
  dataClass: "internal",
  impact: "high",
  cacheTtl: 6 * 60 * 60,

  async execute(input, ctx) {
    const product = await ctx.catalogue.product(input.productId);
    if (!product) throw new Error(`PRODUIT_INTROUVABLE:${input.productId}`);

    const days = input.days ?? 30;
    const leadTimeDays = input.leadTimeDays ?? 21;
    const coverTargetDays = input.coverTargetDays ?? 30;

    const series = await ctx.catalogue.salesSeries(input.productId, days);
    const ventes = velocity(series);
    const couverture = coverage({
      onHand: product.onHand,
      reserved: product.reserved,
      perDay: ventes.perDay,
      // Sous le délai fournisseur, commander ne suffit déjà plus à éviter la
      // rupture : c'est le bon seuil d'alerte, pas un chiffre rond.
      lowThresholdDays: leadTimeDays,
    });
    const tendance = trend(series);

    const quantiteCalculee = restockQuantity({
      perDay: ventes.perDay,
      available: couverture.available,
      leadTimeDays,
      coverTargetDays,
    });

    const mesures = { ventes, couverture, tendance };

    const result = await ctx.run({
      capabilities: ["structured", "reasoning"],
      dataClass: "internal",
      impact: "high",
      hint: "balanced",
      json: true,
      temperature: 0.1,
      maxOutputTokens: 2_000,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_RULES}

Tu qualifies l'urgence d'un réapprovisionnement. La quantité est déjà calculée : ne la modifie pas et ne la commente pas comme si tu l'avais choisie.
« urgence » vaut : "immediat" si la rupture arrive avant la fin du délai fournisseur, "bientot" si elle arrive peu après, "surveiller" si la marge de manœuvre est confortable, "aucune" si le produit ne se vend pas.
${JSON_HINT('{"urgence":"immediat"|"bientot"|"surveiller"|"aucune","justification":string,"reserves":string[],"confidence":number}')}
« reserves » liste ce qui devrait faire hésiter avant de commander : historique court, tendance en baisse, saisonnalité probable. Liste vide si rien ne cloche.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            produit: productSummary(product),
            fenetreJours: days,
            delaiFournisseurJours: leadTimeDays,
            couvertureViseeJours: coverTargetDays,
            mesures,
            quantiteCalculee,
          }),
        },
      ],
    });

    const parsed = (result.parsed ?? {}) as Record<string, unknown>;

    return {
      produit: { sku: product.sku, titre: product.title },
      mesures,
      quantiteCalculee,
      jusquaRupture: couverture.days,
      recommandation: {
        urgence: oneOf(
          parsed["urgence"],
          ["immediat", "bientot", "surveiller", "aucune"] as const,
          "surveiller",
        ),
        justification:
          typeof parsed["justification"] === "string"
            ? parsed["justification"]
            : "Justification indisponible.",
        reserves: stringList(parsed["reserves"], 4),
        confidence: ratio(parsed["confidence"]),
      },
    };
  },
};
