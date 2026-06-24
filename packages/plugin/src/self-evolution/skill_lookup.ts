/**
 * Neuralgentics — Skill Lookup via Word-Overlap Cosine Similarity
 *
 * Pre-dispatch hook for the orchestrator. Given a task context string
 * and a role, queries broker.listSkills via the BrokerClient, computes
 * word-overlap cosine similarity between the task context and each
 * skill's metadata, and returns the top-1 matching skill (if score ≥ 0.6).
 *
 * Phase 1 uses simple bag-of-words cosine — no real embeddings. The
 * accuracy is good for keyword-rich skill metadata but will miss
 * semantically-similar-but-lexically-different matches. Real embeddings
 * will be added in Phase 2 when the embedding sidecar is wired.
 *
 * @module skill_lookup
 */

import { readFile, stat } from "node:fs/promises";
import type { BrokerClient } from "./broker_client.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum cosine similarity score for a skill to be considered a match.
 *
 * Skills scoring below this threshold are not returned by pickSkill().
 * The value of 0.6 was chosen to balance precision (avoiding false
 * positives on loosely-related tasks) and recall (catching most
 * keyword-overlap matches for well-tagged skills).
 */
export const MIN_SCORE = 0.6;

/**
 * Stopwords for the bag-of-words tokenizer.
 *
 * These common English words carry little semantic signal and are
 * removed before cosine similarity computation. The set is intentionally
 * small to keep tokenization fast while filtering out the most
 * information-poor terms.
 */
export const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "must",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "against",
  "about",
  "and",
  "or",
  "but",
  "if",
  "while",
  "because",
  "since",
  "until",
  "than",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "them",
  "their",
  "my",
  "your",
  "our",
]);

// ============================================================================
// LRU Body Cache (TS-side, Phase 2)
// ============================================================================

/**
 * SkillBodyCache — in-memory LRU cache for SKILL.md body content.
 *
 * Stores full file bodies keyed by absolute path, with LRU eviction
 * when the cache exceeds maxEntries or maxBytes. Cache entries are
 * invalidated when the file's mtimeMs changes.
 *
 * Phase 2: This is the active body cache. The Go SkillBodyCache type
 * is designed and unit-tested but not wired into JSON-RPC yet.
 */
export class SkillBodyCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, CachedBody>();
  private readonly order: string[] = []; // LRU order, oldest first
  private totalBytes = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(maxEntries: number = 100, maxBytes: number = 5 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  /**
   * Get the body for a skill path, using cache if available.
   *
   * If the path is cached and the file's mtimeMs hasn't changed,
   * returns the cached body. Otherwise reads from disk, caches,
   * and returns.
   *
   * @returns The body string, or empty string if the file can't be read.
   */
  async get(path: string): Promise<string> {
    // Check cache.
    const cached = this.entries.get(path);
    if (cached) {
      try {
        const info = await stat(path);
        if (info.mtimeMs === cached.mtimeMs) {
          // Cache hit — promote to MRU.
          this.promoteToMRU(path);
          this.hitCount++;
          return cached.body;
        }
        // mtimeMs changed — invalidate and fall through.
        this.removeEntry(path);
      } catch {
        // File gone — invalidate and fall through.
        this.removeEntry(path);
      }
    }

    // Cache miss — read from disk.
    this.missCount++;
    try {
      const body = await readFile(path, "utf-8");
      let mtimeMs = 0;
      try {
        const info = await stat(path);
        mtimeMs = info.mtimeMs;
      } catch {
        // Use default mtimeMs = 0
      }

      const size = body.length;
      // Insert first, then enforce limits (matches Go behavior).
      this.entries.set(path, { body, mtimeMs, size });
      this.order.push(path);
      this.totalBytes += size;
      this.enforceLimits();

      return body;
    } catch {
      return "";
    }
  }

  /** Invalidate a single entry. */
  invalidate(path: string): void {
    this.removeEntry(path);
  }

  /** Clear the entire cache. */
  invalidateAll(): void {
    this.entries.clear();
    this.order.length = 0;
    this.totalBytes = 0;
  }

  /** Get cache statistics for debugging. */
  cacheStats(): { entries: number; bytes: number; hits: number; misses: number } {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      hits: this.hitCount,
      misses: this.missCount,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private promoteToMRU(path: string): void {
    const idx = this.order.indexOf(path);
    if (idx !== -1) {
      this.order.splice(idx, 1);
      this.order.push(path);
    }
  }

  private removeEntry(path: string): void {
    const entry = this.entries.get(path);
    if (entry) {
      this.totalBytes -= entry.size;
      this.entries.delete(path);
    }
    const idx = this.order.indexOf(path);
    if (idx !== -1) {
      this.order.splice(idx, 1);
    }
  }

  private enforceLimits(): void {
    while (
      this.order.length > 0 &&
      (this.entries.size > this.maxEntries ||
        this.totalBytes > this.maxBytes)
    ) {
      const oldest = this.order[0];
      if (!oldest) break;
      this.removeEntry(oldest);
    }
  }
}

interface CachedBody {
  body: string;
  mtimeMs: number;
  size: number;
}

// Module-level cache instance (100 entries, 5MB).
const bodyCache = new SkillBodyCache();

/**
 * Get cache statistics for debugging.
 */
export function getCacheStats(): {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
} {
  return bodyCache.cacheStats();
}

/**
 * Clear the entire skill body cache.
 */
export function clearCache(): void {
  bodyCache.invalidateAll();
}

// ============================================================================
// Tokenization & Cosine
// ============================================================================

/**
 * Tokenize text into lowercase words, filtering stopwords and short tokens.
 *
 * Splits on non-alphanumeric characters, lowercases, removes stopwords,
 * and drops empty/short tokens.
 *
 * @param text — Input text to tokenize.
 * @returns Array of lowercase tokens (stopwords removed).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Compute word-overlap cosine similarity between two strings.
 *
 * Each string is tokenized and converted to a set of unique tokens.
 * The cosine similarity is computed as:
 *   |intersection(A, B)| / sqrt(|A| * |B|)
 *
 * This is the Phase 1 embedding strategy. It produces a score in [0, 1]
 * where:
 *   - 1.0 means identical token sets
 *   - 0.0 means completely disjoint sets
 *
 * @param a — First text (typically the task context).
 * @param b — Second text (typically the skill's name + description + tags).
 * @returns Cosine similarity score in [0, 1].
 */
export function wordOverlapCosine(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));

  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }

  return intersection / Math.sqrt(ta.size * tb.size);
}

