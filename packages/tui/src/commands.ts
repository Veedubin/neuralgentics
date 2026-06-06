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

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CompactionOrchestrator, CompactionResult } from "./compaction/index.js";
import { handleSpendCommand, handleSpendHistoryCommand } from "./observability/token-counter.js";
import type { TokenCounter } from "./observability/token-counter.js";
import {
  OpportunityDetector,
  handleOpportunitiesCommand,
} from "./opportunity-detector/index.js";
import type { RankedCandidate } from "./opportunity-detector/types.js";
import { CircuitBreaker } from "./kanban/circuit-breaker.js";
import type { KanbanBoard, KanbanStatus } from "./kanban/types.js";
import { KANBAN_STATUSES } from "./kanban/types.js";
import type { NeuralgenticsClient } from "./neuralgentics-client/client.js";
import type { ModelPrefClient } from "./agents/model-registry.js";
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
] as const;

export type CommandName = (typeof COMMANDS)[number];

/** Available commands string for `/help` display. */
const COMMAND_LIST = `/compact, /spend, /memory [query], /board, /chain [chain-id], /harness, /resume <card-id>, /review, /diff, /scaffold <title>, /opportunities, /theme [dark|light], /model [name|reset]`;

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
          message: "Opening 3-way merge viewer... (Tab: cycle pane, 1/2/3: jump, y: accept, n: reject, q: close)",
          refreshKanban: false,
          showDiffThreeWay: true,
          threeWayData: { base, ours, theirs },
        };
      }
      return {
        command: "diff",
        message: "Opening diff verification panel... (press y to accept, n to reject, q to close)",
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
      if (!deps?.opportunityDetector) {
        return {
          command: "opportunities",
          message: "/opportunities — opportunity detector not available (no OpportunityDetector)",
          refreshKanban: false,
        };
      }
      // Run a scan and get candidates
      const candidates = deps.opportunityDetector.scanAndRank();
      const sub = _args[0]?.toLowerCase() ?? "";
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
 * Handle the `/resume <card-id>` command.
 *
 * Resets the circuit breaker failure count for the specified card,
 * allowing it to be dispatched again.
 *
 * @param args - Command arguments (first arg is the card ID, e.g. "T-036").
 * @param circuitBreaker - CircuitBreaker instance (optional — graceful degradation).
 */
function handleResumeCommand(args: string[], circuitBreaker?: CircuitBreaker): CommandResult {
  const cardId = args[0];

  if (!cardId) {
    return {
      command: "resume",
      message: "/resume <card-id> — specify a card ID to reset its failure count.\nExample: /resume T-036",
      refreshKanban: false,
    };
  }

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
      lines.push(`  • ${skill.name}${skill.description ? ` — ${skill.description}` : ""}`);
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
      const roleMatch = content.slice(0, 500).match(/(?:role|agent|config)[\s:]+([^\n]+)/i);
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
      message: "/review — kanban board not loaded yet. Try /board first to parse TASKS.md.",
      refreshKanban: true,
    };
  }

  const lines: string[] = [
    "═══ Kanban Review ═══",
    "",
  ];

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
    lines.push(`⚠ Blocked cards: ${blocked.cards.map((c) => `${c.id} (${c.title.slice(0, 30)})`).join(", ")}`);
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
      message: "/scaffold <title> — specify a card title.\nExample: /scaffold Implement WebSocket transport",
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
    lines.push("Commands: /model <name> to switch, /model reset to restore default");
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
    const available = availableModels.length > 0
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
        message: "/memory <query> — search memories\n/memory get <id> — fetch a memory by ID\n/memory count — show total count",
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

    const lines = [
      `Found ${memories.length} memories for: "${query}"`,
      "",
    ];

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
        message: "/chain <chain-id> — show a specific thought chain\n/chain recent — show the most recent thought chain",
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
      message: "Compaction already in progress. Please wait for the current cycle to complete.",
      refreshKanban: false,
    };
  }

  try {
    const result: CompactionResult | null = await orchestrator.compact();

    if (result === null) {
      return {
        command: "compact",
        message: "Compaction skipped — no content to compact or already at optimal size.",
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