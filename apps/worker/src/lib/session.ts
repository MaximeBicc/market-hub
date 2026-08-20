import { drizzle } from "drizzle-orm/d1";
import { eq, lt } from "drizzle-orm";
import { session, user } from "../db/schema.js";
import type { Env } from "../env.js";
import { randomId, timingSafeEqual } from "./crypto.js";

/**
 * Sessions.
 *
 * L'authentification elle-même se fait par clé d'accès (WebAuthn) : Face ID,
 * Touch ID ou Windows Hello. Aucun mot de passe n'existe dans ce système, donc
 * aucun ne peut fuiter, être réutilisé ailleurs ou faire l'objet d'un
 * hameçonnage — la clé est liée cryptographiquement au domaine.
 *
 * Une fois la clé vérifiée, on pose un cookie de session :
 *   - HttpOnly  : invisible pour JavaScript, donc immunisé au XSS
 *   - Secure    : jamais transmis en clair
 *   - SameSite=Lax : bloque le CSRF tout en survivant aux retours OAuth
 *   - signé HMAC : un identifiant volé mais modifié est rejeté sans requête DB
 *
 * Durée : 90 jours. C'est un outil personnel installé sur un téléphone
 * verrouillé ; se réauthentifier chaque semaine n'apporterait rien.
 */

const COOKIE = "hub_session";
const TTL_SEC = 90 * 86400;

async function sign(env: Env, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const db = drizzle(env.DB);
  const id = randomId(24);
  const now = Math.floor(Date.now() / 1000);

  await db.insert(session).values({
    id,
    userId,
    createdAt: now,
    expiresAt: now + TTL_SEC,
  });

  return `${id}.${await sign(env, id)}`;
}

export function sessionCookie(token: string): string {
  return [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${TTL_SEC}`,
  ].join("; ");
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export interface AuthedUser {
  id: string;
  email: string;
}

/** Renvoie l'utilisateur si la requête porte une session valide, sinon null. */
export async function authenticate(
  env: Env,
  req: Request,
): Promise<AuthedUser | null> {
  const raw = req.headers
    .get("Cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

  if (!raw) return null;

  const [id, sig] = raw.split(".");
  if (!id || !sig) return null;

  // Vérification de la signature AVANT toute lecture en base : un attaquant
  // ne peut pas nous faire faire de requêtes avec des identifiants inventés.
  if (!timingSafeEqual(sig, await sign(env, id))) return null;

  const db = drizzle(env.DB);
  const rows = await db
    .select({ userId: session.userId, expiresAt: session.expiresAt, email: user.email })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(eq(session.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt < Math.floor(Date.now() / 1000)) {
    await db.delete(session).where(eq(session.id, id));
    return null;
  }

  return { id: row.userId, email: row.email };
}

export async function destroySession(env: Env, req: Request): Promise<void> {
  const raw = req.headers.get("Cookie")?.match(/hub_session=([^;.]+)/)?.[1];
  if (raw) await drizzle(env.DB).delete(session).where(eq(session.id, raw));
}

/** Ménage quotidien des sessions périmées. */
export async function purgeExpiredSessions(env: Env): Promise<void> {
  await drizzle(env.DB)
    .delete(session)
    .where(lt(session.expiresAt, Math.floor(Date.now() / 1000)));
}
