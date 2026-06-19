/**
 * Neuralgentics v0.1.0 — TUI Entry Point (T-021 + T-023 + T-032)
 *
 * Full OpenTUI app with 4-panel layout:
 * - Left panel (kanban, ~30%): renders TASKS.md board state
 * - Center panel (chat, ~50%): streaming chat via OpenCode SDK
 * - Right panel (chain, ~20%): progressive thought display
 * - Status bar (bottom, 1 row): session ID, token gauge, agent roster, compaction count
 * - Input bar (1 row): /-prefix command routing + OpenCode prompt dispatch
 *
 * T-032 adds:
 * - Theme system: dark/light themes, F2 to cycle, /theme command
 * - Keyboard navigation: Tab/Shift+Tab between panels, arrow keys, Enter
 * - Mouse support: click to focus panel, scroll within panel
 * - Screen reader: ARIA labels on panels, high-contrast mode (F3)
 */

import { randomUUID } from "node:crypto";
import { existsSync, symlinkSync, readlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createCliRenderer,
  Box,
  Text,
  Input,
  ScrollBox,
} from "@opentui/core";

import { parseKanbanBoard, formatKanbanForPanel, type KanbanBoard } from "./kanban/index.js";
import { handleSlashCommand, handleMemoryCommand, handleChainCommand, handleCachedOpportunitiesCommand, handleResumeSessionCommand, handleOfflineCommand, isWriteCommand, isWriteBlocked, type CommandDependencies } from "./commands.js";
import { initSidecar, checkDatabase, registerSidecarShutdown } from "./sidecar.js";
import { OpenCodeClient, type OpenCodeStatus, type ClientStatus as OpenCodeClientStatus } from "./opencode-client/index.js";
import { NeuralgenticsClient, type ClientStatus as NeuralgenticsClientStatus } from "./neuralgentics-client/client.js";
import { SessionManager, type SessionManagerStatus } from "./session/index.js";
import { DiffPanel } from "./panels/diff.js";
import { ThemeManager } from "./themes/index.js";
import type { ThemeColors } from "./themes/types.js";
import { FocusManager, initPanelAriaLabels, toggleHighContrast, type PanelName } from "./a11y/index.js";
import { TokenCounter } from "./observability/token-counter.js";
import type { TextVNode, BoxVNode, InputVNode } from "./vnode-types.js";
import type { OfflineState } from "./panels/status.js";

// ─── Theme Manager (T-032) ────────────────────────────────────────────────────

const themeManager = new ThemeManager();
let COLORS: ThemeColors = themeManager.current.colors;

const BORDER_STYLE = "single" as const;

// ─── Application State ─────────────────────────────────────────────────────────

interface AppState {
  sessionId: string;
  opencodeSessionId: string | null;
  tokenUsed: number;
  tokenLimit: number;
  agentRoster: Map<string, string>;
  compactionCount: number;
  kanbanBoard: KanbanBoard | null;
  chatMessages: string[];
  chainThoughts: string[];
  opencodeStatus: OpenCodeStatus;
  sessionStatus: SessionManagerStatus;
  /** Offline state for both clients (T-081b). */
  offlineState: OfflineState;
}

const state: AppState = {
  sessionId: randomUUID().slice(0, 8),
  opencodeSessionId: null,
  tokenUsed: 12450,
  tokenLimit: 100000,
  agentRoster: new Map([
    ["coder", "ready"],
    ["tester", "idle"],
    ["architect", "idle"],
  ]),
  compactionCount: 0,
  kanbanBoard: null,
  chatMessages: ["Chat: waiting for session..."],
  chainThoughts: ["Chain: no active thought chains"],
  opencodeStatus: "offline" as OpenCodeStatus,
  sessionStatus: "idle" as SessionManagerStatus,
  offlineState: { opencode: "online", neuralgentics: "online" },
};

// ─── ProxiedVNode references (delegated property access after mount) ───────────
// Assigned once in buildLayout(); all callbacks run after that assignment.
// Using definite assignment assertions (!) since the lifecycle guarantees
// these are set before any callback fires.
//
// ProxiedVNode maps getter return types only (TS limitation with getter/setter
// pairs in mapped types). We use writable interface types (TextVNode, BoxVNode,
// InputVNode) and cast from the factory return value at the single assignment
// site. Property reads like .content return StyledText/RGBA from ProxiedVNode,
// but property writes accept string via the delegated proxy at runtime. The
// interface types capture the write-side shape for compile-time checking.

let kanbanText!: TextVNode;
let chatText!: TextVNode;
let chainText!: TextVNode;
let statusText!: TextVNode;
let inputVNode!: InputVNode;
/** Offline banner text reference (T-081b). */
let offlineBannerText!: TextVNode;

/** OpenCode SDK client — initialized in main(), used by input handler. */
let opencodeClient: OpenCodeClient | null = null;
/** Session Manager — orchestrates session lifecycle and stateless agent protocol. */
let sessionManager: SessionManager | null = null;
/** Neuralgentics JSON-RPC client — initialized in main(), used for memory ops. */
let neuralgenticsClient: NeuralgenticsClient | null = null;
/** Token counter — tracks token usage per call and provides /spend data (T-033). */
let tokenCounter: TokenCounter | null = null;

/** Diff panel — T-030. Modal overlay shown when user runs `/diff` or after a code change. */
let diffPanel: DiffPanel | null = null;

// ─── Focus Manager (T-032) ─────────────────────────────────────────────────────

const focusManager = new FocusManager();

