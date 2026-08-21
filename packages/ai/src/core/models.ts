import type { ModelDescriptor } from "../domain/types.js";

/**
 * LE PANEL — catalogue des modèles utilisables.
 *
 * Règle d'entrée unique : le modèle doit être accessible sans carte bancaire
 * et sans plan payant. Aucun modèle facturé ne figure ici, et il n'existe
 * aucun chemin de code pour en ajouter un à l'exécution. C'est ce qui rend la
 * gratuité structurelle plutôt que déclarative : il n'y a rien à désactiver.
 *
 * Les prix sont ceux publiés par les fournisseurs le 20 août 2026. Ils ne sont
 * jamais payés — ils servent uniquement à convertir une consommation en
 * neurones (voir `budget.ts`) pour comparer sur une même échelle le coût d'une
 * classification et celui d'une comparaison d'images.
 *
 * DEUX MODÈLES SONT VOLONTAIREMENT ABSENTS :
 *   @cf/moonshotai/kimi-k2.6 et @cf/zai-org/glm-5.2 exigent le plan Workers
 *   Paid depuis le 28 juillet 2026. Un compte gratuit reçoit un 403 (5035).
 *   Les inscrire ici reviendrait à mettre une porte de sortie payante dans le
 *   catalogue.
 */

export interface ModelEnv {
  GEMINI_API_KEY?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  GEMINI_GENERAL_MODEL?: string | undefined;
  GEMINI_RESEARCH_MODEL?: string | undefined;
  GROQ_MODEL?: string | undefined;
  OPENROUTER_MODEL?: string | undefined;
}

