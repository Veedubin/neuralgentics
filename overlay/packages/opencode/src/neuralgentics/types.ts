/**
 * Neuralgentics shared type definitions.
 *
 * These types define the data contracts used across the Neuralgentics overlay:
 * agent definitions, routing rules, context packages, memory records,
 * and broker catalog entries.
 */

/** Describes a Neuralgentics agent and its operational parameters. */
export interface AgentDefinition {
  /** Unique agent name (e.g. "neuralgentics-coder"). */
  name: string;
  /** Human-readable description of the agent's role. */
  description: string;
  /** Ollama / cloud model identifier the agent should use. */
  model: string;
  /** Execution mode — "all" for full access, "subagent" for delegated, "primary" for top-level. */
  mode: "all" | "subagent" | "primary";
  /** Maximum protocol steps the agent may execute (0 = unlimited). */
  steps?: number;
}

/** Encodes a mandatory routing rule — which agent must handle a task type
 *  and which agents must NEVER be assigned to it. */
export interface RoutingRule {
  /** The canonical agent name that MUST handle this task type. */
  primary: string;
  /** Agent names that MUST NOT be assigned this task type. */
  never: string[];
}

/** A self-contained context package passed to a stateless agent.
 *  Contains a memory reference so the agent can fetch full context at runtime. */
export interface ContextPackage {
  /** ID of the stored memory record in memini-core. */
  memoryId: string;
  /** Seed prompt that bootstraps the agent with enough context to start. */
  seedPrompt: string;
  /** Short description of the task. */
  task: string;
  /** Name of the agent this package is prepared for. */
  agent: string;
}

/** A record returned from the memini-core memory server. */
export interface MemoryRecord {
  /** Unique memory identifier. */
  id: string;
  /** The memory content text. */
  content: string;
  /** Optional key-value metadata attached to the memory. */
  metadata?: Record<string, unknown>;
}

/** An entry in the MCP broker's server catalog. */
export interface ServerCatalogEntry {
  /** Server name (e.g. "github", "memini-ai"). */
  name: string;
  /** Human-readable description of the server. */
  description: string;
  /** Number of tools this server exposes. */
  toolCount: number;
}

/** A tool match result from the broker's intent-matching system. */
export interface ToolMatch {
  /** The MCP server that owns the matched tool. */
  server: string;
  /** The tool name within the server. */
  tool: string;
  /** Confidence score (0.0 – 1.0) for the match. */
  confidence: number;
}