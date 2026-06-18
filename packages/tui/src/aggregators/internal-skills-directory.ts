/**
 * Internal Skills Directory Aggregator - T-035 (P1-c-ext).
 *
 * Reads local skill SKILL.md files from the project's .opencode/skills/ directory.
 * Per Addendum 2 section 2.1: Local filesystem glob of SKILL.md files in skills subdirs.
 * Trust Tier: 1 (We built them, we trust them)
 *
 * This aggregator uses real filesystem reads (no HTTP) and is always available.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Aggregator, AggregatorResult, AggregatorSearchQuery } from "./types.js";
import { AGGREGATOR_TRUST_TIERS, AGGREGATOR_LABELS, computeMatchScore, INSTALL_SIMPLICITY } from "./types.js";
import { AggregatorCache } from "./cache.js";

/** Parsed skill entry from the local filesystem. */
interface InternalSkill {
  name: string;
  description: string;
  category: string;
  path: string;
}

/**
 * Internal Skills Directory aggregator.
 *
 * Reads SKILL.md files from the .opencode/skills/ subdirectories.
 * This aggregator is always available (uses local filesystem, not HTTP).
 */
export class InternalSkillsDirectoryAggregator implements Aggregator {
  readonly source = "internal_skills_directory" as const;
  readonly label = AGGREGATOR_LABELS["internal_skills_directory"];
  readonly trustTier = AGGREGATOR_TRUST_TIERS["internal_skills_directory"];

  private readonly skillsRoot: string;
  private readonly cache: AggregatorCache;
  private skillIndex: InternalSkill[] | null = null;
  private indexFetchedAt = 0;
  private readonly indexTtlMs: number;

  /**
   * @param options - Configuration options.
   * @param options.cache - Shared cache instance.
   * @param options.skillsRoot - Path to the skills directory (default: ".opencode/skills").
   * @param options.indexTtlMs - How long to cache the skill index (default 5 minutes).
   */
  constructor(options: {
    cache: AggregatorCache;
    skillsRoot?: string;
    indexTtlMs?: number;
  }) {
    this.cache = options.cache;
    this.skillsRoot = options.skillsRoot ?? (
      // Self-contained install: skills live in the install prefix
      process.env.NEURALGENTICS_INSTALL_PREFIX
        ? join(process.env.NEURALGENTICS_INSTALL_PREFIX, ".opencode", "skills")
        : join(process.cwd(), ".opencode", "skills")
    );
    this.indexTtlMs = options.indexTtlMs ?? 5 * 60 * 1000; // 5 minutes
  }

  async search(query: AggregatorSearchQuery): Promise<AggregatorResult[]> {
    const limit = query.limit ?? 5;

    // Check cache first
    const cacheKey = AggregatorCache.makeKey(this.source, query.searchTerms);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached.slice(0, limit);
    }

    // Build skill index from filesystem
    const skills = await this.buildSkillIndex();
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
            installCommand: `cp -r ${skill.path} .opencode/skills/${skill.name}/`,
            trustTier: this.trustTier,
            matchScore,
            category: "skill",
            license: "internal",
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
    // Internal skills are copied from source to user's skills dir
    return `cp -r ${this.skillsRoot}/${result.name}/ .opencode/skills/${result.name}/`;
  }

  isAvailable(): boolean {
    // Internal skills directory is always available (local filesystem)
    return true;
  }

  /**
   * Build the skill index by reading SKILL.md files from the local directory.
   */
  private async buildSkillIndex(): Promise<InternalSkill[]> {
    // Use cached index if fresh
    if (this.skillIndex !== null && Date.now() - this.indexFetchedAt < this.indexTtlMs) {
      return this.skillIndex;
    }

    try {
      const entries = await readdir(this.skillsRoot, { withFileTypes: true });
      const skills: InternalSkill[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(this.skillsRoot, entry.name);
        const skillMdPath = join(skillDir, "SKILL.md");

        try {
          const content = await readFile(skillMdPath, "utf-8");
          const parsed = this.parseSkillMd(content, entry.name);
          skills.push(parsed);
        } catch {
          // Skip skills without SKILL.md files
          continue;
        }
      }

      this.skillIndex = skills;
      this.indexFetchedAt = Date.now();
      return skills;
    } catch {
      // Directory might not exist — return empty
      this.skillIndex = [];
      this.indexFetchedAt = Date.now();
      return [];
    }
  }

  /**
   * Parse a SKILL.md file for name, description, and category.
   * Expects standard Markdown format with a title line and description.
   */
  private parseSkillMd(content: string, dirName: string): InternalSkill {
    const lines = content.split("\n");
    let name = dirName;
    let description = "";
    let category = "general";

    // Extract name from first # heading
    for (const line of lines) {
      const headingMatch = line.match(/^#\s+(.+)/);
      if (headingMatch) {
        name = headingMatch[1]!.trim();
        break;
      }
    }

    // Extract description from the first non-empty, non-heading paragraph
    let foundHeading = false;
    for (const line of lines) {
      if (line.startsWith("#")) {
        foundHeading = true;
        continue;
      }
      if (foundHeading && line.trim().length > 0 && !line.startsWith("|") && !line.startsWith("-")) {
        description = line.trim();
        break;
      }
    }

    // If no description found, use a default
    if (description.length === 0) {
      description = `Internal skill: ${name}`;
    }

    // Extract category from directory name patterns (e.g. "boomerang-coder" -> "boomerang")
    const dashIndex = name.indexOf("-");
    if (dashIndex > 0) {
      category = name.substring(0, dashIndex);
    }

    return {
      name,
      description,
      category,
      path: join(this.skillsRoot, dirName),
    };
  }

  /**
   * Compute match score for an internal skill against a search term.
   */
  private computeScore(skill: InternalSkill, searchTerm: string): number {
    const nameSim = this.similarity(skill.name.toLowerCase(), searchTerm.toLowerCase());
    const descSim = this.similarity(skill.description.toLowerCase(), searchTerm.toLowerCase());

    return computeMatchScore({
      nameSimilarity: nameSim,
      descriptionSimilarity: descSim,
      trustTier: this.trustTier,
      installSimplicity: INSTALL_SIMPLICITY.copy_skill,
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