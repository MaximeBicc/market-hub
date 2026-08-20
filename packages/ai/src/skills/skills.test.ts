import { describe, expect, it } from "vitest";
import { createAiModule } from "../core/module.js";
import {
  MemoryCache,
  MemoryCatalogue,
  MemoryJournal,
  MemoryLedger,
  sampleProduct,
  sampleSeries,
} from "../testing/memory.js";
import type { PriceRecommendOutput } from "./price-recommend.js";
import type { AnomalyOutput } from "./anomaly-detect.js";
import type { ProductAnalyzeOutput } from "./product-analyze.js";
import type { RestockOutput } from "./restock-recommend.js";

/**
 * Le panel monté de bout en bout, avec un faux Workers AI.
 *
 * `répond` reçoit la charge utile envoyée au modèle : c'est ce qui permet de
 * vérifier non seulement la réponse, mais aussi ce qu'on a — ou n'a pas —
 * transmis.
 */
function panel(répond: (payload: unknown) => unknown, options: { produit?: ReturnType<typeof sampleProduct>; série?: ReturnType<typeof sampleSeries> } = {}) {
  const appels: unknown[] = [];
  const produit = options.produit ?? sampleProduct();
  const série = options.série ?? sampleSeries(30, 3);

  const module = createAiModule({
    ai: {
      async run(_model, inputs) {
        const messages = inputs["messages"] as Array<{ role: string; content: string }>;
        const dernier = messages[messages.length - 1];
        const payload = JSON.parse(dernier?.content ?? "{}");
        appels.push(payload);
        // Forme réelle de Workers AI, relevée le 20 août 2026 : compatible
        // OpenAI, avec le coût en neurones annoncé par Cloudflare lui-même.
        return {
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify(répond(payload)),
                reasoning_content: "réflexion du modèle, ne doit pas ressortir",
              },
            },
          ],
          usage: { prompt_tokens: 1_200, completion_tokens: 300, neurons: 32.5 },
        };
      },
    },
    ledger: new MemoryLedger(),
    cache: new MemoryCache(),
    journal: new MemoryJournal(),
    catalogue: new MemoryCatalogue([produit], { [produit.productId]: série }),
    env: {},
    appUrl: "https://exemple.test",
    newId: () => "run-test",
    // Taux figes : aucune suite de tests ne doit joindre la BCE.
    fxRates: async () => ({ perEuro: { EUR: 1, USD: 1.1681 }, publishedOn: "2026-08-20" }),
  });

  return { module, appels };
}

describe("product.analyze", () => {
  it("calcule les mesures et laisse le modèle interpréter", async () => {
    const { module, appels } = panel(() => ({
      conclusion: "Produit sain, stock confortable.",
      forces: ["rotation régulière"],
      risques: [],
      actions: ["vérifier le prix Etsy"],
      confidence: 0.8,
    }));

    const { result } = await module.run({
      skill: "product.analyze",
      input: { productId: "prod-1", feeRate: 0.065 },
    });
    const sortie = result as ProductAnalyzeOutput;

    // 90 unités sur 30 jours = 3 par jour ; 35 disponibles ≈ 11,7 jours.
    expect(sortie.mesures.ventes.perDay).toBe(3);
    expect(sortie.mesures.couverture.days).toBeCloseTo(11.7, 1);
    expect(sortie.mesures.prix?.median).toBe(3_590);
    expect(sortie.analyse.conclusion).toContain("Produit sain");

    // Le modèle a reçu les mesures déjà faites, pas la série brute à sommer.
    const envoyé = appels[0] as Record<string, unknown>;
    expect(envoyé["mesures"]).toBeDefined();
  });

  it("signale le prix d'achat manquant au lieu de le supposer nul", async () => {
    const { module } = panel(
      () => ({ conclusion: "…", forces: [], risques: [], actions: [], confidence: 0.3 }),
      { produit: sampleProduct({ costPrice: null }) },
    );

    const { result } = await module.run({
      skill: "product.analyze",
      input: { productId: "prod-1", feeRate: 0.065 },
    });
    const sortie = result as ProductAnalyzeOutput;

    expect(sortie.mesures.marge?.margin).toBeNull();
    expect(sortie.inconnues).toContain("prix d'achat");
  });
});

describe("product.price.recommend", () => {
  it("relève au plancher une proposition qui détruirait la marge", async () => {
    // Achat 1 200, commission 6,5 %, marge visée 30 %.
    // Plancher = 1200 / (1 - 0,065 - 0,30) = 1 890 centimes.
    const { module } = panel(() => ({
      direction: "baisser",
      prixCentimes: 1_400,
      justification: "S'aligner sur le concurrent le moins cher.",
      confidence: 0.9,
    }));

    const { result } = await module.run({
      skill: "product.price.recommend",
      input: { productId: "prod-1", feeRate: 0.065 },
    });
    const sortie = result as PriceRecommendOutput;

    expect(sortie.plancherCentimes).toBe(1_890);
    expect(sortie.recommandation.prixCentimes).toBe(1_890);
    expect(sortie.recommandation.ajusteAuPlancher).toBe(true);
    // Une proposition rattrapée par le plancher ne mérite pas 0,9 de confiance.
    expect(sortie.recommandation.confidence).toBeLessThanOrEqual(0.4);
  });

  it("laisse passer une proposition au-dessus du plancher", async () => {
    const { module } = panel(() => ({
      direction: "maintenir",
      prixCentimes: 3_590,
      justification: "Le prix actuel tient.",
      confidence: 0.75,
    }));

    const { result } = await module.run({
      skill: "product.price.recommend",
      input: { productId: "prod-1", feeRate: 0.065 },
    });
    const sortie = result as PriceRecommendOutput;

    expect(sortie.recommandation.prixCentimes).toBe(3_590);
    expect(sortie.recommandation.ajusteAuPlancher).toBe(false);
    expect(sortie.recommandation.confidence).toBe(0.75);
  });

  it("ne calcule aucun plancher sans commission connue", async () => {
    const { module } = panel(() => ({
      direction: "maintenir",
      prixCentimes: 3_500,
      justification: "…",
      confidence: 0.5,
    }));

    const { result } = await module.run({
      skill: "product.price.recommend",
      input: { productId: "prod-1" },
    });
    const sortie = result as PriceRecommendOutput;

    expect(sortie.plancherCentimes).toBeNull();
    expect(sortie.inconnues).toContain("prix plancher incalculable");
  });
});

