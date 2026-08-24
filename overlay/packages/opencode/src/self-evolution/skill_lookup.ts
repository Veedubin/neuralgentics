/**
 * SkillLookup — pre-dispatch skill matching for the orchestrator.
 *
 * Queries the Go backend's `broker.listSkills` JSON-RPC method, computes
 * cosine similarity between the task context and each skill's
 * name+description+tags (bag-of-words, no real embeddings — Phase 1),
 * and returns the top-1 match if the score meets the threshold.
 *
 * Design reference: docs/design/skills-brokering-phase-1-design.md §8-§9.
 */

/** Minimal client surface satisfied by GoBackendClient (#call(method, args)). */
export interface BrokerClient {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

interface SkillSummary {
  name: string;
  description: string;
  tags?: string[];
  path?: string;
}

interface SkillCatalogResponse {
  skills?: SkillSummary[];
  total_skills?: number;
  role?: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "nor", "not", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some",
  "such", "no", "only", "own", "same", "than", "too", "very", "just",
  "about", "also", "if", "then", "else", "when", "where", "why", "how",
  "this", "that", "these", "those", "it", "its", "he", "she", "they",
  "them", "we", "you", "i", "me", "my", "your", "his", "her", "our",
]);

/** Tokenize text into a bag-of-words frequency map (lowercase, stopwords dropped). */
export function bagOfWords(text: string): Map<string, number> {
  const vec = new Map<string, number>();
  const tokens = text.toLowerCase().split(/[\s,;:.!?()[\]{}"']+/);
  for (const token of tokens) {
    if (token.length === 0 || STOPWORDS.has(token)) continue;
    vec.set(token, (vec.get(token) ?? 0) + 1);
  }
  return vec;
}

/** Cosine similarity between two sparse frequency vectors. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dotProduct = 0;
  for (const [key, val] of a) {
    const other = b.get(key);
    if (other !== undefined) dotProduct += val * other;
  }
  let magA = 0;
  for (const v of a.values()) magA += v * v;
  let magB = 0;
  for (const v of b.values()) magB += v * v;
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

export interface SkillMatch {
  name: string;
  body: string | null;
  path: string | null;
  score: number;
}

export class SkillLookup {
  private readonly client: BrokerClient;
  private readonly threshold: number;

  constructor(client: BrokerClient, threshold = 0.6) {
    this.client = client;
    this.threshold = threshold;
  }

  /**
   * Pick the best-matching skill for a task context.
   * Returns null when the catalog is empty or no skill meets the threshold.
   */
  async pickSkill(
    taskContext: string,
    role = "orchestrator",
  ): Promise<SkillMatch | null> {
    const raw = await this.client.call("broker.listSkills", { role });
    const catalog = (raw ?? {}) as SkillCatalogResponse;
    const skills = catalog.skills ?? [];
    if (skills.length === 0) return null;

    const taskVec = bagOfWords(taskContext);
    let bestScore = 0;
    let bestSkill: SkillSummary | null = null;
    for (const skill of skills) {
      const skillText = [
        skill.name ?? "",
        skill.description ?? "",
        (skill.tags ?? []).join(" "),
      ].join(" ");
      const score = cosine(taskVec, bagOfWords(skillText));
      if (score > bestScore) {
        bestScore = score;
        bestSkill = skill;
      }
    }

    if (!bestSkill || bestScore < this.threshold) return null;
    return {
      name: bestSkill.name,
      body: null,
      path: bestSkill.path ?? null,
      score: bestScore,
    };
  }
}
