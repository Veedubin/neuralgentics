/**
 * Aggregator-Aware Lookup types — T-035 (P1-c-ext, Addendum 2).
 *
 * Defines the shared types for the 3-of-7 MVP aggregator lookup system:
 * Official MCP Registry, Orchestra Research, Internal Skills Directory.
 *
 * Per the design doc (v4-FINAL-ADDENDUM-2):
 * - Each aggregator implements Aggregator with search() + install() + trust check
 * - Results are scored by a 4-tier trust model
 * - Cache hits must be <100ms using in-memory LRU
 */

// ─── Aggregator Sources ──────────────────────────────────────────────────

/** The 3 MVP aggregator sources. v0.2.0 adds mcpservers.org, Anthropic, npm, PyPI. */
export type AggregatorSource =
  | "official_mcp_registry"
  | "orchestra_research"
  | "internal_skills_directory";

/** Human-readable labels for each aggregator source. */
export const AGGREGATOR_LABELS: Record<AggregatorSource, string> = {
  official_mcp_registry: "Official MCP Registry",
  orchestra_research: "Orchestra Research",
  internal_skills_directory: "Internal Skills Directory",
};

/** Trust tier mapping per Addendum 2 §6. */
export type TrustTier = 1 | 2 | 3 | 4;

/** Trust tier labels for display. */
export const TRUST_TIER_LABELS: Record<TrustTier, string> = {
  1: "Tier 1 \u2605\u2605\u2605 Highly Trusted",
  2: "Tier 2 \u2605\u2605\u2606 Community Vetted",
  3: "Tier 3 \u2605\u2606\u2606 Use With Caution",
  4: "Tier 4 \u2606\u2606\u2606 Build New",
};

/** Trust tier -> numeric score per Addendum 2 §6.2. */
export const TRUST_TIER_SCORES: Record<TrustTier, number> = {
  1: 1.0,
  2: 0.7,
  3: 0.4,
  4: 0.2,
};

/** Which trust tier each aggregator belongs to. */
export const AGGREGATOR_TRUST_TIERS: Record<AggregatorSource, TrustTier> = {
  official_mcp_registry: 1,
  orchestra_research: 1,
  internal_skills_directory: 1,
};

// ─── Aggregator Result ───────────────────────────────────────────────────

/** A single search result from an aggregator. */
export interface AggregatorResult {
  /** Which aggregator source produced this result. */
  source: AggregatorSource;
  /** Name of the tool/skill/package. */
  name: string;
  /** One-line description. */
  description: string;
  /** Version string (if available). */
  version?: string;
  /** Publisher/author (if available). */
  publisher?: string;
  /** Install command template (e.g. "npx -y @context7/mcp"). */
  installCommand: string;
  /** Trust tier of the source. */
  trustTier: TrustTier;
  /** Computed match score (0-1). */
  matchScore: number;
  /** Category (mcp_server, skill, package). */
  category: "mcp_server" | "skill" | "package";
  /** Star count or download count (if available). */
  popularity?: number;
  /** License (if available). */
  license?: string;
  /** Whether the user has previously installed this result. */
  previouslyInstalled?: boolean;
  /** Whether the user has previously rejected this result. */
  previouslyRejected?: boolean;
}

// ─── Search Query ────────────────────────────────────────────────────────

/** A search query sent to one or more aggregators. */
export interface AggregatorSearchQuery {
  /** The detected pattern type that triggered the search. */
  patternType: string;
  /** Human-readable description of the pattern. */
  patternDescription: string;
  /** Additional context (tool names, file paths, etc.). */
  context?: string;
  /** Search terms derived from the pattern (3-5 natural language queries). */
  searchTerms: string[];
  /** Maximum number of results per aggregator. */
  limit?: number;
}

// ─── Aggregator Interface ────────────────────────────────────────────────

/** The interface every aggregator must implement. */
export interface Aggregator {
  /** Unique identifier for this aggregator. */
  readonly source: AggregatorSource;
  /** Human-readable name. */
  readonly label: string;
  /** Trust tier of this aggregator. */
  readonly trustTier: TrustTier;
  /** Search for matching tools/skills/packages. */
  search(query: AggregatorSearchQuery): Promise<AggregatorResult[]>;
  /** Get the install command for a specific result. */
  getInstallCommand(result: AggregatorResult): string;
  /** Check if this aggregator is currently available. */
  isAvailable(): boolean;
}

