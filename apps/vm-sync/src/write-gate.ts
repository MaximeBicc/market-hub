import type { VmConfig } from "./config.js";

/**
 * Toute future écriture vers une marketplace devra passer ici.
 * Phase 1 n'appelle aucune méthode d'écriture des adaptateurs.
 */
export function assertMarketplaceWriteAllowed(
  config: VmConfig,
  operation: string,
): void {
  if (config.mode !== "active" || !config.marketplaceWritesUnlocked) {
    throw new Error(
      `Écriture marketplace bloquée (${operation}) : VM_SYNC_MODE=${config.mode}`,
    );
  }
}
