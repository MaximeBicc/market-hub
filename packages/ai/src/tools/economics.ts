/**
 * Arithmétique commerciale.
 *
 * POURQUOI CE FICHIER EXISTE : un modèle de langage sait expliquer une marge,
 * il ne sait pas la calculer de façon fiable. Il produira 34 % au lieu de
 * 33,7 %, ou appliquera la commission au prix d'achat plutôt qu'au prix de
 * vente, avec une assurance parfaite dans les deux cas.
 *
 * La règle du panel est donc : tout ce qui se calcule se calcule ici, en
 * TypeScript et en centimes entiers. Le modèle reçoit les nombres déjà faits
 * et n'a plus qu'à les interpréter. Il ne peut pas se tromper sur un chiffre
 * qu'on ne lui demande pas de produire.
 *
 * Toutes les valeurs monétaires sont des CENTIMES entiers, jamais des
 * flottants : 0,1 + 0,2 ne vaut pas 0,3 en virgule flottante, et une marge
 * fausse d'un centime sur dix mille lignes se voit en fin de mois.
 */

export interface MarginInput {
  /** Prix de vente, centimes. */
  price: number;
  /** Prix d'achat, centimes. Null quand il n'a jamais été saisi. */
  cost: number | null;
  /**
   * Commission de la plateforme, en fraction (0,065 pour 6,5 %).
   * Null quand elle est inconnue : elle le reste, on ne la devine pas.
   */
  feeRate?: number | null | undefined;
  /** Frais d'expédition à notre charge, centimes. */
  shipping?: number | null | undefined;
}

export interface MarginResult {
  /** Centimes encaissés après commission. Null si la commission est inconnue. */
  net: number | null;
  /** Marge brute en centimes. Null si le prix d'achat est inconnu. */
  margin: number | null;
  /** Marge rapportée au prix de vente, 0–1. Null si incalculable. */
  marginRate: number | null;
  /** Ce qui manquait pour aller plus loin. Affiché tel quel à l'utilisateur. */
  unknowns: string[];
}

/**
 * Marge sur une vente.
 *
 * Un inconnu ne devient jamais zéro. Traiter une commission inconnue comme
 * nulle produirait une marge flatteuse et fausse — exactement l'erreur qui
 * fait garder un produit qui perd de l'argent.
 */
export function margin(input: MarginInput): MarginResult {
  const unknowns: string[] = [];

  if (input.cost === null || input.cost === undefined) unknowns.push("prix d'achat");
  if (input.feeRate === null || input.feeRate === undefined) unknowns.push("commission plateforme");
  if (input.shipping === null || input.shipping === undefined) unknowns.push("frais d'expédition");

  const fee = input.feeRate ?? null;
  const net = fee === null ? null : Math.round(input.price * (1 - fee));

  if (input.cost === null || input.cost === undefined || net === null) {
    return { net, margin: null, marginRate: null, unknowns };
  }

  const shipping = input.shipping ?? 0;
  const value = net - input.cost - shipping;

  return {
    net,
    margin: value,
    marginRate: input.price > 0 ? value / input.price : null,
    unknowns,
  };
}

/**
 * Prix minimum pour atteindre un taux de marge donné.
 *
 * Résout `(p × (1 − commission) − achat − port) / p = cible` pour p, soit
 * `p = (achat + port) / (1 − commission − cible)`. Le dénominateur devient nul
 * ou négatif quand la commission et la marge visée dépassent cent pour cent :
 * aucun prix ne satisfait alors la contrainte, et on le dit plutôt que de
 * renvoyer un nombre absurde.
 */
export function priceForMargin(input: {
  cost: number;
  feeRate: number;
  targetMarginRate: number;
  shipping?: number | undefined;
}): number | null {
  const denominator = 1 - input.feeRate - input.targetMarginRate;
  if (denominator <= 0) return null;
  return Math.ceil((input.cost + (input.shipping ?? 0)) / denominator);
}

/** Écart relatif entre deux prix, du point de vue du premier. */
export function relativeGap(price: number, reference: number): number | null {
  if (reference <= 0) return null;
  return (price - reference) / reference;
}

export interface PriceSpread {
  min: number;
  max: number;
  median: number;
  count: number;
}

/**
 * Dispersion d'un ensemble de prix.
 *
 * La médiane et non la moyenne : sur un marché, une seule annonce à 900 € au
 * milieu d'offres à 20 € déplace la moyenne de façon décisive, alors qu'elle
 * ne dit rien du prix auquel on vend réellement.
 */
export function spread(prices: number[]): PriceSpread | null {
  const values = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (values.length === 0) return null;

  const middle = values.length >> 1;
  const median =
    values.length % 2 === 1
      ? (values[middle] as number)
      : Math.round(((values[middle - 1] as number) + (values[middle] as number)) / 2);

  return {
    min: values[0] as number,
    max: values[values.length - 1] as number,
    median,
    count: values.length,
  };
}
