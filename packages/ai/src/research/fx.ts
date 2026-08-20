/**
 * Conversion de devises, sur les taux de référence de la BCE.
 *
 * POURQUOI C'EST INDISPENSABLE À UNE RECHERCHE DE PRIX : le web renvoie des
 * prix en euros, en dollars, en livres, parfois en yuans. Calculer une médiane
 * sur ce mélange donne un nombre qui ne veut rien dire — et pire, un nombre
 * qui a l'air d'un prix. Un article à « 45 » en dollars et un autre à « 45 »
 * en livres ne sont pas au même prix, mais ils se ressemblent assez pour
 * passer inaperçus dans une liste.
 *
 * La BCE publie ses taux quotidiens en accès libre : pas de clé, pas de
 * compte, pas de plafond. C'est la seule source de change du panel.
 *
 * Ce que ces taux ne sont PAS : un taux de change commercial. Ils servent de
 * référence pour comparer des ordres de grandeur, pas à calculer ce que
 * coûtera réellement un virement.
 */

const SOURCE = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export interface FxRates {
  /** Devise → nombre d'unités pour un euro. L'euro y figure à 1. */
  perEuro: Record<string, number>;
  /** Date de publication annoncée par la BCE, AAAA-MM-JJ. */
  publishedOn: string;
}

/**
 * Lit et analyse le flux quotidien.
 *
 * Analyse par expression régulière plutôt que par un analyseur XML : le
 * document tient en quarante lignes de forme parfaitement stable depuis vingt
 * ans, et l'environnement Workers n'a pas de `DOMParser`. Importer une
 * bibliothèque pour cela coûterait plus que ce que ça rapporte.
 */
export async function fetchEcbRates(): Promise<FxRates> {
  const response = await fetch(SOURCE, {
    headers: { accept: "application/xml,text/xml" },
    // Le taux ne change qu'une fois par jour ouvré : le cache de Cloudflare
    // évite de redemander le même document à chaque recherche.
    cf: { cacheTtl: 6 * 60 * 60, cacheEverything: true },
  } as RequestInit);

  if (!response.ok) throw new Error(`ECB_HTTP:${response.status}`);
  const xml = await response.text();

  const publishedOn = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1] ?? "";
  // L'euro n'est pas listé — il est la base, à 1 par définition.
  const perEuro: Record<string, number> = { EUR: 1 };

  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const code = m[1];
    const rate = Number(m[2]);
    if (code && Number.isFinite(rate) && rate > 0) perEuro[code] = rate;
  }

  if (Object.keys(perEuro).length < 5) throw new Error("ECB_FORMAT_INATTENDU");
  return { perEuro, publishedOn };
}

export interface Converted {
  /** Centimes d'euro. */
  amount: number;
  /** Taux appliqué, pour que le chiffre reste vérifiable. */
  rate: number;
}

/**
 * Convertit un montant vers l'euro.
 *
 * `null` quand la devise est inconnue du flux — et c'est volontaire. Convertir
 * au petit bonheur, ou pire, supposer que c'est déjà des euros, ferait entrer
 * un prix faux dans une médiane sans que rien ne le signale. Un prix qu'on ne
 * sait pas convertir est un prix qu'on écarte.
 */
export function toEur(
  amount: number,
  currency: string | null | undefined,
  rates: FxRates,
): Converted | null {
  const code = (currency ?? "EUR").toUpperCase();
  const rate = rates.perEuro[code];
  if (!rate) return null;
  return { amount: Math.round(amount / rate), rate };
}

/** Devises que le flux BCE ne couvre pas et que l'on rencontrera. */
export const DEVISES_NON_COUVERTES = ["AED", "SAR", "VND", "UAH"] as const;
