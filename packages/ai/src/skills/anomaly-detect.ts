import type { Skill } from "../domain/types.js";
import { detectAnomalies, type AnomalyReport } from "../tools/series.js";
import { ratio, stringList } from "../lib/json.js";
import { JSON_HINT, SYSTEM_RULES } from "./shared.js";

export interface AnomalyInput {
  productId: string;
  days?: number;
  /** Écarts-types au-delà desquels un jour est signalé. 2 par défaut. */
  threshold?: number;
}

export interface AnomalyOutput {
  produit: { sku: string; titre: string };
  rapport: AnomalyReport;
  /** Absente quand aucun écart n'a été détecté : dans ce cas, zéro appel IA. */
  explication?: {
    resume: string;
    pistes: string[];
    confidence: number;
  };
  /** Vrai quand la réponse n'a coûté aucun neurone. */
  sansAppelModele: boolean;
}

/**
 * Détection d'écarts dans les ventes.
 *
 * Cette skill illustre la règle la plus rentable du panel : le meilleur appel
 * de modèle est celui qu'on ne passe pas.
 *
 * La cote z décide seule s'il y a quelque chose à voir. S'il n'y a rien — série
 * trop courte, ventes régulières, aucun jour hors norme — la skill répond
 * immédiatement, sans toucher à l'allocation gratuite. Le modèle n'est appelé
 * que pour expliquer des écarts déjà établis, jamais pour décider s'il y en a.
 *
 * L'ordre inverse serait à la fois plus cher et moins juste : un modèle à qui
 * l'on demande « vois-tu une anomalie ? » en trouve presque toujours une.
 */
export const anomalyDetect: Skill<AnomalyInput, AnomalyOutput> = {
  name: "metrics.anomaly.detect",
  version: "1.0.0",
  description: "Repère les jours de vente hors norme et propose des explications plausibles.",
  dataClass: "internal",
  impact: "medium",
  cacheTtl: 3 * 60 * 60,

  async execute(input, ctx) {
    const product = await ctx.catalogue.product(input.productId);
    if (!product) throw new Error(`PRODUIT_INTROUVABLE:${input.productId}`);

    const days = input.days ?? 60;
    const series = await ctx.catalogue.salesSeries(input.productId, days);
    const rapport = detectAnomalies(series, input.threshold ?? 2);

    const identite = { sku: product.sku, titre: product.title };

    if (!rapport.usable || rapport.anomalies.length === 0) {
      return { produit: identite, rapport, sansAppelModele: true };
    }

    const result = await ctx.run({
      capabilities: ["structured", "reasoning"],
      dataClass: "internal",
      impact: "medium",
      hint: "fast",
      json: true,
      temperature: 0.2,
      maxOutputTokens: 2_000,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_RULES}

Des jours de vente hors norme ont déjà été identifiés statistiquement. Tu n'as pas à confirmer qu'ils sont anormaux : c'est acquis.
Tu proposes des explications PLAUSIBLES, présentées comme telles. Tu n'affirmes pas une cause que les données ne montrent pas.
${JSON_HINT('{"resume":string,"pistes":string[],"confidence":number}')}
« pistes » liste au maximum quatre causes possibles à vérifier : rupture de stock, changement de prix, période de fêtes, mise en avant par la plateforme, saisonnalité. Une piste par ligne, formulée comme une vérification à faire.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            produit: { sku: product.sku, titre: product.title },
            fenetreJours: days,
            rapport,
            // La série sert à situer les écarts dans le temps — trois pics
            // d'affilée ne se lisent pas comme trois pics isolés. Mais elle
            // part sous forme compacte : soixante objets `{date, units,
            // revenue}` allongent le raisonnement du modèle sans rien lui
            // apprendre, et le chiffre d'affaires quotidien n'explique pas une
            // anomalie de VOLUME.
            premierJour: series[0]?.date ?? null,
            unitesParJour: series.map((p) => p.units),
          }),
        },
      ],
    });

    const parsed = (result.parsed ?? {}) as Record<string, unknown>;

    return {
      produit: identite,
      rapport,
      explication: {
        resume:
          typeof parsed["resume"] === "string" ? parsed["resume"] : "Explication indisponible.",
        pistes: stringList(parsed["pistes"], 4),
        confidence: ratio(parsed["confidence"]),
      },
      sansAppelModele: false,
    };
  },
};
