/**
 * Boomerang SDK — Client Tests
 *
 * Tests for the BoomerangClient class, including initialization,
 * configuration, routing validation, and task planning.
 * Memory operations use mocks since the server may not be running.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BoomerangClient, createClient } from '../src/client.js';
import { HooksAdapter } from '../src/adapters/hooks.js';
import type { TaskType, AgentRole, TaskPlan, AgentConfig } from '../src/types.js';

// ============================================================================
// Client Initialization Tests
// ============================================================================

describe('BoomerangClient', () => {
  describe('initialization', () => {
    it('should create a client with default configuration', () => {
      const client = new BoomerangClient();
      const config = client.getConfig();

      expect(config.memory.baseUrl).toBe('http://localhost:8900');
      expect(config.memory.timeoutMs).toBe(10000);
      expect(config.strictness).toBe('standard');
    });

    it('should create a client with custom memory configuration', () => {
      const client = new BoomerangClient({
        memory: { baseUrl: 'http://custom:9999', timeoutMs: 5000 },
      });
      const config = client.getConfig();

      expect(config.memory.baseUrl).toBe('http://custom:9999');
      expect(config.memory.timeoutMs).toBe(5000);
    });

    it('should create a client with strict protocol mode', () => {
      const client = new BoomerangClient({ strictness: 'strict' });
      expect(client.getStrictness()).toBe('strict');
    });

    it('should create a client using the factory function', () => {
      const client = createClient();
      expect(client).toBeInstanceOf(BoomerangClient);
    });

    it('should have a memory adapter', () => {
      const client = new BoomerangClient();
      expect(client.memory).toBeDefined();
    });

    it('should have a hooks adapter', () => {
      const client = new BoomerangClient();
      expect(client.hooks).toBeInstanceOf(HooksAdapter);
    });
  });

  // ============================================================================
  // Routing Tests
  // ============================================================================

  describe('routing', () => {
    it('should resolve the correct agent for code-implementation', () => {
      const client = new BoomerangClient();
      const agent = client.resolveAgent('code-implementation');
      expect(agent).toBe('coder');
    });

    it('should resolve the correct agent for architecture-design', () => {
      const client = new BoomerangClient();
      const agent = client.resolveAgent('architecture-design');
      expect(agent).toBe('architect');
    });

    it('should resolve the correct agent for file-finding', () => {
      const client = new BoomerangClient();
      const agent = client.resolveAgent('file-finding');
      expect(agent).toBe('explorer');
    });

    it('should resolve the correct agent for testing', () => {
      const client = new BoomerangClient();
      const agent = client.resolveAgent('testing');
      expect(agent).toBe('tester');
    });

    it('should resolve the correct agent for linting', () => {
      const client = new BoomerangClient();
      const agent = client.resolveAgent('linting');
      expect(agent).toBe('linter');
    });

    it('should resolve the correct agent for git', () => {
      const client = new BoomerangClient();
      const agent = client.resolveAgent('git');
      expect(agent).toBe('git' as AgentRole);
    });

    it('should resolve the correct agent for documentation', () => {
      const client = new BoomerangClient();
      const agent = client.resolveAgent('documentation');
      expect(agent).toBe('writer');
    });

    it('should validate correct routing', () => {
      const client = new BoomerangClient();
      const result = client.validateRouting('code-implementation', 'coder');
      expect(result.valid).toBe(true);
    });

    it('should detect incorrect routing', () => {
      const client = new BoomerangClient();
      const result = client.validateRouting('code-implementation', 'explorer');
      expect(result.valid).toBe(false);
      expect(result.violation).toContain('ROUTING VIOLATION');
    });

    it('should return expected agent on routing violation', () => {
      const client = new BoomerangClient();
      const result = client.validateRouting('architecture-design', 'coder');
      expect(result.valid).toBe(false);
      expect(result.expectedAgent).toBe('architect');
    });
  });

  // ============================================================================
  // Agent Config Tests
  // ============================================================================

  describe('agent config', () => {
    it('should return agent config for coder', () => {
      const client = new BoomerangClient();
      const config = client.getAgentConfig('coder');
      expect(config.id).toBe('boomerang-coder');
      expect(config.model).toBe('glm-5.1:cloud');
      expect(config.mode).toBe('subagent');
    });

    it('should return agent config for architect', () => {
      const client = new BoomerangClient();
      const config = client.getAgentConfig('architect');
      expect(config.id).toBe('boomerang-architect');
      expect(config.model).toBe('deepseek-v4-pro:cloud');
    });

    it('should return a default config for unknown roles', () => {
      const client = new BoomerangClient();
      const config = client.getAgentConfig('mcp-specialist' as AgentRole);
      expect(config.id).toContain('mcp-specialist');
      expect(config.mode).toBe('subagent');
    });
  });

  // ============================================================================
  // Task Planning Tests
  // ============================================================================

  describe('task planning', () => {
    it('should build a plan from task descriptions', () => {
      const client = new BoomerangClient();
      const plan = client.planTasks([
        { type: 'code-implementation', description: 'Implement feature X' },
        { type: 'testing', description: 'Write tests for X' },
      ]);

      expect(plan.id).toBeDefined();
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks[0].type).toBe('code-implementation');
      expect(plan.tasks[0].agent).toBe('coder');
      expect(plan.tasks[1].type).toBe('testing');
      expect(plan.tasks[1].agent).toBe('tester');
    });

    it('should create dependency graph', () => {
      const client = new BoomerangClient();
      const plan = client.planTasks([
        { type: 'code-implementation', description: 'First task' },
        { type: 'code-implementation', description: 'Second task' },
      ]);

      // Same-type tasks should be chained
      expect(plan.tasks[1].dependsOn).toContain(plan.tasks[0].id);
    });

    it('should detect parallel groups for different task types', () => {
      const client = new BoomerangClient();
      const plan = client.planTasks([
        { type: 'code-implementation', description: 'Code task' },
        { type: 'testing', description: 'Test task' },
      ]);

      // Different type groups can run in parallel
      expect(plan.parallelGroups.length).toBeGreaterThanOrEqual(1);
    });

    it('should use custom plan ID when provided', () => {
      const client = new BoomerangClient();
      const plan = client.planTasks(
        [{ type: 'code-implementation', description: 'Task' }],
        'custom-plan-id'
      );

      expect(plan.id).toBe('custom-plan-id');
    });
  });

  // ============================================================================
  // Hook Tools Tests
  // ============================================================================

  describe('hook tools', () => {
    it('should return four MCP tool definitions', () => {
      const client = new BoomerangClient();
      const tools = client.getHookTools();

      expect(tools.neuralgentics_validate_routing).toBeDefined();
      expect(tools.neuralgentics_save_tool_result).toBeDefined();
      expect(tools.neuralgentics_get_agents_md).toBeDefined();
      expect(tools.neuralgentics_compaction_backup).toBeDefined();
    });

    it('should have correct tool schemas', () => {
      const client = new BoomerangClient();
      const tools = client.getHookTools();

      expect(tools.neuralgentics_validate_routing.inputSchema.type).toBe('object');
      expect(tools.neuralgentics_save_tool_result.inputSchema.type).toBe('object');
    });

    it('should validate routing via tool execution', async () => {
      const client = new BoomerangClient();
      const tools = client.getHookTools();

      const result = await tools.neuralgentics_validate_routing.execute({
        taskType: 'code-implementation',
        agentRole: 'coder',
      });

      expect(result).toContain('Routing VALID');
    });

    it('should block invalid routing via tool execution', async () => {
      const client = new BoomerangClient();
      const tools = client.getHookTools();

      const result = await tools.neuralgentics_validate_routing.execute({
        taskType: 'code-implementation',
        agentRole: 'explorer',
      });

      expect(result).toContain('Routing BLOCKED');
    });

    it('should return error for missing routing params', async () => {
      const client = new BoomerangClient();
      const tools = client.getHookTools();

      const result = await tools.neuralgentics_validate_routing.execute({});
      expect(result).toContain('Error');
    });

    it('should return not-loaded message for AGENTS.md when unset', async () => {
      const client = new BoomerangClient();
      const tools = client.getHookTools();

      const result = await tools.neuralgentics_get_agents_md.execute({});
      expect(result).toContain('not loaded');
    });

    it('should reconfigure hooks with custom handlers', () => {
      const client = new BoomerangClient();
      let handlerCalled = false;

      client.configureHooks(
        {
          onBeforeToolExecute: async () => {
            handlerCalled = true;
          },
        },
        '# Test AGENTS.md content'
      );

      expect(client.hooks).toBeInstanceOf(HooksAdapter);
    });
  });
});