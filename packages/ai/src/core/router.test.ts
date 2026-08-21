import { describe, expect, it } from "vitest";
import { route } from "./router.js";
import { emptyUsage, neuronsFor, type DailyUsage } from "./budget.js";
import { modelCatalogue } from "./models.js";
import type { ExecutionRequest, ModelDescriptor } from "../domain/types.js";

const FULL_PANEL = modelCatalogue({
  GEMINI_API_KEY: "clé-de-test",
  GROQ_API_KEY: "clé-de-test",
  OPENROUTER_API_KEY: "clé-de-test",
  OPENROUTER_MODEL: "un/modele:free",
});

const ask = (over: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  capabilities: ["structured", "reasoning"],
  dataClass: "internal",
  messages: [{ role: "user", content: "x".repeat(4000) }],
  maxOutputTokens: 800,
  ...over,
});

describe("confidentialité", () => {
  it("n'expose jamais de contenu client à un fournisseur externe", () => {
    const { candidates } = route(FULL_PANEL, ask({ dataClass: "customer" }), emptyUsage());

    expect(candidates.length).toBeGreaterThan(0);
    for (const model of candidates) {
      expect(model.provider).toBe("cloudflare");
      expect(model.privacy).toBe("trusted_customer");
    }
  });

  it("écarte les modèles publics des données internes", () => {
    const { candidates } = route(FULL_PANEL, ask({ dataClass: "internal" }), emptyUsage());
    expect(candidates.some((m) => m.privacy === "public_only")).toBe(false);
  });

  it("ouvre tout le panel aux requêtes publiques", () => {
    const { candidates } = route(FULL_PANEL, ask({ dataClass: "public" }), emptyUsage());
    expect(new Set(candidates.map((m) => m.provider)).size).toBeGreaterThan(1);
  });
});

describe("capacités", () => {
  it("ne propose que des modèles à ancrage web pour une recherche", () => {
    const { candidates } = route(
      FULL_PANEL,
      ask({ dataClass: "public", webSearch: true, capabilities: ["web_search"] }),
      emptyUsage(),
    );
    expect(candidates.length).toBeGreaterThan(0);
    for (const model of candidates) expect(model.capabilities).toContain("web_search");
  });

  it("ne renvoie rien quand aucune clé ne fournit la capacité demandée", () => {
    // Sans clé, le panel se réduit à Cloudflare — qui n'a pas d'ancrage web.
    const cloudflareSeul = modelCatalogue({});
    const { candidates, rejected } = route(
      cloudflareSeul,
      ask({ dataClass: "public", webSearch: true, capabilities: ["web_search"] }),
      emptyUsage(),
    );

    expect(candidates).toHaveLength(0);
    expect(rejected.length).toBeGreaterThan(0);
  });
});

