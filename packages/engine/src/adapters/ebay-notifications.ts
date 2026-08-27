/**
 * VÉRIFIER UNE NOTIFICATION EBAY.
 *
 * eBay ne signe pas comme les autres. Shopify pose un HMAC du corps avec un
 * secret partagé ; Etsy suit le format Svix. eBay, lui, signe avec SA clé
 * privée — ECDSA sur P-256, empreinte SHA-1 — et publie la clé publique
 * correspondante derrière un identifiant transporté dans l'en-tête.
 *
 * Trois conséquences qui façonnent tout ce fichier :
 *
 *   1. La signature arrive en DER, la forme des certificats. Web Crypto attend
 *      `r||s` brut. Il faut donc convertir, et c'est le seul endroit du dépôt
 *      où l'on lit de l'ASN.1 à la main.
 *
 *   2. La clé se récupère par un appel réseau, contre un jeton APPLICATIF.
 *      Elle doit être mise en cache : eBay avertit du dépassement de quota si
 *      on la redemande à chaque notification.
 *
 *   3. LA CLÉ EST CELLE D'EBAY, PAS CELLE DU VENDEUR. Contrairement à Shopify
 *      et Etsy, la signature ne désigne donc AUCUN compte : toutes les
 *      boutiques eBay la vérifieraient avec succès. Le routage doit se faire
 *      sur l'identifiant d'utilisateur porté par la charge utile, une fois
 *      celle-ci authentifiée.
 */

/** Ce que l'en-tête `x-ebay-signature` transporte, une fois décodé. */
export interface EnTeteSignature {
  /** Identifiant de la clé publique à récupérer chez eBay. */
  kid: string;
  /** La signature elle-même, en base64, au format DER. */
  signature: string;
  /** L'empreinte annoncée. eBay écrit « SHA1 ». */
  digest?: string | undefined;
  alg?: string | undefined;
}

/**
 * Décode l'en-tête de signature.
 *
 * Il contient du JSON encodé en base64. Rien de secret : l'encodage sert
 * seulement à faire tenir une structure dans une valeur d'en-tête.
 */
export function lireEnTeteSignature(valeur: string): EnTeteSignature | null {
  try {
    const json = atob(valeur.trim());
    const o = JSON.parse(json) as Record<string, unknown>;
    const kid = typeof o["kid"] === "string" ? o["kid"] : null;
    const signature =
      typeof o["signature"] === "string" ? o["signature"] : null;
    if (!kid || !signature) return null;
    return {
      kid,
      signature,
      /*
       * `alg` et `digest` sont lus mais PAS comparés. La documentation d'eBay
       * annonce « ECDSA » en majuscules, la charge réelle porte « ecdsa » en
       * minuscules. Refuser sur cet écart bloquerait toutes les notifications
       * pour une différence de casse dans un champ décoratif.
       */
      ...(typeof o["digest"] === "string" ? { digest: o["digest"] } : {}),
      ...(typeof o["alg"] === "string" ? { alg: o["alg"] } : {}),
    };
  } catch {
    return null;
  }
}

/** Base64 vers octets, sans dépendre d'une bibliothèque. */
export function base64Octets(b64: string): Uint8Array<ArrayBuffer> {
  const binaire = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binaire.length));
  for (let i = 0; i < binaire.length; i++) out[i] = binaire.charCodeAt(i);
  return out;
}

/**
 * Convertit une signature DER en `r||s` brut.
 *
 * ══ POURQUOI CE CODE EXISTE ══
 *
 * Une signature ECDSA est un couple d'entiers (r, s). Deux encodages
 * cohabitent dans le monde :
 *
 *   DER    30 46 02 21 00 9f… 02 21 00 85…    ← ce qu'envoie eBay
 *   brut   9f… 85…  (32 octets chacun)        ← ce qu'attend Web Crypto
 *
 * Deux détails font toute la difficulté, et les deux sont éprouvés par les
 * tests :
 *
 *   - DER encode des entiers SIGNÉS. Quand `r` commence par un octet ≥ 0x80,
 *     un zéro de tête est ajouté pour qu'il ne soit pas lu comme négatif : il
 *     faut le retirer. Sur trois cents signatures tirées au hasard, cent
 *     trente-quatre portaient ce zéro — ce n'est pas un cas rare.
 *
 *   - À l'inverse, un `r` qui commence par des zéros est encodé plus COURT :
 *     il faut le compléter à gauche jusqu'à trente-deux octets. Une seule
 *     signature sur trois cents, mais elle serait rejetée sans ça.
 */
