import type { ExecutionRequest, ModelDescriptor } from "../domain/types.js";
import {
  allows,
  estimateInputTokens,
  neuronsFor,
  type DailyUsage,
  type FreeLimits,
  FREE_LIMITS,
} from "./budget.js";

/**
 * LE CHEF D'ORCHESTRE — quel modèle pour quelle demande.
 *
 * Le routage se fait en deux temps, et l'ordre compte :
 *
 *   1. ÉLIMINER. Confidentialité, capacités, budget restant. Ce sont des
 *      règles binaires : un modèle qui échoue à l'une d'elles n'est pas un
 *      mauvais candidat, il n'est pas candidat.
 *
 *   2. CLASSER. Parmi les survivants, on préfère le meilleur — corrigé par ce
 *      qu'il reste dans la journée. C'est le point qui distingue ce routeur
 *      d'une simple liste de préférences : plus l'allocation gratuite
 *      s'épuise, plus un modèle gourmand devient cher à choisir. Le panel
 *      dérive donc tout seul vers les modèles légers en fin de journée, au
 *      lieu de tomber en panne à 16 h.
 */

export interface RoutingDecision {
  /** Modèles retenus, du meilleur au moins bon. Vide si aucun n'est éligible. */
  candidates: ModelDescriptor[];
  /** Pourquoi chaque modèle écarté l'a été. Sert au diagnostic, pas au contrôle. */
  rejected: string[];
}

/**
 * Un modèle ne voit une donnée que s'il a le droit de la voir.
 *
 * Le texte d'un acheteur ne sort jamais de chez nous. Nos chiffres peuvent
 * partir chez un tiers, à condition d'avoir été assainis. Ce qui est déjà
 * public peut aller partout.
 */
function privacyAllows(model: ModelDescriptor, dataClass: ExecutionRequest["dataClass"]): boolean {
  if (dataClass === "customer") return model.privacy === "trusted_customer";
  if (dataClass === "internal") return model.privacy !== "public_only";
  return true;
}

/**
 * Pression budgétaire du modèle : 0 quand la journée commence, 1 quand il ne
 * reste plus rien. Élevée au carré pour ne mordre qu'en fin de course — sans
 * ça, un plafond lointain pénaliserait dès le matin un modèle parfaitement
 * abordable.
 */
function pressure(
  model: ModelDescriptor,
  usage: DailyUsage,
  limits: FreeLimits,
  estimatedNeurons: number,
): number {
  if (model.provider === "cloudflare") {
    const remaining = Math.max(1, limits.neurons - usage.neurons);
    // Ici la pression est linéaire et non quadratique : le coût d'un appel
    // varie d'un facteur dix selon le modèle, c'est cette différence qu'on
    // veut voir, pas seulement la proximité du plafond.
    return Math.min(1, estimatedNeurons / remaining);
  }
  const cap = limits.requests[model.provider];
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const ratio = (usage.requests[model.provider] ?? 0) / cap;
  return Math.min(1, ratio * ratio);
}

/** Poids de la pression budgétaire face à la qualité. Calibré à l'usage. */
const FRUGALITY_WEIGHT = 250;

function score(
  model: ModelDescriptor,
  request: ExecutionRequest,
  usage: DailyUsage,
  limits: FreeLimits,
  estimatedNeurons: number,
): number {
  let value = model.quality;

  if (request.hint === "fast") value += model.speed * 0.5;

  if (request.hint === "deep") {
    // Un modèle sans raisonnement profond n'est pas seulement moins bon sur ce
    // travail : il donne une réponse plausible et fausse, ce qui est pire.
    value += model.capabilities.includes("deep_reasoning") ? 40 : -60;
  }

  // PRIME DE LA MAISON. Dès que la donnée n'est pas déjà publique, on préfère
  // rester chez nous — même quand un fournisseur externe est autorisé et
  // meilleur sur le papier.
  //
  // Deux raisons, dans cet ordre. La confidentialité d'abord : nos chiffres ne
  // traversent pas Internet tant que ce n'est pas nécessaire, et l'on n'a pas
  // à faire reposer leur protection sur un nettoyeur de texte. L'économie
  // ensuite : l'allocation Cloudflare se renouvelle chaque jour et se perd si
  // elle n'est pas consommée, alors qu'un appel Gemini pris le matin ne sera
  // plus disponible le soir pour une recherche marché qui, elle, n'a aucun
  // autre chemin.
  //
  // La prime ne fige rien : la pression budgétaire plus bas la neutralise
  // quand l'allocation s'épuise, et le panel sort alors de lui-même.
  if (model.provider === "cloudflare" && request.dataClass !== "public") {
    value += request.dataClass === "customer" ? 30 : 15;
  }

  if (request.impact === "high") value += model.quality * 0.3;

  if (request.prefer?.includes(model.provider)) value += 25;

  return value - pressure(model, usage, limits, estimatedNeurons) * FRUGALITY_WEIGHT;
}

export function route(
  catalogue: ModelDescriptor[],
  request: ExecutionRequest,
  usage: DailyUsage,
  limits: FreeLimits = FREE_LIMITS,
): RoutingDecision {
  const inputTokens = estimateInputTokens(request.messages);
  // Pessimisme volontaire sur la sortie : on suppose que le modèle ira au bout
  // de ce qu'on l'autorise à écrire. Se tromper vers le haut coûte un repli
  // sur un modèle plus léger ; se tromper vers le bas coûte de l'argent.
  const outputTokens = request.maxOutputTokens ?? 1_200;

  const rejected: string[] = [];
  const eligible: Array<{ model: ModelDescriptor; value: number }> = [];

  for (const model of catalogue) {
    const id = `${model.provider}/${model.model}`;

    if (!privacyAllows(model, request.dataClass)) {
      rejected.push(`${id} : confidentialité ${request.dataClass}`);
      continue;
    }
    if (!request.capabilities.every((c) => model.capabilities.includes(c))) {
      rejected.push(`${id} : capacité manquante`);
      continue;
    }
    if (request.webSearch && !model.capabilities.includes("web_search")) {
      rejected.push(`${id} : pas d'ancrage web`);
      continue;
    }

    const estimatedNeurons = neuronsFor(model, { inputTokens, outputTokens });
    const verdict = allows(model, usage, {
      limits,
      ...(request.webSearch === undefined ? {} : { webSearch: request.webSearch }),
      ...(request.automatic === undefined ? {} : { automatic: request.automatic }),
      estimatedNeurons,
    });
    if (!verdict.ok) {
      rejected.push(`${id} : ${verdict.reason}`);
      continue;
    }

    eligible.push({
      model,
      value: score(model, request, usage, limits, estimatedNeurons),
    });
  }

  eligible.sort((a, b) => b.value - a.value);
  return { candidates: eligible.map((e) => e.model), rejected };
}
