/**
 * Boomerang SDK — OpenCode Plugin Hooks Adapter
 *
 * Bridges Neuralgentics hook patterns to the OpenCode plugin system.
 * Since OpenCode's plugin API does not provide tool execution interceptor
 * hooks (tool.execute.before / tool.execute.after), this adapter exposes
 * them as explicit MCP tool calls that the orchestrator invokes.
 *
 * Provides typed interfaces for:
 * - Compaction backup (session.compacting lifecycle event)
 * - Routing validation (explicit tool call)
 * - Post-tool context save (explicit tool call)
 * - AGENTS.md content injection (explicit tool call)
 */

import type { AgentRole, TaskType } from '@neuralgentics/orchestrator/types';
import type {
  CompactionEvent,
  HookDefinitions,
  SessionEventType,
} from '../types.js';
import type { MemoryAdapter } from './memory.js';
import { validateRouting } from '@neuralgentics/orchestrator';

// ============================================================================
// Tool Definition Type (same as plugin)
// ============================================================================

export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ============================================================================
// Hooks Adapter
// ============================================================================

export interface HooksAdapterConfig {
  /** Memory adapter for persistence */
  memory: MemoryAdapter;
  /** AGENTS.md content (loaded externally) */
  agentsMdContent?: string;
}

/**
 * HooksAdapter creates MCP tool definitions for the four Neuralgentics
 * hook patterns. Each tool is explicitly called by the orchestrator.
 */
export class HooksAdapter {
  private mem: MemoryAdapter;
  private agentsMd: string | null;
  private handlers: HookDefinitions;

  constructor(config: HooksAdapterConfig, handlers?: HookDefinitions) {
    this.mem = config.memory;
    this.agentsMd = config.agentsMdContent ?? null;
    this.handlers = handlers ?? {};
  }

  /**
   * Get all MCP tool definitions for the hook patterns.
   */
  getTools(): Record<string, ToolDefinition> {
    // Capture instance references for closures
    const mem = this.mem;
    const agentsMd = this.agentsMd;
    const handlers = this.handlers;

    return {
      neuralgentics_validate_routing: {
        description:
          'Validate agent routing against the Routing Matrix. Call before delegating a task.',
        inputSchema: {
          type: 'object',
          properties: {
            taskType: { type: 'string', description: 'Task type (e.g., "code-implementation")' },
            agentRole: { type: 'string', description: 'Agent role (e.g., "coder")' },
          },
          required: ['taskType', 'agentRole'],
        },
        async execute(args: Record<string, unknown>): Promise<string> {
          const taskType = args.taskType as TaskType;
          const agentRole = args.agentRole as AgentRole;

          if (!taskType || !agentRole) {
            return 'Error: taskType and agentRole are required';
          }

          if (handlers.onBeforeToolExecute) {
            await handlers.onBeforeToolExecute({ toolName: 'routing', agent: agentRole });
          }

          const validation = validateRouting(taskType, agentRole);
          return validation.valid
            ? `Routing VALID: ${agentRole} is authorized for ${taskType}`
            : `Routing BLOCKED: ${validation.violation ?? 'Unknown violation'}`;
        },
      },

      neuralgentics_save_tool_result: {
        description: 'Save tool execution result to memory. Call after tool execution.',
        inputSchema: {
          type: 'object',
          properties: {
            agentName: { type: 'string', description: 'Agent name that executed the tool' },
            result: { type: 'string', description: 'Tool execution result' },
            durationMs: { type: 'number', description: 'Execution duration in ms' },
          },
          required: ['agentName', 'result'],
        },
        async execute(args: Record<string, unknown>): Promise<string> {
          const agentName = args.agentName as string;
          const result = args.result as string;
          const durationMs = (args.durationMs as number) ?? 0;

          if (!agentName || !result) {
            return 'Error: agentName and result are required';
          }

          const addResult = await mem.addMemory(result, {
            type: 'tool-result',
            agent: agentName,
            durationMs,
            timestamp: new Date().toISOString(),
          });

          if (!addResult.ok) {
            return `Failed to save context: ${addResult.error}`;
          }

          if (handlers.onAfterToolExecute) {
            await handlers.onAfterToolExecute({ toolName: 'save_result', result, durationMs });
          }

          return `Context saved to memory (ID: ${addResult.value})`;
        },
      },

      neuralgentics_get_agents_md: {
        description: 'Retrieve the AGENTS.md content for context injection.',
        inputSchema: { type: 'object', properties: {} },
        async execute(): Promise<string> {
          if (!agentsMd) {
            return 'AGENTS.md not loaded — file not found at activation time';
          }

          if (handlers.onSystemTransform) {
            await handlers.onSystemTransform({ prompt: agentsMd });
          }

          return agentsMd;
        },
      },

      neuralgentics_compaction_backup: {
        description: 'Backup conversation context before compaction.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Session ID being compacted' },
            conversation: { type: 'string', description: 'Conversation text to back up' },
          },
          required: ['sessionId', 'conversation'],
        },
        async execute(args: Record<string, unknown>): Promise<string> {
          const sessionId = args.sessionId as string;
          const conversation = args.conversation as string;

          if (!sessionId || !conversation) {
            return 'Error: sessionId and conversation are required';
          }

          const addResult = await mem.addMemory(conversation, {
            type: 'compaction-backup',
            sessionId,
            timestamp: new Date().toISOString(),
          });

          if (!addResult.ok) {
            return `Compaction backup failed: ${addResult.error}`;
          }

          return `Compaction backup saved (ID: ${addResult.value})`;
        },
      },
    };
  }

  /**
   * Dispatch a session lifecycle event.
   * Calls any custom handler registered for the event type.
   */
  async dispatchEvent(eventType: SessionEventType, payload: unknown): Promise<void> {
    switch (eventType) {
      case 'session.compacting': {
        const handler = this.handlers.onCompaction;
        if (handler && payload) {
          await handler(payload as CompactionEvent);
        }
        break;
      }
      default:
        break;
    }
  }
}