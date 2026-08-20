import type { Skill } from "../domain/types.js";
import { margin, priceForMargin, relativeGap, spread } from "../tools/economics.js";
import { velocity } from "../tools/series.js";
import { finite, oneOf, ratio } from "../lib/json.js";
import { JSON_HINT, productSummary, SYSTEM_RULES } from "./shared.js";

export interface PriceRecommendInput {
  productId: string;
  /** Commission de la plateforme, fraction. Sans elle, pas de prix plancher. */
  feeRate?: number | null;
  /** Marge visée, fraction. 0,30 par défaut. */
  targetMarginRate?: number;
  /** Frais d'expédition à notre charge, centimes. */
  shipping?: number | null;
  days?: number;
}

export type PriceDirection = "monter" | "baisser" | "maintenir";

export interface PriceRecommendOutput {
  produit: { sku: string; titre: string };
  actuel: {
    prix: ReturnType<typeof spread>;
    margeMediane: ReturnType<typeof margin> | null;
    ventesParJour: number;
  };
  /** Prix sous lequel la marge visée n'est plus atteinte. Null si incalculable. */
  plancherCentimes: number | null;
  recommandation: {
    direction: PriceDirection;
    prixCentimes: number | null;
    /** Vrai quand le prix proposé par le modèle a dû être relevé au plancher. */
    ajusteAuPlancher: boolean;
    ecartAuPrixActuel: number | null;
    justification: string;
    confidence: number;
  };
  inconnues: string[];
}

/**
 * Recommandation de prix, canal par canal unifié.
 *
 * LE POINT IMPORTANT DE CETTE SKILL : le modèle propose un prix, il ne le
 * décide pas. Le plancher est calculé en TypeScript à partir du prix d'achat,
 * de la commission et de la marge visée ; toute proposition en dessous est
 * relevée d'office, et l'ajustement est signalé dans la réponse.
 *
 * Sans ce garde-fou, un modèle à qui l'on montre un marché tendu propose
 * spontanément de s'aligner sur le concurrent le moins cher — y compris quand
 * ce prix fait perdre de l'argent sur chaque vente.
 */
export const priceRecommend: Skill<PriceRecommendInput, PriceRecommendOutput> = {
  name: "product.price.recommend",
  version: "1.0.0",
  description: "Propose un prix unique cohérent entre canaux, borné par la marge visée.",
  dataClass: "internal",
  // Un prix s'applique à toutes les ventes suivantes : l'erreur coûte cher.
  impact: "high",
  cacheTtl: 6 * 60 * 60,

  async execute(input, ctx) {
    const product = await ctx.catalogue.product(input.productId);
    if (!product) throw new Error(`PRODUIT_INTROUVABLE:${input.productId}`);

    const days = input.days ?? 30;
    const targetMarginRate = input.targetMarginRate ?? 0.3;
    const series = await ctx.catalogue.salesSeries(input.productId, days);
    const ventes = velocity(series);
    const prix = spread(product.listings.map((l) => l.price));

    const margeMediane = prix
      ? margin({
          price: prix.median,
          cost: product.costPrice,
          feeRate: input.feeRate ?? null,
          shipping: input.shipping ?? null,
        })
      : null;

    // Le plancher exige les trois données. Il vaut mieux ne pas en avoir que
    // d'en avoir un faux : un plancher calculé sur une commission supposée
    // donnerait une fausse impression de sécurité.
    const plancher =
      product.costPrice !== null && input.feeRate !== null && input.feeRate !== undefined
        ? priceForMargin({
            cost: product.costPrice,
            feeRate: input.feeRate,
            targetMarginRate,
            ...(input.shipping === null || input.shipping === undefined
              ? {}
              : { shipping: input.shipping }),
          })
        : null;

    const inconnues = [...(margeMediane?.unknowns ?? [])];
    if (plancher === null) inconnues.push("prix plancher incalculable");
    if (!prix) inconnues.push("aucune annonce active");

    const result = await ctx.run({
      capabilities: ["structured", "reasoning", "deep_reasoning"],
      dataClass: "internal",
      impact: "high",
      hint: "deep",
      json: true,
      temperature: 0.1,
      maxOutputTokens: 2_000,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_RULES}

Tu recommandes un prix de vente unique, cohérent entre toutes les plateformes.
Le prix plancher, quand il est fourni, est une contrainte : ne propose jamais en dessous.
Aucune donnée de marché externe ne t'est fournie ici : raisonne uniquement sur les prix pratiqués, les ventes observées et la marge.
${JSON_HINT('{"direction":"monter"|"baisser"|"maintenir","prixCentimes":number,"justification":string,"confidence":number}')}
« justification » fait deux phrases au plus.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            produit: productSummary(product),
            fenetreJours: days,
            prixObserves: prix,
            margeAuPrixMedian: margeMediane,
            ventesParJour: Math.round(ventes.perDay * 100) / 100,
            margeVisee: targetMarginRate,
            plancherCentimes: plancher,
            inconnues,
          }),
        },
      ],
    });

    const parsed = (result.parsed ?? {}) as Record<string, unknown>;
    const proposed = finite(parsed["prixCentimes"]);

    // Le seul endroit où l'on contredit le modèle, et il est délibéré.
    const ajusteAuPlancher =
      proposed !== null && plancher !== null && proposed < plancher;
    const prixFinal =
      proposed === null ? null : ajusteAuPlancher ? plancher : Math.round(proposed);

    return {
      produit: { sku: product.sku, titre: product.title },
      actuel: {
        prix,
        margeMediane,
        ventesParJour: Math.round(ventes.perDay * 100) / 100,
      },
      plancherCentimes: plancher,
      recommandation: {
        direction: oneOf(
          parsed["direction"],
          ["monter", "baisser", "maintenir"] as const,
          "maintenir",
        ),
        prixCentimes: prixFinal,
        ajusteAuPlancher,
        ecartAuPrixActuel:
          prixFinal !== null && prix ? relativeGap(prixFinal, prix.median) : null,
        justification:
          typeof parsed["justification"] === "string"
            ? parsed["justification"]
            : "Justification indisponible.",
        // Une proposition rattrapée par le plancher n'était pas fiable : on
        // plafonne sa confiance plutôt que de relayer celle du modèle.
        confidence: ajusteAuPlancher
          ? Math.min(0.4, ratio(parsed["confidence"]))
          : ratio(parsed["confidence"]),
      },
      inconnues,
    };
  },
};
