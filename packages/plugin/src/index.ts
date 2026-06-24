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
 *
 * STATELESS AGENT MODE:
 * When `useStatelessAgents: true` is set in the plugin config (opencode.json),
 * the plugin creates an orchestrator that stores ContextPackages in memini-core
 * before dispatching agents. Agents receive a SeedPrompt with a memory_id
 * instead of the full inline ContextPackage. After the agent completes, the
 * plugin fetches the wrap-up from memini-core and returns a summary.
 * When `useStatelessAgents: false` (default), the original inline flow is used.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MemoryAdapter } from "./adapters/memory.js";
// --- Stateless agent mode imports ---
import {
  validateRouting,
  HttpMemoryAdapter,
  createOrchestrator,
  isStatelessDispatch,
  isStatelessTaskResult,
} from "@neuralgentics/orchestrator";
import type {
  NeuralgenticsOrchestrator,
  OrchestratorConfig,
} from "@neuralgentics/orchestrator";
import type {
  StatelessOrchestrationResult,
  OrchestrationResult,
  StatelessTaskResult,
  Task,
  TaskType,
  AgentRole,
} from "@neuralgentics/orchestrator/types";
// --- End stateless imports ---
import {
  handleCompaction,
  restoreAfterCompaction,
} from "./hooks/compaction.js";
import { SelfEvolutionGate } from "./self-evolution/index.js";

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

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MEMORY_BASE_URL =
  process.env.NEURALGENTICS_MEMORY_URL ?? "http://localhost:8900";
const DEFAULT_AGENTS_MD_PATH = resolve(process.cwd(), "AGENTS.md");
const VERSION = "0.1.0";

// ============================================================================
// Shared State
// ============================================================================

let memory: MemoryAdapter;
let agentsMdContent: string | null = null;

// --- Stateless agent mode state ---
// When useStatelessAgents is enabled, these hold the orchestrator instance
// and track pending tasks by their contextMemoryId for wrap-up retrieval.
let orchestrator: NeuralgenticsOrchestrator | null = null;
let useStatelessAgents = false;
let httpMemory: HttpMemoryAdapter | null = null;

/** Tracks in-flight stateless dispatches by taskId for completeTaskCycle lookups */
const pendingStatelessTasks = new Map<
  string,
  { contextMemoryId: string; agent: AgentRole }
>();
// --- End stateless state ---

// ============================================================================
// Plugin Implementation
// ============================================================================

/**
 * Neuralgentics Plugin — OpenCode Plugin API
 *
 * Called by OpenCode when the plugin is activated. Returns an object
 * with tool, event, config, and cleanup keys.
 */
