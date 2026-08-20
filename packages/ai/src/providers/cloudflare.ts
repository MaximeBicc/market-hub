import type {
  AIProvider,
  ContentPart,
  ModelDescriptor,
  ProviderRequest,
  ProviderResponse,
} from "../domain/types.js";
import { TruncatedBeforeAnswerError } from "../domain/errors.js";

/**
 * Workers AI — le fournisseur par défaut du panel.
 *
 * C'est le seul autorisé à voir du texte écrit par un client : l'inférence
 * tourne sur notre propre compte Cloudflare, rien ne part chez un tiers et
 * rien ne sert à entraîner un modèle.
 *
 * Il n'y a aucune clé à fournir — la liaison `AI` du Worker suffit. C'est ce
 * qui permet à tout le panel de fonctionner le premier jour, avant même
 * d'avoir créé le moindre compte ailleurs.
 */

/**
 * Vue minimale de la liaison `Ai`.
 *
 * On ne dépend pas du type généré par Wrangler : il porte une union figée des
 * identifiants de modèles, régénérée à chaque `wrangler types`, qui casserait
 * la compilation dès que Cloudflare retire un modèle. Trois lignes de contrat
 * suffisent, et rendent ce fournisseur testable sans Worker.
 */
export interface WorkersAIBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

interface CloudflareResult {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; reasoning_content?: string };
  }>;
  /** Forme historique de certains modèles, conservée par prudence. */
  response?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Comptabilité de Cloudflare elle-même : c'est elle qui décrémente. */
    neurons?: number;
  };
}

export class CloudflareProvider implements AIProvider {
  readonly id = "cloudflare" as const;

  constructor(private readonly ai: WorkersAIBinding) {}

  /** Toujours vrai : la liaison fait partie du déploiement, pas des secrets. */
  configured(): boolean {
    return true;
  }

  async generate(model: ModelDescriptor, request: ProviderRequest): Promise<ProviderResponse> {
    const budget = request.maxOutputTokens ?? 1_200;

    const raw = (await this.ai.run(model.model, {
      messages: request.messages.map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map(toOpenAIPart),
      })),
      temperature: request.temperature ?? 0.2,
      max_tokens: budget,
      // Workers AI accepte un schéma de réponse sur les modèles à sortie
      // structurée ; on se limite au mode JSON, disponible partout.
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
    })) as CloudflareResult | string;

    if (typeof raw === "string") {
      return { text: raw, inputTokens: 0, outputTokens: 0 };
    }

    const choice = raw.choices?.[0];
    // Forme observée en production le 20 août 2026 : compatible OpenAI, la
    // réponse est dans `choices[0].message.content`. `reasoning_content`, à
    // côté, contient la réflexion — elle ne doit jamais atteindre la skill.
    const text = choice?.message?.content ?? raw.response ?? "";

    if (!text.trim() && choice?.finish_reason === "length") {
      throw new TruncatedBeforeAnswerError(model.model, budget, {
        inputTokens: raw.usage?.prompt_tokens ?? 0,
        outputTokens: raw.usage?.completion_tokens ?? 0,
        ...(typeof raw.usage?.neurons === "number" ? { neurons: raw.usage.neurons } : {}),
      });
    }

    return {
      text,
      inputTokens: raw.usage?.prompt_tokens ?? 0,
      outputTokens: raw.usage?.completion_tokens ?? 0,
      // Le chiffre de Cloudflare fait foi. Notre conversion ne sert que s'il
      // manque : elle est exacte aujourd'hui, elle ne le restera pas si un
      // tarif change sans qu'on mette le catalogue à jour.
      ...(typeof raw.usage?.neurons === "number" ? { neurons: raw.usage.neurons } : {}),
    };
  }
}

/**
 * Les modèles multimodaux de Workers AI suivent la forme OpenAI et attendent
 * l'image en URI de données. La couche vision a déjà téléchargé et vérifié
 * l'octet ; ici on ne fait que transporter.
 */
function toOpenAIPart(part: ContentPart): Record<string, unknown> {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { url: part.url } };
}
