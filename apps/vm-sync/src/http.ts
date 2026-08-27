import { ConnectorError } from "@hub/core";
import { TokenBucket } from "./token-bucket.js";

const LIMITS: Record<string, { qps: number; burst: number }> = {
  shopify: { qps: 2, burst: 10 },
  etsy: { qps: 5, burst: 10 },
  ebay: { qps: 3, burst: 10 },
  alibaba: { qps: 2, burst: 5 },
  vinted: { qps: 1, burst: 2 },
  mock: { qps: 100, burst: 100 },
};

export function createVmHttp(platform: string) {
  const limits = LIMITS[platform] ?? { qps: 1, burst: 2 };
  const bucket = new TokenBucket(limits.qps, limits.burst);

  return async function http(
    input: string,
    init: RequestInit = {},
  ): Promise<Response> {
    await bucket.take(1);

    const response = await fetch(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });

    if (response.status === 401 || response.status === 403) {
      throw new ConnectorError(
        `${platform} a refusé le jeton (${response.status})`,
        "auth_expired",
      );
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "60");
      throw new ConnectorError(
        `${platform} a renvoyé 429`,
        "rate_limited",
        retryAfter * 1000,
      );
    }
    if (response.status >= 500) {
      throw new ConnectorError(
        `${platform} indisponible (${response.status})`,
        "transient",
        30_000,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ConnectorError(
        `${platform} ${response.status} : ${body.slice(0, 300)}`,
        "permanent",
      );
    }

    return response;
  };
}