// ============================================================================
// Skill Lookup
// ============================================================================

/** Result of a successful skill match. */
export interface SkillMatchResult {
  /** Name of the matched skill. */
  name: string;
  /** Full SKILL.md body loaded from disk. */
  body: string;
  /** Cosine similarity score (always ≥ MIN_SCORE). */
  score: number;
}

/**
 * SkillLookup — pre-dispatch skill matching for the orchestrator.
 *
 * Queries the broker's ListSkills(role) JSON-RPC method, computes cosine
 * similarity between the task context and each skill's metadata, and
 * returns the top-1 match if the score meets the threshold (MIN_SCORE).
 */
export class SkillLookup {
  private readonly broker: BrokerClient;
  private readonly threshold: number;

  /**
   * @param broker — Broker client for fetching the skill catalog.
   * @param threshold — Minimum cosine similarity to return a match (default: MIN_SCORE).
   */
  constructor(broker: BrokerClient, threshold: number = MIN_SCORE) {
    this.broker = broker;
    this.threshold = threshold;
  }

  /**
   * Pick the best-matching skill for a task context.
   *
   * 1. Calls ListSkills(role) via the broker client.
   * 2. Builds a bag-of-words vector for the task context.
   * 3. For each skill, builds a bag-of-words vector for
   *    name + description + tags.join(" ").
   * 4. Computes cosine similarity.
   * 5. Returns the top-1 match if score ≥ threshold, else null.
   *
   * @param taskContext — The task description or context string.
   * @param role — Agent role to filter skills by (default: "orchestrator").
   * @returns Skill match result, or null if no skill meets the threshold.
   */
  async pickSkill(
    taskContext: string,
    role: string = "orchestrator",
  ): Promise<SkillMatchResult | null> {
    const catalog = await this.broker.listSkills(role);

    if (catalog.skills.length === 0) return null;

    let best: { name: string; path: string; score: number } | null = null;

    for (const skill of catalog.skills) {
      const haystack = [
        skill.name,
        skill.description,
        ...(skill.tags ?? []),
      ].join(" ");
      const score = wordOverlapCosine(taskContext, haystack);

      if (best === null || score > best.score) {
        best = { name: skill.name, path: skill.path, score };
      }
    }

    if (!best || best.score < this.threshold) return null;

    // Load the full SKILL.md body via the LRU cache
    const body = await bodyCache.get(best.path);

    return { name: best.name, body, score: best.score };
  }

  /** Expose cache stats for debugging. */
  cacheStats() {
    return bodyCache.cacheStats();
  }
}

// ============================================================================
// File Loader
// ============================================================================

/**
 * Load the full SKILL.md body from disk.
 *
 * @param p — Absolute or relative path to the SKILL.md file.
 * @returns File content, or empty string if the file cannot be read.
 */
export async function loadSkillBody(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}
