import { describe, expect, it } from "vitest";
import { NoFreeModelError, Orchestrator } from "./orchestrator.js";
import { modelCatalogue } from "./models.js";
import type { AIProvider, ExecutionRequest, ProviderId } from "../domain/types.js";
import { TruncatedBeforeAnswerError } from "../domain/errors.js";
import { MemoryLedger, reply, ScriptedProvider } from "../testing/memory.js";

const PANEL = modelCatalogue({ GEMINI_API_KEY: "clé", GROQ_API_KEY: "clé" });

function build(
  providers: Array<[ProviderId, AIProvider]>,
  ledger = new MemoryLedger(),
): { orchestrator: Orchestrator; ledger: MemoryLedger } {
  return {
    orchestrator: new Orchestrator(PANEL, new Map(providers), ledger),
    ledger,
  };
}

const ask = (over: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  capabilities: ["structured", "reasoning"],
  dataClass: "internal",
  messages: [{ role: "user", content: "Analyse ces chiffres." }],
  maxOutputTokens: 500,
  ...over,
});

describe("exécution", () => {
  it("appelle le meilleur modèle autorisé et enregistre la consommation", async () => {
    const cloudflare = new ScriptedProvider("cloudflare", () => reply('{"ok":true}'));
    const { orchestrator, ledger } = build([["cloudflare", cloudflare]]);

    const result = await orchestrator.run(ask({ json: true }));

    expect(result.provider).toBe("cloudflare");
    expect(result.parsed).toEqual({ ok: true });
    expect(result.neurons).toBeGreaterThan(0);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.neurons).toBe(result.neurons);
  });

  it("bascule sur le fournisseur suivant quand le quota est atteint", async () => {
    const cloudflare = new ScriptedProvider(
      "cloudflare",
      () => new Error("3036 daily free allocation exhausted"),
    );
    const groq = new ScriptedProvider("groq", () => reply("réponse de repli"));

    const { orchestrator } = build([
      ["cloudflare", cloudflare],
      ["groq", groq],
    ]);

    const result = await orchestrator.run(ask());

    expect(result.provider).toBe("groq");
    expect(result.trace.join(" ")).toContain("3036");
  });

  it("échoue proprement plutôt que de basculer sur du payant", async () => {
    const cloudflare = new ScriptedProvider("cloudflare", () => new Error("429 rate limited"));
    const groq = new ScriptedProvider("groq", () => new Error("429 rate limited"));
    const gemini = new ScriptedProvider("gemini", () => new Error("429 rate limited"));

    const { orchestrator } = build([
      ["cloudflare", cloudflare],
      ["groq", groq],
      ["gemini", gemini],
    ]);

    await expect(orchestrator.run(ask())).rejects.toBeInstanceOf(NoFreeModelError);
  });

  it("ne tente pas un fournisseur sans clé", async () => {
    const cloudflare = new ScriptedProvider("cloudflare", () => new Error("429"));
    const groq = new ScriptedProvider("groq", () => reply("jamais appelé"), false);

    const { orchestrator } = build([
      ["cloudflare", cloudflare],
      ["groq", groq],
    ]);

    await expect(orchestrator.run(ask())).rejects.toBeInstanceOf(NoFreeModelError);
    expect(groq.calls).toHaveLength(0);
  });

  it("ne réessaie pas le même fournisseur après un refus de quota", async () => {
    // Cloudflare porte quatre modèles : sans mise à l'écart du fournisseur, un
    // 429 en déclencherait quatre à la suite.
    const cloudflare = new ScriptedProvider("cloudflare", () => new Error("429"));
    const { orchestrator } = build([["cloudflare", cloudflare]]);

    await expect(orchestrator.run(ask())).rejects.toBeInstanceOf(NoFreeModelError);
    expect(cloudflare.calls).toHaveLength(1);
  });
});

