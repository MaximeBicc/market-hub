import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { vmSync, type VmControlEnv } from "./routes/vm-sync.js";

/**
 * Worker STAGING dédié au control plane de la VM.
 *
 * Il n'exporte volontairement NI `scheduled()` NI `queue()` : impossible que
 * ce déploiement démarre le polling Cloudflare ou consomme `market-hub-sync`.
 */
const app = new Hono<{ Bindings: VmControlEnv }>();

app.use("*", secureHeaders());

app.get("/health", async (c) => {
  let db = false;
  try {
    await c.env.DB.prepare("SELECT 1").first();
    db = true;
  } catch {
    db = false;
  }
  return c.json({ ok: db, service: "market-hub-vm-control" }, db ? 200 : 503);
});

app.route("/api/internal/vm-sync", vmSync);
app.all("*", (c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<VmControlEnv>;
