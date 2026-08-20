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
  /**
   * Workers AI. Aucune clé, aucun compte tiers : l'inférence tourne sur notre
   * propre compte Cloudflare, dans l'allocation gratuite de 10 000 neurones
   * par jour. C'est le socle du panel d'IA, et le seul fournisseur autorisé à
   * voir du texte écrit par un client.
   */
  AI: Ai;
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

  /* --- Panel d'IA : fournisseurs gratuits complémentaires --- */
  //
  // TOUS OPTIONNELS. Sans aucun d'eux, le panel tourne sur Workers AI seul et
  // reste pleinement fonctionnel — il perd seulement la recherche web, que
  // seul Gemini sait faire gratuitement.
  //
  // Aucun de ces comptes ne demande de carte bancaire, et aucun n'a de repli
  // payant dans le code : lorsqu'un quota gratuit est épuisé, l'appel échoue
  // et l'interface le dit. C'est voulu.
  /** aistudio.google.com — seule route de recherche web du panel. */
  GEMINI_API_KEY?: string;
  /** console.groq.com — repli texte rapide, 1 000 appels/jour. */
  GROQ_API_KEY?: string;
  /** openrouter.ai — dernier recours public, 50 appels/jour. */
  OPENROUTER_API_KEY?: string;

  /* --- Modèles, surchargeables sans redéploiement de code --- */
  //
  // Les catalogues gratuits bougent : un modèle retiré se remplace en
  // inscrivant un secret, sans toucher au dépôt.
  //
  // ATTENTION sur GEMINI_RESEARCH_MODEL : la génération 2.5 est retenue parce
  // que son ancrage Google Search reste gratuit à 1 500 requêtes par JOUR. Sur
  // la génération 3.x, l'offre tombe à 5 000 par MOIS puis devient payante.
  GEMINI_GENERAL_MODEL?: string;
  GEMINI_RESEARCH_MODEL?: string;
  GROQ_MODEL?: string;
  /** Sans valeur explicite, OpenRouter n'entre pas au catalogue. */
  OPENROUTER_MODEL?: string;
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
