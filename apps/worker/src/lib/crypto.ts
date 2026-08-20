/**
 * Chiffrement des jetons OAuth au repos.
 *
 * Menace couverte : une copie de la base D1 qui fuite (export, sauvegarde
 * égarée, erreur de manipulation). Sans la clé maître — qui vit dans les
 * secrets du Worker, pas dans la base — les jetons sont inutilisables.
 *
 * AES-256-GCM : chiffre ET authentifie. Un octet modifié fait échouer le
 * déchiffrement au lieu de produire silencieusement des données fausses.
 * L'IV est aléatoire à chaque écriture et stocké en clair devant le message
 * (c'est sa fonction : il doit être unique, pas secret).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * `Uint8Array<ArrayBuffer>` et non `Uint8Array` tout court : depuis TypeScript
 * 5.7 le type est générique sur son tampon, et les API WebCrypto exigent un
 * `ArrayBuffer` réel — un `ArrayBufferLike` (qui pourrait être un
 * SharedArrayBuffer) est refusé. L'annotation explicite évite un cast à
 * chaque appel.
 */
function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = b64decode(masterKeyB64);
  if (raw.byteLength !== 32) {
    throw new Error(
      "MASTER_KEY doit faire exactement 32 octets encodés en base64",
    );
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Renvoie "base64(iv):base64(chiffré+tag)". */
export async function encryptJson(
  masterKeyB64: string,
  value: unknown,
): Promise<string> {
  const key = await importKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96 bits, recommandé pour GCM
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return `${b64encode(iv)}:${b64encode(ct)}`;
}

export async function decryptJson<T>(
  masterKeyB64: string,
  payload: string,
): Promise<T> {
  const [ivB64, ctB64] = payload.split(":");
  if (!ivB64 || !ctB64) throw new Error("Format de chiffré invalide");
  const key = await importKey(masterKeyB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivB64) },
    key,
    b64decode(ctB64),
  );
  return JSON.parse(dec.decode(pt)) as T;
}

/**
 * Empreinte stable d'un objet, utilisée par le diff de synchronisation.
 * Les clés sont triées : sans cela, deux objets identiques produiraient des
 * empreintes différentes et l'on réécrirait la base à chaque cycle — ce qui
 * ferait exploser le quota de 100 000 lignes écrites par jour de D1.
 */
export async function contentHash(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(canonical));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Comparaison à temps constant, pour tout ce qui touche à un secret. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PKCE : vérificateur aléatoire + challenge S256. */
export async function makePkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function b64url(bytes: Uint8Array): string {
  return b64encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
