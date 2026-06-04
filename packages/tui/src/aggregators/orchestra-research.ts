/**
 * Orchestra Research AI-Research-SKILLs Aggregator — T-035 (P1-c-ext).
 *
 * Searches the Orchestra Research GitHub repository for AI research skills.
 * Per Addendum 2 §2.1: GitHub API fetches CLAUDE.md for skill tree,
 * then individual SKILL.md files. 98 skills, MIT license, 9.3k stars.
 * Trust Tier: 1 (Curated, MIT, high stars)
 */

import type { Aggregator, AggregatorResult, AggregatorSearchQuery } from "./types.js";
import { AGGREGATOR_TRUST_TIERS, AGGREGATOR_LABELS, computeMatchScore, INSTALL_SIMPLICITY } from "./types.js";
import { AggregatorCache } from "./cache.js";

/** GitHub API response for directory listing. */
interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

/** GitHub API response for file content. */
interface GitHubFileContent {
  name: string;
  path: string;
  content?: string;
  encoding?: string;
}

/** Parsed skill entry from the Orchestra Research repository. */
interface OrchestraSkill {
  name: string;
  category: string;
  description: string;
  path: string;
  starCount?: number;
  license?: string;
}

/**
 * Orchestra Research aggregator.
 *
 * Fetches the skill tree from the orchestra-research GitHub repository,
 * then searches skill names and descriptions for matches.
 * In tests, inject a mock via `fetchFn`.
 */
export class OrchestraResearchAggregator implements Aggregator {
  readonly source = "orchestra_research" as const;
  readonly label = AGGREGATOR_LABELS["orchestra_research"];
  readonly trustTier = AGGREGATOR_TRUST_TIERS["orchestra_research"];

  private readonly repoApiUrl: string;
  private readonly cache: AggregatorCache;
  private readonly fetchFn: typeof globalThis.fetch;
  private _available = true;
  private skillIndex: OrchestraSkill[] | null = null;
  private indexFetchedAt = 0;
  private readonly indexTtlMs: number;

  /**
   * @param options - Configuration options.
   * @param options.cache - Shared cache instance.
   * @param options.repoApiUrl - Override the GitHub API URL (for testing).
   * @param options.fetchFn - Override fetch (for mocking in tests).
   * @param options.indexTtlMs - How long to cache the skill index (default 1 hour).
   */
  constructor(options: {
    cache: AggregatorCache;
    repoApiUrl?: string;
    fetchFn?: typeof globalThis.fetch;
    indexTtlMs?: number;
  }) {
    this.cache = options.cache;
    this.repoApiUrl = options.repoApiUrl ?? "https://api.github.com/repos/orchestra-research/ai-research-skills";
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.indexTtlMs = options.indexTtlMs ?? 60 * 60 * 1000; // 1 hour
  }

  async search(query: AggregatorSearchQuery): Promise<AggregatorResult[]> {
    const limit = query.limit ?? 5;

    // Check cache first
    const cacheKey = AggregatorCache.makeKey(this.source, query.searchTerms);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached.slice(0, limit);
    }

    // Fetch or use cached skill index
    const skills = await this.getSkillIndex();
    if (skills.length === 0) {
      return [];
    }

    // Search skills against all query terms
    const results: AggregatorResult[] = [];
    const seen = new Set<string>();

    for (const term of query.searchTerms) {
      const termLower = term.toLowerCase();
      for (const skill of skills) {
        if (seen.has(skill.name)) continue;

        const nameMatch = skill.name.toLowerCase().includes(termLower);
        const descMatch = skill.description.toLowerCase().includes(termLower);
        const catMatch = skill.category.toLowerCase().includes(termLower);

        if (nameMatch || descMatch || catMatch) {
          seen.add(skill.name);
          const matchScore = this.computeScore(skill, term);
          results.push({
            source: this.source,
            name: skill.name,
            description: skill.description,
            installCommand: `npx @orchestra-research/ai-research-skills install ${skill.name}`,
            trustTier: this.trustTier,
            matchScore,
            category: "skill",
            popularity: skill.starCount,
            license: skill.license ?? "MIT",
          });
        }
      }
    }

    // Sort by match score descending
    results.sort((a, b) => b.matchScore - a.matchScore);

    // Cache the results
    this.cache.set(cacheKey, results, this.trustTier);

    return results.slice(0, limit);
  }

  getInstallCommand(result: AggregatorResult): string {
    return result.installCommand;
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Get the skill index, fetching from GitHub if stale.
   */
  private async getSkillIndex(): Promise<OrchestraSkill[]> {
    // Use cached index if fresh
    if (this.skillIndex !== null && Date.now() - this.indexFetchedAt < this.indexTtlMs) {
      return this.skillIndex;
    }

    try {
      // Fetch CLAUDE.md which contains the skill tree
      const url = `${this.repoApiUrl}/contents/CLAUDE.md`;
      const response = await this.fetchFn(url, {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        this._available = false;
        return this.skillIndex ?? [];
      }

      const data = await response.json() as GitHubFileContent;
      this._available = true;

      // Decode base64 content
      const content = data.content
        ? Buffer.from(data.content, "base64").toString("utf-8")
        : "";

      // Parse skill entries from CLAUDE.md
      this.skillIndex = this.parseSkillTree(content);
      this.indexFetchedAt = Date.now();
      return this.skillIndex;
    } catch {
      this._available = false;
      return this.skillIndex ?? [];
    }
  }

  /**
   * Parse the Orchestra Research CLAUDE.md for skill entries.
   * Expects a format like:
   *   - **skill-name**: Category — Description
   *   or sections with ### headers for categories.
   */
  private parseSkillTree(content: string): OrchestraSkill[] {
    const skills: OrchestraSkill[] = [];
    let currentCategory = "general";

    for (const line of content.split("\n")) {
      // Category headers: ### Category Name
      const categoryMatch = line.match(/^###\s+(.+)/);
      if (categoryMatch) {
        currentCategory = categoryMatch[1]!.trim();
        continue;
      }

      // Skill entries: - **skill-name**: Description
      // or: - `skill-name`: Description
      const skillMatch = line.match(/^[-*]\s+\*{0,2}`?([a-z0-9-]+)`?\*{0,2}\s*[:—–-]\s*(.+)/i);
      if (skillMatch) {
        const name = skillMatch[1]!;
        const description = skillMatch[2]!.trim();
        skills.push({
          name,
          category: currentCategory,
          description,
          path: `skills/${name}/SKILL.md`,
          starCount: 9300, // Known star count for the repo
          license: "MIT",
        });
      }
    }

    return skills;
  }

  /**
   * Compute match score for an Orchestra skill against a search term.
   */
  private computeScore(skill: OrchestraSkill, searchTerm: string): number {
    const nameSim = this.similarity(skill.name.toLowerCase(), searchTerm.toLowerCase());
    const descSim = this.similarity(skill.description.toLowerCase(), searchTerm.toLowerCase());

    return computeMatchScore({
      nameSimilarity: nameSim,
      descriptionSimilarity: descSim,
      trustTier: this.trustTier,
      installSimplicity: INSTALL_SIMPLICITY.npx_skill,
    });
  }

  /**
   * Simple Jaccard word-set similarity.
   */
  private similarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (a.length === 0 || b.length === 0) return 0.0;

    const wordsA = new Set(a.split(/[\s_-]+/).filter(Boolean));
    const wordsB = new Set(b.split(/[\s_-]+/).filter(Boolean));

    let intersection = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) intersection++;
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}