/** Sweep expired keys at most this often, counted in attempts. */
const SWEEP_EVERY = 100;
/** Hard cap on distinct keys held in memory (D54). */
export const RATE_LIMIT_MAX_KEYS = 10_000;

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private sinceSweep = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = RATE_LIMIT_MAX_KEYS,
  ) {}

  /** Records an attempt. Returns false when the key is over the limit. */
  attempt(key: string, now = Date.now()): boolean {
    if (++this.sinceSweep >= SWEEP_EVERY) this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    // Refresh the key's position so the oldest entry in the map is the least recently used.
    this.hits.delete(key);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      this.trim(now);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.trim(now);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  /** Drops keys whose attempts have all expired. */
  sweep(now = Date.now()): void {
    this.sinceSweep = 0;
    for (const [k, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }

  /** Keeps the map under the cap: expired keys go first, then the least recently used. A new key is never refused. */
  private trim(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    this.sweep(now);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}
