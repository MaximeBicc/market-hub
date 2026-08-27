export type VmSyncMode = "dry-run" | "shadow" | "active";

export interface VmConfig {
  mode: VmSyncMode;
  controlPlaneUrl: string;
  controlPlaneToken: string;
  pollIntervalMs: number;
  leaseLimit: number;
  maxPagesPerJob: number;
  healthPort: number;
  logLevel: string;
  marketplaceWritesUnlocked: boolean;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variable obligatoire absente : ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} doit être un entier strictement positif`);
  }
  return value;
}

export function loadConfig(): VmConfig {
  const mode = (process.env.VM_SYNC_MODE ?? "shadow").trim() as VmSyncMode;
  if (!["dry-run", "shadow", "active"].includes(mode)) {
    throw new Error(`VM_SYNC_MODE invalide : ${mode}`);
  }

  const config: VmConfig = {
    mode,
    controlPlaneUrl: required("CONTROL_PLANE_URL").replace(/\/+$/, ""),
    controlPlaneToken: required("CONTROL_PLANE_TOKEN"),
    pollIntervalMs: positiveInt("POLL_INTERVAL_MS", 60_000),
    leaseLimit: positiveInt("LEASE_LIMIT", 4),
    maxPagesPerJob: positiveInt("MAX_PAGES_PER_JOB", 40),
    healthPort: positiveInt("HEALTH_PORT", 8080),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    marketplaceWritesUnlocked:
      process.env.ALLOW_MARKETPLACE_WRITES ===
      "I_UNDERSTAND_THIS_WRITES_TO_REAL_MARKETPLACES",
  };

  if (config.mode === "active" && !config.marketplaceWritesUnlocked) {
    throw new Error(
      "Mode active refusé : le verrou ALLOW_MARKETPLACE_WRITES n'est pas déverrouillé.",
    );
  }

  return config;
}
