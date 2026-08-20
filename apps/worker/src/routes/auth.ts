import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { passkey, user, alertRule } from "../db/schema.js";
import type { Env } from "../env.js";
import { randomId } from "../lib/crypto.js";
import {
  authenticate,
  clearCookie,
  createSession,
  destroySession,
  sessionCookie,
} from "../lib/session.js";
import { DEFAULT_RULES } from "../lib/alerts.js";

/**
 * Authentification par clé d'accès (WebAuthn / passkey).
 *
 * Pourquoi ce choix pour un outil personnel :
 *   - Rien à retenir, rien à saisir : Face ID sur le téléphone, Windows Hello
 *     sur le PC. C'est plus rapide qu'un mot de passe, et plus sûr.
 *   - Résistant au hameçonnage par construction : la clé est liée au domaine.
 *     Un faux site ne peut pas la solliciter, même s'il est parfaitement imité.
 *   - Rien à stocker de sensible côté serveur. La base ne contient que des clés
 *     PUBLIQUES : leur fuite n'a aucune conséquence.
 *
 * La première clé enregistrée crée le compte. Ensuite l'enregistrement exige
 * une session valide — sinon n'importe qui pourrait s'ajouter une clé.
 * ⚠️ Enregistrez DEUX appareils : perdre l'unique téléphone enregistré revient
 * à perdre l'accès (voir la procédure de secours dans ARCHITECTURE.md).
 */

export const auth = new Hono<{ Bindings: Env }>();

function rp(env: Env) {
  const url = new URL(env.APP_URL);
  return { id: url.hostname, name: env.APP_NAME, origin: url.origin };
}

/** Y a-t-il déjà un compte ? Détermine si l'écran d'accueil propose « créer ». */
auth.get("/state", async (c) => {
  const rows = await drizzle(c.env.DB)
    .select({ n: sql<number>`count(*)` })
    .from(user);
  const me = await authenticate(c.env, c.req.raw);
  return c.json({
    initialized: (rows[0]?.n ?? 0) > 0,
    authenticated: me !== null,
    email: me?.email ?? null,
  });
});

/* -------------------- Enregistrement d'une clé -------------------- */

auth.post("/register/options", async (c) => {
  const db = drizzle(c.env.DB);
  const { email } = await c.req.json<{ email: string }>();

  const count = (
    await db.select({ n: sql<number>`count(*)` }).from(user)
  )[0]?.n ?? 0;

  const me = await authenticate(c.env, c.req.raw);
  // Compte déjà créé et pas de session → refus. Un seul utilisateur.
  if (count > 0 && !me) return c.json({ error: "unauthorized" }, 401);

  const userId = me?.id ?? randomId();
  const { id: rpID, name: rpName } = rp(c.env);

  const existing = me
    ? await db.select().from(passkey).where(eq(passkey.userId, me.id))
    : [];

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(userId),
    userName: me?.email ?? email,
    attestationType: "none",
    // Empêche d'enregistrer deux fois le même appareil.
    excludeCredentials: existing.map((p) => ({ id: p.id })),
    authenticatorSelection: {
      residentKey: "required", // clé découvrable : connexion sans saisir d'identifiant
      userVerification: "preferred",
    },
  });

  await c.env.CACHE.put(
    `webauthn:reg:${options.challenge}`,
    JSON.stringify({ userId, email: me?.email ?? email }),
    { expirationTtl: 300 },
  );

  return c.json(options);
});

auth.post("/register/verify", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ response: any; challenge: string; label?: string }>();

  const pending = await c.env.CACHE.get(`webauthn:reg:${body.challenge}`);
  if (!pending) return c.json({ error: "challenge expiré" }, 400);
  await c.env.CACHE.delete(`webauthn:reg:${body.challenge}`);
  const { userId, email } = JSON.parse(pending) as { userId: string; email: string };

  const { id: rpID, origin } = rp(c.env);
  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: body.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "vérification échouée" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const cred = verification.registrationInfo.credential;

  // Création du compte au premier enregistrement, avec les règles d'alerte par défaut.
  const exists = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (exists.length === 0) {
    await db.insert(user).values({ id: userId, email, createdAt: now });
    await db.insert(alertRule).values(
      DEFAULT_RULES.map((r) => ({
        id: randomId(),
        userId,
        name: r.name,
        kind: r.kind,
        params: JSON.stringify(r.params),
        shopId: null,
        enabled: 1,
        cooldownSec: r.cooldownSec,
        lastFiredAt: null,
      })),
    );
  }

  await db.insert(passkey).values({
    id: cred.id,
    userId,
    publicKey: btoa(String.fromCharCode(...cred.publicKey)),
    counter: cred.counter,
    transports: JSON.stringify(cred.transports ?? []),
    label: body.label ?? "Appareil",
    createdAt: now,
    lastUsedAt: now,
  });

  const token = await createSession(c.env, userId);
  return c.json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
});

/* -------------------------- Connexion -------------------------- */

auth.post("/login/options", async (c) => {
  const { id: rpID } = rp(c.env);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    // allowCredentials vide : le navigateur propose les clés découvrables.
  });
  await c.env.CACHE.put(`webauthn:auth:${options.challenge}`, "1", {
    expirationTtl: 300,
  });
  return c.json(options);
});

auth.post("/login/verify", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ response: any; challenge: string }>();

  const pending = await c.env.CACHE.get(`webauthn:auth:${body.challenge}`);
  if (!pending) return c.json({ error: "challenge expiré" }, 400);
  await c.env.CACHE.delete(`webauthn:auth:${body.challenge}`);

  const rows = await db
    .select()
    .from(passkey)
    .where(eq(passkey.id, body.response.id))
    .limit(1);
  const stored = rows[0];
  if (!stored) return c.json({ error: "clé inconnue" }, 401);

  const { id: rpID, origin } = rp(c.env);
  const verification = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: body.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: stored.id,
      publicKey: Uint8Array.from(atob(stored.publicKey), (ch) => ch.charCodeAt(0)),
      counter: stored.counter,
    },
  });

  if (!verification.verified) return c.json({ error: "échec" }, 401);

  // Le compteur croissant détecte une clé clonée : s'il recule, on refuse.
  const newCounter = verification.authenticationInfo.newCounter;
  if (stored.counter > 0 && newCounter <= stored.counter) {
    return c.json({ error: "compteur invalide" }, 401);
  }

  await db
    .update(passkey)
    .set({ counter: newCounter, lastUsedAt: Math.floor(Date.now() / 1000) })
    .where(eq(passkey.id, stored.id));

  const token = await createSession(c.env, stored.userId);
  return c.json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
});

auth.post("/logout", async (c) => {
  await destroySession(c.env, c.req.raw);
  return c.json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
});
