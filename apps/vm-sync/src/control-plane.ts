import type {
  LeaseFailure,
  ShadowObservation,
  SyncLease,
} from "./types.js";

export interface ControlPlane {
  lease(limit: number): Promise<SyncLease[]>;
  observe(observation: ShadowObservation): Promise<void>;
  complete(leaseId: string): Promise<void>;
  fail(failure: LeaseFailure): Promise<void>;
}

export class HttpControlPlane implements ControlPlane {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Control plane ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async lease(limit: number): Promise<SyncLease[]> {
    const result = await this.request<{ leases: SyncLease[] }>(
      `/api/internal/vm-sync/lease?limit=${encodeURIComponent(String(limit))}`,
    );
    return result.leases;
  }

  async observe(observation: ShadowObservation): Promise<void> {
    await this.request<void>("/api/internal/vm-sync/observe", {
      method: "POST",
      body: JSON.stringify(observation),
    });
  }

  async complete(leaseId: string): Promise<void> {
    await this.request<void>("/api/internal/vm-sync/complete", {
      method: "POST",
      body: JSON.stringify({ leaseId }),
    });
  }

  async fail(failure: LeaseFailure): Promise<void> {
    await this.request<void>("/api/internal/vm-sync/fail", {
      method: "POST",
      body: JSON.stringify(failure),
    });
  }
}
