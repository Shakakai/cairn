/**
 * Rate-limiting primitives (docs/02, 10): a byte token bucket, fixed-window counters and
 * bounded sets. Pure: callers pass the time.
 */

/** Token bucket over bytes (doc 07 `bytesPerSecond` / `maxBurstBytes`). */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  /** Try to consume `bytes`. Refills continuously; never goes below zero. */
  tryConsume(bytes: number, nowMs: number): boolean {
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    if (elapsedMs > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
      this.lastRefillMs = nowMs;
    }
    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return true;
    }
    return false;
  }

  /** Time until `bytes` will be available, or 0 if available now. */
  msUntilAvailable(bytes: number, nowMs: number): number {
    if (this.tryConsume(bytes, nowMs)) return 0;
    const deficit = bytes - this.tokens;
    return Math.ceil((deficit / this.refillPerSecond) * 1000);
  }
}

/**
 * Fixed-window counter: at most `limit` allowances per `windowMs`.
 * Used for the per-connection frame-rate cap and the new-destination cap (docs/02, 10).
 */
export class FixedWindowCounter {
  private windowStartMs: number;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    nowMs: number,
  ) {
    this.windowStartMs = nowMs;
  }

  /** Returns true while the allowance holds; the first call over the limit returns false. */
  allow(nowMs: number): boolean {
    if (nowMs - this.windowStartMs >= this.windowMs) {
      this.windowStartMs = nowMs;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }

  /** Current count within the active window (metrics/tests). */
  get current(): number {
    return this.count;
  }
}

/** Fixed-window set of distinct keys: at most `limit` distinct keys per `windowMs`. */
export class FixedWindowSet<T> {
  private windowStartMs: number;
  private readonly seen = new Set<T>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    nowMs: number,
  ) {
    this.windowStartMs = nowMs;
  }

  /** Add a key. Returns false when the window's distinct-key budget is exhausted. */
  add(key: T, nowMs: number): boolean {
    if (nowMs - this.windowStartMs >= this.windowMs) {
      this.windowStartMs = nowMs;
      this.seen.clear();
    }
    if (this.seen.has(key)) return true;
    if (this.seen.size >= this.limit) return false;
    this.seen.add(key);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Bounded insertion-ordered set with LRU eviction: the sent-to set of a connection and the
 * nonce/sent-to unions of the registry (docs/02, 01 §5.3). Iteration order is oldest-first.
 */
export class BoundedSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly capacity: number) {}

  /** Returns true iff the key was newly added (possibly evicting the oldest entry). */
  add(key: T): boolean {
    if (this.items.has(key)) return false;
    while (this.items.size >= this.capacity) {
      const oldest = this.items.values().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    this.items.add(key);
    return true;
  }

  has(key: T): boolean {
    return this.items.has(key);
  }

  get size(): number {
    return this.items.size;
  }

  toArray(): T[] {
    return [...this.items];
  }
}