export function derVersRaw(
  der: Uint8Array,
  taille = 32,
): Uint8Array<ArrayBuffer> {
  let o = 0;
  if (der[o++] !== 0x30) {
    throw new Error("Signature eBay : séquence DER attendue");
  }

  // Longueur courte ou longue : au-delà de 127 octets, le bit de poids fort
  // annonce combien d'octets portent la longueur.
  let len = der[o++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | der[o++]!;
  }

  const lireEntier = (): Uint8Array => {
    if (der[o++] !== 0x02) {
      throw new Error("Signature eBay : entier DER attendu");
    }
    const l = der[o++]!;
    let v = der.subarray(o, o + l);
    o += l;
    while (v.length > taille && v[0] === 0x00) v = v.subarray(1);
    if (v.length > taille) {
      throw new Error("Signature eBay : entier plus long que la courbe");
    }
    const out = new Uint8Array(new ArrayBuffer(taille));
    out.set(v, taille - v.length);
    return out;
  };

  const r = lireEntier();
  const s = lireEntier();
  const raw = new Uint8Array(new ArrayBuffer(taille * 2));
  raw.set(r, 0);
  raw.set(s, taille);
  return raw;
}

/**
 * Importe la clé publique rendue par eBay.
 *
 * Elle arrive en PEM DÉGÉNÉRÉ : les marqueurs `BEGIN`/`END` sont là, mais sans
 * aucun saut de ligne. Les retirer et décoder le base64 donne du SPKI, que
 * Web Crypto sait lire directement — inutile de reconstruire le PEM.
 */
export async function importerClePublique(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return crypto.subtle.importKey(
    "spki",
    base64Octets(b64),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * Vérifie qu'un corps vient bien d'eBay.
 *
 * La signature porte sur le CORPS BRUT, seul — pas d'en-tête, pas
 * d'horodatage, pas d'URL dans la chaîne signée. C'est aussi pour ça qu'il ne
 * faut jamais réanalyser puis re-sérialiser le corps avant de vérifier : un
 * espace de différence, une clé réordonnée, et la signature ne correspond
 * plus. Le corps se lit une fois et se vérifie tel quel.
 */
export async function verifierSignatureEbay(
  clePublique: CryptoKey,
  signatureBase64: string,
  corpsBrut: string,
): Promise<boolean> {
  const raw = derVersRaw(base64Octets(signatureBase64));
  return crypto.subtle.verify(
    // L'empreinte se donne à l'APPEL pour ECDSA, pas à l'import de la clé.
    { name: "ECDSA", hash: "SHA-1" },
    clePublique,
    raw,
    new TextEncoder().encode(corpsBrut),
  );
}

/**
 * La réponse au défi d'enregistrement d'une destination.
 *
 * eBay appelle l'adresse en GET avec un `challenge_code` et attend le
 * SHA-256 de trois valeurs concaténées, DANS CET ORDRE, en hexadécimal
 * minuscule. L'adresse hachée doit être celle enregistrée, caractère pour
 * caractère : une barre oblique finale de différence et le défi échoue sans
 * qu'aucun des deux côtés ne dise pourquoi.
 */
export async function reponseDefiEbay(
  challengeCode: string,
  verificationToken: string,
  endpoint: string,
): Promise<string> {
  const octets = new TextEncoder().encode(
    challengeCode + verificationToken + endpoint,
  );
  const h = await crypto.subtle.digest("SHA-256", octets);
  return [...new Uint8Array(h)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Le jeton de vérification doit respecter la forme qu'eBay impose.
 *
 * Trente-deux à quatre-vingts caractères, lettres, chiffres, tiret et
 * souligné. Un jeton trop court est refusé à l'enregistrement de la
 * destination, avec un message qui ne dit pas que c'est la longueur.
 */
export function jetonVerificationValide(jeton: string): boolean {
  return /^[A-Za-z0-9_-]{32,80}$/.test(jeton);
}
