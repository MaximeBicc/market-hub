/**
 * Authentification par mot de passe.
 *
 * PBKDF2-HMAC-SHA256, la seule fonction de dérivation disponible dans le
 * runtime Workers — ni bcrypt ni argon2 n'y existent.
 *
 * DEUX PLAFONDS CONTRAIGNENT LE NOMBRE D'ITÉRATIONS :
 *
 *  1. Cloudflare refuse au-delà de 100 000 itérations, par protection contre
 *     le déni de service. C'est un plafond de la plateforme, pas un réglage.
 *  2. Le plan gratuit accorde 10 ms de CPU par invocation. Le hachage est
 *     l'opération la plus coûteuse de toute l'application.
 *
 * L'OWASP recommande 600 000 itérations pour PBKDF2-SHA256 : on ne peut donc
 * pas les atteindre ici. Ce qui compense, et qui compte bien davantage :
 * **les mots de passe sont générés aléatoirement sur 24 caractères**, soit
 * environ 140 bits d'entropie. Le nombre d'itérations protège contre le
 * cassage par force brute de mots de passe *choisis par un humain* ; face à
 * un secret vraiment aléatoire de cette longueur, aucun matériel existant
 * n'aboutit, quel que soit le nombre d'itérations.
 *
 * Le nombre d'itérations est stocké AVEC chaque empreinte : on peut donc
 * l'augmenter plus tard sans invalider les comptes existants.
 */

const DEFAULT_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export interface PasswordRecord {
  hash: string;
  salt: string;
  iterations: number;
}

export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<PasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await derive(password, salt, iterations);
  return { hash: toB64(bits), salt: toB64(salt), iterations };
}

/**
 * Vérifie un mot de passe.
 *
 * La comparaison est à temps constant : une comparaison naïve s'arrête au
 * premier octet différent, et le temps de réponse révèle alors combien
 * d'octets étaient corrects — de quoi reconstruire l'empreinte octet par octet.
 */
export async function verifyPassword(
  password: string,
  record: PasswordRecord,
): Promise<boolean> {
  const bits = await derive(password, fromB64(record.salt), record.iterations);
  const expected = fromB64(record.hash);
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i]! ^ expected[i]!;
  return diff === 0;
}

/**
 * Génère un mot de passe aléatoire lisible.
 *
 * Alphabet sans caractères ambigus (ni O/0, ni I/l/1) : ces mots de passe
 * seront parfois recopiés à la main sur un téléphone.
 * 24 caractères sur un alphabet de 57 ≈ 140 bits d'entropie.
 */
export function generatePassword(length = 24): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/**
 * Exigences minimales quand l'utilisateur choisit lui-même son mot de passe.
 * Volontairement sobres : imposer des règles de composition (majuscule,
 * chiffre, symbole) produit des mots de passe plus courts et plus prévisibles.
 * La longueur est ce qui compte.
 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < 12) {
    return "Le mot de passe doit faire au moins 12 caractères.";
  }
  if (password.length > 200) {
    return "Le mot de passe ne peut pas dépasser 200 caractères.";
  }
  return null;
}
