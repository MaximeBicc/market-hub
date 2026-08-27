import { Hono, type Context } from "hono";
import { z } from "zod";
import { d1Repositories } from "../engine/repositories.js";

/**
 * Bindings minimaux du control plane VM.
 *
 * Ce routeur est volontairement indépendant du Worker de production : il est
 * servi par `vm-staging-entry.ts`, avec sa propre D1 et ses propres secrets.
 */
export interface VmControlEnv {
  DB: D1Database;
  MASTER_KEY: string;
  VM_CONTROL_PLANE_ENABLED?: string;
  VM_CONTROL_PLANE_TOKEN?: string;
  /** Liste CSV d'identifiants `shop.id`. VIDE = aucune tâche n'est louée. */
  VM_SYNC_ACCOUNT_ALLOWLIST?: string;
  /** En shadow, les rotations OAuth ne sont pas persistées par défaut. */
  VM_ALLOW_CREDENTIAL_PERSIST?: string;
  VM_LEASE_TTL_SEC?: string;
}

type VmContext = Context<{ Bindings: VmControlEnv }>;
const vmSync = new Hono<{ Bindings: VmControlEnv }>();
const encoder = new TextEncoder();

const resourceSchema = z.enum(["orders", "inventory", "listings"]);
const observationSchema = z.object({
  leaseId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(256),
  marketplace: z.string().min(1).max(64),
  resource: resourceSchema,
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative().max(10_000),
  items: z.number().int().nonnegative().max(10_000_000),
  supported: z.boolean(),
  fingerprints: z
    .array(
      z.object({
        id: z.string().min(1).max(512),
        hash: z.string().regex(/^[a-f0-9]{64}$/i),
      }),
    )
    .max(5_000),
  terminalCursor: z.string().max(8_192).nullable(),
  credentialPatch: z.record(z.string(), z.string()).optional(),
  vmMode: z.enum(["dry-run", "shadow", "active"]),
});

const failureSchema = z.object({
  leaseId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(256),
  resource: resourceSchema,
  at: z.number().int().nonnegative(),
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
});

async function digest(value: string): Promise<Uint8Array> {
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return new Uint8Array(raw);
}

async function tokenMatches(expected: string | undefined, provided: string): Promise<boolean> {
  if (!expected || !provided) return false;
  const [a, b] = await Promise.all([digest(expected), digest(provided)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function allowlist(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((x) => x.trim()).filter(Boolean))];
}

function leaseTtl(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "900", 10);
  if (!Number.isFinite(parsed)) return 900;
  return Math.min(3_600, Math.max(60, parsed));
}

function bearer(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

async function jsonBody(c: VmContext): Promise<
  | { value: unknown }
  | { error: "payload_too_large" | "invalid_json" }
> {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
    return { error: "payload_too_large" };
  }
  try {
    return { value: await c.req.json() as unknown };
  } catch {
    return { error: "invalid_json" };
  }
}

vmSync.use("*", async (c, next) => {
  // Double verrou : sans flag ET secret, la surface se comporte comme absente.
  if (c.env.VM_CONTROL_PLANE_ENABLED !== "true" || !c.env.VM_CONTROL_PLANE_TOKEN) {
    return c.json({ error: "not_found" }, 404);
  }

  const ok = await tokenMatches(
    c.env.VM_CONTROL_PLANE_TOKEN,
    bearer(c.req.header("authorization")),
  );
  if (!ok) {
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "unauthorized" }, 401);
  }

  c.header("Cache-Control", "no-store");
  await next();
});

vmSync.get("/status", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const [leases, observations] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM vm_sync_lease WHERE completed_at IS NULL AND expires_at > ?",
    ).bind(now).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM vm_sync_observation").first<{ n: number }>(),
  ]);

  return c.json({
    ok: true,
    allowlistedAccounts: allowlist(c.env.VM_SYNC_ACCOUNT_ALLOWLIST).length,
    credentialPersistence: c.env.VM_ALLOW_CREDENTIAL_PERSIST === "true",
    activeLeases: Number(leases?.n ?? 0),
    observations: Number(observations?.n ?? 0),
  });
});

