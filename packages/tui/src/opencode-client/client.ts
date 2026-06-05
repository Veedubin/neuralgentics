/**
 * OpenCodeClient — Manages the OpenCode server and SDK client (T-023).
 *
 * Spawns an OpenCode server as a child process on localhost:4096 using
 * `createOpencode()` from `@opencode-ai/sdk`, then provides typed methods
 * for the session lifecycle the TUI needs:
 *
 *   createSession → prompt → messages → abort → revert → summarize → init
 *
 * Design patterns follow T-020's NeuralgenticsClient (child process lifecycle)
 * and T-022's sidecar.ts (port conflict detection, degraded mode, clean shutdown).
 */

import { randomUUID } from "node:crypto";
import {
  createOpencode,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import type {
  OpenCodeClientOptions,
  OpenCodeStatus,
  ChatMessage,
  StreamingCallbacks,
  PromptResult,
} from "./types.js";
import { PortConflictError, OpenCodeStartError } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4096;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;

// ─── OpenCodeClient ─────────────────────────────────────────────────────────────

type StatusListener = (status: OpenCodeStatus) => void;
type MessageListener = (msg: ChatMessage) => void;
type CrashListener = (error: Error) => void;

/**
 * OpenCodeClient — manages the OpenCode server lifecycle and provides
 * typed access to the OpenCode SDK session APIs.
 *
 * Usage:
 * ```ts
 * const oc = new OpenCodeClient();
 * await oc.start();
 * const sessionId = await oc.createSession("My Session");
 * const result = await oc.prompt(sessionId, "Hello!");
 * await oc.shutdown();
 * ```
 */
export class OpenCodeClient {
  // ─── Configuration ────────────────────────────────────────────────────────
  private readonly hostname: string;
  private readonly port: number;
  private readonly startupTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly abortSignal?: AbortSignal;

  // ─── State ───────────────────────────────────────────────────────────────
  private _status: OpenCodeStatus = "offline";
  private client: OpencodeClient | null = null;
  private serverClose: (() => void) | null = null;
  private currentSessionId: string | null = null;
  private startPromise: Promise<void> | null = null;

  // ─── Event listeners ─────────────────────────────────────────────────────
  private statusListeners: StatusListener[] = [];
  private messageListeners: MessageListener[] = [];
  private crashListeners: CrashListener[] = [];

  // ─── Shutdown flags ──────────────────────────────────────────────────────
  private shuttingDown = false;

  constructor(options?: OpenCodeClientOptions) {
    this.hostname = options?.hostname ?? DEFAULT_HOSTNAME;
    this.port = options?.port ?? DEFAULT_PORT;
    this.startupTimeoutMs = options?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.promptTimeoutMs = options?.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.abortSignal = options?.signal;

    if (options?.autoStart !== false) {
      this.startPromise = this.start();
    }
  }

  // ─── Public Properties ──────────────────────────────────────────────────

  /** Current server status. */
  get status(): OpenCodeStatus {
    return this._status;
  }

  /** Current session ID (null if no session created yet). */
  get sessionId(): string | null {
    return this.currentSessionId;
  }

  /** Whether the client is in degraded mode (memory ops only, agent loop offline). */
  get isDegraded(): boolean {
    return this._status === "degraded";
  }

  /** Whether the client is ready for prompt operations. */
  get isReady(): boolean {
    return this._status === "ready";
  }

  // ─── Event Subscription ─────────────────────────────────────────────────

  /**
   * Register event listeners.
   * Supports "statusChange", "message", and "crash" events.
   */
  on(event: "statusChange" | "message" | "crash", listener: (...args: unknown[]) => void): this {
    if (event === "statusChange") {
      this.statusListeners.push(listener as StatusListener);
    } else if (event === "message") {
      this.messageListeners.push(listener as MessageListener);
    } else if (event === "crash") {
      this.crashListeners.push(listener as CrashListener);
    }
    return this;
  }

  // ─── Lifecycle Methods ──────────────────────────────────────────────────

  /**
   * Start the OpenCode server and connect the SDK client.
   *
   * On success, status becomes "ready".
   * On port conflict, throws PortConflictError.
   * On other failures, enters "degraded" mode (memory ops still work via T-020 client).
   */
  async start(): Promise<void> {
    if (this._status === "ready" || this._status === "starting") {
      if (this.startPromise) {
        await this.startPromise;
      }
      return;
    }

    this.setStatus("starting");

    try {
      // Step 1: Check if port is already in use (fast pre-check)
      if (await this.isPortInUse(this.port)) {
        // Port already taken — could be another OpenCode server
        throw new PortConflictError(this.port);
      }

      // Step 2: Spawn the OpenCode server and get the client
      const { client, server } = await this.spawnWithTimeout();

      this.client = client;
      this.serverClose = server.close.bind(server);
      this.setStatus("ready");

      console.log(
        `[opencode] Server ready on ${this.hostname}:${this.port}`,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Port conflict from the SDK's spawn
      if (error instanceof PortConflictError) {
        this.setStatus("degraded");
        throw error;
      }

      // Check for EADDRINUSE in error message (SDK wraps spawn errors)
      if (error.message?.includes("EADDRINUSE") || error.message?.includes("address already in use")) {
        this.setStatus("degraded");
        throw new PortConflictError(this.port, error);
      }

      // Any other error — enter degraded mode but don't crash
      console.error(`[opencode] Server failed to start: ${error.message}`);
      this.setStatus("degraded");
      throw new OpenCodeStartError(
        `OpenCode server failed to start: ${error.message}. ` +
          `TUI entering degraded mode — memory operations still available, ` +
          `chat panel shows "Agent loop offline".`,
        error,
      );
    }
  }

  /**
   * Gracefully shut down the OpenCode server.
   * Kills the child process and cleans up resources.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    try {
      // Close the server (kills child process)
      if (this.serverClose) {
        this.serverClose();
        this.serverClose = null;
      }
    } catch (err: unknown) {
      console.error(`[opencode] Error closing server: ${err}`);
    }

    this.client = null;
    this.currentSessionId = null;
    this.setStatus("offline");
    console.log("[opencode] Server shut down");
  }

  /**
   * Register process signal handlers for clean shutdown.
   * Kills the child process on TUI exit (SIGTERM, SIGINT).
   */
  registerShutdownHandlers(): void {
    const handler = () => {
      this.shutdown().then(() => process.exit(0));
    };

    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
    process.on("exit", () => {
      // Synchronous cleanup on exit
      if (this.serverClose) {
        try {
          this.serverClose();
        } catch {
          // Best-effort — process is exiting
        }
      }
    });
  }

  // ─── Session Lifecycle Methods ──────────────────────────────────────────

  /**
   * Create a new OpenCode session.
   * @returns The session ID string.
   */
  async createSession(title?: string): Promise<string> {
    this.assertReady();
    const result = await this.client!.session.create({
      body: { title: title ?? `Neuralgentics ${new Date().toISOString()}` },
    });
    if (result.error) {
      throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`);
    }
    // The SDK returns the session object in result.data
    const sessionData = (result.data as Record<string, unknown>) ?? {};
    const sessionId = (sessionData as { id: string }).id ?? randomUUID();
    this.currentSessionId = sessionId;
    return sessionId;
  }

  /**
   * Send a prompt to the current session and return the text response.
   * Supports streaming via optional callbacks.
   *
   * @param sessionId - The session ID to prompt.
   * @param text - The text prompt to send.
   * @param callbacks - Optional streaming callbacks for progressive rendering.
   * @returns A PromptResult with the response text and metadata.
   */
  async prompt(
    sessionId: string,
    text: string,
    callbacks?: StreamingCallbacks,
  ): Promise<PromptResult> {
    this.assertReady();

    const startTime = Date.now();

    try {
      const result = await this.client!.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text" as const, text }],
        },
      });

      if (result.error) {
        const err = new Error(`Prompt error: ${JSON.stringify(result.error)}`);
        callbacks?.onError?.(err);
        throw err;
      }

      // The SDK returns { info: AssistantMessage, parts: Part[] } for prompt responses
      const data = result.data as unknown as {
        info: { id: string; sessionID: string };
        parts: Array<{ type: string; text?: string }>;
      };

      // Extract text content from parts
      const textParts = (data.parts ?? []).filter(
        (p: { type: string }) => p.type === "text",
      );
      const fullText = textParts
        .map((p: { text?: string }) => p.text ?? "")
        .join("");

      // If we have callbacks, simulate streaming by calling onComplete
      // (the SDK returns the full response at once for prompt())
      if (callbacks?.onToken && fullText) {
        // Simulate progressive rendering by chunking the response
        const chunkSize = Math.max(1, Math.floor(fullText.length / 20));
        let accumulated = "";
        for (let i = 0; i < fullText.length; i += chunkSize) {
          const chunk = fullText.slice(i, i + chunkSize);
          accumulated += chunk;
          callbacks.onToken(chunk, accumulated);
        }
      }

      const ttfr = Date.now() - startTime;
      console.log(
        `[opencode] Prompt completed in ${ttfr}ms (${fullText.length} chars)`,
      );

      callbacks?.onComplete?.(fullText);

      return {
        sessionId: data.info.sessionID ?? sessionId,
        messageId: data.info.id,
        textContent: fullText,
        raw: data,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      callbacks?.onError?.(error);
      throw error;
    }
  }

  /**
   * Get message history for a session.
   * @param sessionId - The session ID.
   * @returns An array of message objects.
   */
  async messages(sessionId: string): Promise<ChatMessage[]> {
    this.assertReady();
    const result = await this.client!.session.messages({
      path: { id: sessionId },
    });

    if (result.error) {
      throw new Error(`Failed to get messages: ${JSON.stringify(result.error)}`);
    }

    // The messages endpoint returns an array of { info: Message, parts: Part[] }
    const dataArray = (Array.isArray(result.data) ? result.data : [result.data]) as unknown as Array<{
      info: { id: string; sessionID: string; role: string };
      parts: Array<{ type: string; text?: string }>;
    }>;

    const chatMessages: ChatMessage[] = [];

    for (const entry of dataArray) {
      let textContent = "";
      for (const part of entry.parts ?? []) {
        if (part.type === "text" && part.text) {
          textContent += part.text;
        }
      }

      chatMessages.push({
        id: entry.info?.id ?? randomUUID(),
        role: entry.info?.role === "user" ? "user" as const : "assistant" as const,
        content: textContent,
        timestamp: Date.now(),
        sessionId: entry.info?.sessionID ?? sessionId,
      });
    }

    return chatMessages;
  }

  /**
   * Abort a running prompt in a session.
   * @param sessionId - The session ID to abort.
   */
  async abort(sessionId: string): Promise<void> {
    this.assertReady();
    await this.client!.session.abort({
      path: { id: sessionId },
    });
  }

  /**
   * Revert a session to a clean state (used by compaction).
   * @param sessionId - The session ID.
   * @param messageId - The message ID to revert to.
   */
  async revert(sessionId: string, messageId?: string): Promise<string> {
    this.assertReady();

    // If no messageId is provided, get the first assistant message
    let targetMessageId = messageId;
    if (!targetMessageId) {
      const msgs = await this.messages(sessionId);
      const firstAssistant = msgs.find((m) => m.role === "assistant");
      if (!firstAssistant) {
        throw new Error("No assistant message found to revert to");
      }
      targetMessageId = firstAssistant.id;
    }

    const result = await this.client!.session.revert({
      path: { id: sessionId },
      body: { messageID: targetMessageId },
    });

    if (result.error) {
      throw new Error(`Failed to revert session: ${JSON.stringify(result.error)}`);
    }

    const sessionData = (result.data as Record<string, unknown>) ?? {};
    return (sessionData as { id: string }).id ?? sessionId;
  }

  /**
   * Summarize a session (compact summary for reseed).
   * Note: The OpenCode SDK requires modelID and providerID for summarize.
   * If not provided, uses defaults from the session.
   * @param sessionId - The session ID.
   * @param modelID - Optional model ID override.
   * @param providerID - Optional provider ID override.
   * @returns A summary string.
   */
  async summarize(sessionId: string, modelID?: string, providerID?: string): Promise<string> {
    this.assertReady();
    const body: Record<string, string> = {};
    if (modelID) body.modelID = modelID;
    if (providerID) body.providerID = providerID;

    const result = await this.client!.session.summarize({
      path: { id: sessionId },
      body: body as NonNullable<Parameters<OpencodeClient["session"]["summarize"]>[0]["body"]>,
    });

    if (result.error) {
      throw new Error(
        `Failed to summarize session: ${JSON.stringify(result.error)}`,
      );
    }

    // The summarize endpoint returns a session with a summary field
    const data = result.data as unknown;
    return typeof data === "string" ? data : JSON.stringify(data);
  }

  /**
   * Initialize a fresh session (resets all state).
   * Note: The OpenCode SDK requires modelID, providerID, and messageID for init.
   * If not provided, uses defaults from the session.
   * @param sessionId - The session ID.
   * @param modelID - Optional model ID override.
   * @param providerID - Optional provider ID override.
   * @param messageID - Optional message ID to reset from.
   */
  async init(
    sessionId: string,
    modelID?: string,
    providerID?: string,
    messageID?: string,
  ): Promise<void> {
    this.assertReady();
    const body: Record<string, string> = {};
    if (modelID) body.modelID = modelID;
    if (providerID) body.providerID = providerID;
    if (messageID) body.messageID = messageID;

    await this.client!.session.init({
      path: { id: sessionId },
      body: body as NonNullable<Parameters<OpencodeClient["session"]["init"]>[0]["body"]>,
    });
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  /**
   * Spawn the OpenCode server with a timeout.
   * Uses the SDK's createOpencode() which spawns `opencode serve` as a child process.
   */
  private async spawnWithTimeout(): Promise<{
    client: OpencodeClient;
    server: { url: string; close: () => void };
  }> {
    const timeoutMs = this.startupTimeoutMs;

    const result = await Promise.race([
      createOpencode({
        hostname: this.hostname,
        port: this.port,
        signal: this.abortSignal,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Server startup timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);

    return result;
  }

  /**
   * Check if a port is already in use by attempting to connect.
   * Returns true if the port is occupied (something is listening).
   */
  private async isPortInUse(port: number): Promise<boolean> {
    try {
      const conn = await Bun.connect({
        hostname: this.hostname,
        port,
        socket: {
          data() {},
          open() {},
          close() {},
          error() {},
        },
      } as unknown as Parameters<typeof Bun.connect>[0]);
      conn.end();
      return true; // Connection succeeded → port in use
    } catch {
      return false; // Connection refused → port available
    }
  }

  /** Assert that the client is ready for operations. */
  private assertReady(): void {
    if (this._status === "degraded") {
      throw new Error(
        "OpenCode server is in degraded mode. Agent loop offline — memory operations only.",
      );
    }
    if (this._status !== "ready" || !this.client) {
      throw new Error(
        `OpenCode server not ready (status: ${this._status}). Call start() first.`,
      );
    }
  }

  /** Update status and notify listeners. */
  private setStatus(status: OpenCodeStatus): void {
    const prev = this._status;
    this._status = status;
    if (prev !== status) {
      console.log(`[opencode] Status: ${prev} → ${status}`);
      for (const listener of this.statusListeners) {
        try {
          listener(status);
        } catch {
          // Swallow listener errors
        }
      }
    }
  }

  /** Emit a crash event to all listeners. */
  private emitCrash(error: Error): void {
    for (const listener of this.crashListeners) {
      try {
        listener(error);
      } catch {
        // Swallow listener errors
      }
    }
  }
}