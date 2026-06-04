/**
 * Boomerang SDK — Type Tests
 *
 * Validates type definitions and utility functions.
 */

import { describe, it, expect } from 'vitest';
import type {
  AgentConfig,
  AgentMode,
  AgentRole,
  PermissionMap,
  TaskPlan,
  PlanTask,
  ContextPackage,
  ScopeBoundaries,
  RetryConfig,
  RetryableErrorType,
  SdkResult,
  SdkSuccess,
  SdkFailure,
  BoomerangClientConfig,
  CompactionEvent,
  SessionEventType,
  HookDefinitions,
} from '../src/types.js';
import {
  classifyError,
  isRetryable,
  calculateBackoff,
  withRetry,
  sleep,
  generateId,
  ok,
  fail,
  tryOperation,
  mapToRecord,
  recordToMap,
  DEFAULT_RETRY_CONFIG,
} from '../src/utils.js';
import {
  getAgentConfig,
  checkRouting,
  buildTaskPlan,
  getAllAgentConfigs,
  getRoutingMatrix,
  resolveAgent,
  validateRouting,
} from '../src/adapters/routing.js';

// ============================================================================
// Utility Tests
// ============================================================================

describe('utils', () => {
  describe('classifyError', () => {
    it('should classify network errors', () => {
      expect(classifyError(new Error('ECONNREFUSED'))).toBe('network');
      expect(classifyError(new Error('network error occurred'))).toBe('network');
    });

    it('should classify timeout errors', () => {
      expect(classifyError(new Error('request timeout'))).toBe('timeout');
      expect(classifyError(new Error('operation timed out'))).toBe('timeout');
    });

    it('should classify rate limit errors', () => {
      expect(classifyError(new Error('429 Too Many Requests'))).toBe('rate-limit');
      expect(classifyError(new Error('rate limit exceeded'))).toBe('rate-limit');
    });

    it('should classify server errors', () => {
      expect(classifyError(new Error('500 Internal Server Error'))).toBe('server');
      expect(classifyError(new Error('502 Bad Gateway'))).toBe('server');
      expect(classifyError(new Error('503 Service Unavailable'))).toBe('server');
    });

    it('should return null for non-retryable errors', () => {
      expect(classifyError(new Error('400 Bad Request'))).toBeNull();
      expect(classifyError(new Error('not found'))).toBeNull();
    });

    it('should return null for non-Error objects', () => {
      expect(classifyError('string error')).toBeNull();
      expect(classifyError(42)).toBeNull();
      expect(classifyError(null)).toBeNull();
    });
  });

  describe('isRetryable', () => {
    it('should identify retryable network errors', () => {
      expect(isRetryable(new Error('ECONNREFUSED'), ['network'])).toBe(true);
    });

    it('should identify non-retryable when not in list', () => {
      expect(isRetryable(new Error('ECONNREFUSED'), ['timeout'])).toBe(false);
    });

    it('should handle non-retryable errors', () => {
      expect(isRetryable(new Error('400 Bad Request'), ['network', 'timeout'])).toBe(false);
    });
  });

  describe('calculateBackoff', () => {
    it('should increase delay with attempt number', () => {
      const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG };
      const delay0 = calculateBackoff(0, config);
      const delay1 = calculateBackoff(1, config);
      const delay2 = calculateBackoff(2, config);

      // Exponential backoff should increase
      expect(delay1).toBeGreaterThan(delay0 * 0.9); // Allow jitter margin
      expect(delay2).toBeGreaterThan(delay1 * 0.9);
    });

    it('should cap delay at maxDelayMs', () => {
      const config: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        maxDelayMs: 100,
      };
      const delay = calculateBackoff(10, config);
      expect(delay).toBeLessThanOrEqual(100);
    });
  });

  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const result = await withRetry(() => Promise.resolve('success'));
      expect(result).toBe('success');
    });

    it('should retry on retryable errors', async () => {
      let attempts = 0;
      const result = await withRetry(
        () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('ECONNREFUSED');
          }
          return Promise.resolve('recovered');
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, retryableErrors: ['network'] }
      );
      expect(result).toBe('recovered');
      expect(attempts).toBe(3);
    });

    it('should throw on non-retryable errors', async () => {
      await expect(
        withRetry(() => {
          throw new Error('400 Bad Request');
        }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, retryableErrors: ['network'] })
      ).rejects.toThrow('400 Bad Request');
    });

    it('should throw after max attempts exhausted', async () => {
      let attempts = 0;
      await expect(
        withRetry(
          () => {
            attempts++;
            throw new Error('ECONNREFUSED');
          },
          { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50, retryableErrors: ['network'] }
        )
      ).rejects.toThrow('ECONNREFUSED');
      expect(attempts).toBe(2);
    });
  });

  describe('sleep', () => {
    it('should resolve after the specified delay', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow slight clock drift
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs with prefix', () => {
      const id1 = generateId('task');
      const id2 = generateId('task');
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^task_/);
      expect(id2).toMatch(/^task_/);
    });

    it('should use different prefixes', () => {
      expect(generateId('plan')).toMatch(/^plan_/);
      expect(generateId('step')).toMatch(/^step_/);
    });
  });

  describe('result helpers', () => {
    it('should create success results', () => {
      const result = ok('value');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('value');
      }
    });

    it('should create failure results', () => {
      const result = fail('error message', true);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('error message');
        expect(result.retryable).toBe(true);
      }
    });

    it('should wrap operations in results', async () => {
      const success = await tryOperation(() => Promise.resolve(42));
      expect(success.ok).toBe(true);
      if (success.ok) {
        expect(success.value).toBe(42);
      }

      const failure = await tryOperation(() => {
        throw new Error('ECONNREFUSED');
      });
      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.retryable).toBe(true);
      }
    });
  });

  describe('map serialization', () => {
    it('should convert Map to Record', () => {
      const map = new Map<string, number>([['a', 1], ['b', 2]]);
      const record = mapToRecord(map);
      expect(record.a).toBe(1);
      expect(record.b).toBe(2);
    });

    it('should convert Record to Map', () => {
      const record: Record<string, number> = { a: 1, b: 2 };
      const map = recordToMap(record);
      expect(map.get('a')).toBe(1);
      expect(map.get('b')).toBe(2);
      expect(map.size).toBe(2);
    });

    it('should round-trip Map → Record → Map', () => {
      const original = new Map<string, string>([['x', 'hello'], ['y', 'world']]);
      const record = mapToRecord(original);
      const roundTrip = recordToMap(record);
      expect(roundTrip.get('x')).toBe('hello');
      expect(roundTrip.get('y')).toBe('world');
    });
  });
});

