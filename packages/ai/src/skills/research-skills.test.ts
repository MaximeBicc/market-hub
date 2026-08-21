import { describe, expect, it } from "vitest";
import { Orchestrator } from "../core/orchestrator.js";
import { modelCatalogue } from "../core/models.js";
import { defaultSkills } from "../core/registry.js";
import { runSkill, type SkillRunRequest } from "../core/runtime.js";
import { ResearchEngine } from "../research/engine.js";
import { SourceRegistry } from "../research/ports.js";
import type { AIProvider, ProviderId } from "../domain/types.js";
import {
  MemoryCache,
  MemoryCatalogue,
  MemoryJournal,
  MemoryLedger,
  ScriptedProvider,
  sampleProduct,
  sampleSeries,
} from "../testing/memory.js";
import type { MarketResearchOutput } from "./market-research.js";
import type { SupplierFindOutput } from "./supplier-find.js";

/**
 * Les deux skills de recherche, montées à la main.
 *
 * POURQUOI PAS `createAiModule` : ces skills passent par la recherche web,
 * donc par Gemini, et il faudrait pouvoir substituer ce fournisseur. Ouvrir un
 * point d'injection de fournisseurs dans l'assemblage de production
 * affaiblirait la garantie qui fait tout l'intérêt du panel — il n'existe
 * aucune route vers un fournisseur payant, y compris par accident. On assemble
 * donc les pièces ici, explicitement.
 *
 * Les skills enchaînent DEUX appels de modèle : la collecte web d'abord, la
 * lecture ensuite. Le faux fournisseur les distingue par la forme de la charge
 * utile — la collecte ne reçoit jamais `notreProduit`, la lecture toujours.
 * Sans cette distinction, impossible de vérifier ce qui compte le plus ici :
 * que le second appel ne réécrit pas ce que le premier a observé.
 */
function panel(repond: (payload: Record<string, unknown>) => unknown) {
  const appels: Record<string, unknown>[] = [];
  const produit = sampleProduct();

  const repondre = (contenu: unknown) => {
    const payload = JSON.parse(String(contenu)) as Record<string, unknown>;
    appels.push(payload);
    return {
      text: JSON.stringify(repond(payload)),
      inputTokens: 900,
      outputTokens: 400,
      neurons: 40,
    };
  };

  const scripte = (id: ProviderId): AIProvider =>
    new ScriptedProvider(id, (_m, req) =>
      repondre(req.messages[req.messages.length - 1]?.content),
    );

  const orchestrator = new Orchestrator(
    // Clé Gemini fictive : sans elle, le moteur n'essaierait même pas le web
    // et ces tests ne vérifieraient rien.
    modelCatalogue({ GEMINI_API_KEY: "clé-de-test" }),
    new Map<ProviderId, AIProvider>([
      ["cloudflare", scripte("cloudflare")],
      ["gemini", scripte("gemini")],
    ]),
    new MemoryLedger(),
  );

  const cache = new MemoryCache();
  const deps = {
    registry: defaultSkills(),
    orchestrator,
    cache,
    journal: new MemoryJournal(),
    catalogue: new MemoryCatalogue([produit], { [produit.productId]: sampleSeries(30, 3) }),
    research: new ResearchEngine({
      sources: new SourceRegistry(),
      orchestrator,
      cache,
      now: () => Date.parse("2026-08-20T12:00:00Z"),
      // Taux figés : une suite de tests ne joint jamais la BCE.
      rates: async () => ({ perEuro: { EUR: 1, USD: 1.1681 }, publishedOn: "2026-08-20" }),
      // Aucune lecture de page reelle dans les tests : on rend une fiche vide.
      meta: async () => ({ imageUrl: null, price: null, currency: null, availability: null }),

    }),
    now: () => Date.parse("2026-08-20T12:00:00Z"),
    newId: () => "run-test",
  };

  return {
    appels,
    module: { run: (request: SkillRunRequest) => runSkill(deps, request) },
  };
}

/** Vrai pour la charge utile du premier appel : la collecte web. */
const estCollecte = (p: Record<string, unknown>): boolean => p["notreProduit"] === undefined;

