import type { Evidence } from "../domain/types.js";
import { toEur, type FxRates } from "./fx.js";

/**
 * Tri et dédoublonnage des preuves.
 *
 * Deux problèmes distincts, souvent confondus :
 *
 * 1. LA MÊME PAGE REVIENT PLUSIEURS FOIS, sous des URL différentes — un
 *    paramètre de suivi, une ancre, un `www` en trop. Sans dédoublonnage, une
 *    annonce comptée trois fois pèse trois fois dans la médiane.
 *
 * 2. TOUTES LES SOURCES NE SE VALENT PAS. La page officielle d'un vendeur vaut
 *    mieux qu'un comparateur qui la recopie, lui-même mieux qu'un blog qui
 *    cite le comparateur. La date compte autant : un prix d'il y a six mois
 *    n'est pas un prix.
 */

/**
 * Paramètres de suivi retirés AVANT comparaison, jamais avant affichage.
 *
 * L'URL montrée à l'utilisateur reste celle qu'on a réellement observée : la
 * nettoyer pourrait la casser sur certains sites, et une preuve dont le lien
 * ne s'ouvre pas ne prouve plus rien.
 */
const SUIVI = /^(utm_|fbclid|gclid|mc_|ref|referrer|source|campaign|_ga)/i;

/** Forme comparable d'une URL. Sert au dédoublonnage, et à rien d'autre. */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.protocol = "https:";
    // Les clés sont relevées AVANT suppression : modifier une collection
    // pendant qu'on la parcourt saute un élément sur deux.
    const aRetirer: string[] = [];
    url.searchParams.forEach((_, key) => {
      if (SUIVI.test(key)) aRetirer.push(key);
    });
    for (const key of aRetirer) url.searchParams.delete(key);
    // Une barre oblique finale ne distingue pas deux pages.
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Confiance de départ, par nature de source. */
const FIABILITE: Record<NonNullable<Evidence["kind"]>, number> = {
  internal: 1, // nos propres données : rien de plus sûr
  marketplace_api: 0.9, // une API officielle, pas une page lue
  supplier_api: 0.9,
  page: 0.6, // page produit lue directement
  search: 0.45, // extrait de résultat de recherche, non vérifié
};

/** Décote selon l'âge de l'observation, sur trente jours. */
function fraicheur(observedAt: string, nowMs: number): number {
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return 0.5;
  const jours = (nowMs - t) / 86_400_000;
  if (jours <= 1) return 1;
  if (jours >= 30) return 0.2;
  return 1 - (jours / 30) * 0.8;
}

export interface RankedEvidence extends Evidence {
  reliability: number;
  /** Prix ramené à l'euro. Null quand la devise est inconnue ou le prix absent. */
  priceEur: number | null;
}

/**
 * Dédoublonne, convertit, classe.
 *
 * En cas de doublon on garde la MEILLEURE des deux, pas la première : un même
 * produit vu à la fois par une API officielle et par un résultat de recherche
 * doit être retenu par l'API.
 */
export function rankEvidence(
  evidence: Evidence[],
  rates: FxRates,
  nowMs: number,
): RankedEvidence[] {
  const parUrl = new Map<string, RankedEvidence>();

  for (const item of evidence) {
    if (!item.url) continue;

    const converti =
      typeof item.price === "number" && item.price > 0
        ? toEur(item.price, item.currency, rates)
        : null;

    const base = FIABILITE[item.kind] ?? 0.4;
    const classee: RankedEvidence = {
      ...item,
      priceEur: converti?.amount ?? null,
      // Une preuve sans prix reste utile — elle situe un fournisseur, une
      // référence — mais elle ne pèse pas autant qu'un prix observé.
      reliability:
        base * fraicheur(item.observedAt, nowMs) * (converti ? 1 : 0.75),
    };

    const cle = canonicalUrl(item.url);
    const existante = parUrl.get(cle);
    if (!existante || classee.reliability > existante.reliability) {
      parUrl.set(cle, classee);
    }
  }

  return [...parUrl.values()].sort((a, b) => b.reliability - a.reliability);
}

/**
 * Les prix exploitables, en centimes d'euro.
 *
 * Une preuve sans prix, ou dont la devise n'a pas pu être convertie, n'entre
 * pas dans le calcul. C'est la règle qui empêche une médiane d'être fausse :
 * mieux vaut une statistique sur cinq observations qu'une statistique sur huit
 * dont trois sont dans une devise inconnue.
 */
export function usablePrices(ranked: RankedEvidence[]): number[] {
  return ranked
    .map((e) => e.priceEur)
    .filter((p): p is number => typeof p === "number" && p > 0);
}
