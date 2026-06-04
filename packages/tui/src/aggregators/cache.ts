/**
 * LRU Cache for Aggregator-Aware Lookup — T-035 (P1-c-ext).
 *
 * In-memory LRU cache with TTL-based invalidation.
 * Cache hits must be <100ms per Addendum 2 §7.
 *
 * Uses a Map as an ordered dictionary (insertion order = recency).
 * On get(), the entry is moved to the end (most recently used).
 * On set(), if capacity is exceeded, the oldest entry is evicted.
 */

import type { AggregatorResult, TrustTier } from "./types.js";
import { CACHE_TTL_BY_TIER } from "./types.js";

/** Cache entry with metadata. */
interface CacheEntry {
  /** The cached results. */
  results: AggregatorResult[];
  /** When this entry was cached (epoch ms). */
  cachedAt: number;
  /** TTL in ms for this entry. */
  ttlMs: number;
  /** The cache key. */
  key: string;
}

/**
 * LRU Cache for aggregator search results.
 *
 * Guarantees <100ms cache hits by using a Map with O(1) lookups.
 * TTL-based invalidation ensures freshness per trust tier.
 */
export class AggregatorCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private hits = 0;
  private misses = 0;

  /**
   * @param maxSize - Maximum number of cache entries (default 500).
   */
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  /**
   * Get cached results for a key.
   * Returns undefined if not found or expired.
   * On hit, moves the entry to most-recently-used position.
   */
  get(key: string): AggregatorResult[] | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }

    // Check TTL expiration
    const now = Date.now();
    if (now - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Move to end (most recently used) — O(1) with Map
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.results;
  }

  /**
   * Store results in the cache.
   * If the cache is full, evicts the least recently used entry.
   */
  set(
    key: string,
    results: AggregatorResult[],
    trustTier: TrustTier,
  ): void {
    // Evict LRU if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Map.keys() returns keys in insertion order; first = oldest
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    // Delete first if updating existing key (to move to end)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    this.cache.set(key, {
      key,
      results,
      cachedAt: Date.now(),
      ttlMs: CACHE_TTL_BY_TIER[trustTier],
    });
  }

  /**
   * Generate a cache key from source + search terms.
   * Deterministic — same inputs always produce the same key.
   */
  static makeKey(source: string, searchTerms: string[]): string {
    // Sort terms for deterministic key generation
    const sorted = [...searchTerms].sort();
    return `${source}:${sorted.join("|")}`;
  }

  /** Check if a key exists and is not expired. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Remove a specific entry. */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Clear all entries. */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Get the number of entries (including possibly expired ones). */
  get size(): number {
    return this.cache.size;
  }

  /** Get cache statistics. */
  getStats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      size: this.cache.size,
    };
  }

  /**
   * Get entries older than a threshold (for staleness warnings).
   * Returns entries where age exceeds the threshold.
   */
  getStaleEntries(maxAgeMs: number): Array<{ key: string; ageMs: number; source: string }> {
    const now = Date.now();
    const stale: Array<{ key: string; ageMs: number; source: string }> = [];
    for (const [key, entry] of this.cache) {
      const ageMs = now - entry.cachedAt;
      if (ageMs > maxAgeMs) {
        // Extract source from key format "source:term1|term2"
        const source = key.split(":")[0] ?? "unknown";
        stale.push({ key, ageMs, source });
      }
    }
    return stale;
  }

  /**
   * Purge all expired entries.
   * Returns the number of entries purged.
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt > entry.ttlMs) {
        this.cache.delete(key);
        purged++;
      }
    }
    return purged;
  }
}