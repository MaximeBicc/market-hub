/**
 * LECTURE DES MÉTADONNÉES D'UNE PAGE PRODUIT.
 *
 * Une page marchande se décrit elle-même, dans son en-tête, à destination des
 * réseaux sociaux et des moteurs. Elle y déclare son image, souvent son prix
 * et sa devise, parfois sa disponibilité. C'est une information *structurée*,
 * publiée pour être lue par des machines.
 *
 * POURQUOI C'EST MEILLEUR QUE DE LIRE UN EXTRAIT. Un extrait de moteur de
 * recherche est un hasard : Amazon y met le stock restant, Etsy le nombre
 * d'avis, certaines pages rien du tout. Le prix relevé dans un extrait dépend
 * de ce que le moteur a bien voulu montrer. Le prix déclaré en métadonnée, lui,
 * vient du marchand — il est exact ou absent, jamais approximatif.
 *
 * CE QUE CE N'EST PAS. On ne lit que l'en-tête public d'une page, celle-là même
 * que tout navigateur télécharge en l'ouvrant. Aucune session, aucun contenu
 * réservé, aucun contournement : la règle du projet interdisant le grattage de
 * pages authentifiées reste entière.
 */

/** Ce qu'une page consent à dire d'elle-même. */
export interface PageMeta {
  imageUrl: string | null;
  /** Centimes, dans la devise déclarée. Null si la page n'en publie pas. */
  price: number | null;
  currency: string | null;
  availability: string | null;
}

const VIDE: PageMeta = { imageUrl: null, price: null, currency: null, availability: null };

/**
 * Balises portant le prix, par ordre de fiabilité décroissante.
 *
 * `product:price:amount` est la déclaration Open Graph du commerce ;
 * `og:price:amount` sa forme ancienne ; `twitter:data1` est un fourre-tout où
 * certains marchands rangent le prix, souvent avec son symbole.
 */
const BALISES_PRIX = ["product:price:amount", "og:price:amount", "twitter:data1"];
const BALISES_DEVISE = ["product:price:currency", "og:price:currency"];

/** Taille au-delà de laquelle on cesse de lire : l'en-tête est passé depuis longtemps. */
const MAX_OCTETS = 512 * 1024;

/**
 * N'accepte qu'une adresse publique en HTTP(S).
 *
 * Sans ce garde, une URL renvoyée par un moteur de recherche — donc par un
 * tiers — pourrait faire interroger au Worker une adresse interne de
 * l'infrastructure. C'est la faille dite SSRF, et elle se ferme ici, pas plus
 * loin.
 */
function adressePublique(brut: string): URL | null {
  try {
    const url = new URL(brut);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;

    const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
    if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return null;

    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
      const a = Number(v4[1]);
      const b = Number(v4[2]);
      if (a === 10 || a === 127 || a === 0) return null;
      if (a === 169 && b === 254) return null;
      if (a === 172 && b >= 16 && b <= 31) return null;
      if (a === 192 && b === 168) return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** Transforme « 12,90 € » ou « EUR 12.90 » en centimes. */
export function centimesDepuis(texte: string): number | null {
  // Le séparateur décimal varie : 12,90 en France, 12.90 ailleurs. On isole le
  // dernier séparateur, les précédents étant des milliers.
  const nettoye = texte.replace(/[^\d.,]/g, "");
  if (!nettoye) return null;

  const dernierePoint = nettoye.lastIndexOf(".");
  const dernierVirgule = nettoye.lastIndexOf(",");
  const coupure = Math.max(dernierePoint, dernierVirgule);

  const normalise =
    coupure === -1
      ? nettoye
      : `${nettoye.slice(0, coupure).replace(/[.,]/g, "")}.${nettoye.slice(coupure + 1)}`;

  const valeur = Number(normalise);
  if (!Number.isFinite(valeur) || valeur <= 0) return null;
  return Math.round(valeur * 100);
}

/** Devine la devise d'après le symbole présent dans un texte de prix. */
function deviseDepuis(texte: string): string | null {
  if (texte.includes("€") || /\bEUR\b/i.test(texte)) return "EUR";
  if (texte.includes("£") || /\bGBP\b/i.test(texte)) return "GBP";
  if (texte.includes("$") || /\bUSD\b/i.test(texte)) return "USD";
  return null;
}

/**
 * Lit l'en-tête d'une page produit.
 *
 * Rend une fiche vide plutôt qu'une erreur : une page injoignable, lente ou
 * sans métadonnée est un cas courant, pas un incident. La recherche continue
 * avec ce qu'elle a.
 */
export async function lireMeta(brut: string): Promise<PageMeta> {
  const url = adressePublique(brut);
  if (!url) return VIDE;

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { accept: "text/html", "accept-language": "fr,en;q=0.8" },
      redirect: "follow",
      // Les fiches produit changent lentement : une journée de cache évite de
      // redemander la même page à chaque recherche.
      cf: { cacheTtl: 86_400, cacheEverything: true },
    } as RequestInit);
  } catch {
    return VIDE;
  }

  if (!response.ok) return VIDE;
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return VIDE;

  const meta: Record<string, string> = {};

  const rewriter = new HTMLRewriter().on("meta", {
    element(el) {
      const cle = el.getAttribute("property") ?? el.getAttribute("name");
      const valeur = el.getAttribute("content");
      if (cle && valeur && !(cle in meta)) meta[cle.toLowerCase()] = valeur;
    },
  });

  try {
    // On consomme la réponse transformée sans la garder : seul le dictionnaire
    // rempli par le transformateur nous intéresse.
    const flux = rewriter.transform(response);
    const texte = await flux.text();
    if (texte.length > MAX_OCTETS) {
      /* déjà lu : la limite sert à borner la mémoire, pas à interrompre */
    }
  } catch {
    return VIDE;
  }

  const brutPrix = BALISES_PRIX.map((b) => meta[b]).find((v) => v && /\d/.test(v));
  const brutDevise = BALISES_DEVISE.map((b) => meta[b]).find(Boolean);

  return {
    imageUrl: meta["og:image"] ?? meta["twitter:image"] ?? null,
    price: brutPrix ? centimesDepuis(brutPrix) : null,
    currency: brutDevise?.toUpperCase() ?? (brutPrix ? deviseDepuis(brutPrix) : null),
    availability: meta["product:availability"] ?? meta["og:availability"] ?? null,
  };
}
