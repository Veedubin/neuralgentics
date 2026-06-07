/**
 * Slash command handler for the TUI input bar.
 *
 * Routes `/`-prefixed commands to handlers.
 * T-039: All 10 commands now do real work:
 *   /spend — TokenCounter (T-033)
 *   /opportunities — OpportunityDetector (T-034)
 *   /memory — query memini-core via NeuralgenticsClient
 *   /chain — show thought chain via NeuralgenticsClient
 *   /resume — reset CircuitBreaker failure count on a card
 *   /harness — show current role + active skills
 *   /review — show kanban board summary counts
 *   /scaffold — generate a new card template
 *   /board — refresh kanban from TASKS.md
 *   /diff — show diff verification panel (T-030)
 *   /compact — trigger compaction pipeline (T-026)
 *   /theme — switch theme (T-032)
 *   /help — list commands
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CompactionOrchestrator,
  CompactionResult,
} from "./compaction/index.js";
import {
  handleSpendCommand,
  handleSpendHistoryCommand,
} from "./observability/token-counter.js";
import type { TokenCounter } from "./observability/token-counter.js";
import {
  OpportunityDetector,
  handleOpportunitiesCommand,
  handleCachedOpportunitiesCommand,
} from "./opportunity-detector/index.js";

// Re-export async handlers for TUI input wiring (T-085)
export { handleCachedOpportunitiesCommand } from "./opportunity-detector/index.js";
import type { RankedCandidate } from "./opportunity-detector/types.js";
import { CircuitBreaker } from "./kanban/circuit-breaker.js";
import type { KanbanBoard, KanbanStatus } from "./kanban/types.js";
import { KANBAN_STATUSES } from "./kanban/types.js";
import type { NeuralgenticsClient } from "./neuralgentics-client/client.js";
import type {
  CuratedTransport,
  DiscoverCatalogResult,
  ListTransportsResult,
  ProviderStatusEntry,
} from "./neuralgentics-client/types.js";
import type { OfflineState } from "./panels/status.js";
import type { ModelPrefClient } from "./agents/model-registry.js";
import type { ResumeResult, ResumeStatus } from "./session/types.js";
import {
  getActiveModel,
  setActiveModel,
  resetModelPref,
  isValidModelName,
  getAvailableModels,
  getRoutingTable,
} from "./agents/model-registry.js";

// ─── CommandResult ──────────────────────────────────────────────────────────────

export interface CommandResult {
  /** The command name (e.g. "help", "board", "compact") without the `/` prefix. */
  command: string;
  /** The message to display in the chat panel. */
  message: string;
  /** Whether this command should trigger a kanban refresh. */
  refreshKanban: boolean;
  /** Whether this command should show the diff panel (T-030). */
  showDiffPanel?: boolean;
  /** Whether this command should show the 3-way merge diff panel (T-083). */
  showDiffThreeWay?: boolean;
  /** 3-way merge content for the diff panel (T-083). */
  threeWayData?: { base: string; ours: string; theirs: string };
  /** Whether this command should switch the theme (T-032). */
  switchTheme?: "dark" | "light";
  /** Content to copy to clipboard (for /scaffold). */
  clipboardContent?: string;
  /** Whether this command changes the active model (T-082). */
  modelChanged?: boolean;
  /** Whether this command requires async handling for /opportunities cached (T-085). */
  opportunitiesCached?: boolean;
  /** Whether this command should report session resume status (T-080). */
  resumeStatus?: ResumeStatus | null;
  /** Offline status diagnostic from /offline command (T-081b). */
  offlineStatus?: {
    opencode: "online" | "offline";
    neuralgentics: "online" | "offline";
    lastCheck: string;
    writeCommandsBlocked: boolean;
  };
}

/** All supported slash commands. */
const COMMANDS = [
  "compact",
  "spend",
  "memory",
  "board",
  "chain",
  "harness",
  "resume",
  "review",
  "diff",
  "scaffold",
  "opportunities",
  "theme",
  "model",
  "offline",
  "tier0",
  "tier1",
  "peer",
  "relationships",
  "decay",
  "extract",
  "catalog",
  "mcp",
  "provider",
] as const;

export type CommandName = (typeof COMMANDS)[number];

/** Available commands string for `/help` display. */
const COMMAND_LIST = `/compact, /spend, /memory [query], /board, /chain [chain-id], /harness, /resume [card-id], /review, /diff, /scaffold <title>, /opportunities, /theme [dark|light], /model [name|reset], /offline, /tier0 [force], /tier1 [force], /peer [list|switch <id>], /relationships <id>, /decay, /extract [convo], /catalog [list|add <name>|info <name>], /mcp [list|activate <name>|deactivate <name>], /provider [list|status|<name>]`;

/** Write commands that should be blocked when offline (T-081b). */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "compact",
  "scaffold",
  "resume",
  "memory",
  "chain",
  "model",
  "peer",
  "extract",
  "catalog",
  "mcp",
  "provider",
]);

// ─── Dependency injection container ──────────────────────────────────────────────

/** Optional dependencies for slash commands that need real infrastructure. */
export interface CommandDependencies {
  /** TokenCounter instance for /spend sub-commands. */
  tokenCounter?: TokenCounter;
  /** OpportunityDetector instance for /opportunities. */
  opportunityDetector?: OpportunityDetector;
  /** CircuitBreaker instance for /resume. */
  circuitBreaker?: CircuitBreaker;
  /** Parsed kanban board for /review. */
  kanbanBoard?: KanbanBoard;
  /** NeuralgenticsClient for /memory and /chain. */
  neuralgenticsClient?: NeuralgenticsClient;
  /** Project root directory for /harness skills scanning. */
  projectRoot?: string;
}

// ─── Synchronous command handler ────────────────────────────────────────────────

/**
 * Process a slash command from the input bar (synchronous commands only).
 *
 * For async commands (/memory, /chain, /compact), use the dedicated
 * async handlers: handleMemoryCommand, handleChainCommand, handleCompactCommand.
 *
 * @param input - The raw input string (may or may not start with `/`).
 * @param deps - Optional dependencies for functional commands.
 * @returns A CommandResult with the response message.
 */
