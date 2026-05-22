/**
 * Neuralgentics — Plugin Entry Point
 *
 * OpenCode plugin following the actual Plugin API contract:
 *   - tool:    Custom MCP tools exposed to the orchestrator
 *   - event:  Lifecycle event handler (session.created, session.idle, etc.)
 *   - config: Merge settings into OpenCode config
 *   - cleanup: Teardown function
 *
 * NOTE: OpenCode's plugin API does NOT provide tool execution interceptor
 * hooks (tool.execute.before / tool.execute.after). The old implementation
 * used ctx.on() which does not exist. Instead, routing validation and
 * post-tool context saving are exposed as custom MCP tools that the
 * orchestrator calls explicitly. This is actually a better design — it
 * gives the orchestrator explicit control over when validation and
 * context saves occur.
 *
 * Similarly, compaction backup and AGENTS.md injection are available as
 * explicit MCP tool calls AND as lifecycle event handlers where supported.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryAdapter } from './adapters/memory.js';
import { validateRouting } from '@neuralgentics/orchestrator';
import type { TaskType, AgentRole } from '@neuralgentics/orchestrator/types';

// ============================================================================
// Plugin Types (matching OpenCode's actual plugin API contract)
// ============================================================================

/** Context provided by OpenCode when the plugin is activated */
export interface PluginContext {
  /** OpenCode client for logging and app interaction */
  client?: unknown;
  /** Command-line arguments */
  args?: string[];
  /** Current working directory */
  cwd?: string;
  /** Plugin-specific configuration from opencode.json */
  pluginConfig?: Record<string, unknown>;
}

/** Shape returned by the plugin function — matches OpenCode's PluginOutput contract */
export interface PluginOutput {
  /** Custom MCP tools the plugin exposes */
  tool: Record<string, ToolDefinition>;
  /** Lifecycle event handler */
  event: (payload: { event: unknown }) => Promise<void>;
  /** Config merger — called to merge plugin settings into OpenCode config */
  config: (cfg: Record<string, unknown>) => Promise<void>;
  /** Cleanup function called on plugin shutdown */
  cleanup: () => Promise<void>;
}