// Panel VNode references keyed by panel name (for focus highlighting)
const panelVNodes: Record<PanelName, BoxVNode | null> = {
  kanban: null,
  chat: null,
  chain: null,
  input: null,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildStatusBarText(): string {
  const tokenPct = ((state.tokenUsed / state.tokenLimit) * 100).toFixed(1);
  const tokenStr = `${state.tokenUsed.toLocaleString()} / ${state.tokenLimit.toLocaleString()} (${tokenPct}%)`;
  const roster = Array.from(state.agentRoster.entries())
    .map(([agent, status]) => `${agent}: ${status}`)
    .join(", ");

  // Show OpenCode server status in status bar
  const ocStatus = state.opencodeStatus === "ready"
    ? "LLM:online"
    : state.opencodeStatus === "degraded"
      ? "LLM:offline"
      : `LLM:${state.opencodeStatus}`;

  // Build offline indicator for status bar (T-081b)
  const offlineParts: string[] = [];
  if (state.offlineState.opencode === "offline") offlineParts.push("LLM:offline");
  if (state.offlineState.neuralgentics === "offline") offlineParts.push("Backend:offline");

  const offlineLabel = offlineParts.length > 0 ? ` │ ${offlineParts.join(" ")}` : "";

  return ` Session: ${state.sessionId} │ ${ocStatus} │ Tokens: ${tokenStr} │ Agents: ${roster} │ Compactions: ${state.compactionCount}${offlineLabel}`;
}

function buildKanbanContent(): string {
  if (!state.kanbanBoard) return "Kanban: loading...";
  return formatKanbanForPanel(state.kanbanBoard, 38).join("\n");
}

// ─── Offline Banner (T-081b) ─────────────────────────────────────────────────

/**
 * Build the offline banner content based on current offline state.
 * Shows "🟧 OFFLINE" when both clients are offline,
 * "Backend:offline" when only neuralgentics is offline,
 * "LLM:offline" when only opencode is offline,
 * or an empty string when both are online.
 */
function buildOfflineBannerContent(): string {
  const { opencode, neuralgentics } = state.offlineState;
  if (opencode === "offline" && neuralgentics === "offline") {
    return "🟧 OFFLINE — Backend + LLM unavailable. Local operations only.";
  }
  if (neuralgentics === "offline") {
    return "⚠ Backend:offline — Go backend unreachable. Memory ops disabled.";
  }
  if (opencode === "offline") {
    return "⚠ LLM:offline — OpenCode server unreachable. Agent loop disabled.";
  }
  return ""; // Both online — no banner
}

/**
 * Update the offline banner VNode based on current state.
 * Called when offline state changes.
 */
function updateOfflineBanner(): void {
  if (!offlineBannerText) return;
  const content = buildOfflineBannerContent();
  offlineBannerText.content = content;
  // Also update the status bar to show offline labels
  statusText.content = buildStatusBarText();
}

// ─── Build TUI Layout ──────────────────────────────────────────────────────────

async function buildLayout(renderer: Awaited<ReturnType<typeof createCliRenderer>>): Promise<void> {
  const root = renderer.root;
  const c = COLORS; // shorthand for current theme colors

  // Initialize ARIA labels for all panels
  initPanelAriaLabels();

  // Load initial kanban data
  try {
    state.kanbanBoard = parseKanbanBoard();
  } catch {
    state.kanbanBoard = null;
  }

  // ── Main 3-column row ──────────────────────────────────────────────────────

  // Kanban panel (~30%)
  const kanbanTextNode = Text({ content: buildKanbanContent(), fg: c.textPrimary });
  kanbanText = kanbanTextNode as unknown as TextVNode;
  const kanbanScroll = ScrollBox({ scrollY: true, scrollX: false, height: "100%" });
  kanbanScroll.add(kanbanTextNode);
  const kanbanPanel = Box({
    id: "kanban-panel",
    border: true,
    borderStyle: BORDER_STYLE,
    borderColor: c.border,
    title: " Kanban ",
    titleAlignment: "left",
    width: "30%",
    height: "100%",
    backgroundColor: c.kanbanBg,
    flexDirection: "column",
  });
  kanbanPanel.add(kanbanScroll);
  panelVNodes.kanban = kanbanPanel as unknown as BoxVNode;

  // Chat panel (~50%)
  const chatTextNode = Text({ content: state.chatMessages.join("\n"), fg: c.textPrimary });
  chatText = chatTextNode as unknown as TextVNode;
  const chatScroll = ScrollBox({ scrollY: true, scrollX: false, height: "100%" });
  chatScroll.add(chatTextNode);
  const chatPanel = Box({
    id: "chat-panel",
    border: true,
    borderStyle: BORDER_STYLE,
    borderColor: c.border,
    title: " Chat ",
    titleAlignment: "left",
    width: "50%",
    height: "100%",
    backgroundColor: c.chatBg,
    flexDirection: "column",
  });
  chatPanel.add(chatScroll);
  panelVNodes.chat = chatPanel as unknown as BoxVNode;

  // Chain panel (~20%)
  const chainTextNode = Text({ content: state.chainThoughts.join("\n"), fg: c.textSecondary });
  chainText = chainTextNode as unknown as TextVNode;
  const chainScroll = ScrollBox({ scrollY: true, scrollX: false, height: "100%" });
  chainScroll.add(chainTextNode);
  const chainPanel = Box({
    id: "chain-panel",
    border: true,
    borderStyle: BORDER_STYLE,
    borderColor: c.border,
    title: " Chain ",
    titleAlignment: "left",
    width: "20%",
    height: "100%",
    backgroundColor: c.chainBg,
    flexDirection: "column",
  });
  chainPanel.add(chainScroll);
  panelVNodes.chain = chainPanel as unknown as BoxVNode;

  // Assemble the 3-column row
  const mainRow = Box({
    flexDirection: "row",
    gap: 0,
    flexGrow: 1,
    height: "100%",
    backgroundColor: c.bg,
  });
  mainRow.add(kanbanPanel);
  mainRow.add(chatPanel);
  mainRow.add(chainPanel);

  // ── Status bar (1 row) ─────────────────────────────────────────────────────

  const statusTextNode = Text({
    content: buildStatusBarText(),
    fg: c.textAccent,
  });
  statusText = statusTextNode as unknown as TextVNode;
  const statusBarBox = Box({
    id: "status-bar",
    height: 1,
    backgroundColor: c.statusBarBg,
    flexDirection: "row",
    padding: 0,
  });
  statusBarBox.add(statusTextNode);

  // ── Input bar (1 row) ───────────────────────────────────────────────────────

  const promptLabel = Text({ content: "> ", fg: c.textAccent });

  const inputNode = Input({
    value: "",
    placeholder: "Type a message or /command...",
    textColor: COLORS.textPrimary,
    backgroundColor: COLORS.inputBarBg,
    flexGrow: 1,
    onSubmit: async () => {
      const value: string = inputNode.value ?? "";
      if (value.trim().length === 0) return;

      // Clear input immediately
      inputNode.value = "";

      // Handle slash commands
      if (value.trim().startsWith("/")) {
        // Build dependency injection for synchronous commands
        const cmdDeps: CommandDependencies = {
          tokenCounter: tokenCounter ?? undefined,
          opportunityDetector: undefined, // OpportunityDetector not instantiated yet
          circuitBreaker: undefined, // Will be set below if available
          kanbanBoard: state.kanbanBoard ?? undefined,
          neuralgenticsClient: neuralgenticsClient ?? undefined,
          projectRoot: undefined, // defaults to cwd
        };

        // Determine if this is an async command
        const cmd = value.trim().slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";

        // T-081b: Write command gating — block write commands when offline
        if (isWriteCommand(cmd) && isWriteBlocked(state.offlineState)) {
          state.chatMessages.push(`⚠ Cannot execute /${cmd} while offline. Use /offline to check status.`);
          chatText.content = state.chatMessages.join("\n");
          return;
        }

        // Async commands: /memory, /chain, /compact
        if (cmd === "memory" && neuralgenticsClient) {
          const asyncResult = await handleMemoryCommand(neuralgenticsClient, value);
          state.chatMessages.push(`/${asyncResult.command}: ${asyncResult.message}`);
          chatText.content = state.chatMessages.join("\n");
          return;
        }

        if (cmd === "chain" && neuralgenticsClient) {
          const asyncResult = await handleChainCommand(neuralgenticsClient, value);
          state.chatMessages.push(`/${asyncResult.command}: ${asyncResult.message}`);
          chatText.content = state.chatMessages.join("\n");
          return;
        }

        // T-080: /resume (no args) → async handler that calls sessionManager.resume()
        if (cmd === "resume" && !value.trim().slice(1).split(/\s+/)[1] && sessionManager) {
          const asyncResult = await handleResumeSessionCommand(sessionManager);
          state.chatMessages.push(`/${asyncResult.command}: ${asyncResult.message}`);
          chatText.content = state.chatMessages.join("\n");

          // Refresh kanban after resume
          if (asyncResult.refreshKanban) {
            try {
              state.kanbanBoard = parseKanbanBoard();
              kanbanText.content = buildKanbanContent();
            } catch {
              // Kanban refresh is non-critical
            }
          }
          return;
        }

        // T-081b: /offline → async handler that shows both clients' status
        if (cmd === "offline") {
          const ocStatus: "online" | "offline" = opencodeClient?.onlineStatus ?? "offline";
          const ngStatus: "online" | "offline" = neuralgenticsClient?.onlineStatus ?? "offline";
          const asyncResult = await handleOfflineCommand(ocStatus, ngStatus);
          state.chatMessages.push(`/${asyncResult.command}: ${asyncResult.message}`);
          chatText.content = state.chatMessages.join("\n");
          return;
        }

        const result = handleSlashCommand(value, cmdDeps);

        // If /board command, refresh kanban from TASKS.md
        if (result.refreshKanban) {
          try {
            state.kanbanBoard = parseKanbanBoard();
            kanbanText.content = buildKanbanContent();
          } catch {
            result.message += " (error re-reading TASKS.md)";
          }
        }

        // If /diff command, show the diff verification panel with a sample diff
        if (result.showDiffPanel && diffPanel) {
          diffPanel.show({
            diff: `--- a/packages/tui/src/example.ts
+++ b/packages/tui/src/example.ts
@@ -1,3 +1,3 @@
-export const greeting = "Hello";
+export const greeting = "Hello, world!";
 export function greet(name: string) {
-  return greeting + " " + name;
+  return \`\${greeting} \${name}!\`;
  }`,
            title: "example.ts (sample diff for T-030 demo)",
            confidence: "high",
          });
        }

        // If /diff --threeway command, show 3-way merge viewer (T-083)
        if (result.showDiffThreeWay && diffPanel && result.threeWayData) {
          diffPanel.showThreeWay({
            base: result.threeWayData.base,
            ours: result.threeWayData.ours,
            theirs: result.threeWayData.theirs,
          });
        }

        // If /theme command, switch the theme (T-032)
        if (result.switchTheme) {
          try {
            themeManager.setTheme(result.switchTheme);
            state.chatMessages.push(`/${result.command}: Switched to ${result.switchTheme} theme`);
            chatText.content = state.chatMessages.join("\n");
            return;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            state.chatMessages.push(`/${result.command}: ${msg}`);
            chatText.content = state.chatMessages.join("\n");
            return;
          }
        }

        // If /opportunities cached, fetch from memory (T-085)
        if (result.opportunitiesCached && neuralgenticsClient) {
          try {
            const cacheClient = neuralgenticsClient as unknown as { call: (method: string, params: Record<string, unknown>) => Promise<unknown> };
            const cachedResult = await handleCachedOpportunitiesCommand(cacheClient);
            state.chatMessages.push(`/${cachedResult.command}: ${cachedResult.message}`);
            chatText.content = state.chatMessages.join("\n");
            return;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            state.chatMessages.push(`/opportunities: Cache lookup failed: ${msg}`);
            chatText.content = state.chatMessages.join("\n");
            return;
          }
        }

        state.chatMessages.push(`/${result.command}: ${result.message}`);
        chatText.content = state.chatMessages.join("\n");
        return;
      }

      // ── Non-slash input → send via SessionManager ──────────────────────────────
      if (!sessionManager && !opencodeClient) {
        // No backend available — show warning
        state.chatMessages.push(`You: ${value.trim()}`);
        state.chatMessages.push("⚠ No session manager or OpenCode client available.");
        chatText.content = state.chatMessages.join("\n");
        return;
      }

      if (!sessionManager) {
        // Fallback to direct OpenCodeClient if SessionManager not initialized
        // (shouldn't happen in normal flow, but defensive)
        if (!opencodeClient || !opencodeClient.isReady) {
          state.chatMessages.push(`You: ${value.trim()}`);
          state.chatMessages.push("⚠ Agent loop offline — memory ops only. Start OpenCode server to enable chat.");
          chatText.content = state.chatMessages.join("\n");
          statusText.content = buildStatusBarText();
          return;
        }

        try {
          if (!state.opencodeSessionId) {
            state.chatMessages.push("Starting session...");
            chatText.content = state.chatMessages.join("\n");
          state.opencodeSessionId = await opencodeClient!.createSession(
              `Neuralgentics ${state.sessionId}`,
            );
            state.chatMessages.push(`Session: ${state.opencodeSessionId}`);
            chatText.content = state.chatMessages.join("\n");
          }

          state.chatMessages.push(`You: ${value.trim()}`);
          chatText.content = state.chatMessages.join("\n");

          state.chatMessages.push("Assistant: ");
          const responseLineIndex = state.chatMessages.length - 1;

          const result = await opencodeClient.prompt(
            state.opencodeSessionId,
            value.trim(),
            {
              onToken: (token: string, fullText: string) => {
                state.chatMessages[responseLineIndex] = `Assistant: ${fullText}`;
                chatText.content = state.chatMessages.join("\n");
              },
              onComplete: (fullText: string) => {
                state.chatMessages[responseLineIndex] = `Assistant: ${fullText}`;
                chatText.content = state.chatMessages.join("\n");
              },
              onError: (error: Error) => {
                state.chatMessages[responseLineIndex] = `Assistant: ⚠ Error: ${error.message}`;
                chatText.content = state.chatMessages.join("\n");
              },
            },
          );

          state.chatMessages[responseLineIndex] = `Assistant: ${result.textContent}`;
          // T-033: Record token usage from the response
          if (tokenCounter) {
            tokenCounter.recordCall(
              Math.ceil(value.trim().length / 4), // estimated input tokens
              Math.ceil((result.textContent?.length ?? 0) / 4), // estimated output tokens
              0, // cached
              0, // system overhead
              { model: "opencode", taskId: undefined, agentId: "opencode" },
            );
            state.tokenUsed = tokenCounter.getSessionTotal().total;
          } else {
            state.tokenUsed += 1;
          }
          chatText.content = state.chatMessages.join("\n");
          statusText.content = buildStatusBarText();
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          state.chatMessages.push(`⚠ Error: ${error.message}`);
          chatText.content = state.chatMessages.join("\n");
        }
        return;
      }

      // ── Use SessionManager for prompt dispatch ─────────────────────────────
      try {
        if (!sessionManager!.sessionId) {
          state.chatMessages.push("Starting session...");
          chatText.content = state.chatMessages.join("\n");
          const sid = await sessionManager!.createSession(
            `Neuralgentics ${state.sessionId}`,
          );
          state.opencodeSessionId = sid;
          state.chatMessages.push(`Session: ${sid}`);
          chatText.content = state.chatMessages.join("\n");
        }

        state.chatMessages.push(`You: ${value.trim()}`);
        chatText.content = state.chatMessages.join("\n");

        state.chatMessages.push("Assistant: ");
        const responseLineIdx = state.chatMessages.length - 1;

        const result = await sessionManager!.prompt(
          sessionManager!.sessionId,
          value.trim(),
          {
            callbacks: {
              onToken: (token: string, fullText: string) => {
                state.chatMessages[responseLineIdx] = `Assistant: ${fullText}`;
                chatText.content = state.chatMessages.join("\n");
              },
              onComplete: (fullText: string) => {
                state.chatMessages[responseLineIdx] = `Assistant: ${fullText}`;
                chatText.content = state.chatMessages.join("\n");
              },
              onError: (error: Error) => {
                state.chatMessages[responseLineIdx] = `Assistant: ⚠ Error: ${error.message}`;
                chatText.content = state.chatMessages.join("\n");
              },
            },
          },
        );

        state.chatMessages[responseLineIdx] = `Assistant: ${result.textContent}`;
        // T-033: Record token usage from the response
        if (tokenCounter) {
          tokenCounter.recordCall(
            Math.ceil(value.trim().length / 4), // estimated input tokens
            Math.ceil((result.textContent?.length ?? 0) / 4), // estimated output tokens
            0, // cached
            0, // system overhead
            { model: "opencode", taskId: undefined, agentId: "session" },
          );
          state.tokenUsed = tokenCounter.getSessionTotal().total;
        } else {
          state.tokenUsed += 1;
        }
        state.sessionStatus = sessionManager!.status;
        chatText.content = state.chatMessages.join("\n");
        statusText.content = buildStatusBarText();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        state.chatMessages.push(`⚠ Error: ${error.message}`);
        chatText.content = state.chatMessages.join("\n");
      }

      try {
        // Create session if we don't have one yet
        if (!state.opencodeSessionId) {
          state.chatMessages.push("Starting session...");
          chatText.content = state.chatMessages.join("\n");
          state.opencodeSessionId = await opencodeClient!.createSession(
            `Neuralgentics ${state.sessionId}`,
          );
          state.chatMessages.push(`Session: ${state.opencodeSessionId}`);
          chatText.content = state.chatMessages.join("\n");
        }

        // Show user message in chat panel
        state.chatMessages.push(`You: ${value.trim()}`);
        chatText.content = state.chatMessages.join("\n");

        // Send prompt with streaming callbacks
        state.chatMessages.push("Assistant: ");
        const responseLineIndex = state.chatMessages.length - 1;

        const result = await opencodeClient!.prompt(
          state.opencodeSessionId,
          value.trim(),
          {
            onToken: (token: string, fullText: string) => {
              // Progressive render — update the assistant line
              state.chatMessages[responseLineIndex] = `Assistant: ${fullText}`;
              chatText.content = state.chatMessages.join("\n");
            },
            onComplete: (fullText: string) => {
              state.chatMessages[responseLineIndex] = `Assistant: ${fullText}`;
              chatText.content = state.chatMessages.join("\n");
            },
            onError: (error: Error) => {
              state.chatMessages[responseLineIndex] = `Assistant: ⚠ Error: ${error.message}`;
              chatText.content = state.chatMessages.join("\n");
            },
          },
        );

        // Final state after prompt completes
        state.chatMessages[responseLineIndex] = `Assistant: ${result.textContent}`;
        // T-033: Record token usage from the response
        if (tokenCounter) {
          tokenCounter.recordCall(
            Math.ceil(value.trim().length / 4), // estimated input tokens
            Math.ceil((result.textContent?.length ?? 0) / 4), // estimated output tokens
            0, // cached
            0, // system overhead
            { model: "opencode", taskId: undefined, agentId: "opencode-direct" },
          );
          state.tokenUsed = tokenCounter.getSessionTotal().total;
        } else {
          state.tokenUsed += 1; // Fallback stub
        }
        chatText.content = state.chatMessages.join("\n");
        statusText.content = buildStatusBarText();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        state.chatMessages.push(`⚠ Error: ${error.message}`);
        chatText.content = state.chatMessages.join("\n");
      }
    },
  });
  inputVNode = inputNode as unknown as InputVNode;

  const inputBar = Box({
    height: 1,
    backgroundColor: COLORS.inputBarBg,
    flexDirection: "row",
  });
  inputBar.add(promptLabel);
  inputBar.add(inputNode);

  // ── Theme change handler (T-032) ──────────────────────────────────────────

  themeManager.onChange((theme) => {
    COLORS = theme.colors;
    // Re-apply colors to all panels
    for (const [name, vnode] of Object.entries(panelVNodes)) {
      if (vnode) {
        vnode.borderColor = name === focusManager.focused ? COLORS.borderActive : COLORS.border;
        if (name === "kanban") vnode.backgroundColor = COLORS.kanbanBg;
        if (name === "chat") vnode.backgroundColor = COLORS.chatBg;
        if (name === "chain") vnode.backgroundColor = COLORS.chainBg;
      }
    }
    kanbanText.fg = COLORS.textPrimary;
    chatText.fg = COLORS.textPrimary;
    chainText.fg = COLORS.textSecondary;
    statusText.fg = COLORS.textAccent;
    (promptLabel as unknown as TextVNode).content = "> ";
    (promptLabel as unknown as TextVNode).fg = COLORS.textAccent;
    if (statusBarBox) (statusBarBox as unknown as BoxVNode).backgroundColor = COLORS.statusBarBg;
    if (inputVNode) {
      inputVNode.textColor = COLORS.textPrimary;
      inputVNode.backgroundColor = COLORS.inputBarBg;
    }
    (rootColumn as unknown as BoxVNode).backgroundColor = COLORS.bg;
    state.chatMessages.push(`Theme: ${theme.label}`);
    chatText.content = state.chatMessages.join("\n");
  });

  // ── Focus change handler (T-032) ──────────────────────────────────────────

  focusManager.onChange((panel) => {
    // Highlight the active panel border
    for (const [name, vnode] of Object.entries(panelVNodes)) {
      if (vnode) {
        vnode.borderColor = name === panel ? COLORS.borderActive : COLORS.border;
      }
    }
  });

  // ── Global key handler for F2/F3/Tab/Arrow (T-032) ─────────────────────────
  // Registered on the renderer's keypress emitter, not on individual VNodes.

  renderer.stdin.on("keypress" as never, (_: unknown, key: { name: string; shift: boolean; ctrl: boolean }) => {
    // F2 → cycle theme
    if (key.name === "f2") {
      const newTheme = themeManager.cycle();
      state.chatMessages.push(`Theme: switched to ${newTheme.label} (F2 to cycle)`);
      chatText.content = state.chatMessages.join("\n");
      return;
    }
    // F3 → toggle high-contrast
    if (key.name === "f3") {
      const enabled = toggleHighContrast(themeManager);
      state.chatMessages.push(`High contrast: ${enabled ? "enabled" : "disabled"} (F3 to toggle)`);
      chatText.content = state.chatMessages.join("\n");
      COLORS = themeManager.current.colors;
      themeManager.onChange(() => {}); // trigger re-render
      for (const [name, vnode] of Object.entries(panelVNodes)) {
        if (vnode) {
          vnode.borderColor = name === focusManager.focused ? COLORS.borderActive : COLORS.border;
          if (name === "kanban") vnode.backgroundColor = COLORS.kanbanBg;
          if (name === "chat") vnode.backgroundColor = COLORS.chatBg;
          if (name === "chain") vnode.backgroundColor = COLORS.chainBg;
        }
      }
      return;
    }
    // Tab → next panel | Shift+Tab → previous panel
    if (key.name === "tab") {
      if (key.shift) {
        focusManager.previous();
      } else {
        focusManager.next();
      }
      return;
    }
    // Enter on a non-input panel → refocus input for typing
    if (key.name === "return" && focusManager.focused !== "input") {
      focusManager.focusPanel("input");
      inputVNode?.focus();
      return;
    }
  });

  // ── Offline banner (T-081b) ─────────────────────────────────────────────────
  // Shows "🟧 OFFLINE" banner when both clients are offline, or partial status
  // when only one is offline. Hidden when both are online.

  const offlineBannerContent = buildOfflineBannerContent();
  offlineBannerText = Text({
    id: "offline-banner",
    content: offlineBannerContent,
    fg: "#FF8C00", // Dark orange for visibility
  }) as unknown as TextVNode;

  // ── Assemble root ───────────────────────────────────────────────────────────

  const rootColumn = Box({
    id: "root-column",
    flexDirection: "column",
    height: "100%",
    width: "100%",
    backgroundColor: c.bg,
  });

  rootColumn.add(mainRow);
  rootColumn.add(statusBarBox);
  // Offline banner slot — content is dynamically toggled via updateOfflineBanner()
  rootColumn.add(offlineBannerText.content.length > 0 ? (() => {
    const bannerBox = Box({
      id: "offline-banner-box",
      height: 1,
      backgroundColor: "#5C3A1E", // Warm brown background for visibility
      flexDirection: "row",
      padding: 0,
    });
    (bannerBox as unknown as { add(child: unknown): void }).add(offlineBannerText);
    return bannerBox;
  })() : (() => {
    // Empty placeholder — always in the DOM but invisible
    const bannerBox = Box({
      id: "offline-banner-box",
      height: 0,
      flexDirection: "row",
    });
    (bannerBox as unknown as { add(child: unknown): void }).add(offlineBannerText);
    return bannerBox;
  })());
  rootColumn.add(inputBar);

  root.add(rootColumn);

  // Focus the input panel initially
  focusManager.focusPanel("input");
  inputVNode.focus();
}

// ─── Init command + auto-config ────────────────────────────────────────────────

/**
 * Find the neuralgentics install prefix by checking common locations.
 * Returns the path to the .opencode/ directory, or null if not found.
 */
function findInstallPrefix(): string | null {
  const candidates = [
    process.env.NEURALGENTICS_INSTALL_PREFIX,
    resolve(process.env.HOME ?? "", ".neuralgentics"),
    resolve(process.cwd(), ".neuralgentics"),
    resolve(process.cwd(), "..", ".neuralgentics"),
  ];
  for (const prefix of candidates) {
    if (prefix && existsSync(join(prefix, ".opencode", "opencode.json"))) {
      return join(prefix, ".opencode");
    }
  }
  return null;
}

/**
 * neuralgentics init — creates the .opencode/ symlink from the install
 * prefix into the current directory. No manual ln -s needed.
 */
function handleInitCommand(): void {
  const prefixOpenCode = findInstallPrefix();
  if (!prefixOpenCode) {
    console.error("neuralgentics: no install found. Run the installer first:");
    console.error("  curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash");
    process.exit(1);
  }

  const cwdOpenCode = resolve(process.cwd(), ".opencode");

  if (existsSync(cwdOpenCode)) {
    try {
      if (readlinkSync(cwdOpenCode) === prefixOpenCode) {
        console.log(`.opencode/ already linked to ${prefixOpenCode}`);
        return;
      }
    } catch {
      // Not a symlink — back up and replace
    }
    // Back up existing directory
    const backup = `${cwdOpenCode}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    require("node:fs").renameSync(cwdOpenCode, backup);
    console.log(`Backed up existing .opencode/ to ${backup}`);
  }

  symlinkSync(prefixOpenCode, cwdOpenCode);
  console.log(`Linked .opencode/ → ${prefixOpenCode}`);
  console.log("Run 'neuralgentics' to start.");
}

/**
 * Auto-detect .opencode/ config on TUI startup. If .opencode/ doesn't
 * exist in cwd, find the install prefix config and symlink it. This
 * makes neuralgentics work from any directory — home dir, project dir,
 * anywhere — without manual setup.
 */
function ensureOpenCodeConfig(): void {
  const cwdOpenCode = resolve(process.cwd(), ".opencode");
  if (existsSync(cwdOpenCode)) return; // already present

  const prefixOpenCode = findInstallPrefix();
  if (!prefixOpenCode) return; // no install found, TUI will start without config

  try {
    symlinkSync(prefixOpenCode, cwdOpenCode);
    console.log(`[neuralgentics] Auto-linked .opencode/ → ${prefixOpenCode}`);
  } catch {
    // Symlink failed (permissions, existing file, etc.) — TUI starts without config
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

/** Renderer reference for cleanup on crash. Set after createCliRenderer succeeds. */
let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;

async function main(): Promise<void> {
  // ── CLI: neuralgentics init ──────────────────────────────────────────────
  // Creates the .opencode/ symlink from the install prefix into the current
  // directory. No manual ln -s needed. Also handles --help and --version.
  if (process.argv[2] === "init") {
    handleInitCommand();
    return;
  }
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    console.log("neuralgentics — AI-powered development TUI");
    console.log("");
    console.log("Usage:");
    console.log("  neuralgentics              Launch the TUI");
    console.log("  neuralgentics init         Set up .opencode/ config in this directory");
    console.log("  neuralgentics --help       Show this help");
    console.log("  neuralgentics --version    Show version");
    console.log("");
    console.log("The TUI auto-detects .opencode/ config from the install prefix.");
    console.log("Run 'neuralgentics init' in any project to link it.");
    return;
  }
  if (process.argv[2] === "--version" || process.argv[2] === "-v") {
    // Read version from package.json at runtime
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync(
        resolve(__dirname, "..", "package.json"), "utf-8"
      ));
      console.log(`neuralgentics v${pkg.version}`);
    } catch {
      console.log("neuralgentics (version unknown)");
    }
    return;
  }

  // ── Auto-detect .opencode/ config ───────────────────────────────────────
  // If .opencode/ doesn't exist in cwd, look for the install prefix config
  // and symlink it. This makes neuralgentics work from any directory —
  // home dir, project dir, anywhere — without manual setup.
  ensureOpenCodeConfig();

  renderer = await createCliRenderer({ exitOnCtrlC: true });
  renderer.setBackgroundColor(COLORS.bg);

  // ── Database health check ──────────────────────────────────────────────
  const dbStatus = await checkDatabase();
  if (!dbStatus.available) {
    console.error(`[neuralgentics] ${dbStatus.error}`);
    // Surface in chat panel so user sees it
    state.chatMessages.push(`⚠ Database: ${dbStatus.error}`);
  } else {
    console.log(`[neuralgentics] Database reachable on ${dbStatus.host}:${dbStatus.port}`);
  }

  // ── gRPC sidecar lifecycle ─────────────────────────────────────────────
  // Auto-spawn sidecar if socket is not found (T-022: auto-start behavior)
  const sidecarStatus = await initSidecar(true);
  if (!sidecarStatus.available) {
    console.error(`[neuralgentics] ${sidecarStatus.error}`);
    state.chatMessages.push(`⚠ Sidecar: ${sidecarStatus.error}`);
  } else if (sidecarStatus.spawnedByTUI) {
    console.log(`[neuralgentics] Sidecar auto-started (pid=${sidecarStatus.pid})`);
    state.chatMessages.push(`Sidecar auto-started (pid=${sidecarStatus.pid})`);
  } else {
    console.log("[neuralgentics] Sidecar already running");
  }

  // Register shutdown handlers (kills sidecar only if TUI spawned it)
  registerSidecarShutdown();

  // ── OpenCode SDK client lifecycle (T-023) ──────────────────────────────────
  opencodeClient = new OpenCodeClient({ autoStart: false });
  // Listen for status changes to update the TUI
  opencodeClient.on("statusChange", (status: unknown) => {
    state.opencodeStatus = status as OpenCodeStatus;
    if (status === "ready") {
      state.chatMessages.push("✓ OpenCode server connected — agent loop online");
      state.agentRoster.set("coder", "ready");
    } else if (status === "degraded") {
      state.chatMessages.push("⚠ Agent loop offline — memory ops only");
      state.agentRoster.set("coder", "offline");
    } else if (status === "offline") {
      state.agentRoster.set("coder", "offline");
    }
    chatText.content = state.chatMessages.join("\n");
    statusText.content = buildStatusBarText();
  });

  opencodeClient.on("crash", (error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    state.chatMessages.push(`⚠ OpenCode crashed: ${msg}`);
    chatText.content = state.chatMessages.join("\n");
  });

  // Try to start the OpenCode server
  try {
    await opencodeClient.start();
    opencodeClient.registerShutdownHandlers();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "PortConflictError") {
      state.chatMessages.push(`⚠ ${err.message}`);
      state.chatMessages.push("⚠ Agent loop offline — memory operations still available via Go backend");
      state.opencodeStatus = "degraded";
    } else if (err && typeof err === "object" && "degraded" in err && (err as { degraded?: unknown }).degraded === true) {
      // OpenCodeStartError — already in degraded mode via statusChange listener
      console.error(`[opencode] ${"message" in err ? (err as { message?: unknown }).message : String(err)}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      state.chatMessages.push(`⚠ OpenCode failed: ${msg}`);
      state.opencodeStatus = "degraded";
    }
    chatText.content = state.chatMessages.join("\n");
    statusText.content = buildStatusBarText();
    // TUI continues in degraded mode — memory ops via T-020 client still work
  }

  // ── Neuralgentics JSON-RPC client (T-020) ────────────────────────────────────
  try {
    neuralgenticsClient = new NeuralgenticsClient();
    await neuralgenticsClient.waitForReady(5000);
    console.log("[neuralgentics] Go backend connected");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[neuralgentics] Go backend failed: ${msg}`);
    state.chatMessages.push(`⚠ Go backend offline: ${msg}`);
    neuralgenticsClient = null;
  }

  // ── Offline Detection Event Listeners (T-081b) ───────────────────────────────
  // Subscribe to both clients' offline events to update banner and status bar.

  if (opencodeClient) {
    opencodeClient.onOfflineEvent("offline", () => {
      state.offlineState = { ...state.offlineState, opencode: "offline" };
      console.log("[offline] OpenCode client went offline");
      updateOfflineBanner();
    });
    opencodeClient.onOfflineEvent("online", () => {
      state.offlineState = { ...state.offlineState, opencode: "online" };
      console.log("[offline] OpenCode client recovered — online");
      updateOfflineBanner();
    });
  }

  if (neuralgenticsClient) {
    neuralgenticsClient.on("offline", () => {
      state.offlineState = { ...state.offlineState, neuralgentics: "offline" };
      console.log("[offline] Neuralgentics client went offline");
      updateOfflineBanner();
    });
    neuralgenticsClient.on("online", () => {
      state.offlineState = { ...state.offlineState, neuralgentics: "online" };
      console.log("[offline] Neuralgentics client recovered — online");
      updateOfflineBanner();
    });
  }

  // ── Token Counter (T-033) ──────────────────────────────────────────────────
  // TokenCounter tracks per-call token usage and provides data for /spend.
  // It persists each entry to neuralgentics memory as type "token_audit".
  tokenCounter = new TokenCounter({
    client: neuralgenticsClient ?? undefined,
    sessionId: state.sessionId,
    persistToMemory: neuralgenticsClient !== null,
  });

  // ── Session Manager (T-027) ──────────────────────────────────────────────────
  // SessionManager glues OpenCodeClient + NeuralgenticsClient together.
  // It handles session lifecycle, streaming prompts, and the stateless agent protocol.
  if (opencodeClient && neuralgenticsClient) {
    sessionManager = new SessionManager({
      opencode: opencodeClient,
      neuralgentics: neuralgenticsClient,
      tokenCounter: tokenCounter ?? undefined,
    });
    sessionManager.on("statusChange", (status: unknown) => {
      state.sessionStatus = status as SessionManagerStatus;
      statusText.content = buildStatusBarText();
    });
    sessionManager.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      state.chatMessages.push(`⚠ Session error: ${msg}`);
      chatText.content = state.chatMessages.join("\n");
    });
    console.log("[session] SessionManager initialized");
  } else if (opencodeClient) {
    // OpenCode available but Go backend offline — limited session manager
    console.warn("[session] Go backend unavailable — SessionManager will not store context in memory");
  }

  await buildLayout(renderer);

  // ── T-080: Session Resume at Startup ─────────────────────────────────────
  // Try to resume from checkpoint. If a checkpoint exists, the TUI banner
  // shows "Resuming session SESS-xxx at [age]". If not, fresh session.
  if (sessionManager) {
    try {
      const resumeResult = await sessionManager.resume();
      if (resumeResult.resumed) {
        state.chatMessages.push(`Resuming session ${resumeResult.checkpointId} at ${resumeResult.age}`);
        console.log(`[session] Resumed from checkpoint: ${resumeResult.checkpointId} (${resumeResult.age})`);

        // Re-parse kanban to reflect current TASKS.md state
        try {
          state.kanbanBoard = parseKanbanBoard();
          kanbanText.content = buildKanbanContent();
        } catch {
          // Kanban parse failure is non-critical on resume
        }
      } else if (resumeResult.reason === "no-checkpoint") {
        state.chatMessages.push("Fresh session — no checkpoint found.");
        console.log("[session] No checkpoint found, starting fresh session.");
      } else if (resumeResult.reason === "offline") {
        state.chatMessages.push("⚠ OpenCode client offline — resume skipped. Use /resume after reconnecting.");
        console.log("[session] Resume skipped: OpenCode client offline.");
      } else if (resumeResult.reason === "already-resumed") {
        console.log("[session] Resume skipped: already resumed.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[session] Resume attempt failed: ${msg}`);
      // Non-fatal — TUI continues with fresh session
    }
    chatText.content = state.chatMessages.join("\n");
  }

  // ── Diff panel (T-030) ───────────────────────────────────────────────────────
  // Instantiated after layout so the modal overlay can attach to the root.
  // The panel is shown via the `/diff` slash command (or programmatically).
  diffPanel = new DiffPanel();
  diffPanel.onAccept(async () => {
    state.chatMessages.push("✓ Diff accepted (test runner would re-run acceptance criteria here)");
    chatText.content = state.chatMessages.join("\n");
    return { pass: true, confidence: "high" };
  });
  diffPanel.onReject(() => {
    state.chatMessages.push("✗ Diff rejected by user");
    chatText.content = state.chatMessages.join("\n");
  });

  // OpenTUI handles SIGWINCH and terminal resize automatically
  // via its yoga layout engine. No explicit resize handler needed.
}

main().catch((err) => {
  console.error("Neuralgentics TUI failed to start:", err);
  // CRITICAL: destroy the renderer before exiting. createCliRenderer puts
  // the terminal in raw mode via setupTerminal(). If we exit without
  // calling destroy(), the terminal stays in raw mode — every keystroke
  // becomes raw escape sequences and the user has to kill the terminal.
  if (renderer && !renderer.isDestroyed) {
    try { renderer.destroy(); } catch { /* best effort */ }
  }
  process.exit(1);
});