vmSync.get("/lease", async (c) => {
  const ids = allowlist(c.env.VM_SYNC_ACCOUNT_ALLOWLIST);
  // Le défaut est volontairement inerte. Autoriser un compte doit être explicite.
  if (ids.length === 0) return c.json({ leases: [], reason: "allowlist_empty" });

  const requested = Number.parseInt(c.req.query("limit") ?? "4", 10);
  const limit = Math.min(10, Math.max(1, Number.isFinite(requested) ? requested : 4));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + leaseTtl(c.env.VM_LEASE_TTL_SEC);
  const placeholders = ids.map(() => "?").join(",");

  type Candidate = {
    jobId: string;
    shopId: string;
    resource: string;
    cursor: string | null;
  };

  const due = await c.env.DB.prepare(
    `SELECT sj.id AS jobId, sj.shop_id AS shopId, sj.resource AS resource, sj.cursor AS cursor
       FROM sync_job sj
       JOIN shop s ON s.id = sj.shop_id
       LEFT JOIN vm_sync_lease vl ON vl.sync_job_id = sj.id
      WHERE sj.enabled = 1
        AND s.status = 'active'
        AND sj.next_run_at <= ?
        AND sj.shop_id IN (${placeholders})
        AND (vl.sync_job_id IS NULL OR vl.completed_at IS NOT NULL OR vl.expires_at <= ?)
      ORDER BY sj.next_run_at ASC
      LIMIT ?`,
  ).bind(now, ...ids, now, limit).all<Candidate>();

  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);
  const leases: Array<{
    leaseId: string;
    leasedUntil: number;
    resource: z.infer<typeof resourceSchema>;
    cursor: string | null;
    account: NonNullable<Awaited<ReturnType<typeof repos.accounts.get>>>;
    credentials: Record<string, string>;
  }> = [];

  for (const candidate of due.results ?? []) {
    const resource = resourceSchema.safeParse(candidate.resource);
    if (!resource.success) continue;

    const leaseId = crypto.randomUUID();
    const claimed = await c.env.DB.prepare(
      `INSERT INTO vm_sync_lease
         (sync_job_id, lease_id, leased_at, expires_at, completed_at, last_failure, failure_at, attempts)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1)
       ON CONFLICT(sync_job_id) DO UPDATE SET
         lease_id = excluded.lease_id,
         leased_at = excluded.leased_at,
         expires_at = excluded.expires_at,
         completed_at = NULL,
         last_failure = NULL,
         failure_at = NULL,
         attempts = vm_sync_lease.attempts + 1
       WHERE vm_sync_lease.completed_at IS NOT NULL
          OR vm_sync_lease.expires_at <= excluded.leased_at
       RETURNING sync_job_id AS jobId`,
    ).bind(candidate.jobId, leaseId, now, expiresAt).first<{ jobId: string }>();

    // Une autre VM a gagné la course entre SELECT et INSERT/UPSERT.
    if (!claimed) continue;

    try {
      const account = await repos.accounts.get(candidate.shopId);
      if (!account?.enabled) {
        await c.env.DB.prepare(
          "UPDATE vm_sync_lease SET completed_at = ?, expires_at = ? WHERE lease_id = ?",
        ).bind(now, now, leaseId).run();
        continue;
      }

      const credentials = (await repos.credentials.get(candidate.shopId)) ?? {};
      leases.push({
        leaseId,
        leasedUntil: expiresAt,
        resource: resource.data,
        cursor: candidate.cursor,
        account,
        credentials,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await c.env.DB.prepare(
        `UPDATE vm_sync_lease
            SET completed_at = ?, expires_at = ?, last_failure = ?, failure_at = ?
          WHERE lease_id = ?`,
      ).bind(now, now, message.slice(0, 4_000), now, leaseId).run();
    }
  }

  return c.json({ leases });
});

vmSync.post("/observe", async (c) => {
  const raw = await jsonBody(c);
  if ("error" in raw) {
    return c.json({ error: raw.error }, raw.error === "payload_too_large" ? 413 : 400);
  }
  const parsed = observationSchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "invalid_observation" }, 400);
  const body = parsed.data;

  type LeaseRow = {
    jobId: string;
    accountId: string;
    platform: string;
    resource: string;
    completedAt: number | null;
  };
  const lease = await c.env.DB.prepare(
    `SELECT l.sync_job_id AS jobId,
            sj.shop_id AS accountId,
            s.platform AS platform,
            sj.resource AS resource,
            l.completed_at AS completedAt
       FROM vm_sync_lease l
       JOIN sync_job sj ON sj.id = l.sync_job_id
       JOIN shop s ON s.id = sj.shop_id
      WHERE l.lease_id = ?
      LIMIT 1`,
  ).bind(body.leaseId).first<LeaseRow>();

  if (!lease) return c.json({ error: "unknown_lease" }, 404);
  if (lease.completedAt !== null) return c.json({ error: "lease_completed" }, 409);
  if (
    lease.accountId !== body.accountId ||
    lease.resource !== body.resource ||
    lease.platform !== body.marketplace
  ) {
    return c.json({ error: "lease_mismatch" }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO vm_sync_observation
       (id, lease_id, sync_job_id, shop_id, marketplace, resource,
        started_at, finished_at, pages, items, supported, fingerprints,
        terminal_cursor, credential_patch, vm_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    body.leaseId,
    lease.jobId,
    body.accountId,
    body.marketplace,
    body.resource,
    body.startedAt,
    body.finishedAt,
    body.pages,
    body.items,
    body.supported ? 1 : 0,
    JSON.stringify(body.fingerprints),
    body.terminalCursor,
    body.credentialPatch ? JSON.stringify(body.credentialPatch) : null,
    body.vmMode,
    now,
  ).run();

  // OFF par défaut. À n'activer que pour des comptes de TEST dédiés : certains
  // fournisseurs font tourner le refresh_token et pourraient invalider celui
  // qu'utilise encore la production.
  if (
    c.env.VM_ALLOW_CREDENTIAL_PERSIST === "true" &&
    body.credentialPatch &&
    Object.keys(body.credentialPatch).length > 0
  ) {
    const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);
    const current = (await repos.credentials.get(body.accountId)) ?? {};
    await repos.credentials.put(body.accountId, { ...current, ...body.credentialPatch });
  }

  return c.body(null, 204);
});

