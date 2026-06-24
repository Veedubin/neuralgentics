/**
 * Neuralgentics — Broker Client for Skills Brokering
 *
 * HTTP JSON-RPC client that calls the Go backend's broker.listSkills
 * method to retrieve the skill catalog filtered by role.
 *
 * Phase 1 limitation: The broker client communicates with the Go backend
 * via HTTP JSON-RPC. The backend must be accessible at the configured
 * endpoint (default: http://localhost:7000/jsonrpc). If the backend is
 * running via MCP stdio only, the StubBrokerClient can be used in tests
 * and an HTTP bridge can be added later.
 */

// ============================================================================
// Types
// ============================================================================

/** Summary of a skill returned by the broker catalog. */
export interface BrokerSkillSummary {
  /** Skill name (from SKILL.md front-matter). */
  name: string;
  /** Skill description (from SKILL.md front-matter). */
  description: string;
  /** Source of the skill: "local" or "external" (Phase 1: always "local"). */
  source: string;
  /** Tags merged from YAML baseline + SKILL.md front-matter. */
  tags: string[];
  /** Relative path to the SKILL.md file from workspace root. */
  path: string;
  /** File size of the SKILL.md in bytes. */
  size_bytes: number;
  /** Agent roles this skill is visible to. */
  agent_scope: string[];
}

/** Response from broker.listSkills — the full skill catalog for a role. */
export interface SkillCatalogResponse {
  /** List of skills visible to the requested role. */
  skills: BrokerSkillSummary[];
  /** Total number of skills in the catalog. */
  total_skills: number;
  /** The role this catalog was built for. */
  role: string;
  /** Source identifier (e.g., "local" for filesystem-based skills). */
  source: string;
}

// ============================================================================
// BrokerClient Interface
// ============================================================================

/**
 * BrokerClient — interface for calling the skills broker.
 *
 * Implementations can use HTTP JSON-RPC (HttpBrokerClient) or
 * return canned data (StubBrokerClient) for testing.
 */
export interface BrokerClient {
  /**
   * List skills available to the given role.
   *
   * @param role — Agent role (e.g., "orchestrator", "coder").
   *               Empty string returns all skills.
   * @returns Skill catalog filtered by role.
   */
  listSkills(role: string): Promise<SkillCatalogResponse>;
}

// ============================================================================
// HttpBrokerClient — Real Implementation
// ============================================================================

/** Default endpoint for the Go backend's JSON-RPC handler. */
export const DEFAULT_BROKER_ENDPOINT = "http://localhost:7000/jsonrpc";

/**
 * HttpBrokerClient — HTTP JSON-RPC client for the Go backend.
 *
 * Sends broker.listSkills requests over HTTP POST to the configured
 * endpoint and returns the parsed SkillCatalogResponse.
 */
export class HttpBrokerClient implements BrokerClient {
  private readonly endpoint: string;

  constructor(endpoint: string = DEFAULT_BROKER_ENDPOINT) {
    this.endpoint = endpoint;
  }

  async listSkills(role: string): Promise<SkillCatalogResponse> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "broker.listSkills",
        params: { role },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `broker.listSkills HTTP ${res.status}: ${res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      result?: SkillCatalogResponse;
      error?: { code: number; message: string };
    };

    if (data.error) {
      throw new Error(
        `broker.listSkills: ${data.error.message} (code ${data.error.code})`,
      );
    }

    if (!data.result) {
      throw new Error("broker.listSkills: no result in response");
    }

    return data.result;
  }
}

// ============================================================================
// StubBrokerClient — Test Implementation
// ============================================================================

/**
 * StubBrokerClient — returns a configurable catalog for testing.
 *
 * Useful for unit tests that don't require a running broker backend.
 * By default returns an empty catalog.
 */
export class StubBrokerClient implements BrokerClient {
  private readonly catalog: SkillCatalogResponse;

  constructor(catalog?: SkillCatalogResponse) {
    this.catalog = catalog ?? {
      skills: [],
      total_skills: 0,
      role: "orchestrator",
      source: "stub",
    };
  }

  async listSkills(_role: string): Promise<SkillCatalogResponse> {
    return this.catalog;
  }
}
