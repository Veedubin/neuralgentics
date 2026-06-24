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

import { readFile } from "node:fs/promises";
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

    // Load the full SKILL.md body from disk
    const body = await loadSkillBody(best.path);

    return { name: best.name, body, score: best.score };
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
