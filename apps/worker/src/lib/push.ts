import { drizzle } from "drizzle-orm/d1";
import { eq, isNull } from "drizzle-orm";
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { pushSubscription } from "../db/schema.js";
import type { Env } from "../env.js";

/**
 * Notifications Web Push (protocole VAPID).
 *
 * Pourquoi cette bibliothèque et pas `web-push` : `web-push` s'appuie sur le
 * module `crypto` de Node et ne fonctionne pas dans un Worker.
 * `@block65/webcrypto-web-push` n'utilise que la WebCrypto standard.
 *
 * ⚠️ CONTRAINTE iOS — à connaître avant de promettre quoi que ce soit :
 * sur iPhone et iPad, le push web ne fonctionne QUE si la PWA a été ajoutée à
 * l'écran d'accueil et ouverte depuis son icône. Dans Safari, l'API Push
 * n'existe simplement pas et la demande de permission est refusée. Il faut
 * iOS 16.4 ou plus. Sur Android (Chrome) et sur ordinateur, aucune de ces
 * restrictions ne s'applique.
 *
 * Les clés VAPID se génèrent une fois pour toutes :
 *   npx web-push generate-vapid-keys
 * puis `wrangler secret put VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`.
 * La clé publique est aussi exposée au navigateur via GET /api/push/key.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Chemin ouvert au clic sur la notification. */
  url?: string;
  /** Les notifications de même `tag` se remplacent au lieu de s'empiler. */
  tag?: string;
}

/**
 * Envoie à tous les appareils enregistrés.
 * Séquentiel volontairement : le plan gratuit plafonne à 6 connexions
 * sortantes simultanées, et on a rarement plus de 2 ou 3 appareils.
 */
export async function sendPushToUser(
  env: Env,
  message: PushMessage,
): Promise<{ sent: number; pruned: number }> {
  const db = drizzle(env.DB);
  const subs = await db
    .select()
    .from(pushSubscription)
    .where(isNull(pushSubscription.failedAt));

  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  let sent = 0;
  let pruned = 0;

  for (const s of subs) {
    const payload = await buildPushPayload(
      {
        data: JSON.stringify(message),
        options: { ttl: 60 * 60, urgency: "normal" },
      },
      {
        endpoint: s.endpoint,
        expirationTime: null,
        keys: { p256dh: s.p256dh, auth: s.auth },
      },
      vapid,
    );

    // `payload` n'est pas directement un RequestInit : ses en-têtes optionnels
    // sont typés `string | undefined`, et son corps est un Uint8Array dont le
    // tampon n'est pas garanti être un ArrayBuffer. On normalise les deux.
    const headers = Object.fromEntries(
      Object.entries(payload.headers).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const res = await fetch(s.endpoint, {
      method: payload.method,
      headers,
      body: new Uint8Array(payload.body),
    });

    if (res.status === 404 || res.status === 410) {
      // L'abonnement est mort (app désinstallée, permission révoquée).
      // On le marque au lieu de le supprimer : l'historique reste lisible.
      await db
        .update(pushSubscription)
        .set({ failedAt: Math.floor(Date.now() / 1000) })
        .where(eq(pushSubscription.id, s.id));
      pruned++;
    } else if (res.ok) {
      sent++;
    }
  }

  return { sent, pruned };
}