describe("product.restock.recommend", () => {
  it("calcule la quantité sans laisser le modèle la choisir", async () => {
    const { module } = panel(() => ({
      urgence: "immediat",
      // Le modèle glisse une quantité : elle doit être ignorée.
      quantite: 9_999,
      justification: "Rupture avant réception.",
      reserves: [],
      confidence: 0.85,
    }));

    const { result } = await module.run({
      skill: "product.restock.recommend",
      input: { productId: "prod-1", leadTimeDays: 21, coverTargetDays: 30 },
    });
    const sortie = result as RestockOutput;

    // 3/jour × (21 + 30) = 153 ; moins 35 disponibles = 118.
    expect(sortie.quantiteCalculee).toBe(118);
    expect(sortie.recommandation.urgence).toBe("immediat");
  });

  it("refuse de proposer une quantité sans historique de vente", async () => {
    const { module } = panel(
      () => ({ urgence: "aucune", justification: "Aucune vente.", reserves: [], confidence: 0.2 }),
      { série: [] },
    );

    const { result } = await module.run({
      skill: "product.restock.recommend",
      input: { productId: "prod-1" },
    });
    const sortie = result as RestockOutput;

    expect(sortie.quantiteCalculee).toBeNull();
    expect(sortie.jusquaRupture).toBeNull();
  });
});

describe("metrics.anomaly.detect", () => {
  it("répond sans appeler le moindre modèle quand rien ne sort du lot", async () => {
    const { module, appels } = panel(() => ({ resume: "ne devrait pas être appelé" }), {
      série: sampleSeries(60, 3),
    });

    const { result, neurons } = await module.run({
      skill: "metrics.anomaly.detect",
      input: { productId: "prod-1" },
    });
    const sortie = result as AnomalyOutput;

    expect(appels).toHaveLength(0);
    expect(neurons).toBe(0);
    expect(sortie.sansAppelModele).toBe(true);
  });

  it("refuse de conclure sur un historique trop court", async () => {
    const { module, appels } = panel(() => ({}), { série: sampleSeries(10, 3) });

    const { result } = await module.run({
      skill: "metrics.anomaly.detect",
      input: { productId: "prod-1" },
    });
    const sortie = result as AnomalyOutput;

    expect(sortie.rapport.usable).toBe(false);
    expect(sortie.rapport.note).toContain("trop court");
    expect(appels).toHaveLength(0);
  });

  it("n'appelle le modèle que pour expliquer un écart déjà établi", async () => {
    const { module, appels } = panel(
      () => ({
        resume: "Deux pics de vente inhabituels.",
        pistes: ["Vérifier une mise en avant plateforme"],
        confidence: 0.6,
      }),
      { série: sampleSeries(60, 2, { 12: 30, 40: 28 }) },
    );

    const { result, neurons } = await module.run({
      skill: "metrics.anomaly.detect",
      input: { productId: "prod-1" },
    });
    const sortie = result as AnomalyOutput;

    expect(sortie.rapport.anomalies.length).toBeGreaterThan(0);
    expect(appels).toHaveLength(1);
    expect(neurons).toBeGreaterThan(0);
    expect(sortie.explication?.resume).toContain("pics");
  });
});

describe("cache", () => {
  it("sert la seconde demande identique sans rappeler de modèle", async () => {
    const { module, appels } = panel(() => ({
      conclusion: "…",
      forces: [],
      risques: [],
      actions: [],
      confidence: 0.5,
    }));

    const première = await module.run({ skill: "product.analyze", input: { productId: "prod-1" } });
    const seconde = await module.run({ skill: "product.analyze", input: { productId: "prod-1" } });

    expect(première.cached).toBe(false);
    expect(seconde.cached).toBe(true);
    expect(seconde.neurons).toBe(0);
    expect(appels).toHaveLength(1);
  });

  it("recalcule quand l'utilisateur le demande explicitement", async () => {
    const { module, appels } = panel(() => ({
      conclusion: "…",
      forces: [],
      risques: [],
      actions: [],
      confidence: 0.5,
    }));

    await module.run({ skill: "product.analyze", input: { productId: "prod-1" } });
    const forcé = await module.run({
      skill: "product.analyze",
      input: { productId: "prod-1" },
      bypassCache: true,
    });

    expect(forcé.cached).toBe(false);
    expect(appels).toHaveLength(2);
  });
});
