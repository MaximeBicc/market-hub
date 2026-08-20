import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { QueueTask } from "@hub/core";
import type { Env } from "./env.js";
import { auth } from "./routes/auth.js";
import { oauth } from "./routes/oauth.js";
import { api } from "./routes/api.js";
import { ai } from "./routes/ai.js";
import { webhooks } from "./routes/webhooks.js";
import { handleScheduled } from "./scheduler.js";
import { handleQueue } from "./consumer.js";

export { RateLimiter } from "./do/rate-limiter.js";

/**
 * Point d'entrée unique du Worker.
 *
 * Un seul déploiement expose TROIS surfaces, ce qui est exactement ce qui rend
 * l'ensemble gratuit et simple à exploiter :
 *
 *   fetch()     → la PWA (fichiers statiques) ET l'API, sur la même origine.
 *                 Même origine = pas de CORS, et des cookies de session qui
 *                 fonctionnent sans configuration particulière.
 *   scheduled() → les cron triggers. Ordonnancement uniquement.
 *   queue()     → le travail réel, avec un budget de sous-requêtes par message.
 */

const app = new Hono<{ Bindings: Env }>();

/**
 * En-têtes de sécurité.
 * La CSP est stricte : aucun script externe n'est autorisé. `connect-src 'self'`
 * garantit qu'un script injecté ne peut pas exfiltrer de données vers un
 * domaine tiers. Toutes les API externes sont appelées par le Worker, jamais
 * par le navigateur — la CSP peut donc rester fermée.
 */
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"], // vignettes des places de marché
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    xFrameOptions: "DENY",
  }),
);

/**
 * Point de santé — déclaré AVANT tout le reste, et volontairement public.
 *
 * `app.route("/api", api)` installe la garde d'authentification sur tout
 * `/api/*` : monter le routeur protégé en premier rendrait ce point
 * inaccessible sans session, donc inutilisable pour vérifier qu'un
 * déploiement répond. Il ne divulgue rien d'autre que le nom de l'app.
 */
app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_NAME }));

app.route("/api/auth", auth);
app.route("/api/oauth", oauth);
app.route("/api/webhooks", webhooks); // public, protégé par signature
app.route("/api/ai", ai);
app.route("/api", api); // en dernier : les routes plus spécifiques d'abord

// Chemin /api inconnu. Un appelant sans session reçoit 401 avant d'arriver
// ici — c'est voulu : inutile de révéler quelles routes existent.
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

/**
 * Tout le reste part vers les fichiers statiques.
 * `not_found_handling: "single-page-application"` (wrangler.jsonc) renvoie
 * index.html pour les routes côté client — /orders, /inventory, etc.
 */
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  async scheduled(event, env, ctx) {
    // waitUntil laisse jusqu'à 30 s après la réponse, mais le travail lourd
    // reste dans la Queue : ici on ne fait qu'ordonnancer.
    ctx.waitUntil(handleScheduled(event, env));
  },

  async queue(batch, env) {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, QueueTask>;
