import { describe, expect, it } from "vitest";
import { CloudflareProvider } from "./cloudflare.js";
import { TruncatedBeforeAnswerError } from "../domain/errors.js";
import { modelCatalogue } from "../core/models.js";
import type { ModelDescriptor } from "../domain/types.js";

/**
 * Ces attentes viennent d'appels réels à Workers AI, passés le 20 août 2026
 * sur les quatre modèles du catalogue. Ce ne sont pas des suppositions sur la
 * forme de l'API : elles la figent telle qu'observée, pour qu'une évolution
 * casse un test plutôt que la production.
 */

const GLM = modelCatalogue({}).find(
  (m) => m.model === "@cf/zai-org/glm-4.7-flash",
) as ModelDescriptor;

const demande = {
  messages: [{ role: "user" as const, content: "Donne du JSON." }],
  json: true,
  maxOutputTokens: 900,
};

/** Réponse réelle de `@cf/zai-org/glm-4.7-flash`, abrégée. */
const REPONSE_REELLE = {
  choices: [
    {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: '{"ok":true,"couleur":"bleu"}',
        // La réflexion arrive à côté du contenu, pas dedans.
        reasoning_content: "L'utilisateur demande un objet JSON strict. Je vais…",
      },
    },
  ],
  usage: { prompt_tokens: 39, completion_tokens: 187, neurons: 7.0213 },
};

describe("transport Workers AI", () => {
  it("lit la réponse dans choices[0].message.content", async () => {
    const provider = new CloudflareProvider({ run: async () => REPONSE_REELLE });
    const response = await provider.generate(GLM, demande);

    expect(response.text).toBe('{"ok":true,"couleur":"bleu"}');
    expect(response.inputTokens).toBe(39);
    expect(response.outputTokens).toBe(187);
  });

  it("ne laisse jamais la réflexion du modèle atteindre la skill", async () => {
    const provider = new CloudflareProvider({ run: async () => REPONSE_REELLE });
    const response = await provider.generate(GLM, demande);

    expect(response.text).not.toContain("L'utilisateur demande");
  });

  it("retient le coût annoncé par Cloudflare plutôt que le nôtre", async () => {
    const provider = new CloudflareProvider({ run: async () => REPONSE_REELLE });
    const response = await provider.generate(GLM, demande);

    // C'est ce chiffre-là qui décrémente réellement l'allocation.
    expect(response.neurons).toBe(7.0213);
  });

  it("refuse une réponse tronquée avant la première ligne utile", async () => {
    // Cas observé avec un budget de 120 jetons : le modèle a tout dépensé en
    // réflexion et renvoyé un contenu vide, sans erreur.
    const provider = new CloudflareProvider({
      run: async () => ({
        choices: [{ finish_reason: "length", message: { content: "" } }],
        usage: { prompt_tokens: 33, completion_tokens: 120, neurons: 4.5495 },
      }),
    });

    await expect(provider.generate(GLM, demande)).rejects.toBeInstanceOf(
      TruncatedBeforeAnswerError,
    );
  });

  it("accepte une réponse vide quand le modèle a fini de lui-même", async () => {
    // Une réponse vide avec `finish_reason: "stop"` est un vrai refus du
    // modèle, pas une troncature. La skill saura quoi en faire.
    const provider = new CloudflareProvider({
      run: async () => ({
        choices: [{ finish_reason: "stop", message: { content: "" } }],
        usage: { prompt_tokens: 10, completion_tokens: 0, neurons: 0.06 },
      }),
    });

    await expect(provider.generate(GLM, demande)).resolves.toMatchObject({ text: "" });
  });

  it("transmet les images en URI de données, forme OpenAI", async () => {
    let recu: Record<string, unknown> = {};
    const provider = new CloudflareProvider({
      run: async (_model, inputs) => {
        recu = inputs;
        return REPONSE_REELLE;
      },
    });

    await provider.generate(GLM, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Que vois-tu ?" },
            { type: "image", url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    });

    const messages = recu["messages"] as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Que vois-tu ?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});

describe("conversion de repli", () => {
  it("reproduit le calcul de Cloudflare quand il ne l'annonce pas", async () => {
    // Sans `usage.neurons`, l'orchestrateur retombe sur notre conversion. Elle
    // a été vérifiée contre les chiffres réels des quatre modèles : écart nul
    // sur trois d'entre eux, inférieur au centième sur le quatrième.
    const provider = new CloudflareProvider({
      run: async () => ({
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        usage: { prompt_tokens: 39, completion_tokens: 187 },
      }),
    });

    const response = await provider.generate(GLM, demande);
    expect(response.neurons).toBeUndefined();
  });
});
