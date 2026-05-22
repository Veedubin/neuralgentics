/**
 * Neuralgentics — Plugin MemoryAdapter Tests
 *
 * Tests the MemoryAdapter HTTP JSON client.
 * Mocks global fetch to avoid needing a running server.
 *
 * Uses bun:test mocks.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// ============================================================================
// Types mirroring the adapter (avoids import of actual source in some contexts)
// ============================================================================

interface Memory {
  id: string;
  content: string;
  sourceType: string;
  sourcePath?: string;
  timestamp: string;
  trustScore?: number;
  metadata?: Record<string, unknown>;
}

interface Relationship {
  targetId: string;
  relationshipType: string;
  confidence: number;
}

// ============================================================================
// Mock fetch responses
// ============================================================================

const MOCK_MEMORIES_RESPONSE = {
  memories: [
    {
      id: 'mem-001',
      content: 'test memory content',
      source_type: 'session',
      source_path: null,
      timestamp: '2025-01-01T00:00:00Z',
      trust_score: 0.5,
      metadata: {},
    },
    {
      id: 'mem-002',
      content: 'another memory',
      source_type: 'project',
      source_path: '/path/to/file.ts',
      timestamp: '2025-01-02T00:00:00Z',
      trust_score: 0.85,
      metadata: { type: 'code' },
    },
  ],
};

const MOCK_ADD_RESPONSE = { id: 'mem-new-001' };

const MOCK_RELATIONSHIPS_RESPONSE = {
  relationships: [
    { target_id: 'mem-002', relationship_type: 'RELATED_TO', confidence: 0.9 },
  ],
};

const MOCK_TIER0_RESPONSE = {
  content: 'Project summary: neuralgentics...',
  memory_count: 10,
  trust_average: 0.65,
  generated_at: '2025-01-01T00:00:00Z',
};

const MOCK_TIER1_RESPONSE = {
  content: 'Key decisions: use HTTP JSON...',
  memory_count: 5,
  trust_average: 0.85,
  generated_at: '2025-01-01T00:00:00Z',
};

const MOCK_STATUS_OK = { status: 'ok' };

// ============================================================================
// Helper to create a mock Response
// ============================================================================

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('MemoryAdapter', () => {
  let MemoryAdapterClass: any;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(async () => {
    // Create a mock function for fetch
    fetchMock = mock(() => mockResponse({ memories: [] }));

    // Replace global fetch with our mock
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    // Import the module fresh
    const mod = await import('../packages/plugin/src/adapters/memory');
    MemoryAdapterClass = mod.MemoryAdapter;
  });

  afterEach(() => {
    // Restore fetch if we need to — bun handles cleanup
  });

  describe('constructor', () => {
    it('should use default baseUrl when no config provided', () => {
      const adapter = new MemoryAdapterClass();
      expect(adapter).toBeDefined();
    });

    it('should accept custom baseUrl', () => {
      const adapter = new MemoryAdapterClass({ baseUrl: 'http://custom:9999' });
      expect(adapter).toBeDefined();
    });
  });

  describe('queryMemories', () => {
    it('should return an array of Memory objects', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_MEMORIES_RESPONSE));

      const adapter = new MemoryAdapterClass();
      const results: Memory[] = await adapter.queryMemories('test query');

      expect(results).toBeArray();
      expect(results.length).toBe(2);
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('content');
      expect(results[0]).toHaveProperty('sourceType');
      expect(results[0].content).toBe('test memory content');
      expect(results[0].sourceType).toBe('session');
    });

    it('should return empty array when memories field is missing', async () => {
      fetchMock.mockImplementation(() => mockResponse({}));

      const adapter = new MemoryAdapterClass();
      const results: Memory[] = await adapter.queryMemories('empty');
      expect(results).toBeArray();
      expect(results.length).toBe(0);
    });

    it('should convert snake_case to camelCase', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_MEMORIES_RESPONSE));

      const adapter = new MemoryAdapterClass();
      const results: Memory[] = await adapter.queryMemories('test');
      expect(results[0].sourceType).toBe('session');
      expect(results[0].trustScore).toBe(0.5);
      expect(results[1].sourceType).toBe('project');
      expect(results[1].trustScore).toBe(0.85);
    });

    it('should include limit parameter in request URL', async () => {
      fetchMock.mockImplementation(() => mockResponse({ memories: [] }));

      const adapter = new MemoryAdapterClass();
      await adapter.queryMemories('test', 5);

      const calledUrl: string = fetchMock.mock.calls[0][0];
      expect(calledUrl).toContain('query=test');
      expect(calledUrl).toContain('limit=5');
    });
  });

  describe('addMemory', () => {
    it('should return a string ID', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_ADD_RESPONSE));

      const adapter = new MemoryAdapterClass();
      const id: string = await adapter.addMemory('new memory');

      expect(id).toBeString();
      expect(id).toBe('mem-new-001');
    });

    it('should POST with content and default source_type', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_ADD_RESPONSE));

      const adapter = new MemoryAdapterClass();
      await adapter.addMemory('hello world');

      const callOptions: RequestInit = fetchMock.mock.calls[0][1];
      expect(callOptions.method || '').toBe('POST');
      const headers = callOptions.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(callOptions.body as string);
      expect(body.content).toBe('hello world');
      expect(body.source_type).toBe('boomerang');
      expect(body.metadata).toBeDefined();
    });

    it('should include metadata when provided', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_ADD_RESPONSE));

      const adapter = new MemoryAdapterClass();
      await adapter.addMemory('with metadata', { key: 'value', count: 42 });

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.metadata.key).toBe('value');
      expect(body.metadata.count).toBe(42);
    });
  });

  describe('adjustTrust', () => {
    it('should POST to the trust endpoint', async () => {
      fetchMock.mockImplementation(() => mockResponse({}));

      const adapter = new MemoryAdapterClass();
      await adapter.adjustTrust('mem-001', 'user_confirmed');

      const url: string = fetchMock.mock.calls[0][0];
      expect(url).toContain('/api/v1/memories/mem-001/trust');

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.signal).toBe('user_confirmed');
    });
  });

  describe('getRelatedMemories', () => {
    it('should return an array of Relationship objects', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_RELATIONSHIPS_RESPONSE));

      const adapter = new MemoryAdapterClass();
      const relationships: Relationship[] =
        await adapter.getRelatedMemories('mem-001');

      expect(relationships).toBeArray();
      expect(relationships.length).toBe(1);
      expect(relationships[0].targetId).toBe('mem-002');
      expect(relationships[0].relationshipType).toBe('RELATED_TO');
      expect(relationships[0].confidence).toBe(0.9);
    });

    it('should return empty array when no relationships', async () => {
      fetchMock.mockImplementation(() => mockResponse({ relationships: [] }));

      const adapter = new MemoryAdapterClass();
      const relationships: Relationship[] =
        await adapter.getRelatedMemories('mem-003');
      expect(relationships).toBeArray();
      expect(relationships.length).toBe(0);
    });
  });

  describe('getTier0Summary', () => {
    it('should return summary content string', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_TIER0_RESPONSE));

      const adapter = new MemoryAdapterClass();
      const summary = await adapter.getTier0Summary();
      expect(summary).toBeString();
      expect(summary).toContain('Project summary');
    });

    it('should return null on fetch failure', async () => {
      fetchMock.mockImplementation(() => {
        throw new Error('Network error');
      });

      const adapter = new MemoryAdapterClass();
      const summary = await adapter.getTier0Summary();
      expect(summary).toBeNull();
    });
  });

  describe('getTier1Summary', () => {
    it('should return summary content string', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_TIER1_RESPONSE));

      const adapter = new MemoryAdapterClass();
      const summary = await adapter.getTier1Summary();
      expect(summary).toBeString();
      expect(summary).toContain('Key decisions');
    });

    it('should return null on fetch failure', async () => {
      fetchMock.mockImplementation(() => {
        throw new Error('Timeout');
      });

      const adapter = new MemoryAdapterClass();
      const summary = await adapter.getTier1Summary();
      expect(summary).toBeNull();
    });
  });

  describe('isHealthy', () => {
    it('should return true when status endpoint returns ok', async () => {
      fetchMock.mockImplementation(() => mockResponse(MOCK_STATUS_OK));

      const adapter = new MemoryAdapterClass();
      const healthy = await adapter.isHealthy();
      expect(healthy).toBeTrue();
    });

    it('should return false when fetch fails', async () => {
      fetchMock.mockImplementation(() => {
        throw new Error('Connection refused');
      });

      const adapter = new MemoryAdapterClass();
      const healthy = await adapter.isHealthy();
      expect(healthy).toBeFalse();
    });
  });

  describe('error handling', () => {
    it('should throw on non-ok HTTP status', async () => {
      fetchMock.mockImplementation(() =>
        new Response('Not Found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      const adapter = new MemoryAdapterClass();
      expect(adapter.queryMemories('fail')).rejects.toThrow('HTTP 404');
    });

    it('should include the path in error messages', async () => {
      fetchMock.mockImplementation(() =>
        new Response('Server Error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      const adapter = new MemoryAdapterClass();
      expect(adapter.queryMemories('fail')).rejects.toThrow(
        '/api/v1/memories',
      );
    });
  });

  describe('camelCase conversion consistency', () => {
    it('should properly convert all snake_case fields from query', async () => {
      const response = {
        memories: [
          {
            id: 'm1',
            content: 'test',
            source_type: 'file',
            source_path: '/path/to/file.py',
            timestamp: '2025-01-01T00:00:00Z',
            trust_score: 0.75,
            metadata: { lines: 100 },
          },
        ],
      };

      fetchMock.mockImplementation(() => mockResponse(response));

      const adapter = new MemoryAdapterClass();
      const results: Memory[] = await adapter.queryMemories('test');

      expect(results[0].sourceType).toBe('file');
      expect(results[0].sourcePath).toBe('/path/to/file.py');
      expect(results[0].trustScore).toBe(0.75);
    });
  });
});
