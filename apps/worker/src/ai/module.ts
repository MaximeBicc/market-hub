import { createAiModule, SourceRegistry, tavilySource, type AiModule } from "@hub/ai";
import type { Env } from "../env.js";
import { aiRepositories, sourceCounters } from "./repositories.js";

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
  /**
   * Sources de recherche extérieures.
   *
   * Tavily n'entre au registre que si sa clé existe — même règle que pour les
   * modèles. Sans elle, la recherche marché se limite aux annonces internes et
   * le dit à l'écran ; avec elle, elle va chercher dehors sans qu'aucune autre
   * ligne du panel ne change.
   */
  const sources = new SourceRegistry();
  if (env.TAVILY_API_KEY) {
    sources.register(
      tavilySource({
        apiKey: env.TAVILY_API_KEY,
        ...sourceCounters(env.DB, "tavily"),
        now: () => Date.now(),
      }),
    );
  }

  return createAiModule({
    ai: env.AI,
    sources,
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