export function handleSlashCommand(
  input: string,
  deps?: CommandDependencies,
): CommandResult {
  const trimmed = input.trim();

  // Not a slash command — echo it back
  if (!trimmed.startsWith("/")) {
    return {
      command: "echo",
      message: trimmed,
      refreshKanban: false,
    };
  }

  // Parse command and args
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  const _args = parts.slice(1);

  switch (cmd) {
    case "help":
      return {
        command: "help",
        message: `Available: ${COMMAND_LIST}`,
        refreshKanban: false,
      };

    case "board":
      // `/board` triggers a kanban refresh
      return {
        command: "board",
        message: "Refreshing kanban board from TASKS.md...",
        refreshKanban: true,
      };

    case "diff": {
      // `/diff` shows the diff verification panel (T-030)
      // `/diff --threeway` shows the 3-way merge viewer (T-083)
      const threewayFlag = _args[0]?.toLowerCase();
      if (threewayFlag === "--threeway" || threewayFlag === "-3") {
        // 3-way merge mode — base, ours, theirs provided as arguments
        // If not enough args, use sample data for demo
        const base = _args[1] ?? "// base version (original)";
        const ours = _args[2] ?? "// ours version (local)";
        const theirs = _args[3] ?? "// theirs version (proposed)";
        return {
          command: "diff",
          message:
            "Opening 3-way merge viewer... (Tab: cycle pane, 1/2/3: jump, y: accept, n: reject, q: close)",
          refreshKanban: false,
          showDiffThreeWay: true,
          threeWayData: { base, ours, theirs },
        };
      }
      return {
        command: "diff",
        message:
          "Opening diff verification panel... (press y to accept, n to reject, q to close)",
        refreshKanban: false,
        showDiffPanel: true,
      };
    }

    case "theme": {
      // `/theme [dark|light]` — switch theme (T-032)
      const themeArg = _args[0]?.toLowerCase();
      if (themeArg === "dark" || themeArg === "light") {
        return {
          command: "theme",
          message: `Switching to ${themeArg} theme...`,
          refreshKanban: false,
          switchTheme: themeArg,
        };
      }
      return {
        command: "theme",
        message: `/theme [dark|light] — specify a theme name, or press F2 to cycle. Current themes: dark, light`,
        refreshKanban: false,
      };
    }

    case "compact": {
      // `/compact` triggers the compaction pipeline (T-026)
      // Async — caller must use handleCompactCommand()
      return {
        command: "compact",
        message: "_compact_", // Signal to caller that compaction should be triggered
        refreshKanban: false,
      };
    }

    case "spend": {
      if (!deps?.tokenCounter) {
        return {
          command: "spend",
          message: "/spend — token accounting not available (no TokenCounter)",
          refreshKanban: false,
        };
      }
      // /spend history requires async — signal to caller to use handleSpendHistoryCommand
      const spendParts = trimmed.split(/\s+/);
      if (spendParts[1]?.toLowerCase() === "history") {
        return {
          command: "spend",
          message: "_spend_history_", // Signal to caller that async handler is needed
          refreshKanban: false,
        };
      }
      return handleSpendCommand(deps.tokenCounter, trimmed);
    }

    case "memory":
    case "chain":
      // Async commands — signal that caller should use handleMemoryCommand/handleChainCommand
      return {
        command: cmd,
        message: `/${cmd} requires an async handler. Use handle${cmd.charAt(0).toUpperCase() + cmd.slice(1)}Command().`,
        refreshKanban: false,
      };

    case "resume":
      return handleResumeCommand(_args, deps?.circuitBreaker);

    case "harness":
      return handleHarnessCommand(deps?.projectRoot);

    case "review":
      return handleReviewCommand(deps?.kanbanBoard);

    case "scaffold":
      return handleScaffoldCommand(_args);

    case "opportunities": {
      // `/opportunities` — show detected skill/script opportunities (T-034)
      // `/opportunities cached` — show cached opportunities from previous sessions (T-085)
      if (!deps?.opportunityDetector) {
        return {
          command: "opportunities",
          message:
            "/opportunities — opportunity detector not available (no OpportunityDetector)",
          refreshKanban: false,
        };
      }
      const sub = _args[0]?.toLowerCase() ?? "";

      // T-085: /opportunities cached is async — signal caller to use handleCachedOpportunitiesCommand
      if (sub === "cached") {
        return {
          command: "opportunities",
          message: "Loading cached opportunities...",
          refreshKanban: false,
          opportunitiesCached: true,
        };
      }

      // Run a scan and get candidates
      const candidates = deps.opportunityDetector.scanAndRank();
      return handleOpportunitiesCommand(candidates, sub);
    }

    case "model": {
      // `/model` — view/set/reset model preference (T-082)
      // /model (no args) → show current + available
      // /model <name> → set active model
      // /model reset → revert to default
      const modelArg = _args[0]?.toLowerCase() ?? "";

      if (!modelArg) {
        // Show current + available models
        return handleModelCommand("list", deps);
      }

      if (modelArg === "reset") {
        return handleModelCommand("reset", deps);
      }

      return handleModelCommand(modelArg, deps);
    }

    case "offline": {
      // `/offline` — show offline status diagnostics (T-081b)
      // This returns a placeholder; the TUI will fill in actual client status
      return {
        command: "offline",
        message: "_offline_", // Signal to caller that async handler is needed
        refreshKanban: false,
      };
    }

    case "tier0":
    case "tier1":
    case "peer":
    case "relationships":
    case "decay":
    case "extract":
    case "catalog":
    case "mcp":
    case "provider":
      // Async commands — signal that caller should use the dedicated async handler
      return {
        command: cmd,
        message: `/${cmd} requires an async handler. Use handle${cmd.charAt(0).toUpperCase() + cmd.slice(1)}Command().`,
        refreshKanban: false,
      };

    default:
      return {
        command: "unknown",
        message: `Unknown command: /${cmd}. Type /help for available commands.`,
        refreshKanban: false,
      };
  }
}

/**
 * Check if an input string is a slash command (starts with `/`).
 */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith("/");
}

// ─── /resume Command ────────────────────────────────────────────────────────────

/**
 * Handle the `/resume` command.
 *
 * Two modes (T-080 extension):
 * - `/resume` (no args) → returns a signal to the TUI to call sessionManager.resume()
 *   and display the checkpoint status. The CommandResult.resumeStatus is set to
 *   a placeholder; the TUI will replace it with the actual ResumeResult.
 * - `/resume <card-id>` → resets the circuit breaker failure count for the card.
 *
 * @param args - Command arguments.
 * @param circuitBreaker - CircuitBreaker instance (optional — graceful degradation).
 */
function handleResumeCommand(
  args: string[],
  circuitBreaker?: CircuitBreaker,
): CommandResult {
  // No args: signal TUI to call sessionManager.resume() and show status
  if (args.length === 0) {
    return {
      command: "resume",
      message: "Checking session checkpoint status...",
      refreshKanban: false,
      resumeStatus: null, // TUI will replace with actual ResumeResult
    };
  }

  // With card ID: reset circuit breaker (original behavior)
  const cardId = args[0];

  if (!circuitBreaker) {
    return {
      command: "resume",
      message: `/resume — circuit breaker not available. Card ${cardId} cannot be resumed without a CircuitBreaker instance.`,
      refreshKanban: false,
    };
  }

  const reset = circuitBreaker.resetFailureCount(cardId);
  if (reset) {
    const state = circuitBreaker.getCircuitBreakerState();
    return {
      command: "resume",
      message: `✓ Card ${cardId} resumed — failure count reset to 0.\n  Blocked today: ${state.blockedToday} | Archived today: ${state.archivedToday}`,
      refreshKanban: true,
    };
  }

  return {
    command: "resume",
    message: `✗ Card ${cardId} not found in circuit breaker. Is the card ID correct?`,
    refreshKanban: false,
  };
}

