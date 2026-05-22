/**
 * Neuralgentics — MemoryAdapter
 *
 * HTTP JSON adapter that calls the Python memini-core server.
 * No MCP imports — uses plain fetch() for all communication.
 */

// ============================================================================
// Local Types (avoids circular workspace dependency at build time)
// ============================================================================

export type MemorySourceType = 'session' | 'file' | 'web' | 'boomerang' | 'project';

export interface Memory {
  id: string;
  content: string;
  sourceType: MemorySourceType;
  sourcePath?: string;
  timestamp: string;
  trustScore?: number;
  metadata?: Record<string, unknown>;
}

export type RelationshipType = 'SUPERSEDES' | 'RELATED_TO' | 'CONTRADICTS' | 'DERIVED_FROM';

export interface Relationship {
  targetId: string;
  relationshipType: RelationshipType;
  confidence: number;
}

export interface MemoryAdapterConfig {
  /** Base URL of the Python HTTP memory server (default: http://localhost:8900) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

interface MemoryResponse {
  memories: MemoryApiResponse[];
}

interface MemoryApiResponse {
  id: string;
  content: string;
  source_type: string;
  source_path?: string;
  timestamp: string;
  trust_score?: number;
  metadata?: Record<string, unknown>;
}

interface AddMemoryResponse {
  id: string;
}

interface TrustResponse {
  trust_score: number;
  trust_level: string;
}

interface RelationshipResponse {
  relationships: RelationshipApiResponse[];
}

interface RelationshipApiResponse {
  target_id: string;
  relationship_type: string;
  confidence: number;
}

interface TieredSummaryResponse {
  content: string;
  memory_count: number;
  trust_average: number;
  generated_at: string;
}

/**
 * Convert snake_case API response to camelCase Memory type.
 */
function toMemory(api: MemoryApiResponse): Memory {
  return {
    id: api.id,
    content: api.content,
    sourceType: api.source_type as MemorySourceType,
    sourcePath: api.source_path,
    timestamp: api.timestamp,
    trustScore: api.trust_score,
    metadata: api.metadata,
  };
}

/**
 * Convert snake_case API response to Relationship type.
 */
function toRelationship(api: RelationshipApiResponse): Relationship {
  return {
    targetId: api.target_id,
    relationshipType: api.relationship_type as Relationship['relationshipType'],
    confidence: api.confidence,
  };
}

/**
 * MemoryAdapter — HTTP JSON client for the Python memini-core server.
 *
 * All communication is via plain HTTP fetch() calls.
 * No MCP protocol, no stdio transport, no SDK dependency.
 */
export class MemoryAdapter {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config?: MemoryAdapterConfig) {
    this.baseUrl = config?.baseUrl ?? 'http://localhost:8900';
    this.timeoutMs = config?.timeoutMs ?? 10000;
  }

  /**
   * Query memories by semantic search.
   */
  async queryMemories(query: string, limit?: number): Promise<Memory[]> {
    const params = new URLSearchParams({ query });
    if (limit) params.set('limit', String(limit));

    const response = await this.fetchJson<MemoryResponse>(
      `GET`,
      `/api/v1/memories?${params.toString()}`
    );

    return (response.memories ?? []).map(toMemory);
  }

  /**
   * Add a new memory entry.
   * Returns the ID of the created memory.
   */
  async addMemory(
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const response = await this.fetchJson<AddMemoryResponse>('POST', '/api/v1/memories', {
      content,
      source_type: 'boomerang',
      metadata: metadata ?? {},
    });

    return response.id;
  }

  /**
   * Adjust trust score for a memory by signal.
   */
  async adjustTrust(id: string, signal: string): Promise<void> {
    await this.fetchJson<unknown>('POST', `/api/v1/memories/${id}/trust`, {
      signal,
    });
  }

  /**
   * Get related memories for a given memory ID.
   */
  async getRelatedMemories(id: string): Promise<Relationship[]> {
    const response = await this.fetchJson<RelationshipResponse>(
      'GET',
      `/api/v1/memories/${id}/relationships`
    );

    return (response.relationships ?? []).map(toRelationship);
  }

  /**
   * Get the L0 project summary (~100 tokens).
   */
  async getTier0Summary(): Promise<string | null> {
    try {
      const response = await this.fetchJson<TieredSummaryResponse>(
        'GET',
        '/api/v1/summary/tier0'
      );
      return response.content ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get the L1 key decisions summary (~2K tokens).
   */
  async getTier1Summary(): Promise<string | null> {
    try {
      const response = await this.fetchJson<TieredSummaryResponse>(
        'GET',
        '/api/v1/summary/tier1'
      );
      return response.content ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if the memory server is healthy.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/status`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — HTTP helper
  // ---------------------------------------------------------------------------

  private async fetchJson<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(
        `MemoryAdapter HTTP ${response.status}: ${path} — ${errorBody}`
      );
    }

    return response.json() as Promise<T>;
  }
}