/**
 * Neuralgentics — Stateless Agent Architecture Tests
 *
 * Tests for the stateless dispatch protocol, memory operations,
 * seed prompt generation, and type guards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Types Tests
// ============================================================================

import type {
  ContextPackageMetadata,
  AgentWrapUpMetadata,
  SeedPrompt,
  StatelessTaskResult,
  AgentWrapUp,
  StatelessOrchestrationResult,
  MemorySourceType,
} from './types.js';

describe('Stateless Types', () => {
  it('should accept valid ContextPackageMetadata', () => {
    const meta: ContextPackageMetadata = {
      taskType: 'code-implementation',
      agentRole: 'coder',
      taskId: 'task_abc123',
      parentMemoryId: null,
      createdAt: '2026-05-22T23:00:00Z',
      project: 'neuralgentics',
      version: '1.0',
    };
    expect(meta.taskType).toBe('code-implementation');
    expect(meta.parentMemoryId).toBeNull();
  });

  it('should accept ContextPackageMetadata with contextMemoryId', () => {
    const meta: ContextPackageMetadata = {
      taskType: 'architecture-design',
      agentRole: 'architect',
      taskId: 'task_def456',
      contextMemoryId: 'mem_cp_001',
      parentMemoryId: 'mem_parent_999',
      createdAt: '2026-05-22T23:05:00Z',
      project: 'neuralgentics',
      version: '1.0',
    };
    expect(meta.contextMemoryId).toBe('mem_cp_001');
    expect(meta.parentMemoryId).toBe('mem_parent_999');
  });

  it('should accept valid AgentWrapUpMetadata', () => {
    const meta: AgentWrapUpMetadata = {
      taskType: 'code-implementation',
      agentRole: 'coder',
      taskId: 'task_abc123',
      contextMemoryId: 'mem_cp_001',
      parentWrapUpId: null,
      createdAt: '2026-05-22T23:05:00Z',
      project: 'neuralgentics',
      durationMs: 45000,
      success: true,
    };
    expect(meta.contextMemoryId).toBe('mem_cp_001');
    expect(meta.durationMs).toBe(45000);
  });

  it('should accept valid SeedPrompt', () => {
    const seed: SeedPrompt = {
      task: 'Build a REST API',
      memoryId: 'mem_cp_001',
      prompt: '---\n## Task\nBuild a REST API...',
    };
    expect(seed.memoryId).toBe('mem_cp_001');
    expect(seed.prompt).toContain('Build a REST API');
  });

  it('should accept valid StatelessTaskResult', () => {
    const result: StatelessTaskResult = {
      memory_id: 'mem_wu_002',
      description: 'Implemented 5 routes',
    };
    expect(result.memory_id).toBe('mem_wu_002');
  });

  it('should accept valid AgentWrapUp', () => {
    const wrapUp: AgentWrapUp = {
      summary: 'Implemented routes',
      filesModified: ['server.py'],
      filesCreated: ['test_users.py'],
      followUpTasks: ['Add auth'],
      trustSignals: { contextMemoryId: 'mem_cp_001', signal: 'agent_used' },
      errors: [],
      warnings: ['Skipped rate limiting'],
      subAgentResults: [],
    };
    expect(wrapUp.summary).toBe('Implemented routes');
    expect(wrapUp.trustSignals.signal).toBe('agent_used');
  });

  it('should accept valid StatelessOrchestrationResult', () => {
    const result: StatelessOrchestrationResult = {
      agent: 'coder',
      contextMemoryId: 'mem_cp_001',
      seedPrompt: {
        task: 'Build API',
        memoryId: 'mem_cp_001',
        prompt: '...',
      },
      executionPlan: {
        steps: [],
        canParallelize: true,
        estimatedComplexity: 'medium',
      },
    };
    expect(result.agent).toBe('coder');
    expect(result.contextMemoryId).toBe('mem_cp_001');
  });

  it('should extend MemorySourceType with context_package and agent_wrap_up', () => {
    const types: MemorySourceType[] = [
      'session',
      'file',
      'web',
      'boomerang',
      'project',
      'context_package',
      'agent_wrap_up',
    ];
    expect(types).toContain('context_package');
    expect(types).toContain('agent_wrap_up');
  });
});

// ============================================================================
// Stateless Protocol Tests
// ============================================================================

import {
  SEED_PROMPT_TEMPLATE,
  isStatelessDispatch,
  isStatelessTaskResult,
  formatSeedPrompt,
  buildSeedPromptObject,
} from './stateless-protocol.js';

describe('Stateless Protocol', () => {
  describe('SEED_PROMPT_TEMPLATE', () => {
    it('should contain {task} placeholder', () => {
      expect(SEED_PROMPT_TEMPLATE).toContain('{task}');
    });

    it('should contain {memoryId} placeholder', () => {
      expect(SEED_PROMPT_TEMPLATE).toContain('{memoryId}');
    });

    it('should contain protocol sections', () => {
      expect(SEED_PROMPT_TEMPLATE).toContain('Context Retrieval');
      expect(SEED_PROMPT_TEMPLATE).toContain('Wrap-Up Storage');
      expect(SEED_PROMPT_TEMPLATE).toContain('Trust Signal');
      expect(SEED_PROMPT_TEMPLATE).toContain('Return Format');
    });

    it('should reference localhost:8900', () => {
      expect(SEED_PROMPT_TEMPLATE).toContain('localhost:8900');
    });
  });

  describe('formatSeedPrompt', () => {
    it('should substitute task and memoryId', () => {
      const result = formatSeedPrompt('Build REST API', 'mem_cp_001');
      expect(result).toContain('Build REST API');
      expect(result).toContain('mem_cp_001');
      expect(result).not.toContain('{task}');
      expect(result).not.toContain('{memoryId}');
    });

    it('should handle multiple substitutions of memoryId', () => {
      const result = formatSeedPrompt('Test task', 'mem_test_123');
      // memoryId appears in GET, trust signal, and wrap-up sections
      const matches = result.match(/mem_test_123/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('buildSeedPromptObject', () => {
    it('should return a valid SeedPrompt object', () => {
      const result = buildSeedPromptObject('Build API', 'mem_cp_001');
      expect(result.task).toBe('Build API');
      expect(result.memoryId).toBe('mem_cp_001');
      expect(result.prompt).toContain('Build API');
      expect(result.prompt).toContain('mem_cp_001');
    });
  });

  describe('isStatelessDispatch', () => {
    it('should return true for valid stateless dispatch result', () => {
      const result = {
        agent: 'coder',
        contextMemoryId: 'mem_cp_001',
        seedPrompt: {
          task: 'Build API',
          memoryId: 'mem_cp_001',
          prompt: '...',
        },
      };
      expect(isStatelessDispatch(result)).toBe(true);
    });

    it('should return false for inline orchestration result', () => {
      const result = {
        agent: 'coder',
        contextPackage: { originalUserRequest: 'test' },
        executionPlan: { steps: [], canParallelize: true, estimatedComplexity: 'low' },
      };
      expect(isStatelessDispatch(result)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isStatelessDispatch(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isStatelessDispatch(undefined)).toBe(false);
    });

    it('should return false for string', () => {
      expect(isStatelessDispatch('just a string')).toBe(false);
    });
  });

  describe('isStatelessTaskResult', () => {
    it('should return true for valid StatelessTaskResult', () => {
      const result = { memory_id: 'mem_wu_002', description: 'Done' };
      expect(isStatelessTaskResult(result)).toBe(true);
    });

    it('should return false for objects missing required fields', () => {
      expect(isStatelessTaskResult({ memory_id: 'mem_wu_002' })).toBe(false);
      expect(isStatelessTaskResult({ description: 'Done' })).toBe(false);
    });

    it('should return false for null', () => {
      expect(isStatelessTaskResult(null)).toBe(false);
    });
  });
});

// ============================================================================
// Orchestrator: Stateless Mode Tests
// ============================================================================

import {
  NeuralgenticsOrchestrator,
  createOrchestrator,
} from './index.js';
import type { MemoryAdapter } from './context.js';

function createMockMemoryAdapter(): MemoryAdapter {
  const storedMemories = new Map<string, { content: string; sourceType: string; metadata: Record<string, unknown> }>();
  let idCounter = 0;

  return {
    queryMemories: vi.fn().mockResolvedValue([]),
    addMemory: vi.fn().mockResolvedValue('mem_generic_001'),
    adjustTrust: vi.fn().mockResolvedValue(undefined),
    getRelatedMemories: vi.fn().mockResolvedValue([]),
    getTier0Summary: vi.fn().mockResolvedValue(null),
    getTier1Summary: vi.fn().mockResolvedValue(null),
    getMemory: vi.fn().mockImplementation(async (id: string) => {
      const mem = storedMemories.get(id);
      if (!mem) throw new Error(`Memory not found: ${id}`);
      return {
        id,
        content: mem.content,
        sourceType: mem.sourceType as any,
        sourcePath: undefined,
        timestamp: new Date().toISOString(),
        trustScore: 0.5,
        metadata: mem.metadata,
      };
    }),
    storeContextPackage: vi.fn().mockImplementation(async (_pkg: any, _meta: any) => {
      const id = `mem_cp_${String(++idCounter).padStart(3, '0')}`;
      storedMemories.set(id, {
        content: JSON.stringify(_pkg),
        sourceType: 'context_package',
        metadata: _meta,
      });
      return id;
    }),
    fetchAgentWrapUp: vi.fn().mockImplementation(async (id: string) => {
      const mem = storedMemories.get(id);
      if (!mem) throw new Error(`Wrap-up not found: ${id}`);
      return JSON.parse(mem.content);
    }),
    storeAgentWrapUp: vi.fn().mockImplementation(async (wrapUp: any, _meta: any) => {
      const id = `mem_wu_${String(++idCounter).padStart(3, '0')}`;
      storedMemories.set(id, {
        content: JSON.stringify(wrapUp),
        sourceType: 'agent_wrap_up',
        metadata: _meta,
      });
      return id;
    }),
  };
}

describe('NeuralgenticsOrchestrator - Stateless Mode', () => {
  let memory: MemoryAdapter;

  beforeEach(() => {
    memory = createMockMemoryAdapter();
  });

  it('should default to inline (non-stateless) mode', () => {
    const orch = createOrchestrator({
      skillsDir: '/tmp/skills',
      memory,
    });
    // handleTask should use inline mode (returns OrchestrationResult with contextPackage)
    expect((orch as any).useStatelessAgents).toBe(false);
  });

  it('should enable stateless mode with config flag', () => {
    const orch = createOrchestrator({
      skillsDir: '/tmp/skills',
      memory,
      useStatelessAgents: true,
    });
    expect((orch as any).useStatelessAgents).toBe(true);
  });

  it('should return StatelessOrchestrationResult in stateless mode', async () => {
    const orch = createOrchestrator({
      skillsDir: '/tmp/skills',
      memory,
      useStatelessAgents: true,
    });

    const task = {
      id: 'task_test_001',
      type: 'code-implementation' as const,
      description: 'Build a REST API for user management',
      userRequest: 'Build a REST API for user management with CRUD operations',
      priority: 'high' as const,
    };

    const result = await orch.handleTask(task);

    // Result should be a StatelessOrchestrationResult
    expect(result).toHaveProperty('agent');
    expect(result).toHaveProperty('contextMemoryId');
    expect(result).toHaveProperty('seedPrompt');
    expect(result).toHaveProperty('executionPlan');
    expect((result as any).contextMemoryId).toBeTruthy();
    expect((result as any).seedPrompt.memoryId).toBeTruthy();
    expect((result as any).seedPrompt.prompt).toContain('Build a REST API for user management');
  });

  it('should return OrchestrationResult in inline mode (no contextMemoryId)', async () => {
    const orch = createOrchestrator({
      skillsDir: '/tmp/skills',
      memory,
      useStatelessAgents: false,
    });

    const task = {
      id: 'task_test_002',
      type: 'code-implementation' as const,
      description: 'Fix the login bug',
      userRequest: 'Fix the login bug in auth.ts',
      priority: 'medium' as const,
    };

    const result = await orch.handleTask(task);

    // Result should be an OrchestrationResult (inline)
    expect(result).toHaveProperty('agent');
    expect(result).toHaveProperty('contextPackage');
    expect(result).toHaveProperty('executionPlan');
    // Should NOT have contextMemoryId or seedPrompt at the top level
    expect((result as any).contextMemoryId).toBeUndefined();
    expect((result as any).seedPrompt).toBeUndefined();
  });

  it('should build seed prompt from task and memory ID', () => {
    const orch = createOrchestrator({
      skillsDir: '/tmp/skills',
      memory,
    });

    const task = {
      id: 'task_test_003',
      type: 'testing' as const,
      description: 'Write unit tests for the orchestrator',
      userRequest: 'Write unit tests for the orchestrator module',
      priority: 'low' as const,
    };

    const prompt = orch.buildSeedPrompt(task, 'mem_cp_test');
    expect(prompt).toContain('Write unit tests for the orchestrator');
    expect(prompt).toContain('mem_cp_test');
    expect(prompt).toContain('GET http://localhost:8900/memory/mem_cp_test');
  });

  it('should complete task cycle: fetch wrap-up and adjust trust', async () => {
    const mockMemory = createMockMemoryAdapter();
    const orch = createOrchestrator({
      skillsDir: '/tmp/skills',
      memory: mockMemory,
      useStatelessAgents: true,
    });

    // Store a wrap-up first
    const wrapUp = {
      summary: 'Implemented feature X',
      filesModified: ['src/feature.ts'],
      filesCreated: ['tests/feature.test.ts'],
      followUpTasks: ['Add integration tests'],
      trustSignals: { contextMemoryId: 'mem_cp_001', signal: 'agent_used' },
      errors: [],
      warnings: [],
      subAgentResults: [],
    };

    const wrapUpId = await mockMemory.storeAgentWrapUp(wrapUp, {
      taskType: 'code-implementation',
      agentRole: 'coder',
      taskId: 'task_test_004',
      contextMemoryId: 'mem_cp_001',
      parentWrapUpId: null,
      createdAt: new Date().toISOString(),
      project: 'neuralgentics',
      success: true,
    });

    const result: StatelessTaskResult = {
      memory_id: wrapUpId,
      description: 'Implemented feature X',
    };

    const completedWrapUp = await orch.completeTaskCycle('task_test_004', result, 'mem_cp_001');

    expect(completedWrapUp.summary).toBe('Implemented feature X');
    expect(completedWrapUp.filesModified).toContain('src/feature.ts');
    expect(mockMemory.adjustTrust).toHaveBeenCalledWith('mem_cp_001', 'agent_used');
  });
});

// ============================================================================
// HttpMemoryAdapter Tests (Unit, mock fetch)
// ============================================================================

import { HttpMemoryAdapter } from './context.js';

describe('HttpMemoryAdapter', () => {
  let adapter: HttpMemoryAdapter;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    adapter = new HttpMemoryAdapter('http://localhost:8900');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should store a context package via POST /memory/add', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'mem_cp_test_001' }),
    });

    const pkg: any = {
      originalUserRequest: 'Test task',
      taskBackground: 'Background info',
      relevantFiles: [],
      codeSnippets: [],
      previousDecisions: [],
      expectedOutput: 'Result',
      scopeBoundaries: { inScope: [], outOfScope: [] },
      errorHandling: 'Log and escalate',
    };

    const metadata: any = {
      taskType: 'code-implementation',
      agentRole: 'coder',
      taskId: 'task_001',
      parentMemoryId: null,
      createdAt: '2026-05-22T23:00:00Z',
      project: 'neuralgentics',
      version: '1.0',
    };

    const id = await adapter.storeContextPackage(pkg, metadata);

    expect(id).toBe('mem_cp_test_001');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8900/memory/add');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.sourceType).toBe('context_package');
  });

  it('should fetch a memory via GET /memory/{id}', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'mem_cp_001',
        content: '{"originalUserRequest":"test"}',
        sourceType: 'context_package',
        timestamp: '2026-05-22T23:00:00Z',
      }),
    });

    const mem = await adapter.getMemory('mem_cp_001');

    expect(mem.id).toBe('mem_cp_001');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8900/memory/mem_cp_001');
  });

  it('should store an agent wrap-up via POST /memory/add', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'mem_wu_test_001' }),
    });

    const wrapUp: any = {
      summary: 'Test wrap-up',
      filesModified: [],
      filesCreated: [],
      followUpTasks: [],
      trustSignals: { contextMemoryId: 'mem_cp_001', signal: 'agent_used' },
      errors: [],
      warnings: [],
      subAgentResults: [],
    };

    const metadata: any = {
      taskType: 'code-implementation',
      agentRole: 'coder',
      taskId: 'task_001',
      contextMemoryId: 'mem_cp_001',
      parentWrapUpId: null,
      createdAt: '2026-05-22T23:05:00Z',
      project: 'neuralgentics',
      durationMs: 30000,
      success: true,
    };

    const id = await adapter.storeAgentWrapUp(wrapUp, metadata);

    expect(id).toBe('mem_wu_test_001');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8900/memory/add');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.sourceType).toBe('agent_wrap_up');
  });

  it('should fetch an agent wrap-up via GET + JSON parse', async () => {
    const wrapUpContent = JSON.stringify({
      summary: 'Done',
      filesModified: ['src/main.ts'],
      filesCreated: [],
      followUpTasks: [],
      trustSignals: { contextMemoryId: 'mem_cp_001', signal: 'agent_used' },
      errors: [],
      warnings: [],
      subAgentResults: [],
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'mem_wu_001',
        content: wrapUpContent,
        sourceType: 'agent_wrap_up',
        timestamp: '2026-05-22T23:05:00Z',
      }),
    });

    const wrapUp = await adapter.fetchAgentWrapUp('mem_wu_001');

    expect(wrapUp.summary).toBe('Done');
    expect(wrapUp.filesModified).toContain('src/main.ts');
  });

  it('should adjust trust via POST /memory/{id}/trust', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await adapter.adjustTrust('mem_cp_001', 'agent_used');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8900/memory/mem_cp_001/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ signal: 'agent_used' }),
      })
    );
  });

  it('should throw on non-OK response from getMemory', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(adapter.getMemory('nonexistent')).rejects.toThrow(
      'getMemory(nonexistent) failed: 404 Not Found'
    );
  });

  it('should throw on non-OK response from storeContextPackage', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(
      adapter.storeContextPackage({} as any, {} as any)
    ).rejects.toThrow('storeContextPackage failed: 500 Internal Server Error');
  });
});

// ============================================================================
// Context Builder: Seed Prompt Generation Tests
// ============================================================================

import { buildSeedPrompt as buildSeedPromptFunc } from './context.js';

describe('Context: buildSeedPrompt', () => {
  it('should store context package and return seed prompt with memory ID', async () => {
    const mockMemory = createMockMemoryAdapter();

    const contextPkg: any = {
      originalUserRequest: 'Build feature X',
      taskBackground: 'Task: Build feature X\nType: code-implementation',
      relevantFiles: ['src/main.ts'],
      codeSnippets: [],
      previousDecisions: [],
      expectedOutput: 'Modified files',
      scopeBoundaries: { inScope: ['Code implementation'], outOfScope: [] },
      errorHandling: 'Log and escalate',
    };

    const task = {
      id: 'task_seed_001',
      type: 'code-implementation' as const,
      description: 'Build feature X',
      userRequest: 'Build feature X in the API module',
      priority: 'high' as const,
    };

    const result = await buildSeedPromptFunc(mockMemory, task, contextPkg, 'coder');

    expect(result.contextMemoryId).toBeTruthy();
    expect(result.seedPrompt.memoryId).toBeTruthy();
    expect(result.seedPrompt.task).toBe('Build feature X');
    expect(result.seedPrompt.prompt).toContain('Build feature X');
    expect(result.seedPrompt.prompt).toContain(result.contextMemoryId);
    expect(mockMemory.storeContextPackage).toHaveBeenCalled();
  });
});