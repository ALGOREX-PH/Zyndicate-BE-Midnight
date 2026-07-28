interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Small LRU cache with TTL, used to soften repeated discovery queries
 * (public mandate listings). Values are cloned-by-reference; callers must
 * not mutate cached results.
 */
export class LruTtlCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();

  constructor(
    private readonly maxEntries = 200,
    private readonly ttlMs = 5000
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // refresh recency
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Invalidate everything — called on any mandate write. */
  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