// ─── Install Command Types ────────────────────────────────────────────────

/** Install command types per aggregator source. */
export type InstallType =
  | "npx_mcp"        // Add MCP config to opencode.json
  | "npx_skill"       // npx @orchestra-research/ai-research-skills install <skill>
  | "copy_skill"      // cp from internal skills directory
  | "bun_add"         // bun add <package>
  | "npm_install"     // npm install -g <package>
  | "uv_add"          // uv add <package>
  | "go_install";    // go install <package>@latest

/** MCP server configuration block (for opencode.json). */
export interface MCPConfig {
  /** Server name (key in mcpServers). */
  name: string;
  /** Command to run (e.g. "npx"). */
  command: string;
  /** Arguments (e.g. ["-y", "@context7/mcp"]). */
  args: string[];
  /** Environment variables (optional). */
  env?: Record<string, string>;
}

// ─── Cache Types ──────────────────────────────────────────────────────────

/** A cached aggregator search result. */
export interface CachedResult {
  /** The cache key (source + query hash). */
  key: string;
  /** The aggregator results. */
  results: AggregatorResult[];
  /** When this entry was cached (epoch ms). */
  cachedAt: number;
  /** TTL in ms (default varies by tier). */
  ttlMs: number;
}

/** Cache configuration per trust tier. */
export const CACHE_TTL_BY_TIER: Record<TrustTier, number> = {
  1: 7 * 24 * 60 * 60 * 1000,  // 7 days for Tier 1
  2: 24 * 60 * 60 * 1000,       // 24h for Tier 2
  3: 6 * 60 * 60 * 1000,        // 6h for Tier 3
  4: 0,                          // No cache for Tier 4 (build new)
};

// ─── Trust Event Types ────────────────────────────────────────────────────

/** Trust adjustment events recorded in memini-core. */
export type TrustSignal = "agent_used" | "agent_ignored" | "user_confirmed" | "user_corrected";

/** An install/reject event recorded for trust feedback. */
export interface TrustEvent {
  /** The result that was installed or rejected. */
  result: AggregatorResult;
  /** Whether the user installed (true) or rejected (false). */
  installed: boolean;
  /** Timestamp of the event. */
  timestamp: number;
  /** The trust signal to record. */
  signal: TrustSignal;
}

// ─── Match Scoring ────────────────────────────────────────────────────────

/**
 * Compute match score per Addendum 2 §3.3:
 * match_score = (name_similarity * 0.30)
 *             + (description_similarity * 0.40)
 *             + (trust_tier_score * 0.20)
 *             + (install_simplicity * 0.10)
 */
export function computeMatchScore(params: {
  nameSimilarity: number;
  descriptionSimilarity: number;
  trustTier: TrustTier;
  installSimplicity: number;
}): number {
  const trustScore = TRUST_TIER_SCORES[params.trustTier];
  return (
    params.nameSimilarity * 0.30
    + params.descriptionSimilarity * 0.40
    + trustScore * 0.20
    + params.installSimplicity * 0.10
  );
}

/** Install simplicity scores per Addendum 2 §3.3. */
export const INSTALL_SIMPLICITY: Record<InstallType, number> = {
  npx_mcp: 1.0,
  npx_skill: 0.9,
  copy_skill: 1.0,
  bun_add: 0.7,
  npm_install: 0.7,
  uv_add: 0.7,
  go_install: 0.4,
};

// ─── Orchestrator Types ───────────────────────────────────────────────────

/** Tier bucket for ranked results per Addendum 2 §3.1. */
export interface TierBucket {
  tier: TrustTier;
  label: string;
  results: AggregatorResult[];
}

/** Full lookup result from all aggregators. */
export interface AggregatorLookupResult {
  /** The search query that was used. */
  query: AggregatorSearchQuery;
  /** Results bucketed by trust tier. */
  tiers: TierBucket[];
  /** All results sorted by match score (descending). */
  allResults: AggregatorResult[];
  /** How many aggregators were searched. */
  aggregatorsSearched: number;
  /** How many results were found total. */
  totalResults: number;
  /** Cache hit info. */
  cacheHits: number;
  /** Time taken for the lookup in ms. */
  lookupTimeMs: number;
  /** Whether this was served from cache. */
  fromCache: boolean;
  /** Staleness warning (if cached results are old). */
  stalenessWarning?: string;
}