describe("pression budgétaire", () => {
  const vision = (): ExecutionRequest =>
    ask({
      dataClass: "customer",
      capabilities: ["vision"],
      maxOutputTokens: 600,
    });

  it("préfère le modèle le plus capable quand la journée commence", () => {
    const { candidates } = route(FULL_PANEL, vision(), emptyUsage());
    expect(candidates[0]?.model).toBe("@cf/qwen/qwen3.8-27b");
  });

  it("bascule sur le modèle économe quand l'allocation s'épuise", () => {
    const presqueVide: DailyUsage = { ...emptyUsage(), neurons: 9_300 };
    const { candidates } = route(FULL_PANEL, vision(), presqueVide);

    // Qwen coûte environ dix fois Gemma : à 700 neurones restants, le choisir
    // consommerait le reste de la journée en un appel.
    expect(candidates[0]?.model).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("écarte un modèle dont l'appel estimé dépasse l'allocation restante", () => {
    const epuise: DailyUsage = { ...emptyUsage(), neurons: 9_990 };
    const { candidates, rejected } = route(FULL_PANEL, vision(), epuise);

    expect(candidates.some((m) => m.provider === "cloudflare")).toBe(false);
    expect(rejected.join(" ")).toContain("allocation_neurones_epuisee");
  });

  it("respecte le plafond d'appels d'un fournisseur externe", () => {
    const usage: DailyUsage = {
      ...emptyUsage(),
      requests: { cloudflare: 0, gemini: 1_200, groq: 0, openrouter: 0 },
    };
    const { candidates } = route(FULL_PANEL, ask({ dataClass: "public" }), usage);
    expect(candidates.some((m) => m.provider === "gemini")).toBe(false);
  });

  it("réserve une part de l'ancrage web aux demandes manuelles", () => {
    // Le quota Google se compte au MOIS : 5 000 partagés entre les modèles
    // 3.x, dont on retient 4 500 par prudence. Un plafond journalier ne
    // protégerait de rien — trente jours à 200 feraient 6 000.
    const usage: DailyUsage = { ...emptyUsage(), searchRequestsThisMonth: 4_050 };
    const recherche = ask({
      dataClass: "public",
      webSearch: true,
      capabilities: ["web_search"],
    });

    // Le travail automatique s'arrête à 4 000 ; l'utilisateur garde ses 500.
    expect(route(FULL_PANEL, { ...recherche, automatic: true }, usage).candidates).toHaveLength(0);
    expect(
      route(FULL_PANEL, { ...recherche, automatic: false }, usage).candidates.length,
    ).toBeGreaterThan(0);
  });

  it("écarte l'ancrage web quand le mois entier est consommé", () => {
    const usage: DailyUsage = { ...emptyUsage(), searchRequestsThisMonth: 4_500 };
    const { candidates, rejected } = route(
      FULL_PANEL,
      ask({ dataClass: "public", webSearch: true, capabilities: ["web_search"] }),
      usage,
    );

    expect(candidates).toHaveLength(0);
    expect(rejected.join(" ")).toContain("quota_ancrage_web_mensuel");
  });
});

describe("intention de routage", () => {
  it("écarte les modèles sans raisonnement profond sur un travail « deep »", () => {
    const { candidates } = route(
      FULL_PANEL,
      ask({ hint: "deep", capabilities: ["reasoning"] }),
      emptyUsage(),
    );
    expect(candidates[0]?.capabilities).toContain("deep_reasoning");
  });
});

describe("conversion en neurones", () => {
  it("chiffre un appel de vision à quelques centaines de neurones", () => {
    const qwen = FULL_PANEL.find((m) => m.model === "@cf/qwen/qwen3.8-27b") as ModelDescriptor;
    const cout = neuronsFor(qwen, { inputTokens: 2_800, outputTokens: 400 });

    // (2800 × 0,45 + 400 × 3,20) ÷ 11 = 231. Autrement dit ~43 comparaisons
    // dans l'allocation quotidienne de 10 000 neurones.
    expect(cout).toBe(231);
  });

  it("chiffre une classification à quelques dizaines de neurones", () => {
    const glm = FULL_PANEL.find((m) => m.model === "@cf/zai-org/glm-4.7-flash") as ModelDescriptor;
    expect(neuronsFor(glm, { inputTokens: 2_000, outputTokens: 600 })).toBe(33);
  });
});

describe("capacités mesurées", () => {
  it("ne propose plus GLM aux skills d'analyse", () => {
    // Éprouvé en production : ce modèle épuise son budget de sortie en
    // réflexion sans conclure. Lui retirer « reasoning » évite d'y gaspiller
    // 76 neurones à chaque tentative avant de se rabattre.
    const { candidates } = route(FULL_PANEL, ask({ capabilities: ["reasoning"] }), emptyUsage());
    expect(candidates.some((m) => m.model === "@cf/zai-org/glm-4.7-flash")).toBe(false);
  });

  it("le garde en tête pour le classement de textes courts", () => {
    // C'est le travail de lot 2 : étiqueter messages et avis. Donnée client,
    // donc Cloudflare obligatoire, et GLM est le moins gourmand des trois.
    const { candidates } = route(
      FULL_PANEL,
      ask({ dataClass: "customer", capabilities: ["classify"], hint: "fast" }),
      emptyUsage(),
    );
    expect(candidates[0]?.model).toBe("@cf/zai-org/glm-4.7-flash");
  });
});