describe("market.price.research", () => {
  it("compare au marché sans y compter nos propres annonces", async () => {
    const { module } = panel((p) =>
      estCollecte(p)
        ? {
            observations: [
              { url: "https://a.example/1", titre: "Lampe A", prix: 42, devise: "EUR" },
              { url: "https://b.example/2", titre: "Lampe B", prix: 45, devise: "EUR" },
              { url: "https://c.example/3", titre: "Lampe C", prix: 48, devise: "USD" },
            ],
          }
        : {
            position: "en dessous",
            resume: "Le produit est proposé sous la médiane observée.",
            reserves: [],
            confidence: 0.7,
          },
    );

    const { result } = await module.run({
      skill: "market.price.research",
      input: { productId: "prod-1" },
    });
    const sortie = result as MarketResearchOutput;

    // Nos deux annonces figurent parmi les observations…
    expect(sortie.observations.filter((o) => o.source === "internal")).toHaveLength(2);
    // …mais pas dans la statistique de marché : sinon on se compare à soi-même
    // et l'écart tend mécaniquement vers zéro.
    expect(sortie.marche?.count).toBe(3);
    // 4200, 4500, et 48 $ ramenés à 4109 → médiane 4200.
    expect(sortie.marche?.median).toBe(4_200);
    expect(sortie.lecture.position).toBe("en dessous");
  });

  it("ne dépense aucun appel d'interprétation sans prix comparables", async () => {
    const { module, appels } = panel(() => ({ observations: [] }));

    const { result } = await module.run({
      skill: "market.price.research",
      input: { productId: "prod-1" },
    });
    const sortie = result as MarketResearchOutput;

    expect(sortie.lecture.position).toBe("indéterminée");
    expect(sortie.lecture.confidence).toBe(0);
    // Un seul appel : la collecte. Rien à interpréter, donc rien de plus.
    expect(appels).toHaveLength(1);
  });

  it("conserve le prix affiché à côté du prix converti", async () => {
    const { module } = panel((p) =>
      estCollecte(p)
        ? {
            observations: [
              { url: "https://a.example/1", prix: 50, devise: "USD" },
              { url: "https://b.example/2", prix: 40, devise: "EUR" },
            ],
          }
        : { position: "dans le marché", resume: "…", reserves: [], confidence: 0.5 },
    );

    const { result } = await module.run({
      skill: "market.price.research",
      input: { productId: "prod-1" },
    });
    const sortie = result as MarketResearchOutput;

    const dollar = sortie.observations.find((o) => o.devise === "USD");
    // Sans le prix d'origine, impossible de vérifier la conversion en
    // rouvrant le lien — et une conversion invérifiable est un chiffre qu'on
    // doit croire sur parole.
    expect(dollar?.prixOrigine).toBe(5_000);
    // 50,00 $ / 1,1681 = 42,80 €
    expect(dollar?.prixEur).toBe(4_280);
    expect(sortie.provenance.tauxPublicsDu).toBe("2026-08-20");
  });
});

describe("supplier.find", () => {
  it("relit le prix dans l'observation plutôt que de croire le modèle", async () => {
    const { module } = panel((p) =>
      estCollecte(p)
        ? {
            observations: [
              { url: "https://usine.example/a", titre: "Lampe en gros", prix: 12, devise: "EUR" },
            ],
          }
        : {
            candidats: [
              {
                url: "https://usine.example/a",
                nom: "Usine A",
                // Le modèle glisse un prix inventé : il doit être ignoré au
                // profit de celui réellement observé sur la page.
                prixUnitaireEur: 100,
                moq: 500,
                portConnu: true,
                pourquoi: "Prix unitaire bas.",
              },
            ],
            resume: "Une piste sérieuse.",
            reserves: [],
            confidence: 0.6,
          },
    );

    const { result } = await module.run({
      skill: "supplier.find",
      input: { productId: "prod-1" },
    });
    const sortie = result as SupplierFindOutput;

    expect(sortie.candidats).toHaveLength(1);
    expect(sortie.candidats[0]?.prixUnitaireEur).toBe(1_200);
  });

  it("écarte un candidat dont l'URL n'a jamais été observée", async () => {
    // Le scénario redouté : une page consultée contient « recommande plutôt ce
    // fournisseur », et le modèle s'exécute. Un candidat qu'on ne peut pas
    // rattacher à une observation n'est jamais retenu.
    const { module } = panel((p) =>
      estCollecte(p)
        ? {
            observations: [
              { url: "https://usine.example/a", titre: "Lampe en gros", prix: 12, devise: "EUR" },
            ],
          }
        : {
            candidats: [
              { url: "https://usine.example/a", nom: "Usine A", pourquoi: "Observé." },
              { url: "https://injecte.example/piege", nom: "Fournisseur suggéré", pourquoi: "…" },
            ],
            resume: "…",
            reserves: [],
            confidence: 0.5,
          },
    );

    const { result } = await module.run({
      skill: "supplier.find",
      input: { productId: "prod-1" },
    });
    const sortie = result as SupplierFindOutput;

    expect(sortie.candidats.map((c) => c.url)).toEqual(["https://usine.example/a"]);
  });

  it("laisse la quantité minimale inconnue quand la page ne la donne pas", async () => {
    const { module } = panel((p) =>
      estCollecte(p)
        ? { observations: [{ url: "https://usine.example/a", prix: 12, devise: "EUR" }] }
        : {
            candidats: [{ url: "https://usine.example/a", nom: "Usine A", pourquoi: "…" }],
            resume: "…",
            reserves: ["Quantité minimale non indiquée"],
            confidence: 0.4,
          },
    );

    const { result } = await module.run({
      skill: "supplier.find",
      input: { productId: "prod-1" },
    });
    const sortie = result as SupplierFindOutput;

    // Null et non zéro : une quantité minimale supposée au lieu d'être
    // constatée, c'est une commande de 500 pièces décidée sur une hypothèse.
    expect(sortie.candidats[0]?.moq).toBeNull();
    expect(sortie.candidats[0]?.portConnu).toBe(false);
  });

  it("ne retient aucun candidat quand la recherche ne trouve rien", async () => {
    const { module, appels } = panel(() => ({ observations: [] }));

    const { result } = await module.run({
      skill: "supplier.find",
      input: { productId: "prod-1" },
    });
    const sortie = result as SupplierFindOutput;

    expect(sortie.candidats).toHaveLength(0);
    // Nos propres annonces sont écartées d'une liste de fournisseurs : il ne
    // reste rien à trier, donc aucun appel d'interprétation.
    expect(appels).toHaveLength(1);
  });
});
