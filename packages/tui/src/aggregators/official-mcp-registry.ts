/**
 * Official MCP Registry Aggregator — T-035 (P1-c-ext).
 *
 * Searches the Official MCP Registry at registry.modelcontextprotocol.io.
 * Per Addendum 2 §2.1: REST API at GET registry.modelcontextprotocol.io/v0.1/servers?search=<query>
 * Trust Tier: 1 (Official, authenticated namespaces, Linux Foundation-hosted)
 */

import type { Aggregator, AggregatorResult, AggregatorSearchQuery } from "./types.js";
import { AGGREGATOR_TRUST_TIERS, AGGREGATOR_LABELS, computeMatchScore, INSTALL_SIMPLICITY } from "./types.js";
import { AggregatorCache } from "./cache.js";

/** Registry API response entry (simplified). */
interface RegistryServer {
  name: string;
  description: string;
  version?: string;
  status?: string;
  publisher?: string;
  install_command?: string;
}

/** Registry API response. */
interface RegistryResponse {
  servers: RegistryServer[];
  total?: number;
}

/**
 * Official MCP Registry aggregator.
 *
 * Searches registry.modelcontextprotocol.io for MCP servers.
 * In production, makes real HTTP calls. In tests, inject a mock via `fetchFn`.
 */
export class OfficialMCPRegistryAggregator implements Aggregator {
  readonly source = "official_mcp_registry" as const;
  readonly label = AGGREGATOR_LABELS["official_mcp_registry"];
  readonly trustTier = AGGREGATOR_TRUST_TIERS["official_mcp_registry"];

  private readonly registryUrl: string;
  private readonly cache: AggregatorCache;
  private readonly fetchFn: typeof globalThis.fetch;
  private _available = true;

  /**
   * @param options - Configuration options.
   * @param options.cache - Shared cache instance.
   * @param options.registryUrl - Override the registry URL (for testing).
   * @param options.fetchFn - Override fetch (for mocking in tests).
   */
  constructor(options: {
    cache: AggregatorCache;
    registryUrl?: string;
    fetchFn?: typeof globalThis.fetch;
  }) {
    this.cache = options.cache;
    this.registryUrl = options.registryUrl ?? "https://registry.modelcontextprotocol.io/v0.1";
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async search(query: AggregatorSearchQuery): Promise<AggregatorResult[]> {
    const limit = query.limit ?? 5;

    // Check cache first
    const cacheKey = AggregatorCache.makeKey(this.source, query.searchTerms);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached.slice(0, limit);
    }

    // Search all terms, deduplicate results
    const allResults = new Map<string, AggregatorResult>();

    for (const term of query.searchTerms) {
      try {
        const results = await this.searchTerm(term, limit);
        for (const result of results) {
          if (!allResults.has(result.name)) {
            allResults.set(result.name, result);
          }
        }
      } catch {
        // Skip failed terms — graceful degradation
        this._available = false;
      }
    }

    const results = Array.from(allResults.values());

    // Cache the combined results
    this.cache.set(cacheKey, results, this.trustTier);

    return results.slice(0, limit);
  }

  getInstallCommand(result: AggregatorResult): string {
    // MCP server config block for opencode.json
    const config = {
      command: "npx",
      args: ["-y", result.installCommand],
    };
    return JSON.stringify(config, null, 2);
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Search for a single term against the registry API.
   */
  private async searchTerm(term: string, limit: number): Promise<AggregatorResult[]> {
    const url = `${this.registryUrl}/servers?search=${encodeURIComponent(term)}&size=${limit}`;

    const response = await this.fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    if (!response.ok) {
      this._available = false;
      return [];
    }

    const data = await response.json() as RegistryResponse;
    this._available = true;

    return (data.servers ?? []).map((server) => this.toResult(server, term));
  }

  /**
   * Convert a registry server entry to an AggregatorResult.
   */
  private toResult(server: RegistryServer, searchTerm: string): AggregatorResult {
    const nameSimilarity = this.similarity(server.name.toLowerCase(), searchTerm.toLowerCase());
    const descriptionSimilarity = this.similarity(
      (server.description ?? "").toLowerCase(),
      searchTerm.toLowerCase(),
    );

    const matchScore = computeMatchScore({
      nameSimilarity,
      descriptionSimilarity,
      trustTier: this.trustTier,
      installSimplicity: INSTALL_SIMPLICITY.npx_mcp,
    });

    return {
      source: this.source,
      name: server.name,
      description: server.description ?? "",
      version: server.version,
      publisher: server.publisher,
      installCommand: server.install_command ?? server.name,
      trustTier: this.trustTier,
      matchScore,
      category: "mcp_server",
    };
  }

  /**
   * Simple string similarity using Jaccard coefficient on word sets.
   * Good enough for MVP — v0.2.0 can use embedding-based similarity.
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