vmSync.post("/complete", async (c) => {
  const raw = await jsonBody(c);
  if ("error" in raw) return c.json({ error: raw.error }, 400);
  const parsed = z.object({ leaseId: z.string().min(1).max(128) }).safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "invalid_completion" }, 400);

  type LeaseRow = {
    jobId: string;
    completedAt: number | null;
    intervalSec: number;
  };
  const lease = await c.env.DB.prepare(
    `SELECT l.sync_job_id AS jobId,
            l.completed_at AS completedAt,
            sj.interval_sec AS intervalSec
       FROM vm_sync_lease l
       JOIN sync_job sj ON sj.id = l.sync_job_id
      WHERE l.lease_id = ?
      LIMIT 1`,
  ).bind(parsed.data.leaseId).first<LeaseRow>();

  if (!lease) return c.json({ error: "unknown_lease" }, 404);
  if (lease.completedAt !== null) return c.body(null, 204); // idempotent

  const observation = await c.env.DB.prepare(
    `SELECT terminal_cursor AS terminalCursor
       FROM vm_sync_observation
      WHERE lease_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
  ).bind(parsed.data.leaseId).first<{ terminalCursor: string | null }>();
  if (!observation) return c.json({ error: "observation_required" }, 409);

  const now = Math.floor(Date.now() / 1000);
  const continuation = Boolean(observation.terminalCursor);
  const nextRunAt = continuation ? now + 5 : now + Math.max(1, lease.intervalSec);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE vm_sync_lease
          SET completed_at = ?, expires_at = ?
        WHERE lease_id = ? AND completed_at IS NULL`,
    ).bind(now, now, parsed.data.leaseId),
    c.env.DB.prepare(
      `UPDATE sync_job
          SET cursor = ?,
              last_run_at = ?,
              last_ok_at = ?,
              next_run_at = ?,
              failure_count = 0,
              last_error = NULL
        WHERE id = ?`,
    ).bind(observation.terminalCursor, now, now, nextRunAt, lease.jobId),
  ]);

  return c.body(null, 204);
});

vmSync.post("/fail", async (c) => {
  const raw = await jsonBody(c);
  if ("error" in raw) return c.json({ error: raw.error }, 400);
  const parsed = failureSchema.safeParse(raw.value);
  if (!parsed.success) return c.json({ error: "invalid_failure" }, 400);
  const body = parsed.data;

  type LeaseRow = {
    jobId: string;
    accountId: string;
    resource: string;
    completedAt: number | null;
    intervalSec: number;
    failureCount: number;
  };
  const lease = await c.env.DB.prepare(
    `SELECT l.sync_job_id AS jobId,
            l.completed_at AS completedAt,
            sj.shop_id AS accountId,
            sj.resource AS resource,
            sj.interval_sec AS intervalSec,
            sj.failure_count AS failureCount
       FROM vm_sync_lease l
       JOIN sync_job sj ON sj.id = l.sync_job_id
      WHERE l.lease_id = ?
      LIMIT 1`,
  ).bind(body.leaseId).first<LeaseRow>();

  if (!lease) return c.json({ error: "unknown_lease" }, 404);
  if (lease.completedAt !== null) return c.body(null, 204);
  if (lease.accountId !== body.accountId || lease.resource !== body.resource) {
    return c.json({ error: "lease_mismatch" }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const failures = lease.failureCount + 1;
  const retryDelay = body.retryable
    ? Math.min(lease.intervalSec * 2 ** Math.min(failures, 10), 6 * 3600)
    : 6 * 3600;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE vm_sync_lease
          SET completed_at = ?, expires_at = ?, last_failure = ?, failure_at = ?
        WHERE lease_id = ? AND completed_at IS NULL`,
    ).bind(now, now, body.message, body.at || now, body.leaseId),
    c.env.DB.prepare(
      `UPDATE sync_job
          SET failure_count = ?, last_error = ?, next_run_at = ?
        WHERE id = ?`,
    ).bind(failures, body.message, now + retryDelay, lease.jobId),
  ]);

  return c.body(null, 204);
});

export { vmSync };
