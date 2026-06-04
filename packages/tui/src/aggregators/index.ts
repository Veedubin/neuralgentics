/**
 * Aggregator-Aware Lookup — barrel export + AggregatorOrchestrator.
 * T-035 (P1-c-ext, Addendum 2).
 *
 * The orchestrator searches all 3 MVP aggregators in parallel,
 * merges results by trust tier, and provides centralized lookup.
 */

export { AggregatorCache } from "./cache.js";
export {
  OfficialMCPRegistryAggregator,
} from "./official-mcp-registry.js";
export {
  OrchestraResearchAggregator,
} from "./orchestra-research.js";
export {
  InternalSkillsDirectoryAggregator,
} from "./internal-skills-directory.js";
export { TrustChecker } from "./trust-checker.js";
export {
  generateInstallCommand,
  getInstallType,
  generateMCPConfig,
  getInstallSimplicity,
  formatResultDescription,
} from "./install-generator.js";
export {
  type AggregatorSource,
  type AggregatorResult,
  type AggregatorSearchQuery,
  type Aggregator,
  type TrustTier,
  type TrustSignal,
  type InstallType,
  type MCPConfig,
  type CachedResult,
  type TrustEvent,
  type TierBucket,
  type AggregatorLookupResult,
  AGGREGATOR_LABELS,
  AGGREGATOR_TRUST_TIERS,
  TRUST_TIER_LABELS,
  TRUST_TIER_SCORES,
  CACHE_TTL_BY_TIER,
  INSTALL_SIMPLICITY,
  computeMatchScore,
} from "./types.js";

import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import type {
  Aggregator,
  AggregatorResult,
  AggregatorSearchQuery,
  AggregatorLookupResult,
  TrustTier,
  TierBucket,
} from "./types.js";
import { TRUST_TIER_LABELS } from "./types.js";
import { AggregatorCache } from "./cache.js";
import { OfficialMCPRegistryAggregator } from "./official-mcp-registry.js";
import { OrchestraResearchAggregator } from "./orchestra-research.js";
import { InternalSkillsDirectoryAggregator } from "./internal-skills-directory.js";
import { TrustChecker } from "./trust-checker.js";

/**
 * AggregatorOrchestrator — searches all 3 MVP aggregators in parallel.
 *
 * Per Addendum 2 §3.1: aggregators are queried in parallel for speed.
 * Results are merged and bucketed by trust tier per §3.3 scoring.
 */
export class AggregatorOrchestrator {
  private readonly aggregators: Aggregator[];
  private readonly cache: AggregatorCache;
  private readonly trustChecker: TrustChecker;

  /**
   * @param options - Configuration options.
   * @param options.client - NeuralgenticsClient for trust adjustments (null for testing).
   * @param options.mcpRegistryUrl - Override MCP Registry URL (for testing).
   * @param options.orchestraUrl - Override Orchestra Research API URL (for testing).
   * @param options.skillsRoot - Override skills directory path (for testing).
   * @param options.fetchFn - Override fetch (for mocking in tests).
   * @param options.cacheSize - Maximum cache entries (default 500).
   */
  constructor(options?: {
    client?: NeuralgenticsClient | null;
    mcpRegistryUrl?: string;
    orchestraUrl?: string;
    skillsRoot?: string;
    fetchFn?: typeof globalThis.fetch;
    cacheSize?: number;
  }) {
    this.cache = new AggregatorCache(options?.cacheSize ?? 500);
    this.trustChecker = new TrustChecker(options?.client ?? null);

    this.aggregators = [
      new OfficialMCPRegistryAggregator({
        cache: this.cache,
        registryUrl: options?.mcpRegistryUrl,
        fetchFn: options?.fetchFn,
      }),
      new OrchestraResearchAggregator({
        cache: this.cache,
        repoApiUrl: options?.orchestraUrl,
        fetchFn: options?.fetchFn,
      }),
      new InternalSkillsDirectoryAggregator({
        cache: this.cache,
        skillsRoot: options?.skillsRoot,
      }),
    ];
  }

  /**
   * Search all aggregators in parallel for the given query.
   * Returns results bucketed by trust tier and sorted by match score.
   */
  async lookup(query: AggregatorSearchQuery): Promise<AggregatorLookupResult> {
    const startTime = Date.now();
    let cacheHits = 0;

    // Search all aggregators in parallel
    const searchPromises = this.aggregators.map(async (agg) => {
      try {
        return await agg.search(query);
      } catch {
        // Graceful degradation — skip failed aggregators
        return [];
      }
    });

    const searchResults = await Promise.all(searchPromises);

    // Merge all results
    const allResults: AggregatorResult[] = [];
    for (const results of searchResults) {
      allResults.push(...results);
    }

    // Sort by match score descending
    allResults.sort((a, b) => b.matchScore - a.matchScore);

    // Bucket by trust tier
    const tierMap = new Map<TrustTier, AggregatorResult[]>();
    for (const tier of [1, 2, 3, 4] as TrustTier[]) {
      tierMap.set(tier, []);
    }
    for (const result of allResults) {
      const bucket = tierMap.get(result.trustTier);
      if (bucket) {
        bucket.push(result);
      }
    }

    const tiers: TierBucket[] = [];
    for (const [tier, results] of tierMap) {
      if (results.length > 0) {
        tiers.push({
          tier,
          label: TRUST_TIER_LABELS[tier],
          results,
        });
      }
    }

    // Check for staleness warning
    const staleEntries = this.cache.getStaleEntries(7 * 24 * 60 * 60 * 1000);
    const stalenessWarning = staleEntries.length > 0
      ? `Aggregator index has ${staleEntries.length} stale entries (>${Math.round(staleEntries[0]!.ageMs / (24 * 60 * 60 * 1000))} days old). Results may be outdated. Run /opportunities --refresh to update.`
      : undefined;

    // Count available aggregators
    const availableAggregators = this.aggregators.filter((a) => a.isAvailable()).length;

    return {
      query,
      tiers,
      allResults,
      aggregatorsSearched: availableAggregators,
      totalResults: allResults.length,
      cacheHits,
      lookupTimeMs: Date.now() - startTime,
      fromCache: cacheHits > 0,
      stalenessWarning,
    };
  }

  /**
   * Record an install event (user chose to install a result).
   */
  async recordInstall(result: AggregatorResult): Promise<void> {
    await this.trustChecker.recordInstall(result);
  }

  /**
   * Record a reject event (user dismissed a result).
   */
  async recordReject(result: AggregatorResult): Promise<void> {
    await this.trustChecker.recordReject(result);
  }

  /**
   * Clear the cache (e.g. on /opportunities --refresh).
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Purge expired cache entries.
   */
  purgeExpired(): number {
    return this.cache.purgeExpired();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { hits: number; misses: number; hitRate: number; size: number } {
    return this.cache.getStats();
  }

  /**
   * Get the list of aggregators.
   */
  getAggregators(): Aggregator[] {
    return [...this.aggregators];
  }
}