import type { SalesPoint } from "../domain/types.js";

/**
 * Statistiques sur une série de ventes.
 *
 * Même principe que `economics.ts` : le calcul est ici, l'interprétation est
 * au modèle. Un LLM à qui l'on demande « ces ventes sont-elles anormales ? »
 * répond oui bien trop souvent — il cherche à être utile. Un écart-type, lui,
 * ne cherche rien.
 */

export interface Velocity {
  /** Unités vendues par jour sur la fenêtre observée. */
  perDay: number;
  totalUnits: number;
  /** Centimes. */
  totalRevenue: number;
  days: number;
  /**
   * Nombre de jours avec au moins une vente. Deux produits à 30 unités n'ont
   * rien à voir selon qu'elles sont parties en un jour ou en trente.
   */
  activeDays: number;
}

export function velocity(points: SalesPoint[]): Velocity {
  const totalUnits = points.reduce((sum, p) => sum + p.units, 0);
  const totalRevenue = points.reduce((sum, p) => sum + p.revenue, 0);
  const days = Math.max(1, points.length);

  return {
    perDay: totalUnits / days,
    totalUnits,
    totalRevenue,
    days,
    activeDays: points.filter((p) => p.units > 0).length,
  };
}

export interface Coverage {
  /** Jours de stock restants au rythme actuel. Null si le produit ne se vend pas. */
  days: number | null;
  onHand: number;
  available: number;
  /** Vrai quand la couverture passe sous le seuil demandé. */
  low: boolean;
}

/**
 * Couverture de stock.
 *
 * `null` et non `Infinity` quand le rythme est nul : « il reste 47 000 jours
 * de stock » est une phrase vraie et inutile. « Ce produit ne s'est pas vendu
 * sur la période » est la bonne information.
 */
export function coverage(input: {
  onHand: number;
  reserved: number;
  perDay: number;
  lowThresholdDays: number;
}): Coverage {
  const available = Math.max(0, input.onHand - input.reserved);
  if (input.perDay <= 0) {
    return { days: null, onHand: input.onHand, available, low: false };
  }
  const days = available / input.perDay;
  return {
    days: Math.round(days * 10) / 10,
    onHand: input.onHand,
    available,
    low: days < input.lowThresholdDays,
  };
}

/**
 * Quantité à commander pour tenir jusqu'à la prochaine livraison, plus une
 * marge de sécurité.
 *
 * `null` sans rythme de vente établi : sans historique, toute quantité
 * proposée serait une invention. Mieux vaut afficher « pas assez d'historique »
 * que suggérer d'immobiliser de la trésorerie sur une intuition.
 */
export function restockQuantity(input: {
  perDay: number;
  available: number;
  leadTimeDays: number;
  coverTargetDays: number;
}): number | null {
  if (input.perDay <= 0) return null;
  const needed = input.perDay * (input.leadTimeDays + input.coverTargetDays);
  return Math.max(0, Math.ceil(needed - input.available));
}

export interface Anomaly {
  date: string;
  units: number;
  /** Écarts-types par rapport à la moyenne de la série. */
  z: number;
  direction: "haut" | "bas";
}

export interface AnomalyReport {
  mean: number;
  stdDev: number;
  anomalies: Anomaly[];
  /** Faux quand la série est trop courte ou trop plate pour conclure. */
  usable: boolean;
  note?: string | undefined;
}

/**
 * Détection d'écarts par cote z.
 *
 * Deux garde-fous, et ils comptent plus que la formule :
 *
 *   • moins de quatorze points, on refuse de conclure. Sur une semaine, un
 *     samedi chargé sort systématiquement du lot sans rien signifier ;
 *   • écart-type nul, on refuse aussi. Une série plate donnerait une division
 *     par zéro, et la moindre vente deviendrait une anomalie infinie.
 */
export function detectAnomalies(points: SalesPoint[], threshold = 2): AnomalyReport {
  if (points.length < 14) {
    return {
      mean: 0,
      stdDev: 0,
      anomalies: [],
      usable: false,
      note: `Historique trop court : ${points.length} jours, il en faut au moins 14.`,
    };
  }

  const values = points.map((p) => p.units);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return {
      mean,
      stdDev: 0,
      anomalies: [],
      usable: false,
      note: "Ventes parfaitement régulières : aucun écart à mesurer.",
    };
  }

  const anomalies: Anomaly[] = [];
  for (const point of points) {
    const z = (point.units - mean) / stdDev;
    if (Math.abs(z) >= threshold) {
      anomalies.push({
        date: point.date,
        units: point.units,
        z: Math.round(z * 100) / 100,
        direction: z > 0 ? "haut" : "bas",
      });
    }
  }

  return { mean: Math.round(mean * 100) / 100, stdDev: Math.round(stdDev * 100) / 100, anomalies, usable: true };
}

export interface Trend {
  /** Variation entre la première et la seconde moitié de la période, en fraction. */
  change: number | null;
  firstHalfUnits: number;
  secondHalfUnits: number;
}

/**
 * Tendance grossière : deux moitiés comparées.
 *
 * Pas de régression linéaire — sur trente points bruités elle donnerait une
 * pente précise et trompeuse. Deux moitiés répondent à la seule question qui
 * compte ici : est-ce que ça monte ou est-ce que ça descend.
 */
export function trend(points: SalesPoint[]): Trend {
  const half = Math.floor(points.length / 2);
  if (half === 0) return { change: null, firstHalfUnits: 0, secondHalfUnits: 0 };

  const first = points.slice(0, half).reduce((sum, p) => sum + p.units, 0);
  const second = points.slice(half).reduce((sum, p) => sum + p.units, 0);

  return {
    change: first > 0 ? (second - first) / first : null,
    firstHalfUnits: first,
    secondHalfUnits: second,
  };
}
