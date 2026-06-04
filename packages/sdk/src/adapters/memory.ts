/**
 * Boomerang SDK — Memory Adapter
 *
 * Wraps the MemoryAdapter pattern from @neuralgentics/plugin with
 * SDK-level retry logic, typed results, and convenience methods.
 * Connects to memini-core on port 8900 via HTTP JSON.
 */

import type { MemoryConfig, SdkResult, TrustSignal } from '../types.js';
import { DEFAULT_RETRY_CONFIG } from '../utils.js';
import type { RetryConfig } from '../types.js';
import { withRetry, tryOperation } from '../utils.js';

// ============================================================================
// Local Memory Types (matching the server schema)
// ============================================================================

export interface Memory {
  id: string;
  content: string;
  sourceType: string;
  sourcePath?: string;
  timestamp: string;
  trustScore?: number;
  metadata?: Record<string, unknown>;
}

export interface Relationship {
  targetId: string;
  relationshipType: string;
  confidence: number;
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

interface QueryResponse {
  memories: MemoryApiResponse[];
}

interface AddResponse {
  id: string;
}

interface TieredSummaryResponse {
  content: string;
  memory_count: number;
  trust_average: number;
  generated_at: string;
}

function toMemory(api: MemoryApiResponse): Memory {
  return {
    id: api.id,
    content: api.content,
    sourceType: api.source_type,
    sourcePath: api.source_path,
    timestamp: api.timestamp,
    trustScore: api.trust_score,
    metadata: api.metadata,
  };
}

// ============================================================================
// Memory Adapter
// ============================================================================

/**
 * SDK-level Memory Adapter with retry logic and typed results.
 *
 * Connects to the memini-core HTTP server (default: http://localhost:8900).
 * All operations use automatic retry with exponential backoff for
 * transient network errors.
 */
export class MemoryAdapter {
  private baseUrl: string;
  private timeoutMs: number;
  private retryConfig: RetryConfig;

  constructor(config: MemoryConfig, retryConfig?: Partial<RetryConfig>) {
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * Query memories by semantic search with retry.
   */
  async queryMemories(query: string, limit?: number): Promise<Memory[]> {
    const params = new URLSearchParams({ query });
    if (limit) params.set('limit', String(limit));

    return withRetry(
      async () => {
        const response = await this.fetchJson<QueryResponse>(
          'GET',
          `/api/v1/memories?${params.toString()}`
        );
        return (response.memories ?? []).map(toMemory);
      },
      this.retryConfig
    );
  }

  /**
   * Add a new memory with retry.
   */
  async addMemory(content: string, metadata?: Record<string, unknown>): Promise<SdkResult<string>> {
    return tryOperation(async () => {
      const response = await withRetry(
        () =>
          this.fetchJson<AddResponse>('POST', '/api/v1/memories', {
            content,
            source_type: 'boomerang',
            metadata: metadata ?? {},
          }),
        this.retryConfig
      );
      return response.id;
    });
  }

  /**
   * Adjust trust score by signal with retry.
   */
  async adjustTrust(id: string, signal: TrustSignal): Promise<SdkResult<void>> {
    return tryOperation(async () => {
      await withRetry(
        () => this.fetchJson<unknown>('POST', `/api/v1/memories/${id}/trust`, { signal }),
        this.retryConfig
      );
    });
  }

  /**
   * Get related memories with retry.
   */
  async getRelatedMemories(id: string): Promise<Relationship[]> {
    return withRetry(async () => {
      const response = await this.fetchJson<{ relationships: Array<{ target_id: string; relationship_type: string; confidence: number }> }>(
        'GET',
        `/api/v1/memories/${id}/relationships`
      );
      return (response.relationships ?? []).map((r) => ({
        targetId: r.target_id,
        relationshipType: r.relationship_type,
        confidence: r.confidence,
      }));
    }, this.retryConfig);
  }

  /**
   * Get L0 project summary (~100 tokens).
   */
  async getTier0Summary(): Promise<string | null> {
    try {
      const response = await withRetry(
        () => this.fetchJson<TieredSummaryResponse>('GET', '/api/v1/summary/tier0'),
        this.retryConfig
      );
      return response.content ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get L1 key decisions summary (~2K tokens).
   */
  async getTier1Summary(): Promise<string | null> {
    try {
      const response = await withRetry(
        () => this.fetchJson<TieredSummaryResponse>('GET', '/api/v1/summary/tier1'),
        this.retryConfig
      );
      return response.content ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Health check — is the memory server responsive?
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
  // Private
  // ---------------------------------------------------------------------------

  private async fetchJson<T>(method: string, path: string, body?: unknown): Promise<T> {
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
      throw new Error(`MemoryAdapter HTTP ${response.status}: ${path} — ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }
}