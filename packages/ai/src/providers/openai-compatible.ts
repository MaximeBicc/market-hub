import type {
  AIProvider,
  ContentPart,
  ModelDescriptor,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
} from "../domain/types.js";

/**
 * Groq et OpenRouter parlent le même dialecte que l'API OpenAI.
 *
 * Un seul client pour les deux : ils ne diffèrent que par l'adresse, un
 * en-tête de courtoisie, et surtout par leur plafond gratuit — 1 000 appels
 * par jour pour Groq, 50 pour OpenRouter. Ce plafond n'est pas géré ici mais
 * dans `budget.ts`, pour rester au même endroit que tous les autres.
 */
class OpenAICompatibleProvider implements AIProvider {
  constructor(
    readonly id: ProviderId,
    private readonly endpoint: string,
    private readonly apiKey: string | undefined,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  configured(): boolean {
    return Boolean(this.apiKey);
  }

  async generate(model: ModelDescriptor, request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.apiKey) throw new Error(`PROVIDER_NOT_CONFIGURED:${this.id}`);

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: model.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map(toPart),
        })),
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens ?? 1_400,
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`${this.id} ${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: data.choices?.[0]?.message?.content ?? "",
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
}

function toPart(part: ContentPart): Record<string, unknown> {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { url: part.url } };
}

export function groqProvider(apiKey: string | undefined): AIProvider {
  return new OpenAICompatibleProvider(
    "groq",
    "https://api.groq.com/openai/v1/chat/completions",
    apiKey,
  );
}

export function openRouterProvider(
  apiKey: string | undefined,
  appUrl: string,
): AIProvider {
  return new OpenAICompatibleProvider(
    "openrouter",
    "https://openrouter.ai/api/v1/chat/completions",
    apiKey,
    // OpenRouter attribue le trafic à l'application déclarée. Sans ces
    // en-têtes le compte est traité comme anonyme, ce qui durcit encore un
    // plafond gratuit déjà bas.
    { "HTTP-Referer": appUrl, "X-Title": "MarketHub" },
  );
}
