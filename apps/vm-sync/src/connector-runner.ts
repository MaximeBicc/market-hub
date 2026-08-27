import type {
  CanonicalOrderEvent,
  MarketplaceContext,
  RemoteListing,
} from "@hub/engine";
import type { VmConfig } from "./config.js";
import { fingerprint } from "./fingerprint.js";
import { createVmHttp } from "./http.js";
import { Logger } from "./log.js";
import { buildVmRegistry } from "./registry.js";
import type {
  ItemFingerprint,
  ShadowObservation,
  SyncLease,
} from "./types.js";

function eventId(item: CanonicalOrderEvent): string {
  return item.eventId || item.remoteOrderId;
}

function listingId(item: RemoteListing): string {
  return item.remoteId;
}

export class ConnectorRunner {
  private readonly registry = buildVmRegistry();

  constructor(
    private readonly config: VmConfig,
    private readonly log: Logger,
  ) {}

  async run(lease: SyncLease): Promise<ShadowObservation> {
    const startedAt = Math.floor(Date.now() / 1000);
    const adapter = this.registry.get(lease.account.marketplace);
    const credentials = { ...lease.credentials };
    const credentialPatch: Record<string, string> = {};

    const ctx: MarketplaceContext = {
      account: lease.account,
      credentials,
      http: createVmHttp(String(lease.account.marketplace)),
      saveCredentials: async (patch) => {
        Object.assign(credentials, patch);
        Object.assign(credentialPatch, patch);
      },
    };

    const fingerprints: ItemFingerprint[] = [];
    let cursor = lease.cursor ?? undefined;
    let pages = 0;
    let items = 0;
    let supported = true;

    if (lease.resource === "orders") {
      if (!adapter.pollOrderEvents) {
        supported = false;
      } else {
        while (pages < this.config.maxPagesPerJob) {
          const page = await adapter.pollOrderEvents(ctx, cursor);
          pages += 1;
          items += page.events.length;
          for (const item of page.events) {
            fingerprints.push({ id: eventId(item), hash: fingerprint(item) });
          }

          const next = page.cursor;
          if (!next || next === cursor) {
            cursor = undefined;
            break;
          }
          cursor = next;
        }
      }
    } else {
      if (!adapter.fetchListings) {
        supported = false;
      } else {
        while (pages < this.config.maxPagesPerJob) {
          const page = await adapter.fetchListings(ctx, cursor);
          pages += 1;
          items += page.items.length;
          for (const item of page.items) {
            fingerprints.push({ id: listingId(item), hash: fingerprint(item) });
          }

          const next = page.cursor;
          if (!next || next === cursor) {
            cursor = undefined;
            break;
          }
          cursor = next;
        }
      }
    }

    if (pages >= this.config.maxPagesPerJob && cursor) {
      this.log.warn("vm.sync.pagination_cap", {
        leaseId: lease.leaseId,
        accountId: lease.account.id,
        resource: lease.resource,
      });
    }

    return {
      leaseId: lease.leaseId,
      accountId: lease.account.id,
      marketplace: String(lease.account.marketplace),
      resource: lease.resource,
      startedAt,
      finishedAt: Math.floor(Date.now() / 1000),
      pages,
      items,
      supported,
      fingerprints,
      terminalCursor: cursor ?? null,
      ...(Object.keys(credentialPatch).length > 0 ? { credentialPatch } : {}),
      vmMode: this.config.mode,
    };
  }
}
