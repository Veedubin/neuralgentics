/**
 * TypeScript types for the OpenCode SDK Client (T-023).
 *
 * These types are defined locally to avoid depending on the SDK's internal
 * type paths (which aren't exported via package.json exports). The types
 * mirror the SDK's generated types for the APIs we use.
 */

// ─── OpenCode Client Status ───────────────────────────────────────────────────

/** The current state of the OpenCode server connection. */
export type OpenCodeStatus =
  | "offline"       // Server not started or failed to start
  | "starting"      // Server spawning in progress
  | "ready"         // Server running, client connected
  | "degraded";    // Server failed, TUI in degraded mode (memory ops only)

// ─── Chat Message Types ────────────────────────────────────────────────────────

/** A single chat message in the TUI's chat panel. */
export interface ChatMessage {
  /** Unique ID for this message. */
  id: string;
  /** Who sent this message: "user" or "assistant". */
  role: "user" | "assistant";
  /** The text content of this message. */
  content: string;
  /** Timestamp (ms since epoch). */
  timestamp: number;
  /** Session ID this message belongs to. */
  sessionId: string;
  /** Whether the message is still being streamed. */
  streaming?: boolean;
}

// ─── Streaming Callbacks ────────────────────────────────────────────────────────

/** Callbacks invoked as streaming tokens arrive from the LLM. */
export interface StreamingCallbacks {
  /** Called when a new text token arrives. Receives the token and the full accumulated text. */
  onToken?: (token: string, fullText: string) => void;
  /** Called when the streaming response completes. */
  onComplete?: (fullText: string) => void;
  /** Called if streaming encounters an error. */
  onError?: (error: Error) => void;
}

// ─── OpenCode Client Events ─────────────────────────────────────────────────────

/** Events emitted by OpenCodeClient. */
export interface OpenCodeClientEvents {
  /** Server status changed. */
  statusChange: (status: OpenCodeStatus) => void;
  /** A new chat message was received. */
  message: (msg: ChatMessage) => void;
  /** Server crashed unexpectedly. */
  crash: (error: Error) => void;
}

// ─── OpenCode Client Options ────────────────────────────────────────────────────

/** Configuration for creating an OpenCodeClient. */
export interface OpenCodeClientOptions {
  /** Hostname for the OpenCode server. Default: "127.0.0.1" */
  hostname?: string;
  /** Port for the OpenCode server. Default: 4096 */
  port?: number;
  /** Timeout (ms) for server startup. Default: 10_000 */
  startupTimeoutMs?: number;
  /** Timeout (ms) for prompt requests. Default: 120_000 */
  promptTimeoutMs?: number;
  /** Whether to start the server immediately. Default: true */
  autoStart?: boolean;
  /** AbortSignal to cancel server startup. */
  signal?: AbortSignal;
}

// ─── Prompt Result ──────────────────────────────────────────────────────────────

/** Result of sending a prompt to a session. */
export interface PromptResult {
  /** The session ID this prompt belongs to. */
  sessionId: string;
  /** The assistant message ID. */
  messageId: string;
  /** Extracted text content from text parts. */
  textContent: string;
  /** Full response data from the SDK. */
  raw: unknown;
}

// ─── Custom Errors ──────────────────────────────────────────────────────────────

/** Error thrown when port is already in use. */
export class PortConflictError extends Error {
  public readonly port: number;

  constructor(port: number, cause?: Error) {
    super(
      `Port ${port} in use. Is another OpenCode server running?` +
        (cause ? ` (${cause.message})` : ""),
    );
    this.name = "PortConflictError";
    this.port = port;
    if (cause) {
      this.cause = cause;
    }
  }
}

/** Error thrown when OpenCode server fails to start (triggers degraded mode). */
export class OpenCodeStartError extends Error {
  public readonly degraded: true;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "OpenCodeStartError";
    this.degraded = true;
    if (cause) {
      this.cause = cause;
    }
  }
}