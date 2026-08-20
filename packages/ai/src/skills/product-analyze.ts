import type { Skill } from "../domain/types.js";
import { margin, spread } from "../tools/economics.js";
import { coverage, trend, velocity } from "../tools/series.js";
import { ratio, stringList } from "../lib/json.js";
import { JSON_HINT, productSummary, SYSTEM_RULES } from "./shared.js";

export interface ProductAnalyzeInput {
  productId: string;
  /** Fenêtre d'observation. 30 jours par défaut. */
  days?: number;
  /** Commission de la plateforme, fraction. Inconnue si absente. */
  feeRate?: number | null;
}

export interface ProductAnalyzeOutput {
  produit: { sku: string; titre: string };
  /** Tout ce qui a été calculé, pas deviné. Affiché à côté de l'interprétation. */
  mesures: {
    ventes: ReturnType<typeof velocity>;
    couverture: ReturnType<typeof coverage>;
    tendance: ReturnType<typeof trend>;
    prix: ReturnType<typeof spread>;
    marge: ReturnType<typeof margin> | null;
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

/**
 * Lecture d'ensemble d'un produit.
 *
 * Le partage du travail est le même partout dans le panel : la vitesse de
 * vente, la couverture, la tendance et la marge sont calculées ici, en
 * TypeScript. Le modèle ne reçoit que des nombres finis et répond à une seule
 * question — qu'est-ce que ça veut dire, et que faire.
 */
export const productAnalyze: Skill<ProductAnalyzeInput, ProductAnalyzeOutput> = {
  name: "product.analyze",
  version: "1.0.0",
  description: "Interprète les indicateurs d'un produit : ventes, stock, marge, prix par canal.",
  // Nos chiffres, pas ceux d'un client : un fournisseur externe peut les voir
  // après nettoyage si l'allocation Cloudflare est épuisée.
  dataClass: "internal",
  impact: "medium",
  // Deux heures : au-delà, une vente ou un changement de stock a de bonnes
  // chances d'avoir rendu l'analyse fausse.
  cacheTtl: 2 * 60 * 60,

  async execute(input, ctx) {
    const product = await ctx.catalogue.product(input.productId);
    if (!product) throw new Error(`PRODUIT_INTROUVABLE:${input.productId}`);

    const days = input.days ?? 30;
    const series = await ctx.catalogue.salesSeries(input.productId, days);

    const ventes = velocity(series);
    const couverture = coverage({
      onHand: product.onHand,
      reserved: product.reserved,
      perDay: ventes.perDay,
      lowThresholdDays: 14,
    });
    const tendance = trend(series);
    const prix = spread(product.listings.map((l) => l.price));

    // La marge se calcule sur le prix médian effectivement affiché, pas sur le
    // prix de référence : c'est à ce prix-là que les ventes ont eu lieu.
    const marge = prix
      ? margin({
          price: prix.median,
          cost: product.costPrice,
          feeRate: input.feeRate ?? null,
        })
      : null;

    const mesures = { ventes, couverture, tendance, prix, marge };
    const inconnues = [...(marge?.unknowns ?? [])];
    if (!prix) inconnues.push("aucune annonce active");
    if (series.length === 0) inconnues.push("aucune vente sur la période");

    const result = await ctx.run({
      capabilities: ["structured", "reasoning"],
      dataClass: "internal",
      impact: "medium",
      hint: "balanced",
      json: true,
      temperature: 0.1,
      maxOutputTokens: 2_000,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_RULES}

Tu analyses un produit du catalogue. Les mesures sont déjà calculées.
${JSON_HINT('{"conclusion":string,"forces":string[],"risques":string[],"actions":string[],"confidence":number}')}
« conclusion » fait deux phrases au plus. « actions » propose au maximum trois gestes concrets, chacun en une ligne. Une action ne peut porter que sur le prix, le stock, la fiche produit ou une vérification à faire : tu ne publies ni ne modifies jamais rien toi-même.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            produit: productSummary(product),
            fenetreJours: days,
            mesures,
            inconnues,
          }),
        },
      ],
    });

    const parsed = (result.parsed ?? {}) as Record<string, unknown>;

    return {
      produit: { sku: product.sku, titre: product.title },
      mesures,
      analyse: {
        conclusion:
          typeof parsed["conclusion"] === "string"
            ? parsed["conclusion"]
            : "Analyse indisponible.",
        forces: stringList(parsed["forces"], 5),
        risques: stringList(parsed["risques"], 5),
        actions: stringList(parsed["actions"], 3),
        confidence: ratio(parsed["confidence"]),
      },
      inconnues,
    };
  },
};
