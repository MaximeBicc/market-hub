import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { user } from "../db/schema.js";
import type { Env } from "../env.js";
import {
  authenticate,
  clearCookie,
  createSession,
  destroyAllSessions,
  destroySession,
  sessionCookie,
} from "../lib/session.js";
import { checkPasswordStrength } from "../lib/password.js";
import type { RateLimiter } from "../do/rate-limiter.js";

/**
 * Authentification par identifiant et mot de passe.
 *
 * Deux comptes nommés, créés par migration : l'outil est utilisé à deux, et
 * savoir qui a modifié quoi vaut mieux qu'un compte partagé.
 *
 * Les comptes ne se créent pas depuis l'application : il n'existe aucune route
 * d'inscription. Ajouter une personne se fait par migration. Pour un outil
 * privé à deux, une page d'inscription n'est qu'une surface d'attaque.
 */

export const auth = new Hono<{ Bindings: Env }>();

/**
 * Limitation des tentatives, par identifiant.
 *
 * Sans elle, un attaquant peut essayer des mots de passe aussi vite que le
 * réseau le permet. On réutilise le Durable Object du limiteur de débit :
 * il est déjà le point de rendez-vous global du système.
 *
 * Réglage : 5 tentatives immédiates, puis une toutes les 10 secondes, et
 * 40 par jour au maximum. Assez souple pour une faute de frappe, assez strict
 * pour rendre toute attaque par dictionnaire inopérante.
 */
function authObject(env: Env, key: string): DurableObjectStub<RateLimiter> {
  const id = env.RATE_LIMITER.idFromName(`login:${key.toLowerCase()}`);
  return env.RATE_LIMITER.get(id) as DurableObjectStub<RateLimiter>;
}

auth.get("/state", async (c) => {
  const me = await authenticate(c.env, c.req.raw);
  return c.json({
    authenticated: me !== null,
    username: me?.username ?? null,
    displayName: me?.displayName ?? null,
  });
});

auth.post("/login", async (c) => {
  const body = await c.req
    .json<{ username?: string; password?: string }>()
    .catch(() => ({}) as { username?: string; password?: string });

  const username = (body.username ?? "").trim();
  const password = body.password ?? "";

  if (!username || !password) {
    return c.json({ error: "Identifiant et mot de passe requis." }, 400);
  }

  const guard = authObject(c.env, username);
  const gate = await guard.acquire(1, 0.1, 5, 40);
  if (!gate.ok) {
    const seconds = Math.ceil(gate.waitMs / 1000);
    return c.json(
      {
        error: `Trop de tentatives. Réessayez dans ${seconds} seconde${seconds > 1 ? "s" : ""}.`,
      },
      429,
    );
  }

  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(user)
    // Comparaison sans casse : « mxb_market-hub » doit fonctionner.
    .where(sql`lower(${user.username}) = lower(${username})`)
    .limit(1);

  const found = rows[0];

  /**
   * Message d'erreur identique que l'identifiant existe ou non, et
   * vérification du mot de passe menée même sur un compte inexistant :
   * sans cela, le temps de réponse révèle quels identifiants sont valides.
   */
  const record = found
    ? {
        hash: found.passwordHash,
        salt: found.passwordSalt,
        iterations: found.passwordIterations,
      }
    : {
        // Empreinte factice, pour dépenser le même temps de calcul.
        hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        salt: "AAAAAAAAAAAAAAAAAAAAAA==",
        iterations: 100_000,
      };

  // Vérification déléguée au Durable Object : PBKDF2 dépasse largement les
  // 10 ms de CPU d'un Worker gratuit, alors qu'un DO en reçoit 30 secondes.
  const valid = await guard.checkPassword(password, record);

  if (!found || !valid) {
    return c.json({ error: "Identifiant ou mot de passe incorrect." }, 401);
  }

  await db
    .update(user)
    .set({ lastLoginAt: Math.floor(Date.now() / 1000) })
    .where(eq(user.id, found.id));

  const token = await createSession(c.env, found.id);
  return c.json(
    { ok: true, username: found.username, displayName: found.displayName },
    200,
    { "Set-Cookie": sessionCookie(token) },
  );
});

auth.post("/logout", async (c) => {
  await destroySession(c.env, c.req.raw);
  return c.json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
});

/** Changement de mot de passe. Exige l'ancien : une session volée ne suffit pas. */
auth.post("/password", async (c) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req
    .json<{ current?: string; next?: string }>()
    .catch(() => ({}) as { current?: string; next?: string });

  const current = body.current ?? "";
  const next = body.next ?? "";

  const weak = checkPasswordStrength(next);
  if (weak) return c.json({ error: weak }, 400);

  const db = drizzle(c.env.DB);
  const rows = await db.select().from(user).where(eq(user.id, me.id)).limit(1);
  const found = rows[0];
  if (!found) return c.json({ error: "unauthorized" }, 401);

  const guard = authObject(c.env, found.username);
  const ok = await guard.checkPassword(current, {
    hash: found.passwordHash,
    salt: found.passwordSalt,
    iterations: found.passwordIterations,
  });
  if (!ok) return c.json({ error: "Mot de passe actuel incorrect." }, 401);

  const rec = await guard.makePassword(next);
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(user)
    .set({
      passwordHash: rec.hash,
      passwordSalt: rec.salt,
      passwordIterations: rec.iterations,
      passwordChangedAt: now,
    })
    .where(eq(user.id, me.id));

  // Toutes les autres sessions tombent : si le mot de passe a été changé
  // parce qu'il était compromis, laisser vivre les sessions ouvertes
  // ailleurs viderait la mesure de son sens.
  await destroyAllSessions(c.env, me.id);
  const token = await createSession(c.env, me.id);

  return c.json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
});
