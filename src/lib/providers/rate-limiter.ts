/**
 * Per-provider token buckets and a TTL cache (CLAUDE.md §6).
 *
 * The constraint that matters: Alpha Vantage allows 25 requests a day. That
 * budget is spent by the nightly batch job and must never be reachable from a
 * user-facing request, so the limiter distinguishes a `batch` caller from an
 * `interactive` one and refuses interactive access to a daily-budget provider.
 */

export interface BucketConfig {
  /** Tokens added per interval. */
  capacity: number;
  /** Refill interval in milliseconds. */
  intervalMs: number;
  /**
   * A daily budget is reserved for batch jobs. Interactive callers are refused
   * outright rather than quietly consuming the nightly allowance.
   */
  batchOnly?: boolean;
}

export type CallerKind = 'interactive' | 'batch';

export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    readonly name: string,
    readonly config: BucketConfig,
  ) {
    this.tokens = config.capacity;
  }

  private refill(now: number) {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = (elapsed / this.config.intervalMs) * this.config.capacity;
    if (gained >= 1 || this.tokens < this.config.capacity) {
      this.tokens = Math.min(this.config.capacity, this.tokens + gained);
      this.lastRefill = now;
    }
  }

  /** Milliseconds until a token is available; 0 when one is free now. */
  waitMs(now = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    const perToken = this.config.intervalMs / this.config.capacity;
    return Math.ceil((1 - this.tokens) * perToken);
  }

  tryTake(now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  async take(caller: CallerKind = 'batch'): Promise<void> {
    if (this.config.batchOnly && caller === 'interactive') {
      throw new Error(
        `${this.name} has a daily request budget reserved for scheduled jobs; ` +
          'serve this request from the cache or another provider instead',
      );
    }
    for (;;) {
      if (this.tryTake()) return;
      const wait = this.waitMs();
      if (wait > 60_000) throw new Error(`${this.name} rate limit: would block ${wait}ms`);
      await sleep(Math.max(wait, 25));
    }
  }

  get available(): number {
    this.refill(Date.now());
    return Math.floor(this.tokens);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Budgets as published by each provider's free tier. Verify these before
 * relying on them — free-tier limits move, and a limit that has tightened
 * shows up as silent failure rather than an error.
 */
export const BUCKETS: Record<string, BucketConfig> = {
  alpaca: { capacity: 200, intervalMs: 60_000 },
  finnhub: { capacity: 60, intervalMs: 60_000 },
  yahoo: { capacity: 60, intervalMs: 60_000 }, // undocumented; kept deliberately polite
  alphavantage: { capacity: 25, intervalMs: 86_400_000, batchOnly: true },
  fred: { capacity: 120, intervalMs: 60_000 },
  exchangerate: { capacity: 100, intervalMs: 3_600_000 },
  kenfrench: { capacity: 10, intervalMs: 3_600_000, batchOnly: true },
};

const buckets = new Map<string, TokenBucket>();

export function bucketFor(provider: string): TokenBucket {
  let b = buckets.get(provider);
  if (!b) {
    b = new TokenBucket(provider, BUCKETS[provider] ?? { capacity: 30, intervalMs: 60_000 });
    buckets.set(provider, b);
  }
  return b;
}

/* ---------------- Response cache ---------------- */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * TTLs are keyed to each provider's actual freshness, not to a guess. Caching a
 * real-time Alpaca quote for five minutes would make it a five-minute-delayed
 * quote displayed as live, which is the failure mode §6 exists to prevent.
 */
export const TTL_MS = {
  quoteRealtime: 15_000,
  quoteDelayed: 60_000,
  dailyBar: 12 * 3_600_000,
  fxDaily: 6 * 3_600_000,
  fundamentals: 24 * 3_600_000,
  earnings: 6 * 3_600_000,
  macro: 12 * 3_600_000,
} as const;

export class TtlCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

export const cache = new TtlCache();
