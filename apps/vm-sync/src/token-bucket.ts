export class TokenBucket {
  private tokens: number;
  private lastRefillMs = Date.now();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = Math.max(1, burst);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillMs) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(
      this.burst,
      this.tokens + elapsed * Math.max(0.01, this.ratePerSecond),
    );
    this.lastRefillMs = now;
  }

  async take(count = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const missing = count - this.tokens;
      const waitMs = Math.ceil(
        (missing / Math.max(0.01, this.ratePerSecond)) * 1000,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(waitMs, 10_000)),
      );
    }
  }
}