export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** Compaction event payload (if OpenCode emits it) */
interface CompactionPayload {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MEMORY_BASE_URL = process.env.NEURALGENTICS_MEMORY_URL ?? 'http://localhost:8900';
const DEFAULT_AGENTS_MD_PATH = resolve(process.cwd(), 'AGENTS.md');
const VERSION = '0.1.0';

// ============================================================================
// Shared State
// ============================================================================

let memory: MemoryAdapter;
let agentsMdContent: string | null = null;

// ============================================================================
// Plugin Implementation
// ============================================================================

/**
 * Neuralgentics Plugin — OpenCode Plugin API
 *
 * Called by OpenCode when the plugin is activated. Returns an object
 * with tool, event, config, and cleanup keys.
 */
export const NeuralgenticsPlugin = async (ctx: PluginContext): Promise<PluginOutput> => {
  const baseUrl = (ctx.pluginConfig?.memoryBaseUrl as string) ?? DEFAULT_MEMORY_BASE_URL;
  const agentsMdPath = (ctx.pluginConfig?.agentsMdPath as string) ?? DEFAULT_AGENTS_MD_PATH;

  memory = new MemoryAdapter({ baseUrl });

  // Load AGENTS.md at activation time
  try {
    agentsMdContent = await readFile(agentsMdPath, 'utf-8');
  } catch {
    console.warn('[Neuralgentics] AGENTS.md not found at:', agentsMdPath);
  }

  // Log activation
  try {
    const log = (ctx.client as { app?: { log?: (msg: string) => void } }).app?.log;
    log?.(`Neuralgentics v${VERSION} activated`);
    log?.(`Memory server: ${baseUrl}`);
  } catch {
    // Logging not available
  }

  console.log(`[Neuralgentics] Plugin activated — memory: ${baseUrl}`);

  // ==========================================================================
  // Custom MCP Tools
  // ==========================================================================

  const tools: Record<string, ToolDefinition> = {
    // ------------------------------------------------------------------------
    // Tool: Validate routing — replaces tool.execute.before hook
    //
    // LIMITATION: OpenCode's plugin API does not support tool execution
    // interceptors. The orchestrator must call this tool explicitly before
    // delegating a task to validate that the routing is correct per the
    // Routing Matrix.
    // ------------------------------------------------------------------------
    neuralgentics_validate_routing: {
      description:
        'Validate agent routing against the Routing Matrix. Call before delegating a task to ensure the correct agent is selected.',
      inputSchema: {
        type: 'object',
        properties: {
          taskType: {
            type: 'string',
            description: 'The type of task (e.g., "code", "architecture", "testing")',
          },
          agentRole: {
            type: 'string',
            description: 'The agent role being considered (e.g., "coder", "architect")',
          },
        },
        required: ['taskType', 'agentRole'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const taskType = args.taskType as string;
        const agentRole = args.agentRole as string;

        if (!taskType || !agentRole) {
          return 'Error: taskType and agentRole are required';
        }

        const validation = validateRouting(taskType as TaskType, agentRole as AgentRole);

        if (validation.valid) {
          return `Routing VALID: ${agentRole} is authorized for ${taskType}`;
        }

        return `Routing BLOCKED: ${validation.violation ?? 'Unknown violation'}`;
      },
    },

    // ------------------------------------------------------------------------
    // Tool: Save tool result — replaces tool.execute.after hook
    //
    // LIMITATION: Same as above — no after-hook in OpenCode's plugin API.
    // The orchestrator or agent calls this explicitly after tool execution
    // to persist the result context to memory.
    // ------------------------------------------------------------------------
    neuralgentics_save_tool_result: {
      description:
        'Save a tool execution result to neuralgentics memory. Call after tool execution to persist context.',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: {
            type: 'string',
            description: 'Name of the agent that executed the tool',
          },
          result: {
            type: 'string',
            description: 'The tool execution result to save',
          },
          durationMs: {
            type: 'number',
            description: 'Execution duration in milliseconds',
          },
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

        try {
          const memoryId = await memory.addMemory(result, {
            type: 'tool-result',
            agent: agentName,
            durationMs,
            timestamp: new Date().toISOString(),
          });

          return `Context saved to memory (ID: ${memoryId})`;
        } catch (err) {
          return `Failed to save context: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    // ------------------------------------------------------------------------
    // Tool: Get AGENTS.md content — replaces system prompt transform hook
    //
    // Instead of injecting into the system prompt via a hook, the
    // orchestrator calls this tool to retrieve AGENTS.md content and
    // include it in agent context packages.
    // ------------------------------------------------------------------------
    neuralgentics_get_agents_md: {
      description:
        'Retrieve the AGENTS.md content for the current project. Used by the orchestrator to inject project context into agent prompts.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<string> {
        if (!agentsMdContent) {
          return 'AGENTS.md not loaded — file not found at activation time';
        }
        return agentsMdContent;
      },
    },

    // ------------------------------------------------------------------------
    // Tool: Compaction backup — explicit version for orchestrator calls
    //
    // This tool provides an explicit way to backup conversation context
    // to memory before compaction occurs. The lifecycle event handler
    // (below) also attempts to handle compaction automatically if OpenCode
    // emits the event, but this tool ensures the backup is available
    // regardless.
    // ------------------------------------------------------------------------
    neuralgentics_compaction_backup: {
      description:
        'Backup conversation context to memory before compaction. Call when the session is about to be compacted to preserve conversation history.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The session ID being compacted',
          },
          conversation: {
            type: 'string',
            description: 'The conversation text to back up (role: content format)',
          },
        },
        required: ['sessionId', 'conversation'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const sessionId = args.sessionId as string;
        const conversation = args.conversation as string;

        if (!sessionId || !conversation) {
          return 'Error: sessionId and conversation are required';
        }

        try {
          const memoryId = await memory.addMemory(conversation, {
            type: 'compaction-backup',
            sessionId,
            timestamp: new Date().toISOString(),
          });

          return `Compaction backup saved (ID: ${memoryId})`;
        } catch (err) {
          return `Compaction backup failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  };

  // ==========================================================================
  // Lifecycle Event Handler
  // ==========================================================================

  const eventHandler = async ({ event }: { event: unknown }): Promise<void> => {
    const eventType = (event as { type?: string }).type;

    switch (eventType) {
      case 'session.created': {
        try {
          const log = (ctx.client as { app?: { log?: (msg: string) => void } }).app?.log;
          log?.('Session created — Neuralgentics ready');
        } catch {
          // Logging not available
        }
        break;
      }

      case 'session.idle': {
        try {
          const log = (ctx.client as { app?: { log?: (msg: string) => void } }).app?.log;
          log?.('Session idle — Neuralgentics tools available');
        } catch {
          // Logging not available
        }
        break;
      }

      case 'session.compacting': {
        // If OpenCode emits this event, automatically back up the conversation
        // to memory before compaction occurs.
        const payload = event as CompactionPayload;
        if (payload.sessionId && payload.messages?.length) {
          try {
            const conversationText = payload.messages
              .map((m) => `${m.role}: ${m.content}`)
              .join('\n');

            const memoryId = await memory.addMemory(conversationText, {
              type: 'compaction-backup',
              sessionId: payload.sessionId,
              timestamp: new Date().toISOString(),
            });

            console.log(`[Neuralgentics] Auto-compaction backup saved: ${memoryId}`);
          } catch (err) {
            console.warn('[Neuralgentics] Auto-compaction backup failed:', err);
          }
        }
        break;
      }

      default:
        // Unhandled event — no-op
        break;
    }
  };

  // ==========================================================================
  // Config Merger
  // ==========================================================================

  const configHandler = async (cfg: Record<string, unknown>): Promise<void> => {
    cfg.neuralgentics = {
      version: VERSION,
      memoryBaseUrl: baseUrl,
      agentsMdLoaded: agentsMdContent !== null,
      // AGENTS.md content is available via the neuralgentics_get_agents_md tool
      // rather than being force-injected into system prompts.
      // Orchestrators should call the tool when building context packages.
    };
  };

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  const cleanupHandler = async (): Promise<void> => {
    console.log('[Neuralgentics] Plugin shutting down');
    // MemoryAdapter uses plain HTTP — no persistent connections to close
  };

  // ==========================================================================
  // Return Plugin Output
  // ==========================================================================

  return {
    tool: tools,
    event: eventHandler,
    config: configHandler,
    cleanup: cleanupHandler,
  };
};

export default NeuralgenticsPlugin;

/**
 * Get the shared MemoryAdapter instance (for orchestrator access).
 */
export function getMemoryAdapter(): MemoryAdapter {
  return memory;
}