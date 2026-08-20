import type { AIMessage, ModelDescriptor, ProviderId } from "../domain/types.js";

/**
 * BUDGET GRATUIT — la pièce qui rend le « zéro euro » vérifiable.
 *
 * Le panel n'a aucun fournisseur payant : la gratuité ne repose donc pas sur
 * un interrupteur qu'on pourrait oublier d'armer, mais sur l'absence de route
 * vers la dépense. Il reste malgré tout deux endroits où de l'argent peut
 * apparaître si le compte est mal configuré :
 *
 *   1. Cloudflare Workers AI — au-delà de 10 000 neurones par jour, un compte
 *      Workers *Free* refuse (erreur 3036), mais un compte Workers *Paid*
 *      facture l'excédent sans rien demander. C'est le vrai risque : passer au
 *      plan payant pour une raison sans rapport, et transformer l'IA en poste
 *      de dépense silencieux.
 *
 *   2. Gemini — l'ancrage Google Search est gratuit dans une limite
 *      quotidienne, puis facturé au millier de requêtes si le projet Google a
 *      la facturation activée.
 *
 * D'où ce module : on compte, et on s'arrête avant la limite. C'est un
 * garde-fou, pas une optimisation.
 */

/**
 * Prix d'un neurone Cloudflare, en dollars. Publié à 0,011 $ les 1 000.
 *
 * On ne paie jamais ce prix ; il sert d'unité de compte commune. Cloudflare
 * facture en neurones mais publie ses modèles en dollars par million de
 * jetons : cette constante fait la conversion dans un sens comme dans l'autre.
 */
const NEURON_USD = 0.011 / 1000;

/** Allocation quotidienne offerte à tous les comptes, remise à zéro à 00 h 00 UTC. */
export const FREE_NEURONS_PER_DAY = 10_000;

/**
 * Convertit une consommation en neurones Cloudflare.
 *
 * Formule : (jetons_entrée × prix_entrée + jetons_sortie × prix_sortie) ÷ 11.
 * Le 11 vient de 1 000 000 de jetons × 0,011 $ / 1 000 neurones — autrement
 * dit, un dollar vaut environ 90 909 neurones.
 *
 * Appliquée aux autres fournisseurs, elle donne un coût *fictif* mais
 * comparable : c'est la seule façon de dire « cette comparaison visuelle vaut
 * dix classifications » sur un tableau de bord unique.
 */
export function neuronsFor(
  model: ModelDescriptor,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const usd =
    (usage.inputTokens * model.price.input + usage.outputTokens * model.price.output) /
    1_000_000;
  return Math.round(usd / NEURON_USD);
}

/** Traduit un solde de neurones en dollars, pour l'affichage seul. */
export function neuronsToUsd(neurons: number): number {
  return neurons * NEURON_USD;
}

/* ------------------------------------------------------------------ */
/* Plafonds                                                            */
/* ------------------------------------------------------------------ */

/**
 * Plafonds retenus, volontairement sous les limites annoncées.
 *
 * Les offres gratuites bougent : ces valeurs sont datées du 20 août 2026 et
 * doivent être revérifiées avant d'être relevées. La marge n'est pas de la
 * timidité — un compteur local et un compteur distant ne comptent jamais
 * exactement pareil, et c'est le distant qui facture.
 */
export interface FreeLimits {
  /** Cloudflare ne limite pas le nombre d'appels, seulement les neurones. */
  neurons: number;
  requests: Record<ProviderId, number>;
  /** Requêtes Gemini avec ancrage Google Search. */
  searchRequests: number;
  /**
   * Part de l'ancrage web gardée pour les demandes manuelles.
   *
   * Sans elle, une nuit d'analyse automatique consomme le quota et l'écran de
   * recherche ne répond plus le matin — au moment précis où l'on s'en sert.
   */
  searchManualReserve: number;
}

export const FREE_LIMITS: FreeLimits = {
  neurons: FREE_NEURONS_PER_DAY,
  requests: {
    // Aucune limite d'appels : c'est le compteur de neurones qui tranche.
    cloudflare: Number.POSITIVE_INFINITY,
    // Palier gratuit annoncé à 1 500 requêtes/jour sur les Flash.
    gemini: 1_200,
    // gpt-oss-120b sur Groq : 1 000 requêtes/jour, plus strict que les autres
    // modèles de la maison. On retient le plus strict.
    groq: 900,
    // 50 requêtes/jour sans achat de crédits. Les échecs comptent aussi.
    openrouter: 45,
  },
  // Ancrage Google Search : gratuit jusqu'à 1 500 requêtes/jour sur Gemini 2.5.
  // ATTENTION : sur la génération 3.x, l'offre passe à 5 000 par MOIS puis
  // devient payante. Changer le modèle de recherche impose de revoir ce chiffre.
  searchRequests: 1_200,
  searchManualReserve: 200,
};

/** Ce que le registre de consommation sait du jour en cours. */
export interface DailyUsage {
  neurons: number;
  requests: Record<ProviderId, number>;
  searchRequests: number;
}

export const emptyUsage = (): DailyUsage => ({
  neurons: 0,
  requests: { cloudflare: 0, gemini: 0, groq: 0, openrouter: 0 },
  searchRequests: 0,
});

/**
 * Estimation du coût d'un appel AVANT de le passer.
 *
 * Refuser après coup ne sert à rien : le neurone est déjà consommé. On estime
 * donc grossièrement — quatre caractères par jeton, une constante par image —
 * et on écarte le modèle qui ferait clairement déborder l'allocation.
 *
 * L'estimation est délibérément pessimiste. Se tromper vers le haut coûte un
 * repli sur un modèle plus léger ; se tromper vers le bas coûte de l'argent.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Coût en jetons d'une image en pleine définition. Ordre de grandeur commun
 * aux modèles multimodaux ; à recalibrer sur les vraies réponses d'usage.
 */
const IMAGE_TOKENS = 1_200;

export function estimateInputTokens(messages: AIMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") chars += part.text.length;
      else images += 1;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

export interface BudgetVerdict {
  ok: boolean;
  /** Renseigné quand `ok` est faux : ce qui a bloqué, en clair. */
  reason?: string;
}

/**
 * Le modèle a-t-il encore de la place aujourd'hui ?
 *
 * Trois questions, dans cet ordre : le fournisseur a-t-il encore des appels,
 * l'ancrage web a-t-il encore du quota, l'allocation de neurones absorbe-t-elle
 * l'appel estimé.
 */
export function allows(
  model: ModelDescriptor,
  usage: DailyUsage,
  options: {
    limits?: FreeLimits;
    webSearch?: boolean;
    automatic?: boolean;
    estimatedNeurons?: number;
  } = {},
): BudgetVerdict {
  const limits = options.limits ?? FREE_LIMITS;

  const used = usage.requests[model.provider] ?? 0;
  const cap = limits.requests[model.provider];
  if (used >= cap) {
    return { ok: false, reason: `quota_requetes_${model.provider}` };
  }

  if (options.webSearch) {
    // Le travail automatique n'a pas accès à la réserve manuelle.
    const searchCap = options.automatic
      ? Math.max(0, limits.searchRequests - limits.searchManualReserve)
      : limits.searchRequests;
    if (usage.searchRequests >= searchCap) {
      return { ok: false, reason: "quota_ancrage_web" };
    }
  }

  if (model.provider === "cloudflare") {
    const projected = usage.neurons + (options.estimatedNeurons ?? 0);
    if (projected > limits.neurons) {
      return { ok: false, reason: "allocation_neurones_epuisee" };
    }
  }

  return { ok: true };
}