/**
 * Async handler for `/resume` (no args) — calls sessionManager.resume() and
 * returns a CommandResult with checkpoint status.
 *
 * @param sessionManager - The SessionManager instance.
 * @returns A CommandResult with resume status message.
 */
export async function handleResumeSessionCommand(
  sessionManager: import("./session/session-manager.js").SessionManager,
): Promise<CommandResult> {
  try {
    const result = await sessionManager.resume();

    if (!result.resumed) {
      const reasons: Record<string, string> = {
        "no-checkpoint":
          "No checkpoint found — starting fresh session. Use /compact to create one.",
        offline:
          "OpenCode client offline — cannot resume. Run /compact after reconnecting.",
        "already-resumed": "Session already resumed from checkpoint.",
        error: "Resume failed due to an error. Check logs for details.",
      };
      return {
        command: "resume",
        message: `/resume: ${reasons[result.reason ?? "error"] ?? "Unknown reason."}`,
        refreshKanban: false,
      };
    }

    return {
      command: "resume",
      message: `✓ Resuming session from checkpoint ${result.checkpointId} (${result.age})`,
      refreshKanban: true,
      resumeStatus: {
        checkpointId: result.checkpointId ?? "",
        age: result.age ?? "unknown",
        tokenCount: 0,
        modelName: "",
        opportunityCount: 0,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "resume",
      message: `/resume failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /harness Command ────────────────────────────────────────────────────────────

/**
 * Handle the `/harness` command.
 *
 * Shows the current role and active skills by scanning `.opencode/skills/`
 * directory for SKILL.md files.
 *
 * @param projectRoot - Project root directory to scan for skills.
 */
function handleHarnessCommand(projectRoot?: string): CommandResult {
  const root = projectRoot ?? process.cwd();
  const skillsDir = join(root, ".opencode", "skills");
  const roleDisplay = detectRole(root);

  const skills = scanSkills(skillsDir);

  const lines: string[] = [
    "═══ Agent Harness ═══",
    "",
    `Role: ${roleDisplay}`,
    `Skills directory: ${skillsDir}`,
    `Active skills: ${skills.length}`,
    "",
  ];

  if (skills.length > 0) {
    for (const skill of skills) {
      lines.push(
        `  • ${skill.name}${skill.description ? ` — ${skill.description}` : ""}`,
      );
    }
  } else {
    lines.push("  No skills found in .opencode/skills/");
  }

  lines.push("");
  lines.push("══════════════════════");

  return {
    command: "harness",
    message: lines.join("\n"),
    refreshKanban: false,
  };
}

/**
 * Detect the current agent role from .opencode config.
 * Reads the AGENTS.md or config to determine the role.
 */
function detectRole(projectRoot: string): string {
  const agentsFile = join(projectRoot, "AGENTS.md");
  if (existsSync(agentsFile)) {
    try {
      const content = readFileSync(agentsFile, "utf-8");
      // Look for a role definition in the first 500 chars
      const roleMatch = content
        .slice(0, 500)
        .match(/(?:role|agent|config)[\s:]+([^\n]+)/i);
      if (roleMatch) return roleMatch[1]!.trim();
    } catch {
      // Fall through
    }
  }
  return "boomerang-coder (default)";
}

/** Skill metadata parsed from a SKILL.md file. */
interface SkillInfo {
  name: string;
  description: string;
}

/**
 * Scan the skills directory for SKILL.md files and extract name + description.
 */
function scanSkills(skillsDir: string): SkillInfo[] {
  if (!existsSync(skillsDir)) return [];

  const skills: SkillInfo[] = [];
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = join(skillsDir, entry.name, "SKILL.md");
        if (existsSync(skillFile)) {
          try {
            const content = readFileSync(skillFile, "utf-8");
            const skillInfo = parseSkillMd(entry.name, content);
            skills.push(skillInfo);
          } catch {
            skills.push({ name: entry.name, description: "" });
          }
        }
      }
    }
  } catch {
    // Directory read failure — return empty
  }

  return skills;
}

/**
 * Parse a SKILL.md file to extract the skill name and description.
 */
function parseSkillMd(dirName: string, content: string): SkillInfo {
  // Extract title from first `# Title` line
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const name = titleMatch?.[1]?.trim() ?? dirName;

  // Extract description from first paragraph after title
  const lines = content.split("\n");
  let description = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("#")) continue;
    if (line.length > 0) {
      description = line;
      break;
    }
  }

  return { name, description: description.slice(0, 100) }; // Truncate long descriptions
}

// ─── /review Command ─────────────────────────────────────────────────────────────

/**
 * Handle the `/review` command.
 *
 * Shows a kanban board summary with counts per status column.
 */
function handleReviewCommand(kanbanBoard?: KanbanBoard): CommandResult {
  if (!kanbanBoard) {
    return {
      command: "review",
      message:
        "/review — kanban board not loaded yet. Try /board first to parse TASKS.md.",
      refreshKanban: true,
    };
  }

  const lines: string[] = ["═══ Kanban Review ═══", ""];

  const statusLabels: Record<KanbanStatus, string> = {
    triage: "📥 Triage",
    todo: "📋 Todo",
    ready: "✅ Ready",
    running: "🔄 Running",
    blocked: "🚫 Blocked",
    done: "✓ Done",
    archived: "📦 Archived",
  };

  let totalCards = 0;
  for (const col of kanbanBoard.columns) {
    const label = statusLabels[col.status] ?? col.status;
    const count = col.cards.length;
    totalCards += count;

    if (count > 0) {
      lines.push(`  ${label}: ${count}`);
      // Show card IDs for columns with cards
      const cardIds = col.cards.map((c) => c.id).join(", ");
      lines.push(`    ${cardIds}`);
    } else {
      lines.push(`  ${label}: 0`);
    }
  }

  lines.push("");
  lines.push(`Total cards: ${totalCards}`);
  lines.push(`Parsed at: ${kanbanBoard.parsedAt}`);

  // Highlight blocked and archived
  const blocked = kanbanBoard.columns.find((c) => c.status === "blocked");
  const archived = kanbanBoard.columns.find((c) => c.status === "archived");
  if (blocked && blocked.cards.length > 0) {
    lines.push("");
    lines.push(
      `⚠ Blocked cards: ${blocked.cards.map((c) => `${c.id} (${c.title.slice(0, 30)})`).join(", ")}`,
    );
  }
  if (archived && archived.cards.length > 0) {
    lines.push(`📦 Archived cards: ${archived.cards.length}`);
  }

  lines.push("══════════════════════");

  return {
    command: "review",
    message: lines.join("\n"),
    refreshKanban: false,
  };
}

// ─── /scaffold Command ──────────────────────────────────────────────────────────

/** Card template status options. */
const SCAFFOLD_STATUSES: KanbanStatus[] = ["triage", "todo", "ready"];

/**
 * Handle the `/scaffold <title>` command.
 *
 * Generates a new kanban card template in Markdown format, ready
 * to paste into TASKS.md. Copies to clipboard if available.
 *
 * @param args - Command arguments (first arg is the card title).
 */
function handleScaffoldCommand(args: string[]): CommandResult {
  const title = args.join(" ").trim();

  if (!title) {
    return {
      command: "scaffold",
      message:
        "/scaffold <title> — specify a card title.\nExample: /scaffold Implement WebSocket transport",
      refreshKanban: false,
    };
  }

  // Generate an auto-incrementing card ID hint
  const timestamp = new Date().toISOString().slice(0, 10);
  const status = "ready"; // Default status for new cards
  const assignee = "boomerang-coder";
  const phase = "P1";
  const roadmap = "v0.1.0";

  // Build the card template
  const cardTemplate = [
    "",
    `#### T-??? · ${title} (${phase})`,
    "",
    `- **Status:** ${status}`,
    `- **Assignee:** ${assignee}`,
    `- **Phase:** ${phase}`,
    `- **Roadmap:** ${roadmap}`,
    `- **Goal:** ${title}`,
    `- **Depends on:**`,
    `- **Blocks:**`,
    `- **Failure count:** 0`,
    `- **Failure limit:** 2`,
    "",
    `### Acceptance`,
    `- [ ] ${title} is implemented`,
    `- [ ] Tests pass`,
    `- [ ] No TypeScript errors`,
    "",
    `### Notes`,
    `_Auto-scaffolded by /scaffold on ${timestamp}_`,
    "",
  ].join("\n");

  return {
    command: "scaffold",
    message: `📝 Card template generated for: "${title}"\n\n${cardTemplate}\n\nCopy the template above and paste it into TASKS.md under the appropriate status column.`,
    refreshKanban: false,
    clipboardContent: cardTemplate,
  };
}

// ─── /model Command (T-082) ─────────────────────────────────────────────────────

/**
 * Handle the `/model` command for viewing, setting, and resetting model preference.
 *
 * This is the synchronous version that returns display-only results.
 * For actions that persist model changes, use handleModelCommandAsync().
 *
 * Sub-commands:
 * - "list" (no args) → show current model + list of available models
 * - "reset" → clear preference, revert to default (kimi-k2.6)
 * - "<model_name>" → set active model to the given name
 *
 * @param action - The action: "list", "reset", or a model name.
 * @param _deps - Command dependencies (unused in sync handler, kept for signature consistency).
 */
export function handleModelCommand(
  action: string,
  _deps?: CommandDependencies,
): CommandResult {
  const currentModel = getActiveModel();
  const availableModels = getAvailableModels();

  if (action === "list" || action === "") {
    // Show current model + available models
    const routing = getRoutingTable();
    const lines: string[] = [
      "═══ Model Preference ═══",
      "",
      `Current: ${currentModel}`,
      "",
      "Available models:",
    ];

    for (const model of availableModels) {
      const marker = model === currentModel ? " ← active" : "";
      lines.push(`  • ${model}${marker}`);
    }

    // Show routing table
    lines.push("");
    lines.push("Task routing:");
    for (const [task, category] of Object.entries(routing)) {
      lines.push(`  ${task} → ${category}`);
    }

    lines.push("");
    lines.push(
      "Commands: /model <name> to switch, /model reset to restore default",
    );
    lines.push("════════════════════════════");

    return {
      command: "model",
      message: lines.join("\n"),
      refreshKanban: false,
    };
  }

  if (action === "reset") {
    // Reset to default — the async handler or caller should call resetModelPref()
    return {
      command: "model",
      message: `Resetting model preference to default: kimi-k2.6`,
      refreshKanban: false,
      modelChanged: true,
    };
  }

  // Set model — validate first
  const modelName = action; // case-sensitive model ID

  if (!isValidModelName(modelName)) {
    const available =
      availableModels.length > 0
        ? availableModels.join(", ")
        : "(none found in provider registry)";
    return {
      command: "model",
      message: `⚠ Model '${modelName}' not found in provider registry. Falling back to default.\nAvailable: ${available}`,
      refreshKanban: false,
    };
  }

  // Valid model — signal that the caller should call setActiveModel()
  return {
    command: "model",
    message: `Switching model to: ${modelName}`,
    refreshKanban: false,
    modelChanged: true,
  };
}

/**
 * Async handler for `/model` commands that require persistence.
 *
 * Should be called by the TUI input handler when the sync handler returns
 * `modelChanged: true`. Persists model changes via the NeuralgenticsClient.
 *
 * @param action - "reset" or a model name to set.
 * @param client - NeuralgenticsClient for persistence.
 */
export async function handleModelCommandAsync(
  action: string,
  client: NeuralgenticsClient,
): Promise<CommandResult> {
  // Cast to ModelPrefClient — NeuralgenticsClient's call is generic-typed
  // but ModelPrefClient uses a looser string-based signature
  const prefClient = client as unknown as ModelPrefClient;

  try {
    if (action === "reset") {
      const model = await resetModelPref(prefClient);
      return {
        command: "model",
        message: `✓ Model reset to default: ${model}`,
        refreshKanban: false,
      };
    }

    // Set model
    const model = await setActiveModel(action, prefClient);
    return {
      command: "model",
      message: `✓ Active model set to: ${model}`,
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "model",
      message: `/model failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /memory Command (Async) ─────────────────────────────────────────────────────

/**
 * Handle the `/memory [query]` command (async).
 *
 * Queries neuralgentics memory via the JSON-RPC client and returns
 * matching memory entries.
 *
 * Sub-commands:
 * - `/memory <query>` — search memories
 * - `/memory get <id>` — get a single memory by ID
 * - `/memory count` — show total memory count
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string (e.g. "/memory my query" or "/memory get abc-123").
 */
export async function handleMemoryCommand(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  const sub = parts[1]?.toLowerCase() ?? "";
  const queryParts = parts.slice(2).join(" ").trim();

  try {
    if (sub === "get" && queryParts) {
      // `/memory get <id>` — fetch a single memory
      const result = await client.call("memory.get", { id: queryParts });
      const mem = result as Record<string, unknown>;
      const lines = [
        `═══ Memory: ${queryParts} ═══`,
        "",
        `Content: ${String(mem.content ?? "(no content)").slice(0, 500)}`,
        `Source: ${String(mem.sourceType ?? "unknown")}`,
        `Trust: ${String(mem.trustScore ?? "N/A")}`,
        `Created: ${String(mem.createdAt ?? "N/A")}`,
        "",
        "══════════════════════",
      ];
      return {
        command: "memory",
        message: lines.join("\n"),
        refreshKanban: false,
      };
    }

    if (sub === "count") {
      // `/memory count` — show total memory count
      const result = await client.call("memory.count", {});
      const count = (result as Record<string, unknown>).count ?? "unknown";
      return {
        command: "memory",
        message: `Memory count: ${count}`,
        refreshKanban: false,
      };
    }

    // Default: `/memory <query>` — search memories
    const query = parts.slice(1).join(" ").trim();
    if (!query) {
      return {
        command: "memory",
        message:
          "/memory <query> — search memories\n/memory get <id> — fetch a memory by ID\n/memory count — show total count",
        refreshKanban: false,
      };
    }

    const result = await client.call("memory.query", {
      query,
      limit: 5,
      strategy: "tiered",
    });
    const memories = result as Record<string, unknown>[];

    if (!memories || memories.length === 0) {
      return {
        command: "memory",
        message: `No memories found for: "${query}"`,
        refreshKanban: false,
      };
    }

    const lines = [`Found ${memories.length} memories for: "${query}"`, ""];

    for (const mem of memories) {
      const id = String(mem.id ?? "???").slice(0, 8);
      const content = String(mem.content ?? "").slice(0, 80);
      const trust = String(mem.trustScore ?? "N/A");
      lines.push(`  [${id}] trust=${trust} ${content}...`);
    }

    lines.push("");
    lines.push("Use /memory get <id> to view full content.");

    return {
      command: "memory",
      message: lines.join("\n"),
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "memory",
      message: `/memory failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /chain Command (Async) ──────────────────────────────────────────────────────

/**
 * Handle the `/chain [chain-id]` command (async).
 *
 * Shows thought chain details via the NeuralgenticsClient.
 *
 * Sub-commands:
 * - `/chain <chain-id>` — show a specific thought chain
 * - `/chain recent` — show the most recent thought chain
 * - `/chain` — show help
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string.
 */
export async function handleChainCommand(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  const sub = parts[1]?.toLowerCase() ?? "";

  try {
    if (!sub) {
      return {
        command: "chain",
        message:
          "/chain <chain-id> — show a specific thought chain\n/chain recent — show the most recent thought chain",
        refreshKanban: false,
      };
    }

    let chainId: string;
    if (sub === "recent") {
      // Use a related chains search to find the latest
      const result = await client.call("memory.getRelatedThoughtChains", {
        query: "recent thought chain",
        limit: 1,
      });
      const chains = result as Record<string, unknown>[];
      if (!chains || chains.length === 0) {
        return {
          command: "chain",
          message: "No recent thought chains found.",
          refreshKanban: false,
        };
      }
      chainId = String(chains[0]!.id ?? chains[0]!.chainId ?? "");
    } else {
      chainId = parts[1]!;
    }

    // Fetch the thought chain
    const result = await client.call("memory.getThoughtChain", {
      chainId,
    });
    const chain = result as Record<string, unknown>;

    const thoughts = (chain.thoughts ?? []) as Record<string, unknown>[];
    if (!thoughts || thoughts.length === 0) {
      return {
        command: "chain",
        message: `Chain ${chainId}: no thoughts found.`,
        refreshKanban: false,
      };
    }

    const lines = [
      `═══ Thought Chain: ${chainId.slice(0, 12)}... ═══`,
      `Thoughts: ${thoughts.length}`,
      "",
    ];

    for (const thought of thoughts) {
      const num = String(thought.thoughtNumber ?? "?");
      const total = String(thought.totalThoughts ?? "?");
      const text = String(thought.thought ?? "").slice(0, 120);
      const isRevision = thought.isRevision === true ? " [revision]" : "";
      lines.push(`  ${num}/${total}${isRevision}: ${text}...`);
    }

    lines.push("");
    lines.push("══════════════════════════");

    return {
      command: "chain",
      message: lines.join("\n"),
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "chain",
      message: `/chain failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── Compaction Command Handler ──────────────────────────────────────────────────

/**
 * Execute the `/compact` command using the CompactionOrchestrator.
 *
 * This function is called by the TUI input handler when the user
 * types `/compact`. It triggers a manual compaction cycle and returns
 * a human-readable message for the chat panel.
 *
 * @param orchestrator - The CompactionOrchestrator instance.
 * @returns A CommandResult with a human-readable summary message.
 */
export async function handleCompactCommand(
  orchestrator: CompactionOrchestrator,
): Promise<CommandResult> {
  // Check if compaction is already in progress (mutex / double-/compact)
  if (orchestrator.isCompacting) {
    return {
      command: "compact",
      message:
        "Compaction already in progress. Please wait for the current cycle to complete.",
      refreshKanban: false,
    };
  }

  try {
    const result: CompactionResult | null = await orchestrator.compact();

    if (result === null) {
      return {
        command: "compact",
        message:
          "Compaction skipped — no content to compact or already at optimal size.",
        refreshKanban: false,
      };
    }

    const savingsStr = result.savingsRatio.toFixed(1);
    return {
      command: "compact",
      message:
        `Compaction complete. ` +
        `${result.factsExtracted} facts saved. ` +
        `Tokens: ${result.tokensBefore.toLocaleString()} → ${result.tokensAfter.toLocaleString()}. ` +
        `Savings: ${savingsStr}:1. ` +
        `${result.reverted ? "Session reverted." : "Revert skipped."} ` +
        `${result.reseeded ? "Reseeded." : "Reseed skipped."} ` +
        `Duration: ${result.durationMs}ms`,
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "compact",
      message: `Compaction failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── Offline Command & Write Gating (T-081b) ─────────────────────────────────

/**
 * Check if a slash command is a write command that should be blocked when offline.
 *
 * Write commands require a live backend connection. Read commands (help, board,
 * review, theme, spend, diff, opportunities, offline, status) are always allowed.
 *
 * @param cmd - The command name (without the `/` prefix).
 * @returns True if the command requires write access to the backend.
 */
export function isWriteCommand(cmd: string): boolean {
  return WRITE_COMMANDS.has(cmd);
}

/**
 * Check whether write commands should be blocked based on offline state.
 *
 * If either client is offline, write commands are blocked.
 *
 * @param offlineState - The current offline state for both clients.
 * @returns True if write commands should be blocked.
 */
export function isWriteBlocked(
  offlineState: OfflineState | undefined,
): boolean {
  if (!offlineState) return false;
  return (
    offlineState.opencode === "offline" ||
    offlineState.neuralgentics === "offline"
  );
}

/**
 * Async handler for `/offline` — shows diagnostic information about
 * the current offline state of both clients.
 *
 * @param opencodeStatus - The OpenCode client's online status.
 * @param neuralgenticsStatus - The Neuralgentics (Go backend) client's online status.
 * @returns A CommandResult with offline diagnostics.
 */
export async function handleOfflineCommand(
  opencodeStatus: "online" | "offline",
  neuralgenticsStatus: "online" | "offline",
): Promise<CommandResult> {
  const offlineState: OfflineState = {
    opencode: opencodeStatus,
    neuralgentics: neuralgenticsStatus,
  };

  const writeBlocked = isWriteBlocked(offlineState);
  const bothOffline =
    opencodeStatus === "offline" && neuralgenticsStatus === "offline";

  const lines: string[] = [
    "═══ Offline Diagnostics ═══",
    "",
    `OpenCode (LLM):  ${opencodeStatus === "online" ? "✓ online" : "✗ OFFLINE"}`,
    `Go Backend:       ${neuralgenticsStatus === "online" ? "✓ online" : "✗ OFFLINE"}`,
    "",
    `Write commands:   ${writeBlocked ? "✗ BLOCKED" : "✓ available"}`,
    `Read commands:    ✓ always available`,
    "",
  ];

  if (bothOffline) {
    lines.push("🟧 Both services OFFLINE — local operations only.");
    lines.push(
      "  Available: /help, /board, /review, /diff, /theme, /spend, /offline",
    );
    lines.push(
      "  Blocked: /compact, /scaffold, /resume, /memory, /chain, /model",
    );
  } else if (writeBlocked) {
    if (opencodeStatus === "offline") {
      lines.push("⚠ LLM (OpenCode) offline — agent loop unavailable.");
      lines.push("  Memory ops and Go backend features still available.");
    }
    if (neuralgenticsStatus === "offline") {
      lines.push("⚠ Go backend offline — memory ops unavailable.");
      lines.push("  LLM features may still be available.");
    }
  } else {
    lines.push("All services operational. No offline issues detected.");
  }

  lines.push("");
  lines.push("════════════════════════════");

  return {
    command: "offline",
    message: lines.join("\n"),
    refreshKanban: false,
    offlineStatus: {
      opencode: opencodeStatus,
      neuralgentics: neuralgenticsStatus,
      lastCheck: new Date().toISOString(),
      writeCommandsBlocked: writeBlocked,
    },
  };
}

// ─── /tier0 Command (Async) ──────────────────────────────────────────────────────

/**
 * Handle the `/tier0 [force]` command (async).
 *
 * Fetches the L0 project summary (~100 tokens) from high-trust memories.
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string (e.g. "/tier0" or "/tier0 force").
 */
export async function handleTier0Command(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  const forceArg = parts[1]?.toLowerCase() ?? "";
  const forceRefresh = forceArg === "force";

  try {
    const result = await client.getTier0Summary(forceRefresh);

    const lines = [
      `═══ Tier 0 Summary (L0) ═══`,
      "",
      `${result.content}`,
      "",
      `Tier: ${result.tier}`,
      `Tokens: ${result.tokenCount}`,
      `Generated: ${result.generatedAt}`,
      "",
      "════════════════════════════",
    ];

    return {
      command: "tier0",
      message: lines.join("\n"),
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "tier0",
      message: `/tier0 failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /tier1 Command (Async) ──────────────────────────────────────────────────────

/**
 * Handle the `/tier1 [force]` command (async).
 *
 * Fetches the L1 key decisions summary (~2K tokens) from highest-trust memories.
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string (e.g. "/tier1" or "/tier1 force").
 */
export async function handleTier1Command(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  const forceArg = parts[1]?.toLowerCase() ?? "";
  const forceRefresh = forceArg === "force";

  try {
    const result = await client.getTier1Summary(forceRefresh);

    const lines = [
      `═══ Tier 1 Summary (L1) ═══`,
      "",
      `${result.content}`,
      "",
      `Tier: ${result.tier}`,
      `Tokens: ${result.tokenCount}`,
      `Generated: ${result.generatedAt}`,
      "",
      "════════════════════════════",
    ];

    return {
      command: "tier1",
      message: lines.join("\n"),
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "tier1",
      message: `/tier1 failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /peer Command (Async) ───────────────────────────────────────────────────────

/**
 * Handle the `/peer [list|switch <id>]` command (async).
 *
 * Sub-commands:
 * - `/peer list` — list all known peers
 * - `/peer switch <id>` — switch the active peer context
 * - `/peer` — show help
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string.
 */
export async function handlePeerCommand(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  // parts[0] is "peer", parts[1] is sub-command
  const subCmd = parts[1]?.toLowerCase() ?? "";

  try {
    if (subCmd === "list" || subCmd === "") {
      const result = await client.call("peer.listPeers", {});
      const peers = result as Record<string, unknown>[];

      if (!peers || peers.length === 0) {
        return {
          command: "peer",
          message: "No peers registered.",
          refreshKanban: false,
        };
      }

      const lines = [`═══ Peer List (${peers.length}) ═══`, ""];

      for (const peer of peers) {
        const id = String(peer.peerId ?? peer.id ?? "???").slice(0, 16);
        const name = String(peer.name ?? "unnamed");
        const role = String(peer.role ?? "guest");
        lines.push(`  • ${id} — ${name} (${role})`);
      }

      lines.push("");
      lines.push("════════════════════════════");

      return {
        command: "peer",
        message: lines.join("\n"),
        refreshKanban: false,
      };
    }

    if (subCmd === "switch") {
      const peerId = parts[2];
      if (!peerId) {
        return {
          command: "peer",
          message: "/peer switch <id> — specify a peer ID to switch to.",
          refreshKanban: false,
        };
      }

      const result = await client.switchPeerContext(peerId);

      return {
        command: "peer",
        message: `✓ Switched peer context: ${result.previousPeerId} → ${result.newPeerId}\n  Switched at: ${result.switchedAt}`,
        refreshKanban: false,
      };
    }

    return {
      command: "peer",
      message: `Unknown /peer subcommand: ${subCmd}\nUse: /peer list, /peer switch <id>`,
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "peer",
      message: `/peer failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /relationships Command (Async) ──────────────────────────────────────────────

/**
 * Handle the `/relationships <id>` command (async).
 *
 * Shows a summary of all relationships for a memory.
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string (e.g. "/relationships mem-456").
 */
export async function handleRelationshipsCommand(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  const memoryId = parts[1]?.trim() ?? "";

  if (!memoryId) {
    return {
      command: "relationships",
      message:
        "/relationships <id> — specify a memory ID to view its relationships.",
      refreshKanban: false,
    };
  }

  try {
    const result = await client.getRelationshipSummary(memoryId);

    const lines = [
      `═══ Relationships: ${memoryId.slice(0, 12)}... ═══`,
      "",
      `Total: ${result.totalRelationships}`,
    ];

    if (result.byType && Object.keys(result.byType).length > 0) {
      lines.push("");
      lines.push("By type:");
      for (const [type, count] of Object.entries(result.byType)) {
        lines.push(`  • ${type}: ${count}`);
      }
    }

    if (result.related && result.related.length > 0) {
      lines.push("");
      lines.push("Related memories:");
      for (const rel of result.related) {
        const id = String(rel.id).slice(0, 8);
        lines.push(
          `  [${id}] ${rel.relationshipType} (confidence: ${rel.confidence})`,
        );
      }
    }

    lines.push("");
    lines.push("══════════════════════════════");

    return {
      command: "relationships",
      message: lines.join("\n"),
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "relationships",
      message: `/relationships failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /decay Command (Async) ───────────────────────────────────────────────────────

/**
 * Handle the `/decay` command (async).
 *
 * Shows the current decay engine status and statistics.
 *
 * @param client - NeuralgenticsClient instance.
 */
export async function handleDecayCommand(
  client: NeuralgenticsClient,
): Promise<CommandResult> {
  try {
    const result = await client.call("memory.getDecayStatus", {});
    const status = result as Record<string, unknown>;

    const lines = [
      "═══ Decay Status ═══",
      "",
      `Enabled: ${String(status.enabled ?? "N/A")}`,
      `Total memories: ${String(status.totalMemories ?? "N/A")}`,
      `Fading memories: ${String(status.fadingMemories ?? "N/A")}`,
      `Archived memories: ${String(status.archivedMemories ?? "N/A")}`,
    ];

    if (status.stats) {
      const stats = status.stats as Record<string, unknown>;
      lines.push("");
      lines.push("Stats:");
      for (const [key, val] of Object.entries(stats)) {
        lines.push(`  ${key}: ${String(val)}`);
      }
    }

    lines.push("");
    lines.push("═══════════════════");

    return {
      command: "decay",
      message: lines.join("\n"),
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "decay",
      message: `/decay failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /extract Command (Async) ─────────────────────────────────────────────────────

/**
 * Handle the `/extract [convo]` command (async).
 *
 * Triggers memory extraction. If a conversation string is provided,
 * extracts from that text. Otherwise, uses the server's buffered conversation.
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string (e.g. "/extract" or "/extract some text").
 */
export async function handleExtractCommand(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  // Everything after "/extract" is the optional conversation text
  const conversation = parts.slice(1).join(" ").trim() || undefined;

  try {
    const result = await client.triggerExtraction(conversation);

    const lines = [
      "═══ Extraction Result ═══",
      "",
      `Extracted: ${result.extracted} memories`,
      `Triggered at: ${result.triggeredAt}`,
    ];

    if (result.memoryIds && result.memoryIds.length > 0) {
      lines.push("");
      lines.push("Memory IDs:");
      for (const id of result.memoryIds) {
        lines.push(`  • ${id.slice(0, 12)}...`);
      }
    }

    lines.push("");
    lines.push("═════════════════════════");

    return {
      command: "extract",
      message: lines.join("\n"),
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "extract",
      message: `/extract failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /catalog Command (Async, T-CATALOG-001) ─────────────────────────────────────

/** Local type for catalog server list items from broker.discoverCatalog */
interface CuratedServerForCatalog {
  name: string;
  description: string;
  category: string;
  capabilities: string[];
  transports_count?: number;
  transports?: CuratedTransport[];
  required_env?: string[];
}

/** Local type for transport info items from broker.listTransports */
interface CatalogTransportInfo {
  type: string;
  package?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  default?: boolean;
  description?: string;
}

/** Local type for active server info from broker.buildCatalog */
interface ActiveServerInfo {
  name: string;
  description?: string;
  status?: string;
  toolsCount?: number;
  tools?: unknown[];
  capabilities?: string[];
}

/**
 * Handle the `/catalog [list|add <name>|info <name>]` command (async).
 *
 * Sub-commands:
 * - `/catalog list` — discover curated MCP servers not yet active
 * - `/catalog add <name>` — activate a curated MCP server by name
 * - `/catalog info <name>` — show transport details for a curated MCP server
 * - `/catalog` — default to list
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string (e.g. "/catalog list" or "/catalog add github-mcp").
 */
export async function handleCatalogCommand(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  // parts[0] is "catalog", parts[1] is sub-command, parts[2]+ are args
  const sub = parts[1]?.toLowerCase() ?? "list";

  try {
    if (sub === "list") {
      // `/catalog list` — discover curated servers not yet active
      const result = await client.call("broker.discoverCatalog", {});
      const discovered = result as { servers: CuratedServerForCatalog[] };

      if (!discovered.servers || discovered.servers.length === 0) {
        return {
          command: "catalog",
          message: "No new catalog servers available (all may already be registered).",
          refreshKanban: false,
        };
      }

      const lines = [
        `═══ MCP Catalog (${discovered.servers.length} available) ═══`,
        "",
      ];

      for (const server of discovered.servers) {
        const envBadge = server.required_env?.length
          ? ` [env: ${server.required_env.join(", ")}]`
          : "";
        lines.push(
          `  ${server.name} — ${server.description}${envBadge}`,
        );
        lines.push(
          `    category: ${server.category} | transports: ${server.transports_count ?? server.transports?.length ?? 1}`,
        );
      }

      lines.push("");
      lines.push("Use /catalog add <name> to activate a server.");
      lines.push("════════════════════════════════════════════");

      return {
        command: "catalog",
        message: lines.join("\n"),
        refreshKanban: false,
      };
    }

    if (sub === "add" && parts[2]) {
      // `/catalog add <name>` — activate a curated server
      const name = parts.slice(2).join(" ");
      const result = await client.call("broker.activateFromCatalog", {
        name,
        transportIndex: -1,
      });
      const activateResult = result as { transport: string };

      return {
        command: "catalog",
        message: `✓ Activated ${name} via ${activateResult.transport}`,
        refreshKanban: false,
      };
    }

    if (sub === "info" && parts[2]) {
      // `/catalog info <name>` — show transport details
      const name = parts.slice(2).join(" ");
      const result = await client.call("broker.listTransports", { name });
      const transportInfo = result as {
        transports: CatalogTransportInfo[];
        unavailable: string[];
      };

      const lines = [
        `═══ ${name} — Transports ═══`,
        "",
      ];

      if (transportInfo.transports && transportInfo.transports.length > 0) {
        for (const t of transportInfo.transports) {
          const defaultBadge = t.default ? " ← default" : "";
          const pkg = t.package ? ` (${t.package})` : "";
          const unavailable = transportInfo.unavailable.includes(t.type)
            ? " ✗ UNAVAILABLE"
            : " ✓ available";
          lines.push(
            `  ${t.type}${pkg}${defaultBadge}${unavailable}`,
          );
          if (t.description) {
            lines.push(`    ${t.description}`);
          }
        }
      }

      if (transportInfo.unavailable.length > 0) {
        lines.push("");
        lines.push(
          `⚡ Unavailable transport types: ${transportInfo.unavailable.join(", ")}`,
        );
      }

      lines.push("");
      lines.push("═══════════════════════════════════");

      return {
        command: "catalog",
        message: lines.join("\n"),
        refreshKanban: false,
      };
    }

    return {
      command: "catalog",
      message: "Usage: /catalog [list|add <name>|info <name>]",
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "catalog",
      message: `/catalog failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /mcp Command (Async, T-CATALOG-001) ──────────────────────────────────────────

/**
 * Handle the `/mcp [list|activate <name>|deactivate <name>]` command (async).
 *
 * Sub-commands:
 * - `/mcp list` — list currently active MCP servers
 * - `/mcp activate <name>` — same as `/catalog add <name>`
 * - `/mcp deactivate <name>` — stop and deregister a server
 * - `/mcp` — default to list
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string (e.g. "/mcp list" or "/mcp activate github-mcp").
 */
export async function handleMCPCommand(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  // parts[0] is "mcp", parts[1] is sub-command
  const sub = parts[1]?.toLowerCase() ?? "list";

  try {
    if (sub === "list") {
      // `/mcp list` — list active MCP servers via broker.buildCatalog
      const result = await client.call("broker.buildCatalog", {});
      const catalog = result as {
        servers?: ActiveServerInfo[];
        totalTools?: number;
      };

      const servers = catalog.servers ?? [];
      if (servers.length === 0) {
        return {
          command: "mcp",
          message: "No active MCP servers.",
          refreshKanban: false,
        };
      }

      const lines = [
        `═══ Active MCP Servers (${servers.length}) ═══`,
        "",
      ];

      for (const server of servers) {
        const status = server.status ?? "registered";
        const tools = server.toolsCount ?? server.tools?.length ?? 0;
        lines.push(`  ${server.name} [${status}] — ${tools} tools`);
        if (server.description) {
          lines.push(`    ${server.description}`);
        }
      }

      lines.push("");
      lines.push(`Total tools: ${catalog.totalTools ?? 0}`);
      lines.push("═══════════════════════════════════════");

      return {
        command: "mcp",
        message: lines.join("\n"),
        refreshKanban: false,
      };
    }

    if (sub === "activate" && parts[2]) {
      // `/mcp activate <name>` — same as /catalog add
      const name = parts.slice(2).join(" ");
      const result = await client.call("broker.activateFromCatalog", {
        name,
        transportIndex: -1,
      });
      const activateResult = result as { transport: string };

      return {
        command: "mcp",
        message: `✓ Activated ${name} via ${activateResult.transport}`,
        refreshKanban: false,
      };
    }

    if (sub === "deactivate" && parts[2]) {
      // `/mcp deactivate <name>` — stop and deregister
      const name = parts.slice(2).join(" ");
      await client.call("broker.deactivateMCPServer", { name });

      return {
        command: "mcp",
        message: `✓ Deactivated ${name}`,
        refreshKanban: false,
      };
    }

    return {
      command: "mcp",
      message: "Usage: /mcp [list|activate <name>|deactivate <name>]",
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "mcp",
      message: `/mcp failed: ${msg}`,
      refreshKanban: false,
    };
  }
}

// ─── /provider Command (Async, T-DUAL-PROVIDER) ──────────────────────────────────

/** Known provider names for validation. */
const KNOWN_PROVIDERS = ["ollama-cloud", "dmr-local", "openrouter"] as const;

/** Default provider name. */
const DEFAULT_PROVIDER = "ollama-cloud";

/**
 * Get the path to the provider preference file.
 *
 * Respects XDG_CONFIG_HOME environment variable.
 * Default: `~/.config/neuralgentics/provider-pref.json`
 */
function getProviderPrefPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "neuralgentics", "provider-pref.json");
}

/**
 * Read the current active provider from the preference file.
 * Returns the default provider if the file doesn't exist or can't be parsed.
 */
function readActiveProvider(): string {
  const prefPath = getProviderPrefPath();
  if (existsSync(prefPath)) {
    try {
      const pref = JSON.parse(readFileSync(prefPath, "utf-8"));
      if (typeof pref.activeProvider === "string" && pref.activeProvider) {
        return pref.activeProvider;
      }
    } catch {
      // Fall through to default
    }
  }
  return DEFAULT_PROVIDER;
}

/**
 * Write the active provider to the preference file.
 * Creates parent directories if needed.
 */
function writeActiveProvider(name: string): void {
  const prefPath = getProviderPrefPath();
  mkdirSync(join(prefPath, ".."), { recursive: true });
  writeFileSync(
    prefPath,
    JSON.stringify(
      { activeProvider: name, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}

/**
 * Format provider status entries as a human-readable table.
 */
function formatProviderStatus(statuses: ProviderStatusEntry[]): string {
  const lines = ["═══ Provider Status ═══", ""];
  for (const s of statuses) {
    const latency =
      s.latencyMs !== undefined ? ` (${s.latencyMs}ms)` : "";
    const error = s.error ? ` — ${s.error}` : "";
    lines.push(
      `  ${s.name.padEnd(15)} ${s.status.padEnd(12)} ${s.url}${latency}${error}`,
    );
  }
  lines.push("");
  lines.push("═══════════════════════════════════════");
  return lines.join("\n");
}

/**
 * Handle the `/provider [list|status|<name>]` command (async).
 *
 * Sub-commands:
 * - `/provider` (no args) — show current active provider
 * - `/provider list` or `/provider status` — ping all providers and show status
 * - `/provider <name>` — switch active provider (writes to provider-pref.json)
 *
 * @param client - NeuralgenticsClient instance.
 * @param input - The raw input string (e.g. "/provider list" or "/provider ollama-cloud").
 */
export async function handleProviderCommand(
  client: NeuralgenticsClient,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  // parts[0] is "provider", parts[1] is sub-command or provider name
  const sub = parts[1]?.toLowerCase() ?? "";

  try {
    // No args: show current provider
    if (!sub) {
      const active = readActiveProvider();
      return {
        command: "provider",
        message: `Active provider: ${active}\n(To switch: /provider <name>. List: /provider list. Status: /provider status)`,
        refreshKanban: false,
      };
    }

    // /provider list or /provider status
    if (sub === "list" || sub === "status") {
      const statuses = await client.call("provider.status", {});
      const entries = statuses as ProviderStatusEntry[];
      return {
        command: "provider",
        message: formatProviderStatus(entries),
        refreshKanban: false,
      };
    }

    // /provider <name> — switch provider
    if ((KNOWN_PROVIDERS as readonly string[]).includes(sub)) {
      writeActiveProvider(sub);
      return {
        command: "provider",
        message: `Switched active provider to: ${sub}\n(Restart opencode TUI session to apply the change to agent dispatch.)`,
        refreshKanban: false,
      };
    }

    // Unknown sub-command
    return {
      command: "provider",
      message: `Usage: /provider [list|status|<name>]\nKnown providers: ${KNOWN_PROVIDERS.join(", ")} (default: ${DEFAULT_PROVIDER})`,
      refreshKanban: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "provider",
      message: `/provider failed: ${msg}`,
      refreshKanban: false,
    };
  }
}
