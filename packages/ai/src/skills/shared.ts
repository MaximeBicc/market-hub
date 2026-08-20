import type { ProductFacts } from "../domain/types.js";

/**
 * Règles communes à toutes les skills.
 *
 * Elles sont en tête de chaque instruction système parce que c'est le seul
 * endroit où l'on peut border un modèle : une fois la réponse produite, il est
 * trop tard pour lui interdire d'inventer.
 */
export const SYSTEM_RULES = `Tu assistes un vendeur qui gère plusieurs boutiques en ligne.

Règles absolues :
- Tu n'inventes aucun chiffre. Les nombres qu'on te donne sont déjà calculés : tu les interprètes, tu ne les recalcules pas et tu ne les corriges pas.
- Ce qui est marqué inconnu reste inconnu. Tu le signales, tu ne le remplaces pas par une estimation.
- Tu écris en français, dans un registre sobre : pas de superlatif, pas d'emphase, pas de formule d'accroche.
- Tu réponds uniquement par du JSON valide, sans texte autour et sans bloc de code.
- Ta confiance est un nombre entre 0 et 1. Elle est basse quand les données manquent, et le dire est une bonne réponse.`;

/**
 * Le produit tel que le modèle le voit.
 *
 * Volontairement construit champ par champ plutôt que sérialisé depuis la
 * base : c'est ce qui garantit qu'un champ ajouté plus tard au schéma — un
 * nom d'acheteur, une note interne — ne parte pas chez un fournisseur tiers
 * sans que personne l'ait décidé.
 */
export function productSummary(product: ProductFacts): Record<string, unknown> {
  return {
    sku: product.sku,
    titre: product.title,
    prixAchatCentimes: product.costPrice,
    prixReferenceCentimes: product.referencePrice,
    etiquettes: product.tags,
    stockPhysique: product.onHand,
    stockReserve: product.reserved,
    annonces: product.listings.map((l) => ({
      plateforme: l.platform,
      boutique: l.shopName,
      prixCentimes: l.price,
      devise: l.currency,
      quantite: l.quantity,
      statut: l.status,
    })),
  };
}

/**
 * Budget de sortie : prévoir le raisonnement.
 *
 * Tous les modèles du catalogue Workers AI réfléchissent à voix haute avant de
 * répondre, et cette réflexion consomme le budget de sortie — mesuré entre 100
 * et 190 jetons sur une simple demande de JSON, le 20 août 2026. Un budget
 * calculé sur la seule taille de la réponse attendue produit donc une réponse
 * vide, et une skill qui interprète du vide.
 *
 * Les skills gardent donc une marge d'environ 300 jetons au-dessus de ce dont
 * leur JSON a besoin. Le fournisseur Cloudflare, lui, refuse explicitement une
 * réponse tronquée avant la première ligne utile plutôt que de la laisser
 * passer pour une réponse vide.
 */

/** Réponse minimale attendue de toute skill d'analyse. */
export interface Interpretation {
  conclusion: string;
  confidence: number;
}

export const JSON_HINT = (shape: string): string =>
  `Réponds exactement selon cette forme JSON : ${shape}`;