describe("confidentialité à l'exécution", () => {
  it("ne laisse jamais un fournisseur externe recevoir du contenu client", async () => {
    const cloudflare = new ScriptedProvider("cloudflare", () => new Error("429"));
    const groq = new ScriptedProvider("groq", () => reply("ne devrait pas arriver"));
    const gemini = new ScriptedProvider("gemini", () => reply("ne devrait pas arriver"));

    const { orchestrator } = build([
      ["cloudflare", cloudflare],
      ["groq", groq],
      ["gemini", gemini],
    ]);

    await expect(
      orchestrator.run(
        ask({
          dataClass: "customer",
          messages: [{ role: "user", content: "Bonjour, ma commande #99887766 n'est pas arrivée." }],
        }),
      ),
    ).rejects.toBeInstanceOf(NoFreeModelError);

    expect(groq.calls).toHaveLength(0);
    expect(gemini.calls).toHaveLength(0);
  });

  it("nettoie nos chiffres avant de les confier à un fournisseur externe", async () => {
    const cloudflare = new ScriptedProvider("cloudflare", () => new Error("429"));
    const groq = new ScriptedProvider("groq", () => reply("ok"));

    const { orchestrator } = build([
      ["cloudflare", cloudflare],
      ["groq", groq],
    ]);

    await orchestrator.run(
      ask({
        dataClass: "internal",
        messages: [
          { role: "user", content: "Contact fournisseur : achat@usine.example — 06 12 34 56 78" },
        ],
      }),
    );

    const envoye = String(groq.calls[0]?.request.messages[0]?.content);
    expect(envoye).not.toContain("achat@usine.example");
    expect(envoye).toContain("[courriel]");
    expect(envoye).toContain("[téléphone]");
  });
});

describe("comptabilité des échecs", () => {
  it("inscrit ce qu'un appel raté a tout de même coûté", async () => {
    // Cas relevé en production : le modèle dépense tout son budget de sortie en
    // raisonnement, ne rend rien, et Cloudflare décompte quand même.
    const cloudflare = new ScriptedProvider(
      "cloudflare",
      (model) =>
        new TruncatedBeforeAnswerError(model.model, 900, {
          inputTokens: 750,
          outputTokens: 900,
          neurons: 36.8,
        }),
    );
    const groq = new ScriptedProvider("groq", () => reply("réponse de repli"));

    const { orchestrator, ledger } = build([
      ["cloudflare", cloudflare],
      ["groq", groq],
    ]);

    const result = await orchestrator.run(ask());

    expect(result.provider).toBe("groq");

    // Une troncature n'est PAS une erreur de fournisseur : elle dépend du
    // modèle, pas du compte. Chacun des quatre modèles Cloudflare est donc
    // tenté — c'est justifié, ils ne raisonnent pas tous autant, et en
    // production gpt-oss a répondu là où glm et gemma avaient renoncé.
    //
    // Ce qui compte ici : les quatre appels ratés sont facturés, et le
    // registre les porte. Sans eux, le solde affiché serait plus large que la
    // réalité — dans le seul sens qui mène au dépassement.
    // Le nombre exact dépend du catalogue et bougera : ce qui doit tenir,
    // c'est que CHAQUE tentative facturée soit inscrite, et que le total
    // corresponde.
    const rates = ledger.entries.filter((e) => e.provider === "cloudflare");
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.every((e) => e.neurons === 36.8)).toBe(true);

    const total = await ledger.today();
    expect(total.neurons).toBeCloseTo(rates.length * 36.8, 5);
    expect(result.trace.join(" ")).toContain("malgré l'échec");
  });

  it("n'invente aucun coût pour un échec réseau", async () => {
    const cloudflare = new ScriptedProvider(
      "cloudflare",
      () => new Error("InferenceUpstreamError: Network connection lost."),
    );
    const groq = new ScriptedProvider("groq", () => reply("ok"));

    const { orchestrator, ledger } = build([
      ["cloudflare", cloudflare],
      ["groq", groq],
    ]);

    await orchestrator.run(ask());
    expect(ledger.entries.filter((e) => e.provider === "cloudflare")).toHaveLength(0);
  });
});
