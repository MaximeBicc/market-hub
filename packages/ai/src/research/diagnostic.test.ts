import { describe, expect, it } from "vitest";
import { ResearchEngine } from "./engine.js";
import { SourceRegistry } from "./ports.js";
import { Orchestrator } from "../core/orchestrator.js";
import { modelCatalogue } from "../core/models.js";
import type { AIProvider, ProviderId } from "../domain/types.js";
import { MemoryCache, MemoryLedger, reply, ScriptedProvider } from "../testing/memory.js";

/**
 * Ce que l'utilisateur lit quand la recherche web échoue.
 *
 * Ces tests naissent d'un vrai incident. Le moteur annonçait « quota de
 * recherche web épuisé » alors qu'aucune requête n'avait jamais été passée :
 * l'API Google n'était simplement pas activée. Le message envoyait attendre
 * minuit pour un problème d'une minute — et, mis en cache six heures, il
 * survivait à sa propre correction.
 *
 * Un message d'erreur faux coûte plus cher qu'un message absent : il détourne
 * de la vraie cause avec autorité.
 */

const TAUX = { perEuro: { EUR: 1 }, publishedOn: "2026-08-21" };
const MAINTENANT = Date.parse("2026-08-21T00:30:00Z");

/** Moteur dont Gemini échoue avec le message que l'on veut éprouver. */
function moteurDontGeminiEchoue(
  erreur: string,
  consommation: { searchRequestsThisMonth?: number } = {},
) {
  const cache = new MemoryCache();
  const gemini = new ScriptedProvider("gemini", () => new Error(erreur));
  const ledger = new MemoryLedger(consommation);

  return {
    cache,
    ledger,
    engine: new ResearchEngine({
      sources: new SourceRegistry(),
      orchestrator: new Orchestrator(
        modelCatalogue({ GEMINI_API_KEY: "clé" }),
        new Map<ProviderId, AIProvider>([
          ["cloudflare", new ScriptedProvider("cloudflare", () => reply("{}"))],
          ["gemini", gemini],
        ]),
        ledger,
      ),
      cache,
      now: () => MAINTENANT,
      rates: async () => TAUX,
      // Aucune lecture de page reelle dans les tests : on rend une fiche vide.
      meta: async () => ({ imageUrl: null, price: null, currency: null, availability: null }),
    }),
  };
}

const chercher = (engine: ResearchEngine) =>
  engine.research({ query: "porte-clés avion", direction: "revente" });

describe("message d'échec de la recherche web", () => {
  it("nomme l'API non activée au lieu d'accuser le quota", async () => {
    // Réponse réelle de Google sur un projet fraîchement créé.
    const { engine } = moteurDontGeminiEchoue(
      'gemini 403 {"error":{"status":"PERMISSION_DENIED","message":"Generative Language API has not been used in project 123 before or it is disabled."}}',
    );

    const { warnings } = await chercher(engine);
    const message = warnings.join(" ");

    expect(message).toContain("pas activée");
    expect(message).toContain("Generative Language API");
    expect(message).not.toContain("Quota");
  });

  it("nomme la clé refusée quand Google la rejette", async () => {
    const { engine } = moteurDontGeminiEchoue(
      'gemini 400 {"error":{"status":"INVALID_ARGUMENT","message":"API key not valid. API_KEY_INVALID"}}',
    );

    const { warnings } = await chercher(engine);
    expect(warnings.join(" ")).toContain("refusée par Google");
  });

  it("distingue « rien accordé » de « tout consommé »", async () => {
    // Zéro recherche à notre compteur : ce n'est pas un épuisement, c'est une
    // allocation nulle. Envoyer attendre la fin du mois serait faux.
    const { engine } = moteurDontGeminiEchoue(
      'gemini 429 {"error":{"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota"}}',
    );

    const { warnings } = await chercher(engine);
    const message = warnings.join(" ");
    expect(message).toContain("AUCUNE ce mois-ci");
    expect(message).toContain("vaut zéro");
    // Le message contient « elle n'est pas épuisée » : c'est la formule
    // trompeuse qu'on interdit, pas le mot.
    expect(message).not.toContain("Quota de recherche web épuisé");
  });

  it("annonce un vrai épuisement quand nous avons réellement consommé", async () => {
    const { engine, ledger } = moteurDontGeminiEchoue(
      'gemini 429 {"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}',
      { searchRequestsThisMonth: 4_200 },
    );
    void ledger;

    const { warnings } = await chercher(engine);
    expect(warnings.join(" ")).toContain("4200 recherches ce mois-ci");
  });

  it("montre le message brut plutôt que d'inventer une explication", async () => {
    const { engine } = moteurDontGeminiEchoue("gemini 500 quelque chose d'inattendu");

    const { warnings } = await chercher(engine);
    const message = warnings.join(" ");

    // Illisible mais vrai vaut mieux que lisible et faux.
    expect(message).toContain("quelque chose d'inattendu");
    expect(message).not.toContain("Quota");
  });
});

describe("durée de vie d'un échec", () => {
  it("expire en cinq minutes, pas en six heures", async () => {
    const { engine, cache } = moteurDontGeminiEchoue("gemini 403 SERVICE_DISABLED");

    await chercher(engine);

    // Sans quoi, corriger la configuration ne change rien pendant une
    // demi-journée : on revoit le même message et on croit la correction
    // sans effet.
    expect(cache.ttls).toHaveLength(1);
    expect(cache.ttls[0]).toBe(5 * 60);
  });

  it("garde six heures une recherche qui a réellement abouti", async () => {
    const cache = new MemoryCache();
    const engine = new ResearchEngine({
      sources: new SourceRegistry(),
      orchestrator: new Orchestrator(
        modelCatalogue({ GEMINI_API_KEY: "clé" }),
        new Map<ProviderId, AIProvider>([
          [
            "gemini",
            new ScriptedProvider("gemini", () =>
              reply(
                JSON.stringify({
                  observations: [{ url: "https://a.example/1", prix: 12, devise: "EUR" }],
                }),
              ),
            ),
          ],
        ]),
        new MemoryLedger(),
      ),
      cache,
      now: () => MAINTENANT,
      rates: async () => TAUX,
      // Aucune lecture de page reelle dans les tests : on rend une fiche vide.
      meta: async () => ({ imageUrl: null, price: null, currency: null, availability: null }),
    });

    await chercher(engine);
    expect(cache.ttls[0]).toBe(6 * 60 * 60);
  });
});
