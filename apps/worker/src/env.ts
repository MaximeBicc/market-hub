import type { AppCredentials } from "@hub/connectors";
import type { Platform } from "@hub/core";

/**
 * Liaisons Cloudflare + secrets.
 *
 * Les secrets ne sont JAMAIS dans le dépôt :
 *   - en local  → apps/worker/.dev.vars (ignoré par git)
 *   - en prod   → `wrangler secret put NOM`
 * Limite du plan gratuit : 64 secrets par Worker. On en utilise ~12.
 */
export interface Env {
  /* Liaisons d'infrastructure */
  DB: D1Database;
  CACHE: KVNamespace;
  SYNC_QUEUE: Queue;
  RATE_LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
  // MEDIA: R2Bucket;  ← à rétablir le jour où l'on stocke des images produits

  /* Variables publiques (wrangler.jsonc → vars) */
  APP_NAME: string;
  APP_URL: string;
  LOG_LEVEL: string;

  /* --- Secrets --- */

  /** Clé maître AES-256 (32 octets en base64) chiffrant les jetons OAuth en base. */
  MASTER_KEY: string;
  /** Clé de signature des cookies de session (HMAC-SHA256). */
  SESSION_SECRET: string;

  /** Paire VAPID pour les notifications push Web. */
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string; // "mailto:vous@exemple.fr"

  /** Identifiants applicatifs des places de marché. */
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string;
  ETSY_CLIENT_ID: string;
  ETSY_CLIENT_SECRET: string;
  EBAY_CLIENT_ID: string;
  EBAY_CLIENT_SECRET: string;
  EBAY_RU_NAME: string;
  ALIBABA_APP_KEY: string;
  ALIBABA_APP_SECRET: string;

  /** Claude — appelé uniquement côté serveur, jamais exposé au navigateur. */
  ANTHROPIC_API_KEY: string;
}

/** Résout les identifiants applicatifs d'une plateforme depuis les secrets. */
export function credentialsFor(env: Env, platform: Platform): AppCredentials {
  switch (platform) {
    case "shopify":
      return {
        clientId: env.SHOPIFY_CLIENT_ID,
        clientSecret: env.SHOPIFY_CLIENT_SECRET,
      };
    case "etsy":
      return {
        clientId: env.ETSY_CLIENT_ID,
        clientSecret: env.ETSY_CLIENT_SECRET,
      };
    case "ebay":
      return {
        clientId: env.EBAY_CLIENT_ID,
        clientSecret: env.EBAY_CLIENT_SECRET,
        redirectAlias: env.EBAY_RU_NAME,
      };
    case "alibaba":
      return {
        clientId: env.ALIBABA_APP_KEY,
        clientSecret: env.ALIBABA_APP_SECRET,
      };
  }
}
