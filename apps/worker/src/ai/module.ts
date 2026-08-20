import { createAiModule, type AiModule } from "@hub/ai";
import type { Env } from "../env.js";
import { aiRepositories } from "./repositories.js";

/**
 * Assemble le panel d'IA pour une invocation.
 *
 * TOUT EST OPTIONNEL SAUF CLOUDFLARE. La liaison `AI` fait partie du
 * déploiement et ne demande aucune clé : le panel fonctionne donc dès le
 * premier jour, sur les 10 000 neurones offerts quotidiennement.
 *
 * Ajouter Gemini, Groq ou OpenRouter plus tard ne demande aucune modification
 * de code : il suffit d'inscrire le secret, et le modèle correspondant entre
 * au catalogue au déploiement suivant. Retirer la clé l'en sort. C'est ce qui
 * permet de commencer petit sans se fermer de porte.
 */
export function buildAi(env: Env): AiModule {
  return createAiModule({
    ai: env.AI,
    ...aiRepositories(env.DB),
    env: {
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      GROQ_API_KEY: env.GROQ_API_KEY,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      GEMINI_GENERAL_MODEL: env.GEMINI_GENERAL_MODEL,
      GEMINI_RESEARCH_MODEL: env.GEMINI_RESEARCH_MODEL,
      GROQ_MODEL: env.GROQ_MODEL,
      OPENROUTER_MODEL: env.OPENROUTER_MODEL,
    },
    appUrl: env.APP_URL,
  });
}
