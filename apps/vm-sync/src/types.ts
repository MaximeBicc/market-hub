import type { MarketplaceAccount } from "@hub/engine";

export type VmSyncResource = "orders" | "inventory" | "listings";

export interface SyncLease {
  leaseId: string;
  leasedUntil: number;
  resource: VmSyncResource;
  cursor: string | null;
  account: MarketplaceAccount;
  /** Identifiants déjà déchiffrés par le control plane staging. */
  credentials: Record<string, string>;
}

export interface ItemFingerprint {
  id: string;
  hash: string;
}

export interface ShadowObservation {
  leaseId: string;
  accountId: string;
  marketplace: string;
  resource: VmSyncResource;
  startedAt: number;
  finishedAt: number;
  pages: number;
  items: number;
  supported: boolean;
  fingerprints: ItemFingerprint[];
  terminalCursor: string | null;
  /** Jetons/échéances renouvelés par l'adaptateur pendant la lecture. */
  credentialPatch?: Record<string, string>;
  vmMode: "dry-run" | "shadow" | "active";
}

export interface LeaseFailure {
  leaseId: string;
  accountId: string;
  resource: VmSyncResource;
  at: number;
  message: string;
  retryable: boolean;
}

export interface RuntimeStats {
  startedAt: number;
  loops: number;
  leasesSeen: number;
  leasesOk: number;
  leasesFailed: number;
  lastLoopAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
}