// ============================================================================
// Routing Adapter Tests
// ============================================================================

describe('routing adapter', () => {
  describe('resolveAgent', () => {
    it('should resolve all task types from the Routing Matrix', () => {
      expect(resolveAgent('code-implementation')).toBe('coder');
      expect(resolveAgent('architecture-design')).toBe('architect');
      expect(resolveAgent('file-finding')).toBe('explorer');
      expect(resolveAgent('testing')).toBe('tester');
      expect(resolveAgent('linting')).toBe('linter');
      expect(resolveAgent('git')).toBe('git' as AgentRole);
      expect(resolveAgent('documentation')).toBe('writer');
      expect(resolveAgent('web-scraping')).toBe('scraper');
      expect(resolveAgent('mcp-debug')).toBe('mcp-specialist' as AgentRole);
      expect(resolveAgent('release')).toBe('release' as AgentRole);
    });
  });

  describe('validateRouting', () => {
    it('should validate correct routing', () => {
      const result = validateRouting('code-implementation', 'coder');
      expect(result.valid).toBe(true);
    });

    it('should reject wrong agent for task type', () => {
      const result = validateRouting('code-implementation', 'explorer');
      expect(result.valid).toBe(false);
      expect(result.violation).toBeDefined();
    });
  });

  describe('getAgentConfig', () => {
    it('should return config for coder', () => {
      const config = getAgentConfig('coder');
      expect(config.id).toBe('boomerang-coder');
      expect(config.name).toBe('Boomerang Coder');
      expect(config.skill).toBe('boomerang-coder');
      expect(config.model).toBe('glm-5.1:cloud');
      expect(config.mode).toBe('subagent');
    });

    it('should have permissions in agent configs', () => {
      const config = getAgentConfig('coder');
      expect(Object.keys(config.permissions).length).toBeGreaterThan(0);
      expect(config.permissions['memini-ai-dev_add_memory']).toBe('allow');
    });

    it('should return default for unknown role', () => {
      const config = getAgentConfig('custom-role' as AgentRole);
      expect(config.id).toContain('custom-role');
    });
  });

  describe('checkRouting', () => {
    it('should return agent config with routing check', () => {
      const result = checkRouting('code-implementation', 'coder');
      expect(result.valid).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.config?.id).toBe('boomerang-coder');
    });
  });

  describe('buildTaskPlan', () => {
    it('should create a plan with unique IDs', () => {
      const plan = buildTaskPlan([
        { type: 'code-implementation', description: 'Implement X' },
        { type: 'testing', description: 'Test X' },
      ]);

      expect(plan.id).toBeDefined();
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks[0].id).not.toBe(plan.tasks[1].id);
    });

    it('should chain same-type task dependencies', () => {
      const plan = buildTaskPlan([
        { type: 'code-implementation', description: 'Task A' },
        { type: 'code-implementation', description: 'Task B' },
      ]);

      expect(plan.tasks[1].dependsOn).toContain(plan.tasks[0].id);
      expect(plan.dependencies.has(plan.tasks[1].id)).toBe(true);
    });

    it('should create parallel groups for different types', () => {
      const plan = buildTaskPlan([
        { type: 'code-implementation', description: 'Code' },
        { type: 'testing', description: 'Test' },
        { type: 'linting', description: 'Lint' },
      ]);

      // Different types start in parallel
      expect(plan.parallelGroups.length).toBeGreaterThanOrEqual(1);
    });

    it('should respect priority', () => {
      const plan = buildTaskPlan([
        { type: 'code-implementation', description: 'Low', priority: 'low' },
        { type: 'testing', description: 'High', priority: 'high' },
      ]);

      expect(plan.tasks[0].priority).toBe('low');
      expect(plan.tasks[1].priority).toBe('high');
    });
  });

  describe('getAllAgentConfigs', () => {
    it('should return all default agent configs', () => {
      const configs = getAllAgentConfigs();
      expect(configs.length).toBeGreaterThanOrEqual(5);
      expect(configs.some((c) => c.id === 'boomerang-coder')).toBe(true);
      expect(configs.some((c) => c.id === 'boomerang-architect')).toBe(true);
    });
  });

  describe('getRoutingMatrix', () => {
    it('should return the full routing matrix', () => {
      const matrix = getRoutingMatrix();
      expect(matrix.length).toBe(10); // All task types in ROUTING_MATRIX
    });
  });
});