export const NeuralgenticsPlugin = async (
  ctx: PluginContext,
): Promise<PluginOutput> => {
  const baseUrl =
    (ctx.pluginConfig?.memoryBaseUrl as string) ?? DEFAULT_MEMORY_BASE_URL;
  const agentsMdPath =
    (ctx.pluginConfig?.agentsMdPath as string) ?? DEFAULT_AGENTS_MD_PATH;

  // --- Stateless agent mode: read configuration ---
  useStatelessAgents =
    (ctx.pluginConfig?.useStatelessAgents as boolean) ?? false;

  memory = new MemoryAdapter({ baseUrl });

  // When stateless mode is enabled, create the HttpMemoryAdapter and orchestrator.
  // HttpMemoryAdapter talks to memini-core's /memory/ routes (used by the
  // stateless protocol), while the local MemoryAdapter uses /api/v1/ routes
  // for the existing compaction/save_tool_result tools.
  if (useStatelessAgents) {
    httpMemory = new HttpMemoryAdapter(baseUrl);
    const skillsDir =
      (ctx.pluginConfig?.skillsDir as string) ??
      resolve(process.cwd(), "skills");
    const orchestratorConfig: OrchestratorConfig = {
      skillsDir,
      memory: httpMemory,
      strictness:
        (ctx.pluginConfig?.strictness as OrchestratorConfig["strictness"]) ??
        "standard",
      useStatelessAgents: true,
    };
    orchestrator = createOrchestrator(orchestratorConfig);
    console.log(`[Neuralgentics] Stateless agent mode ENABLED`);
  }
  // --- End stateless mode initialization ---

  // Load AGENTS.md at activation time
  try {
    agentsMdContent = await readFile(agentsMdPath, "utf-8");
  } catch {
    console.warn("[Neuralgentics] AGENTS.md not found at:", agentsMdPath);
  }

  // Log activation
  try {
    const log = (ctx.client as { app?: { log?: (msg: string) => void } }).app
      ?.log;
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
        "Validate agent routing against the Routing Matrix. Call before delegating a task to ensure the correct agent is selected.",
      inputSchema: {
        type: "object",
        properties: {
          taskType: {
            type: "string",
            description:
              'The type of task (e.g., "code", "architecture", "testing")',
          },
          agentRole: {
            type: "string",
            description:
              'The agent role being considered (e.g., "coder", "architect")',
          },
        },
        required: ["taskType", "agentRole"],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const taskType = args.taskType as string;
        const agentRole = args.agentRole as string;

        if (!taskType || !agentRole) {
          return "Error: taskType and agentRole are required";
        }

        const validation = validateRouting(
          taskType as TaskType,
          agentRole as AgentRole,
        );

        if (validation.valid) {
          return `Routing VALID: ${agentRole} is authorized for ${taskType}`;
        }

        return `Routing BLOCKED: ${validation.violation ?? "Unknown violation"}`;
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
        "Save a tool execution result to neuralgentics memory. Call after tool execution to persist context.",
      inputSchema: {
        type: "object",
        properties: {
          agentName: {
            type: "string",
            description: "Name of the agent that executed the tool",
          },
          result: {
            type: "string",
            description: "The tool execution result to save",
          },
          durationMs: {
            type: "number",
            description: "Execution duration in milliseconds",
          },
        },
        required: ["agentName", "result"],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const agentName = args.agentName as string;
        const result = args.result as string;
        const durationMs = (args.durationMs as number) ?? 0;

        if (!agentName || !result) {
          return "Error: agentName and result are required";
        }

        try {
          const memoryId = await memory.addMemory(result, {
            type: "tool-result",
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
        "Retrieve the AGENTS.md content for the current project. Used by the orchestrator to inject project context into agent prompts.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      async execute(): Promise<string> {
        if (!agentsMdContent) {
          return "AGENTS.md not loaded — file not found at activation time";
        }
        return agentsMdContent;
      },
    },

    // ------------------------------------------------------------------------
    // Tool: Compaction backup — explicit version for orchestrator calls
    //
    // This tool provides an explicit way to backup critical workspace files
    // (AGENTS.md, TASKS.md) to memory before compaction removes context.
    // Uses the dedicated compaction hook for robust file-based backup
    // with trust boosting and compaction event recording.
    // ------------------------------------------------------------------------
    neuralgentics_compaction_backup: {
      description:
        "Backup critical workspace files (AGENTS.md, TASKS.md) to memory before compaction removes them. Call when the session is about to be compacted.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_root: {
            type: "string",
            description: "Workspace root directory (defaults to cwd)",
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const workspaceRoot = (args.workspace_root as string) || process.cwd();

        try {
          const result = await handleCompaction(memory, workspaceRoot);
          return JSON.stringify(
            {
              success: result.success,
              backedUp: result.backedUp,
              failed: result.failed,
              memoryIds: result.memoryIds,
            },
            null,
            2,
          );
        } catch (err) {
          return `Compaction backup failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    // ------------------------------------------------------------------------
    // Tool: Compaction restore — restore context after compaction
    //
    // Queries memory for the latest compaction backups and returns
    // the content for re-injection into the session.
    // ------------------------------------------------------------------------
    neuralgentics_compaction_restore: {
      description:
        "Restore critical workspace files from memory after compaction. Retrieves the latest backups of AGENTS.md, TASKS.md, etc.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_root: {
            type: "string",
            description: "Workspace root directory (defaults to cwd)",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Specific files to restore (defaults to AGENTS.md, TASKS.md)",
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const workspaceRoot = (args.workspace_root as string) || process.cwd();
        const files = args.files as string[] | undefined;

        try {
          const results = await restoreAfterCompaction(
            memory,
            workspaceRoot,
            files,
          );
          return JSON.stringify(results, null, 2);
        } catch (err) {
          return `Compaction restore failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    // ------------------------------------------------------------------------
    // Tool: Self-evolution gate — detect and create skills/agents
    //
    // Runs the self-evolution gate cycle: finds pattern candidates from
    // memory, evaluates them against 4 criteria, and optionally creates
    // skills/agents for qualified candidates.
    // ------------------------------------------------------------------------
    neuralgentics_evolution_gate: {
      description:
        "Run the self-evolution gate cycle. Detects repeated patterns from session history and evaluates them for skill/agent creation.",
      inputSchema: {
        type: "object",
        properties: {
          auto_create: {
            type: "boolean",
            description:
              "Automatically create qualified skills/agents (default: false)",
          },
          no_skills: {
            type: "boolean",
            description: "Skip skill evaluation (default: false)",
          },
          no_agents: {
            type: "boolean",
            description: "Skip agent evaluation (default: false)",
          },
          min_trigger_count: {
            type: "number",
            description:
              "Minimum trigger count to consider a candidate (default: 3)",
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const gate = new SelfEvolutionGate(
          {
            autoCreate: (args.auto_create as boolean) ?? false,
            noSkills: (args.no_skills as boolean) ?? false,
            noAgents: (args.no_agents as boolean) ?? false,
            minTriggerCount: (args.min_trigger_count as number) ?? 3,
          },
          memory,
        );

        try {
          const result = await gate.run({ autoCreate: true });
          return JSON.stringify(result, null, 2);
        } catch (err) {
          return `Evolution gate failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    // ========================================================================
    // STATELESS AGENT MODE TOOLS
    // These tools are only functional when useStatelessAgents is enabled.
    // When stateless mode is off, they return an error message.
    // ========================================================================

    // ------------------------------------------------------------------------
    // Tool: Dispatch task — stateless orchestrator dispatch
    //
    // When stateless mode is enabled, this tool:
    // 1. Constructs a Task object from the input parameters
    // 2. Calls orchestrator.handleTask() which stores the ContextPackage
    //    in memini-core and returns a SeedPrompt
    // 3. Returns the seed prompt text for the agent to execute
    //
    // The agent then:
    // - Fetches its context from memini-core using the memory_id
    // - Does the work
    // - Stores wrap-up in memini-core
    // - Returns {memory_id, description} to the caller
    // - The caller then calls neuralgentics_complete_task to finalize
    // ------------------------------------------------------------------------
    neuralgentics_dispatch_task: {
      description:
        "Dispatch a task through the stateless orchestrator. Stores ContextPackage in memini-core and returns a SeedPrompt for the agent. Requires useStatelessAgents: true in plugin config.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Unique task identifier",
          },
          task_type: {
            type: "string",
            description:
              'Task type (e.g., "code-implementation", "architecture-design", "testing")',
          },
          description: {
            type: "string",
            description: "Task description for the agent",
          },
          user_request: {
            type: "string",
            description: "Original user request (verbatim)",
          },
          priority: {
            type: "string",
            description:
              'Task priority: "low", "medium", or "high" (default: "medium")',
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Relevant file paths for the task",
          },
        },
        required: ["task_id", "task_type", "description", "user_request"],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        if (!useStatelessAgents || !orchestrator) {
          return "Error: Stateless agent mode is not enabled. Set useStatelessAgents: true in plugin config.";
        }

        const task: Task = {
          id: args.task_id as string,
          type: (args.task_type as TaskType) ?? "code-implementation",
          description: args.description as string,
          userRequest: args.user_request as string,
          priority: (args.priority as Task["priority"]) ?? "medium",
          files: args.files as string[] | undefined,
        };

        try {
          const result = await orchestrator.handleTask(task);

          if (isStatelessDispatch(result)) {
            const statelessResult = result as StatelessOrchestrationResult;

            // Track the pending task for completeTaskCycle lookups
            pendingStatelessTasks.set(task.id, {
              contextMemoryId: statelessResult.contextMemoryId,
              agent: statelessResult.agent,
            });

            return JSON.stringify(
              {
                mode: "stateless",
                agent: statelessResult.agent,
                contextMemoryId: statelessResult.contextMemoryId,
                seedPrompt: statelessResult.seedPrompt.prompt,
                executionPlan: statelessResult.executionPlan,
              },
              null,
              2,
            );
          }

          // Fallback: if useStatelessAgents is true but handleTask returned
          // an inline result (shouldn't happen, but handle gracefully)
          const inlineResult = result as OrchestrationResult;
          return JSON.stringify(
            {
              mode: "inline",
              agent: inlineResult.agent,
              contextPackage: inlineResult.contextPackage,
              executionPlan: inlineResult.executionPlan,
            },
            null,
            2,
          );
        } catch (err) {
          return `Dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    // ------------------------------------------------------------------------
    // Tool: Complete task — fetch wrap-up from memini-core after agent
    //
    // After the agent finishes and returns {memory_id, description},
    // call this tool to:
    // 1. Fetch the wrap-up from memini-core
    // 2. Adjust trust on the context memory (+0.05 agent_used)
    // 3. Return the full AgentWrapUp summary
    // ------------------------------------------------------------------------
    neuralgentics_complete_task: {
      description:
        "Complete a stateless task cycle. Call after the agent returns {memory_id, description} to fetch the wrap-up from memini-core, adjust trust, and return the summary. Requires useStatelessAgents: true in plugin config.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID (must match a previous dispatch_task call)",
          },
          memory_id: {
            type: "string",
            description: "Memory ID of the agent wrap-up stored in memini-core",
          },
          description: {
            type: "string",
            description: "One-line summary from the agent",
          },
        },
        required: ["task_id", "memory_id", "description"],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        if (!useStatelessAgents || !orchestrator) {
          return "Error: Stateless agent mode is not enabled. Set useStatelessAgents: true in plugin config.";
        }

        const taskId = args.task_id as string;
        const agentResult: StatelessTaskResult = {
          memory_id: args.memory_id as string,
          description: args.description as string,
        };

        // Look up the contextMemoryId from the pending dispatch
        const pending = pendingStatelessTasks.get(taskId);
        if (!pending) {
          return `Error: No pending stateless dispatch found for task_id: ${taskId}. Was dispatch_task called first?`;
        }

        try {
          const wrapUp = await orchestrator.completeTaskCycle(
            taskId,
            agentResult,
            pending.contextMemoryId,
          );

          // Clean up the pending task
          pendingStatelessTasks.delete(taskId);

          return JSON.stringify(
            {
              success: true,
              summary: wrapUp.summary,
              filesModified: wrapUp.filesModified,
              filesCreated: wrapUp.filesCreated,
              followUpTasks: wrapUp.followUpTasks,
              errors: wrapUp.errors,
              warnings: wrapUp.warnings,
            },
            null,
            2,
          );
        } catch (err) {
          return `Complete task cycle failed: ${err instanceof Error ? err.message : String(err)}`;
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
      case "session.created": {
        try {
          const log = (ctx.client as { app?: { log?: (msg: string) => void } })
            .app?.log;
          log?.("Session created — Neuralgentics ready");
        } catch {
          // Logging not available
        }
        break;
      }

      case "session.idle": {
        try {
          const log = (ctx.client as { app?: { log?: (msg: string) => void } })
            .app?.log;
          log?.("Session idle — Neuralgentics tools available");
        } catch {
          // Logging not available
        }
        break;
      }

      case "session.compacting": {
        // If OpenCode emits this event, automatically back up critical files
        // to memory before compaction removes them.
        // Uses the compaction hook which backs up AGENTS.md, TASKS.md, etc.
        try {
          const result = await handleCompaction(memory, process.cwd());
          const log = (ctx.client as { app?: { log?: (msg: string) => void } })
            .app?.log;
          log?.(
            `Compaction backup: ${result.backedUp.length} files saved, ${result.failed.length} failed`,
          );
        } catch (err) {
          console.error(
            "[neuralgentics] Compaction backup failed:",
            err instanceof Error ? err.message : err,
          );
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
      // --- Stateless agent mode config ---
      useStatelessAgents,
      // AGENTS.md content is available via the neuralgentics_get_agents_md tool
      // rather than being force-injected into system prompts.
      // Orchestrators should call the tool when building context packages.
    };
  };

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  const cleanupHandler = async (): Promise<void> => {
    console.log("[Neuralgentics] Plugin shutting down");
    // --- Stateless agent mode cleanup ---
    pendingStatelessTasks.clear();
    orchestrator = null;
    httpMemory = null;
    // --- End stateless cleanup ---
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

// --- Stateless agent mode getters ---

/**
 * Get the orchestrator instance (only available when useStatelessAgents is enabled).
 * Returns null when stateless mode is disabled.
 */
export function getOrchestrator(): NeuralgenticsOrchestrator | null {
  return orchestrator;
}

/**
 * Check if stateless agent mode is enabled.
 */
export function isStatelessMode(): boolean {
  return useStatelessAgents;
}

// --- End stateless getters ---

// ============================================================================
// Re-exports from sub-modules
// ============================================================================

export {
  handleCompaction,
  restoreAfterCompaction,
} from "./hooks/compaction.js";
export {
  backupFileToMemory,
  restoreContextFromMemory,
} from "./hooks/backup.js";
export { SelfEvolutionGate } from "./self-evolution/index.js";
export {
  computeAllScores,
  meetsThreshold,
  scoreRepetition,
  scoreInterfaceClarity,
  scoreIndependence,
  scoreTimeSavings,
} from "./self-evolution/evaluator.js";
export {
  generateSkillMarkdown,
  generateAgentEntry,
  patternToSkillParams,
} from "./self-evolution/templates.js";
export {
  SkillLookup,
  wordOverlapCosine,
  tokenize,
  loadSkillBody,
  MIN_SCORE,
  STOPWORDS,
} from "./self-evolution/skill_lookup.js";
export type { SkillMatchResult } from "./self-evolution/skill_lookup.js";
export {
  HttpBrokerClient,
  StubBrokerClient,
  DEFAULT_BROKER_ENDPOINT,
} from "./self-evolution/broker_client.js";
export type {
  BrokerSkillSummary,
  SkillCatalogResponse,
  BrokerClient,
} from "./self-evolution/broker_client.js";
export {
  ExternalSkillsFetcher,
  DEFAULT_REPOS,
  readEnvFile,
} from "./self-evolution/external_fetcher.js";
export type {
  RepoConfig,
  ManifestRepoEntry,
  Manifest,
  FetchResult,
  EnvReader,
  ExecFn,
} from "./self-evolution/external_fetcher.js";
export type {
  CompactionBackupResult,
  CompactionRestoreFile,
  CompactionRestoreResult,
  PatternType,
  CriteriaResult,
  PatternCandidate,
  EvolutionResult,
  SelfEvolutionGateOptions,
  CriteriaScores,
} from "./types.js";
export { CRITERION_THRESHOLD } from "./types.js";

// --- Stateless agent mode re-exports ---
export {
  isStatelessDispatch as isStatelessOrchestratorResult,
  isStatelessTaskResult,
  formatSeedPrompt,
} from "@neuralgentics/orchestrator";
export type {
  SeedPrompt,
  StatelessOrchestrationResult,
  StatelessTaskResult,
  AgentWrapUp,
  ContextPackage,
  ContextPackageMetadata,
  AgentWrapUpMetadata,
} from "@neuralgentics/orchestrator/types";
// --- End stateless re-exports ---
