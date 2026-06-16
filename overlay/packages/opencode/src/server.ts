/**
 * Neuralgentics OpenCode Server Plugin
 *
 * Exports the standard OpenCode plugin contract:
 *   default { id, server }
 *
 * The `server` function receives OpenCode's PluginInput and returns Hooks
 * that register custom MCP tools, handle lifecycle events, and manage the
 * Go backend JSON-RPC stdio connection.
 *
 * Because @opencode-ai/plugin is an optional peer dependency (it is provided
 * by OpenCode at runtime), all external types are declared inline as
 * structural matches — no compile-time import required.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GoBackendClient } from "./neuralgentics/go-backend-client.js";

// ============================================================================
// Inline OpenCode type stubs (structural match — runtime validated by OpenCode)
// ============================================================================

/** Minimal PluginInput shape — OpenCode provides the full object at runtime. */
interface PluginInput {
  client?: unknown;
  project?: { name?: string; path?: string };
  directory: string;
  worktree: string;
  serverUrl: URL;
  $?: unknown; // BunShell, optional
}

/** Tool argument schema descriptor (Zod-free, JSON-Schema compatible). */
interface ToolArgSchema {
  type: string;
  description?: string;
  optional?: boolean;
  default?: unknown;
}

/** Tool definition returned in the `tool` hook. */
interface ToolDefinition {
  description: string;
  args: Record<string, ToolArgSchema>;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

/** Context passed to tool execute. */
interface ToolContext {
  sessionID: string;
  messageID: string;
  directory: string;
  worktree: string;
}

/** Hooks returned by the server function. */
interface Hooks {
  tool?: Record<string, ToolDefinition>;
  event?: (payload: { event: Record<string, unknown> }) => Promise<void>;
  config?: (cfg: Record<string, unknown>) => Promise<void>;
  cleanup?: () => Promise<void>;
}

/** PluginModule default export shape. */
interface PluginModule {
  id: string;
  server: (input: PluginInput) => Promise<Hooks>;
}

// ============================================================================
// Plugin State
// ============================================================================

const VERSION = "0.2.0";
const DEFAULT_BINARY = "neuralgentics-backend";

/** Shared GoBackendClient instance — initialised once per plugin load. */
let backend: GoBackendClient | null = null;

/** Cached AGENTS.md content (loaded lazily). */
let agentsMdContent: string | null = null;

// ============================================================================
// Helpers
// ============================================================================

/** Resolve the Go backend binary path from env or fallback. */
function resolveBinaryPath(): string {
  return process.env.NEURALGENTICS_BACKEND_PATH ?? DEFAULT_BINARY;
}

/** Load AGENTS.md from disk if not already cached. */
async function loadAgentsMd(directory: string): Promise<string | null> {
  if (agentsMdContent !== null) return agentsMdContent;
  const candidates = [
    resolve(directory, "AGENTS.md"),
    resolve(directory, "..", "AGENTS.md"),
    resolve(process.cwd(), "AGENTS.md"),
  ];
  for (const path of candidates) {
    try {
      agentsMdContent = await readFile(path, "utf-8");
      return agentsMdContent;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ============================================================================
// Tool Builders
// ============================================================================

/**
 * Build a proxy tool that forwards arguments to a Go backend JSON-RPC method
 * and returns the result as a JSON string.
 */
function makeProxyTool(
  method: string,
  description: string,
  argMap: Record<string, ToolArgSchema>,
): ToolDefinition {
  return {
    description,
    args: argMap,
    async execute(args: Record<string, unknown>): Promise<string> {
      if (!backend) {
        return JSON.stringify({ error: "Go backend not initialised" });
      }
      try {
        const result = await backend.call(method, args);
        return JSON.stringify({ success: true, result }, null, 2);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ success: false, error: message }, null, 2);
      }
    },
  };
}

// ============================================================================
// Server Function
// ============================================================================

/**
 * OpenCode plugin server function.
 *
 * Initialises the GoBackendClient and returns Hooks for tools, events,
 * config merging, and cleanup.
 */
async function server(input: PluginInput): Promise<Hooks> {
  const directory = input.directory ?? process.cwd();

  // --------------------------------------------------------------------------
  // Initialise GoBackendClient
  // --------------------------------------------------------------------------
  const binaryPath = resolveBinaryPath();
  backend = new GoBackendClient(binaryPath);
  try {
    await backend.waitForReady();
    console.error(`[Neuralgentics] Go backend ready (${binaryPath})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Neuralgentics] Failed to start Go backend: ${message}`);
    // Continue — tools will return errors until backend is healthy.
  }

  // --------------------------------------------------------------------------
  // Register Tools
  // --------------------------------------------------------------------------
  const tool: Record<string, ToolDefinition> = {
    // --- Memory tools --------------------------------------------------------
    neuralgentics_memory_add: makeProxyTool(
      "memory.add",
      "Add a memory entry to the Neuralgentics database.",
      {
        text: { type: "string", description: "Memory content text" },
        sourceType: {
          type: "string",
          description: "Source type: session, file, web, project, thought",
          default: "session",
        },
        sourcePath: {
          type: "string",
          description: "Optional source file path or URL",
          optional: true,
        },
        metadata: {
          type: "object",
          description: "Optional key-value metadata",
          optional: true,
        },
      },
    ),

    neuralgentics_memory_query: makeProxyTool(
      "memory.query",
      "Query memories with semantic or full-text search.",
      {
        query: { type: "string", description: "Search query text" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
        strategy: {
          type: "string",
          description: "Search strategy: tiered, vector_only, text_only, parallel",
          default: "tiered",
        },
      },
    ),

    neuralgentics_memory_get: makeProxyTool(
      "memory.get",
      "Retrieve a single memory entry by its ID.",
      {
        id: { type: "string", description: "Memory UUID" },
      },
    ),

    neuralgentics_memory_delete: makeProxyTool(
      "memory.delete",
      "Delete a memory entry by its ID.",
      {
        id: { type: "string", description: "Memory UUID to delete" },
      },
    ),

    neuralgentics_memory_adjustTrust: makeProxyTool(
      "memory.adjustTrust",
      "Adjust the trust score of a memory entry.",
      {
        memoryID: { type: "string", description: "Memory UUID" },
        signal: {
          type: "string",
          description: "Trust signal: agent_used, agent_ignored, user_confirmed, user_corrected",
        },
      },
    ),

    // --- Memory manager (lazy tool exposure) --------------------------------
    // Phase 3 of the memoryManager port. This is the entry point for
    // agents to request additional tools on demand. Agents start with only the
    // tools listed in the default initial set, and can request more via this
    // tool. Once a tool has been used 5+ times, the broker allows the agent to
    // bypass it and call the tool directly.
    neuralgentics_memory_manager: {
      description:
        "Manage tool exposure for the current agent. Actions: " +
        "'get_initial_set' returns the default 5-7 tools the agent starts with; " +
        "'request_tool' records a new tool request and returns its schema; " +
        "'get_tools' returns all tools this agent has been exposed to; " +
        "'increment_use' bumps the use count for a tool (and may flip it to bypass mode).",
      args: {
        action: {
          type: "string",
          description:
            "One of: get_initial_set, request_tool, get_tools, increment_use",
        },
        peer_id: {
          type: "string",
          description: "Agent peer ID (default: 'default')",
          default: "default",
        },
        tool_server: {
          type: "string",
          description: "Server name (e.g. 'neuralgentics') — required for request_tool and increment_use",
          optional: true,
        },
        tool_name: {
          type: "string",
          description: "Tool name (e.g. 'memory.add') — required for request_tool and increment_use",
          optional: true,
        },
      },
      execute: async (args, ctx) => {
        const action = String(args.action ?? "");
        const peerID = String(args.peer_id ?? "default");
        if (!backend) {
          throw new Error("Go backend not ready");
        }
        const toStr = (v: unknown): string =>
          typeof v === "string" ? v : JSON.stringify(v);
        switch (action) {
          case "get_initial_set":
            return toStr(await backend.call("agent.getInitialToolSet", { peer_id: peerID }));
          case "request_tool": {
            const server = String(args.tool_server ?? "");
            const name = String(args.tool_name ?? "");
            if (!server || !name) {
              throw new Error("request_tool requires tool_server and tool_name");
            }
            await backend.call("agent.recordToolRequest", {
              peer_id: peerID,
              tool_server: server,
              tool_name: name,
            });
            return JSON.stringify({ success: true, tool_server: server, tool_name: name, peer_id: peerID });
          }
          case "get_tools":
            return toStr(await backend.call("agent.getTools", { peer_id: peerID }));
          case "increment_use": {
            const server = String(args.tool_server ?? "");
            const name = String(args.tool_name ?? "");
            if (!server || !name) {
              throw new Error("increment_use requires tool_server and tool_name");
            }
            return toStr(await backend.call("agent.incrementToolUse", {
              peer_id: peerID,
              tool_server: server,
              tool_name: name,
            }));
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    },

    // --- Orchestrator tools --------------------------------------------------
    neuralgentics_orchestrator_route: makeProxyTool(
      "orchestrator.route",
      "Route a task to the correct agent role based on the Routing Matrix.",
      {
        taskType: { type: "string", description: "Task type string" },
        description: { type: "string", description: "Task description", optional: true },
      },
    ),

    neuralgentics_orchestrator_dispatch: makeProxyTool(
      "orchestrator.dispatch",
      "Dispatch one or more tasks through the orchestrator.",
      {
        tasks: {
          type: "array",
          description: "Array of task objects with id, type, description, userRequest",
        },
      },
    ),

    // --- Broker tools --------------------------------------------------------
    neuralgentics_broker_buildCatalog: makeProxyTool(
      "broker.buildCatalog",
      "Build a token-reduced server catalog for the current role.",
      {
        role: { type: "string", description: "Agent role (default: orchestrator)", default: "orchestrator" },
      },
    ),

    neuralgentics_broker_call: makeProxyTool(
      "broker.call",
      "Call a tool on a specific MCP server through the broker.",
      {
        serverName: { type: "string", description: "MCP server name" },
        toolName: { type: "string", description: "Tool name" },
        args: { type: "object", description: "Tool arguments", optional: true },
      },
    ),

    neuralgentics_broker_matchIntent: makeProxyTool(
      "broker.matchIntent",
      "Match an intent to the best available tool via the broker.",
      {
        intent: { type: "string", description: "User intent description" },
        role: { type: "string", description: "Agent role", default: "orchestrator" },
      },
    ),

    // --- Utility tools -------------------------------------------------------
    neuralgentics_get_agents_md: {
      description:
        "Retrieve the AGENTS.md content for the current project. Used by the orchestrator to inject project context into agent prompts.",
      args: {
        workspace_root: {
          type: "string",
          description: "Workspace root directory (defaults to plugin directory)",
          optional: true,
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const dir = (args.workspace_root as string) || directory;
        const content = await loadAgentsMd(dir);
        if (!content) {
          return "AGENTS.md not found — looked in project root and parent directories";
        }
        return content;
      },
    },

    neuralgentics_ping: {
      description: "Ping the Neuralgentics Go backend to verify connectivity.",
      args: {},
      async execute(): Promise<string> {
        if (!backend) {
          return JSON.stringify({ ok: false, error: "Backend not initialised" });
        }
        try {
          const result = await backend.call("ping", {});
          return JSON.stringify({ ok: true, result }, null, 2);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ ok: false, error: message }, null, 2);
        }
      },
    },
  };

  // --------------------------------------------------------------------------
  // Event Handler
  // --------------------------------------------------------------------------
  const event = async ({
    event,
  }: {
    event: Record<string, unknown>;
  }): Promise<void> => {
    const type = event.type as string;
    switch (type) {
      case "session.created": {
        console.error("[Neuralgentics] Session created — tools ready");
        break;
      }
      case "session.compacting": {
        try {
          const content = await loadAgentsMd(directory);
          if (content && backend) {
            await backend.call("memory.add", {
              text: content,
              sourceType: "context_package",
              metadata: { reason: "compaction_backup", file: "AGENTS.md" },
            });
            console.error("[Neuralgentics] AGENTS.md backed up before compaction");
          }
        } catch (err) {
          console.error("[Neuralgentics] Compaction backup failed:", err);
        }
        break;
      }
      default:
        break;
    }
  };

  // --------------------------------------------------------------------------
  // Config Merger
  // --------------------------------------------------------------------------
  const config = async (cfg: Record<string, unknown>): Promise<void> => {
    (cfg as Record<string, unknown>).neuralgentics = {
      version: VERSION,
      backendBinary: binaryPath,
      backendReady: backend !== null,
      agentsMdLoaded: agentsMdContent !== null,
    };
  };

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------
  const cleanup = async (): Promise<void> => {
    console.error("[Neuralgentics] Plugin shutting down");
    if (backend) {
      try {
        await backend.shutdown();
      } catch {
        // ignore shutdown errors
      }
      backend = null;
    }
  };

  // --------------------------------------------------------------------------
  // Return Hooks
  // --------------------------------------------------------------------------
  return { tool, event, config, cleanup };
}

// ============================================================================
// Default Export — OpenCode Plugin Contract
// ============================================================================

const pluginModule: PluginModule = {
  id: "neuralgentics",
  server,
};

export default pluginModule;

// Also export named pieces for testing / advanced use
export { server, resolveBinaryPath, loadAgentsMd };
export type {
  PluginInput,
  PluginModule,
  Hooks,
  ToolDefinition,
  ToolContext,
  ToolArgSchema,
};
