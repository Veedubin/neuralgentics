/**
 * SessionManager — Orchestrates chat session lifecycle and the
 * stateless agent protocol (T-027).
 *
 * Glues together:
 * - OpenCodeClient (T-023) for session lifecycle (create/prompt/messages/revert)
 * - NeuralgenticsClient (T-020) for memory storage and trust signals
 *
 * The stateless agent protocol replaces multi-thousand-token ContextPackages
 * with a ~200 token seed prompt that references a memory-stored context.
 */

import { randomUUID } from "node:crypto";
import { OpenCodeClient } from "../opencode-client/client.js";
import { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import type { ChatMessage, StreamingCallbacks } from "../opencode-client/types.js";
import type {
  SessionManagerStatus,
  SessionManagerOptions,
  ContextPackage,
  ContextStoreResult,
  SeedPrompt,
  RevertResult,
  PromptOptions,
} from "./types.js";

// ─── Seed Prompt Template ──────────────────────────────────────────────────────

/**
 * Seed prompt template for the stateless agent protocol.
 * This template is <250 tokens — the sub-agent fetches its full context
 * from memory using the provided memory_id.
 */
const SEED_PROMPT_TEMPLATE = `Task: {{task}}
Memory ID: {{memory_id}}
Action: Fetch the ContextPackage from NeuralgenticsClient using the Memory ID above and execute the task.

Context: {{context_summary}}
Constraints: {{constraints}}
Expected Output: {{expected_output}}

Retrieve the full context from memory before starting. Apply agent_used trust signal on completion.`;

/** Approximate token count for the seed prompt template (conservative estimate). */
const SEED_PROMPT_TEMPLATE_TOKENS = 120;

// ─── Event Listener Types ───────────────────────────────────────────────────────

type StatusListener = (status: SessionManagerStatus) => void;
type MessageListener = (msg: ChatMessage) => void;
type ContextStoredListener = (result: ContextStoreResult) => void;
type TrustAppliedListener = (memoryId: string, signal: string) => void;
type ErrorListener = (error: Error) => void;

// ─── SessionManager ─────────────────────────────────────────────────────────────

/**
 * SessionManager — orchestrates the chat session lifecycle with the
 * stateless agent protocol.
 *
 * Usage:
 * ```ts
 * const sm = new SessionManager({ opencode, neuralgentics });
 * const sessionId = await sm.createSession("My Session");
 * const result = await sm.prompt(sessionId, "Hello!");
 * const history = await sm.messages(sessionId);
 * await sm.revert(sessionId);
 * ```
 */
export class SessionManager {
  // ─── Dependencies ──────────────────────────────────────────────────────

  private readonly opencode: OpenCodeClient;
  private readonly neuralgentics: NeuralgenticsClient;

  // ─── Configuration ─────────────────────────────────────────────────────

  private readonly autoCreateSession: boolean;
  private readonly memoryEnabled: boolean;
  private readonly trustSignalsEnabled: boolean;

  // ─── State ──────────────────────────────────────────────────────────────

  private _status: SessionManagerStatus = "idle";
  private _sessionId: string | null = null;
  private _messageCount = 0;

  // ─── Event listeners ────────────────────────────────────────────────────

  private statusListeners: StatusListener[] = [];
  private messageListeners: MessageListener[] = [];
  private contextStoredListeners: ContextStoredListener[] = [];
  private trustAppliedListeners: TrustAppliedListener[] = [];
  private errorListeners: ErrorListener[] = [];

  constructor(
    options: {
      opencode: OpenCodeClient;
      neuralgentics: NeuralgenticsClient;
    } & Partial<SessionManagerOptions>,
  ) {
    this.opencode = options.opencode;
    this.neuralgentics = options.neuralgentics;
    this.autoCreateSession = options.autoCreateSession ?? true;
    this.memoryEnabled = options.memoryEnabled ?? true;
    this.trustSignalsEnabled = options.trustSignalsEnabled ?? true;

    // Forward OpenCode status changes
    this.opencode.on("statusChange", (status: unknown) => {
      const ocStatus = status as string;
      if (ocStatus === "ready") {
        this.setStatus("active");
      } else if (ocStatus === "degraded") {
        this.setStatus("degraded");
      } else if (ocStatus === "offline") {
        this.setStatus("idle");
      }
    });
  }

  // ─── Public Properties ──────────────────────────────────────────────────

  /** Current session manager status. */
  get status(): SessionManagerStatus {
    return this._status;
  }

  /** Current OpenCode session ID (null if no session created yet). */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Number of messages in the current session. */
  get messageCount(): number {
    return this._messageCount;
  }

  /** Whether the session manager is ready for prompt operations. */
  get isReady(): boolean {
    return this._status === "active" || this._status === "streaming";
  }

  // ─── Event Subscription ─────────────────────────────────────────────────

  /**
   * Register event listeners for session lifecycle events.
   */
  on(
    event: "statusChange" | "message" | "contextStored" | "trustApplied" | "error",
    listener: (...args: unknown[]) => void,
  ): this {
    switch (event) {
      case "statusChange":
        this.statusListeners.push(listener as StatusListener);
        break;
      case "message":
        this.messageListeners.push(listener as MessageListener);
        break;
      case "contextStored":
        this.contextStoredListeners.push(listener as ContextStoredListener);
        break;
      case "trustApplied":
        this.trustAppliedListeners.push(listener as TrustAppliedListener);
        break;
      case "error":
        this.errorListeners.push(listener as ErrorListener);
        break;
    }
    return this;
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────────

  /**
   * Create a new OpenCode session.
   * @param title - Optional session title.
   * @returns The session ID string.
   */
  async createSession(title?: string): Promise<string> {
    const sessionId = await this.opencode.createSession(
      title ?? `Neuralgentics Session ${new Date().toISOString()}`,
    );
    this._sessionId = sessionId;
    this._messageCount = 0;
    this.setStatus("active");
    return sessionId;
  }

  /**
   * Send a prompt to the current session and return the response.
   * Streams chunks back via optional callbacks.
   *
   * @param sessionId - The session ID (or uses current session if null).
   * @param message - The text prompt to send.
   * @param options - Optional prompt options (callbacks, title, memory storage).
   * @returns The full response text and metadata.
   */
  async prompt(
    sessionId: string | null,
    message: string,
    options?: PromptOptions,
  ): Promise<{ textContent: string; sessionId: string; messageId: string }> {
    const sid = sessionId ?? this._sessionId;
    if (!sid) {
      if (this.autoCreateSession) {
        const newId = await this.createSession(options?.sessionTitle);
        return this.promptWithSession(newId, message, options);
      }
      throw new Error("No active session. Call createSession() first or enable autoCreateSession.");
    }

    return this.promptWithSession(sid, message, options);
  }

  /**
   * Get the full message history for a session.
   * @param sessionId - The session ID (uses current session if null).
   * @returns An array of ChatMessage objects.
   */
  async messages(sessionId?: string | null): Promise<ChatMessage[]> {
    const sid = sessionId ?? this._sessionId;
    if (!sid) {
      throw new Error("No active session. Call createSession() first.");
    }
    return this.opencode.messages(sid);
  }

  /**
   * Revert a session to a clean state (clears/rewinds messages).
   * @param sessionId - The session ID (uses current session if null).
   * @param messageId - Optional message ID to revert to.
   * @returns The result of the revert operation.
   */
  async revert(sessionId?: string | null, messageId?: string): Promise<RevertResult> {
    const sid = sessionId ?? this._sessionId;
    if (!sid) {
      throw new Error("No active session. Call createSession() first.");
    }

    // Count messages before revert
    const messagesBefore = await this.opencode.messages(sid);
    const countBefore = messagesBefore.length;

    // Perform the revert
    const revertedId = await this.opencode.revert(sid, messageId);

    // Count messages after revert
    const messagesAfter = await this.opencode.messages(sid);
    const countAfter = messagesAfter.length;

    const removed = Math.max(0, countBefore - countAfter);
    this._messageCount = countAfter;

    return {
      sessionId: revertedId,
      messagesRemoved: removed,
    };
  }

  // ─── Stateless Agent Protocol ───────────────────────────────────────────

  /**
   * Store a context package as a Neuralgentics memory entry.
   * The context is serialized as JSON and stored with sourceType "context_package".
   *
   * @param context - The context package to store.
   * @returns The memory ID for later retrieval.
   */
  async storeContext(context: ContextPackage): Promise<ContextStoreResult> {
    if (!this.memoryEnabled) {
      throw new Error("Memory storage is disabled. Enable memoryEnabled to store context packages.");
    }

    const content = JSON.stringify(context);

    const result = await this.neuralgentics.call("memory.add", {
      content,
      sourceType: "context_package",
      metadata: {
        type: "context_package",
        targetAgent: context.targetAgent,
        task: context.task,
        createdAt: context.createdAt,
      },
    });

    const memoryId = (result as { id: string }).id;

    const storeResult: ContextStoreResult = { memoryId };

    // Notify listeners
    for (const listener of this.contextStoredListeners) {
      try {
        listener(storeResult);
      } catch {
        // Swallow listener errors
      }
    }

    console.log(`[session] Context package stored: ${memoryId} (agent=${context.targetAgent})`);
    return storeResult;
  }

  /**
   * Fetch a context package from memory by its ID.
   *
   * @param memoryId - The memory ID returned by storeContext().
   * @returns The deserialized ContextPackage.
   */
  async fetchContext(memoryId: string): Promise<ContextPackage> {
    const result = await this.neuralgentics.call("memory.get", {
      id: memoryId,
    });

    const entry = result as Record<string, unknown>;
    const content = typeof entry.content === "string"
      ? entry.content
      : JSON.stringify(entry.content ?? entry);

    try {
      return JSON.parse(content) as ContextPackage;
    } catch {
      throw new Error(`Failed to parse context package from memory ${memoryId}: content is not valid JSON`);
    }
  }

  /**
   * Generate a seed prompt for a sub-agent.
   * The seed prompt is <250 tokens and contains a memory_id reference
   * for the sub-agent to fetch its full context package.
   *
   * @param memoryId - The memory ID where the full context is stored.
   * @param context - The context package (used for summary fields).
   * @returns A SeedPrompt with rendered text and token estimate.
   */
  generateSeedPrompt(memoryId: string, context: ContextPackage): SeedPrompt {
    const text = SEED_PROMPT_TEMPLATE
      .replace("{{task}}", context.task)
      .replace("{{memory_id}}", memoryId)
      .replace("{{context_summary}}", context.task.slice(0, 100))
      .replace("{{constraints}}", context.constraints.slice(0, 3).join("; "))
      .replace("{{expected_output}}", context.expectedOutput.slice(0, 80));

    // Conservative token estimate: ~4 chars per token
    const estimatedTokens = Math.ceil(text.length / 4);

    return {
      text,
      memoryId,
      estimatedTokens,
    };
  }

  /**
   * Apply a trust signal to a context memory.
   * Typically called when a sub-agent completes its task.
   *
   * @param memoryId - The memory ID of the context package.
   * @param signal - The trust signal (e.g., "agent_used", "user_confirmed").
   * @returns The trust adjustment result.
   */
  async applyTrustSignal(
    memoryId: string,
    signal: string = "agent_used",
  ): Promise<{ oldScore: number; newScore: number; adjustment: number }> {
    if (!this.trustSignalsEnabled) {
      return { oldScore: 0, newScore: 0, adjustment: 0 };
    }

    const result = await this.neuralgentics.call("memory.adjustTrust", {
      memoryId,
      signal,
    });

    const typed = result as { oldScore: number; newScore: number; adjustmentAmount: number };

    // Notify listeners
    for (const listener of this.trustAppliedListeners) {
      try {
        listener(memoryId, signal);
      } catch {
        // Swallow listener errors
      }
    }

    console.log(
      `[session] Trust signal applied: ${signal} on ${memoryId} ` +
      `(${typed.oldScore?.toFixed(2) ?? "?"} → ${typed.newScore?.toFixed(2) ?? "?"})`,
    );

    return {
      oldScore: typed.oldScore ?? 0,
      newScore: typed.newScore ?? 0,
      adjustment: typed.adjustmentAmount ?? 0,
    };
  }

  /**
   * Convenience method: store a context package and generate its seed prompt.
   * This is the primary entry point for dispatching sub-agents.
   *
   * @param context - The context package to store.
   * @returns The seed prompt and metadata.
   */
  async dispatchAgent(context: ContextPackage): Promise<{
    seedPrompt: SeedPrompt;
    contextResult: ContextStoreResult;
  }> {
    const contextResult = await this.storeContext(context);
    const seedPrompt = this.generateSeedPrompt(contextResult.memoryId, context);
    return { seedPrompt, contextResult };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  /**
   * Send a prompt to a specific session with streaming and memory storage.
   */
  private async promptWithSession(
    sessionId: string,
    message: string,
    options?: PromptOptions,
  ): Promise<{ textContent: string; sessionId: string; messageId: string }> {
    this.setStatus("streaming");

    try {
      const result = await this.opencode.prompt(sessionId, message, options?.callbacks);

      this._messageCount += 2; // user message + assistant response

      // Optionally store the prompt exchange in memory
      if (this.memoryEnabled && (options?.storeInMemory ?? true)) {
        try {
          await this.neuralgentics.call("memory.add", {
            content: `User: ${message}\nAssistant: ${result.textContent}`,
            sourceType: "session",
            metadata: {
              sessionId,
              messageId: result.messageId,
              type: "chat_exchange",
            },
          });
        } catch (err: unknown) {
          // Memory storage failure is non-critical — log and continue
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[session] Failed to store chat exchange in memory: ${errMsg}`);
        }
      }

      this.setStatus("active");
      return {
        textContent: result.textContent,
        sessionId: result.sessionId,
        messageId: result.messageId,
      };
    } catch (err: unknown) {
      this.setStatus("active");
      const error = err instanceof Error ? err : new Error(String(err));

      // Notify error listeners
      for (const listener of this.errorListeners) {
        try {
          listener(error);
        } catch {
          // Swallow listener errors
        }
      }

      throw error;
    }
  }

  /**
   * Update status and notify listeners.
   */
  private setStatus(status: SessionManagerStatus): void {
    const prev = this._status;
    this._status = status;
    if (prev !== status) {
      console.log(`[session] Status: ${prev} → ${status}`);
      for (const listener of this.statusListeners) {
        try {
          listener(status);
        } catch {
          // Swallow listener errors
        }
      }
    }
  }
}