export function modelCatalogue(env: ModelEnv): ModelDescriptor[] {
  const models: ModelDescriptor[] = [
    /* ---------------- Cloudflare Workers AI ----------------
     * Seul fournisseur autorisé à voir du texte écrit par un client : les
     * modèles tournent sur notre compte, le contenu ne nourrit personne. */
    {
      provider: "cloudflare",
      model: "@cf/zai-org/glm-4.7-flash",
      // PAS de « reasoning », et c'est une mesure, pas un jugement.
      //
      // Éprouvé le 20 août 2026 sur de vrais prompts d'analyse : ce modèle
      // dépense la totalité de son budget de sortie en réflexion — 2 000
      // jetons, soit 76 neurones — puis rend une réponse vide. Le repli
      // fonctionne, mais chaque tentative gaspille l'allocation : cent
      // analyses effaceraient les trois quarts de la journée avant même
      // d'avoir produit un résultat.
      //
      // Le retirer du panel serait exagéré : il reste le moins cher pour ce à
      // quoi il excelle, le classement de textes courts. Lui refuser la
      // capacité « reasoning » suffit à ce que le routeur ne le propose plus
      // aux skills d'analyse, tout en le gardant en tête de liste pour
      // l'étiquetage des messages et des avis.
      capabilities: ["classify", "structured"],
      privacy: "trusted_customer",
      quality: 80,
      speed: 96,
      price: { input: 0.06, output: 0.4 },
      note: "Le moins gourmand du panel, réservé au classement de textes courts. Inapte au raisonnement long : mesuré, il réfléchit sans conclure.",
    },
    {
      provider: "cloudflare",
      model: "@cf/google/gemma-4-26b-a4b-it",
      capabilities: ["classify", "structured", "reasoning", "vision"],
      privacy: "trusted_customer",
      quality: 86,
      speed: 78,
      price: { input: 0.1, output: 0.3 },
      note: "Vision privée bon marché : environ dix fois moins de neurones que Qwen pour une comparaison d'images.",
    },
    {
      provider: "cloudflare",
      model: "@cf/openai/gpt-oss-120b",
      capabilities: ["structured", "reasoning", "deep_reasoning"],
      privacy: "trusted_customer",
      quality: 93,
      speed: 66,
      price: { input: 0.35, output: 0.75 },
      note: "Raisonnement profond privé. ~95 appels par jour : à réserver aux décisions à fort impact.",
    },
    {
      provider: "cloudflare",
      model: "@cf/qwen/qwen3.8-27b",
      capabilities: ["structured", "reasoning", "deep_reasoning", "vision"],
      privacy: "trusted_customer",
      quality: 93,
      speed: 82,
      price: { input: 0.45, output: 3.2 },
      note: "Meilleure vision du panel, mais ~40 comparaisons par jour seulement. Arbitrage explicite contre Gemma.",
    },
  ];

  /* ---------------- Gemini ----------------
   * Le palier gratuit sert à améliorer les produits Google : aucun contenu
   * client ne doit y arriver. D'où `sanitized_only` et `public_only`, jamais
   * `trusted_customer`. */
  if (env.GEMINI_API_KEY) {
    models.push({
      provider: "gemini",
      model: env.GEMINI_GENERAL_MODEL || "gemini-3.7-flash",
      capabilities: ["classify", "structured", "reasoning", "deep_reasoning", "vision"],
      privacy: "sanitized_only",
      quality: 97,
      speed: 88,
      price: { input: 0.75, output: 3.75 },
      note: "Le plus capable du panel. Reçoit nos chiffres assainis, jamais le texte d'un acheteur.",
    });

    /* --- Recherche web ---
     *
     * DEUX modèles, et le second n'est pas du luxe.
     *
     * La première version n'en déclarait qu'un, `gemini-2.5-flash`, choisi
     * parce que son ancrage Google Search restait gratuit à 1 500 requêtes par
     * JOUR là où la génération 3.x n'en offre que 5 000 par MOIS. Google l'a
     * retiré aux comptes nouvellement créés : il répond 404 « no longer
     * available to new users ». Toute la recherche marché tombait avec lui,
     * sans qu'aucun repli n'existe.
     *
     * D'où deux entrées. Un modèle retiré renvoie un 404, que l'orchestrateur
     * ne classe ni en quota ni en configuration : il passe simplement au
     * suivant. Le panel survit donc au prochain retrait sans intervention.
     *
     * Le plafond, lui, est mensuel — voir `budget.ts`. Ce n'est pas une
     * préférence, c'est la forme du quota 3.x. */
    models.push({
      provider: "gemini",
      model: env.GEMINI_RESEARCH_MODEL || "gemini-3.5-flash",
      capabilities: ["structured", "reasoning", "web_search", "vision"],
      privacy: "public_only",
      quality: 92,
      speed: 89,
      price: { input: 0.3, output: 2.5 },
      note: "Route de recherche web principale. Ancrage Google Search, quota mensuel partagé.",
    });

    models.push({
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      capabilities: ["structured", "reasoning", "web_search"],
      privacy: "public_only",
      // Qualité volontairement sous la précédente : ce modèle ne sert que si
      // la route principale disparaît à son tour.
      quality: 84,
      speed: 96,
      price: { input: 0.3, output: 2.5 },
      note: "Repli de recherche web, au cas où le modèle principal serait retiré.",
    });
  }

  /* ---------------- Groq ---------------- */
  if (env.GROQ_API_KEY) {
    models.push({
      provider: "groq",
      model: env.GROQ_MODEL || "openai/gpt-oss-120b",
      capabilities: ["structured", "reasoning", "deep_reasoning"],
      privacy: "sanitized_only",
      quality: 93,
      speed: 99,
      price: { input: 0.15, output: 0.6 },
      note: "Repli texte très rapide quand l'allocation Cloudflare est épuisée. 1 000 appels/jour.",
    });
  }

  /* ---------------- OpenRouter ----------------
   * Aucun modèle par défaut : le catalogue gratuit d'OpenRouter tourne, et un
   * identifiant codé en dur finirait par désigner un modèle disparu ou, pire,
   * un modèle payant homonyme. Sans `OPENROUTER_MODEL` explicite, le
   * fournisseur n'existe pas. */
  if (env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL) {
    models.push({
      provider: "openrouter",
      model: env.OPENROUTER_MODEL,
      capabilities: ["structured", "reasoning"],
      privacy: "public_only",
      quality: 75,
      speed: 65,
      // Les variantes « :free » sont gratuites : rien à convertir.
      price: { input: 0, output: 0 },
      note: "Dernier recours public. 50 appels/jour, échecs compris. Modèle imposé par la configuration.",
    });
  }

  return models;
}
