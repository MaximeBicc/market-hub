import { describe, expect, it, vi } from "vitest";
import { tavilySource, TAVILY_PAR_MOIS } from "./tavily.js";
import type { ResearchRequest } from "../ports.js";

/**
 * Le moteur de recherche du panel, éprouvé sur ce qui peut coûter cher.
 *
 * Tavily facture le dépassement au lieu de couper. Sans carte au dossier il ne
 * peut rien prélever, mais la gratuité ne doit jamais reposer sur l'incapacité
 * technique d'un fournisseur à encaisser : le plafond est vérifié ici, avant
 * l'appel.
 */

const MAINTENANT = Date.parse("2026-08-21T10:00:00Z");

const demande = (over: Partial<ResearchRequest> = {}): ResearchRequest => ({
  query: "porte-clés vélo",
  direction: "revente",
  ...over,
});

function source(options: {
  used?: number;
  reponse?: unknown;
  statut?: number;
  apiKey?: string | undefined;
}) {
  const appels: Array<{ body: Record<string, unknown> }> = [];
  let compte = options.used ?? 0;

  const fetchSimule = vi.fn(async (_url: string, init?: RequestInit) => {
    appels.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const statut = options.statut ?? 200;
    return new Response(JSON.stringify(options.reponse ?? { results: [] }), { status: statut });
  });
  vi.stubGlobal("fetch", fetchSimule);

  return {
    appels,
    compte: () => compte,
    port: tavilySource({
      apiKey: "apiKey" in options ? options.apiKey : "tvly-test",
      usedThisMonth: async () => compte,
      record: async () => {
        compte += 1;
      },
      now: () => MAINTENANT,
    }),
  };
}

describe("disponibilité", () => {
  it("se tait sans clé", async () => {
    const { port } = source({ apiKey: undefined });
    expect(await port.available()).toBe(false);
  });

  it("s'arrête AVANT le plafond, pas après", async () => {
    // Un dépassement est facturé : le constater ne suffit pas, il faut
    // l'empêcher.
    expect(await source({ used: TAVILY_PAR_MOIS - 1 }).port.available()).toBe(true);
    expect(await source({ used: TAVILY_PAR_MOIS }).port.available()).toBe(false);
    expect(await source({ used: TAVILY_PAR_MOIS + 50 }).port.available()).toBe(false);
  });
});

describe("recherche", () => {
  it("transforme les résultats en preuves datées", async () => {
    const { port } = source({
      reponse: {
        results: [
          {
            title: "Porte-clés vélo — Boutique",
            url: "https://boutique.example/produit",
            content: "Porte-clés en métal, 12,90 € livré.",
          },
        ],
      },
    });

    const preuves = await port.search(demande());

    expect(preuves).toHaveLength(1);
    expect(preuves[0]?.url).toBe("https://boutique.example/produit");
    expect(preuves[0]?.kind).toBe("page");
    expect(preuves[0]?.observedAt).toBe(new Date(MAINTENANT).toISOString());
    // AUCUN prix relevé ici : Tavily n'en extrait pas, et deviner depuis un
    // extrait produirait le chiffre sans source que le panel refuse.
    expect(preuves[0]?.price).toBeNull();
  });

  it("écarte un résultat sans URL", async () => {
    const { port } = source({
      reponse: { results: [{ title: "Sans lien", content: "12 €" }, { url: "https://a.example/1" }] },
    });

    const preuves = await port.search(demande());
    expect(preuves.map((p) => p.url)).toEqual(["https://a.example/1"]);
  });

  it("compte la recherche pour ne pas dépasser le mois", async () => {
    const s = source({ reponse: { results: [] } });
    await s.port.search(demande());
    expect(s.compte()).toBe(1);
  });

  it("formule différemment selon qu'on achète ou qu'on revend", async () => {
    const revente = source({});
    await revente.port.search(demande({ direction: "revente" }));

    const appro = source({});
    await appro.port.search(demande({ direction: "approvisionnement" }));

    // Confondre les deux comparerait un prix de gros à un prix de détail.
    expect(String(revente.appels[0]?.body["query"])).toContain("prix acheter");
    expect(String(appro.appels[0]?.body["query"])).toContain("grossiste");
  });

  it("ne demande jamais de réponse rédigée", async () => {
    const s = source({});
    await s.port.search(demande());

    // Tavily sait produire un résumé. Ce serait un texte sans source
    // vérifiable — exactement ce que le panel n'affiche pas.
    expect(s.appels[0]?.body["include_answer"]).toBe(false);
    expect(s.appels[0]?.body["search_depth"]).toBe("basic");
  });

  it("remonte une erreur HTTP au lieu de rendre une liste vide", async () => {
    const { port } = source({ statut: 429, reponse: { error: "rate limited" } });
    // Une liste vide se lirait comme « rien trouvé » ; le moteur doit savoir
    // que la source a échoué, pour le dire.
    await expect(port.search(demande())).rejects.toThrow(/tavily 429/);
  });
});