// ============================================================================
// Type Structural Tests
// ============================================================================

describe('type definitions', () => {
  it('should allow constructing a valid AgentConfig', () => {
    const config: AgentConfig = {
      id: 'test-agent',
      name: 'Test Agent',
      skill: 'test-skill',
      model: 'test-model:cloud',
      permissions: { 'tool_one': 'allow', 'tool_two': 'deny' },
      mode: 'subagent',
    };

    expect(config.id).toBe('test-agent');
    expect(config.mode).toBe('subagent');
    expect(config.permissions['tool_one']).toBe('allow');
  });

  it('should allow constructing a valid ContextPackage', () => {
    const ctx: ContextPackage = {
      originalRequest: 'implement feature X',
      background: 'Task: ...',
      relevantFiles: ['src/index.ts'],
      codeSnippets: ['const x = 1'],
      decisions: ['Use ESM'],
      outputFormat: 'Modified files',
      scope: { inScope: ['code'], outOfScope: ['design'] },
    };

    expect(ctx.originalRequest).toBe('implement feature X');
    expect(ctx.scope.inScope).toContain('code');
  });

  it('should allow constructing SdkResult variants', () => {
    const success: SdkResult<string> = { ok: true, value: 'done' };
    const failure: SdkResult<string> = { ok: false, error: 'failed', retryable: false };

    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
  });

  it('should allow constructing a CompactionEvent', () => {
    const event: CompactionEvent = {
      sessionId: 'sess-123',
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { count: 1 },
    };

    expect(event.sessionId).toBe('sess-123');
    expect(event.messages).toHaveLength(1);
  });

  it('should allow constructing a TaskPlan', () => {
    const plan: TaskPlan = {
      id: 'plan-1',
      tasks: [
        { id: 't1', type: 'code-implementation', description: 'X', dependsOn: [], priority: 'medium', agent: 'coder' },
      ],
      dependencies: new Map([['t1', []]]),
      parallelGroups: [['t1']],
    };

    expect(plan.id).toBe('plan-1');
    expect(plan.dependencies.get('t1')).toEqual([]);
  });
});