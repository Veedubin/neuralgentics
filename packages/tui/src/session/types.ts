/**
 * Session Manager Types (T-027)
 *
 * Defines the TypeScript interfaces for the session lifecycle,
 * stateless agent protocol, and seed prompt exchange.
 */

import type { ChatMessage, StreamingCallbacks, OpenCodeStatus } from "../opencode-client/types.js";

// ─── Session State ──────────────────────────────────────────────────────────────

/** The current state of a session managed by SessionManager. */
export type SessionManagerStatus =
  | "idle"        // No session created yet
  | "active"      // Session created, ready for prompts
  | "streaming"   // A prompt is currently streaming a response
  | "degraded";   // OpenCode server offline — memory ops only

// ─── Context Package ────────────────────────────────────────────────────────────

/**
 * A context package stored as a memory when dispatching a sub-agent.
 *
 * This replaces the traditional multi-thousand-token ContextPackage
 * with a lightweight memory reference + a ~200 token seed prompt.
 */
export interface ContextPackage {
  /** The task description (what the sub-agent should do). */
  task: string;
  /** The original user request (verbatim). */
  userRequest: string;
  /** Key decisions or constraints. */
  constraints: string[];
  /** Relevant file paths with explanations. */
  relevantFiles: Array<{ path: string; reason: string }>;
  /** Code snippets extracted for context. */
  codeSnippets: Array<{ file: string; snippet: string }>;
  /** The expected output format. */
  expectedOutput: string;
  /** Which agent role this context is for. */
  targetAgent: string;
  /** Timestamp when this context was created. */
  createdAt: number;
}

/** Result of storing a context package — the memory ID for retrieval. */
export interface ContextStoreResult {
  /** The memory ID assigned to this context package. */
  memoryId: string;
}

// ─── Seed Prompt ────────────────────────────────────────────────────────────────

/**
 * A seed prompt — the lightweight (~200 token) prompt given to sub-agents
 * that contains a memory_id they can use to fetch their full context package.
 */
export interface SeedPrompt {
  /** The rendered seed prompt text (<250 tokens). */
  text: string;
  /** The memory ID where the full context package is stored. */
  memoryId: string;
  /** Token count estimate for the seed prompt. */
  estimatedTokens: number;
}

// ─── Prompt Options ─────────────────────────────────────────────────────────────

/** Options for the SessionManager.prompt() method. */
export interface PromptOptions {
  /** Optional title for the session (used when creating a new session). */
  sessionTitle?: string;
  /** Optional streaming callbacks for progressive rendering. */
  callbacks?: StreamingCallbacks;
  /** Whether to store the prompt in Neuralgentics memory (default: true). */
  storeInMemory?: boolean;
}

// ─── Revert Result ──────────────────────────────────────────────────────────────

/** Result of a session revert operation. */
export interface RevertResult {
  /** The session ID after revert. */
  sessionId: string;
  /** Number of messages removed by the revert. */
  messagesRemoved: number;
}

// ─── Session Manager Events ─────────────────────────────────────────────────────

/** Events emitted by SessionManager. */
export interface SessionManagerEvents {
  /** Session status changed. */
  statusChange: (status: SessionManagerStatus) => void;
  /** A new message was added to the chat. */
  message: (msg: ChatMessage) => void;
  /** A context package was stored. */
  contextStored: (result: ContextStoreResult) => void;
  /** A trust signal was applied to a context memory. */
  trustApplied: (memoryId: string, signal: string) => void;
  /** An error occurred. */
  error: (error: Error) => void;
}

// ─── Session Manager Options ────────────────────────────────────────────────────

/** Configuration for creating a SessionManager. */
export interface SessionManagerOptions {
  /** Whether to auto-create a session on first prompt (default: true). */
  autoCreateSession?: boolean;
  /** Whether to store prompts in Neuralgentics memory (default: true). */
  memoryEnabled?: boolean;
  /** Whether to apply agent_used trust signal on sub-agent completion (default: true). */
  trustSignalsEnabled?: boolean;
}

// ─── Resume Result (T-080) ───────────────────────────────────────────────────────

/** Result of a session resume operation. */
export interface ResumeResult {
  /** Whether the session was successfully resumed from a checkpoint. */
  resumed: boolean;
  /** The checkpoint ID if resumed. */
  checkpointId?: string;
  /** Human-readable age string (e.g. "2.3 hours ago"). */
  age?: string;
  /** Reason for not resuming, if resumed is false. */
  reason?: "no-checkpoint" | "offline" | "already-resumed" | "error";
}

/** Detailed status reported by the /resume command. */
export interface ResumeStatus {
  /** The checkpoint ID. */
  checkpointId: string;
  /** Human-readable age string. */
  age: string;
  /** Total token count at checkpoint time. */
  tokenCount: number;
  /** Model name stored in checkpoint. */
  modelName: string;
  /** Number of opportunity candidates in cache. */
  opportunityCount: number;
}