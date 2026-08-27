import { ConnectorError } from "@hub/core";
import type { VmConfig } from "./config.js";
import type { ControlPlane } from "./control-plane.js";
import { ConnectorRunner } from "./connector-runner.js";
import { Logger } from "./log.js";
import type { RuntimeStats, SyncLease } from "./types.js";

function retryable(err: unknown): boolean {
  if (err instanceof ConnectorError) {
    return err.kind === "rate_limited" || err.kind === "transient";
  }
  const message = err instanceof Error ? err.message : String(err);
  return /429|5\d\d|timeout|temporar|network|fetch/i.test(message);
}

export class VmRuntime {
  readonly stats: RuntimeStats = {
    startedAt: Math.floor(Date.now() / 1000),
    loops: 0,
    leasesSeen: 0,
    leasesOk: 0,
    leasesFailed: 0,
    lastLoopAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
  };

  private stopped = false;
  private readonly runner: ConnectorRunner;

  constructor(
    private readonly config: VmConfig,
    private readonly controlPlane: ControlPlane,
    private readonly log: Logger,
  ) {
    this.runner = new ConnectorRunner(config, log);
  }

  stop(): void {
    this.stopped = true;
  }

  async start(): Promise<void> {
    this.log.info("vm.runtime.started", {
      mode: this.config.mode,
      pollIntervalMs: this.config.pollIntervalMs,
      leaseLimit: this.config.leaseLimit,
      marketplaceWritesUnlocked: this.config.marketplaceWritesUnlocked,
    });

    while (!this.stopped) {
      const loopStarted = Date.now();
      try {
        await this.loop();
      } catch (err) {
        this.stats.lastErrorAt = Math.floor(Date.now() / 1000);
        this.log.error("vm.runtime.loop_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const elapsed = Date.now() - loopStarted;
      const delay = Math.max(250, this.config.pollIntervalMs - elapsed);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.log.info("vm.runtime.stopped");
  }

  private async loop(): Promise<void> {
    this.stats.loops += 1;
    this.stats.lastLoopAt = Math.floor(Date.now() / 1000);

    const leases = await this.controlPlane.lease(this.config.leaseLimit);
    this.stats.leasesSeen += leases.length;

    for (const lease of leases) {
      if (this.stopped) break;
      await this.process(lease);
    }
  }

  private async process(lease: SyncLease): Promise<void> {
    this.log.info("vm.sync.start", {
      leaseId: lease.leaseId,
      accountId: lease.account.id,
      marketplace: lease.account.marketplace,
      resource: lease.resource,
      mode: this.config.mode,
    });

    try {
      const observation = await this.runner.run(lease);

      // Phase 1 : lecture + mesure uniquement.
      await this.controlPlane.observe(observation);
      await this.controlPlane.complete(lease.leaseId);

      this.stats.leasesOk += 1;
      this.stats.lastSuccessAt = Math.floor(Date.now() / 1000);

      this.log.info("vm.sync.ok", {
        leaseId: lease.leaseId,
        pages: observation.pages,
        items: observation.items,
        supported: observation.supported,
      });
    } catch (err) {
      this.stats.leasesFailed += 1;
      this.stats.lastErrorAt = Math.floor(Date.now() / 1000);
      const message = err instanceof Error ? err.message : String(err);

      this.log.error("vm.sync.failed", {
        leaseId: lease.leaseId,
        accountId: lease.account.id,
        resource: lease.resource,
        message,
      });

      await this.controlPlane.fail({
        leaseId: lease.leaseId,
        accountId: lease.account.id,
        resource: lease.resource,
        at: Math.floor(Date.now() / 1000),
        message,
        retryable: retryable(err),
      });
    }
  }
}
