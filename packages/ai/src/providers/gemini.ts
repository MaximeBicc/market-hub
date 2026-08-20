import type {
  AIProvider,
  AIMessage,
  ContentPart,
  Evidence,
  ModelDescriptor,
  ProviderRequest,
  ProviderResponse,
} from "../domain/types.js";

/**
 * Gemini — la seule route de recherche web du panel.
 *
 * Deux usages, deux niveaux de confidentialité :
 *   • analyse générale — reçoit nos chiffres, après nettoyage ;
 *   • recherche marché — ancrage Google Search, ne reçoit que du public.
 *
 * RÈGLE ABSOLUE : le palier gratuit de Gemini autorise Google à utiliser le
 * contenu envoyé pour améliorer ses produits. Aucun message d'acheteur, aucun
 * avis, aucune adresse ne doit y arriver. Cette règle n'est pas appliquée ici
 * mais dans le routeur, qui n'accorde à ce fournisseur que la confidentialité
 * `sanitized_only` ou `public_only` — jamais `trusted_customer`.
 */
export class GeminiProvider implements AIProvider {
  readonly id = "gemini" as const;

  constructor(private readonly apiKey: string | undefined) {}

  configured(): boolean {
    return Boolean(this.apiKey);
  }

  async generate(model: ModelDescriptor, request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.apiKey) throw new Error("PROVIDER_NOT_CONFIGURED:gemini");

    // Gemini sépare l'instruction système du fil de conversation, là où les
    // autres fournisseurs la traitent comme un message parmi d'autres.
    const system = request.messages
      .filter((m) => m.role === "system")
      .map(plainText)
      .filter(Boolean)
      .join("\n\n");

    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: toParts(m.content),
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxOutputTokens ?? 1_600,
        ...(request.json ? { responseMimeType: "application/json" } : {}),
      },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(request.webSearch ? { tools: [{ google_search: {} }] } : {}),
    };

    // La clé voyage dans un en-tête et non dans l'URL : une URL finit dans les
    // journaux d'accès, les traces d'erreur et l'historique du navigateur.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new Error(`gemini ${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];

    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

    // L'ancrage renvoie les pages réellement consultées. Ce sont les seules
    // sources qu'on garde : une URL citée dans le texte du modèle sans figurer
    // ici n'a pas été lue, et n'a donc rien prouvé.
    const sources: Evidence[] = [];
    const observedAt = new Date().toISOString();
    for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
      if (chunk.web?.uri) {
        sources.push({
          url: chunk.web.uri,
          title: chunk.web.title,
          kind: "search",
          observedAt,
        });
      }
    }

    return {
      text,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      sources,
    };
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function plainText(message: AIMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function toParts(content: string | ContentPart[]): Record<string, unknown>[] {
  if (typeof content === "string") return [{ text: content }];

  return content.map((part) => {
    if (part.type === "text") return { text: part.text };

    // Gemini veut l'image décomposée en type MIME + base64. La couche vision
    // a déjà produit une URI de données valide et vérifiée.
    const match = part.url.match(/^data:([^;]+);base64,(.*)$/s);
    if (!match?.[1] || !match[2]) throw new Error("IMAGE_NON_RESOLUE");
    return { inlineData: { mimeType: match[1], data: match[2] } };
  });
}
