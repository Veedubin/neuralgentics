/**
 * System-Prompt Reseed Module (T-028)
 *
 * Implements the 7-part progressive reseed system described in the roadmap.
 * After compaction, the session context is rebuilt with essential information
 * in ≤2K tokens, with parts 1-3 visible in <200ms.
 *
 * Parts:
 * 1. AGENTS.md section-scoped — relevant sections only
 * 2. Compaction summary — brief summary of what was compacted
 * 3. Card context — current TASKS.md card being worked on
 * 4. Active skills — list of loaded skills from .opencode/skills/
 * 5. Board snapshot — current kanban state
 * 6. Recent memories — top-K high-trust memories from neuralgentics
 * 7. Tool set — current tool set from agent.getInitialToolSet
 *
 * Progressive loading: Parts 1-3 are synchronous/local (fast),
 * Parts 4-7 are async and loaded with timeouts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Token Budget Constants ─────────────────────────────────────────────────────

/** Maximum total tokens for a reseed prompt. */
const MAX_TOTAL_TOKENS = 2000;

/** Token budget per part (sum ≤ MAX_TOTAL_TOKENS). */
const PART_BUDGET: Record<ReseedPart, number> = {
  agents_md: 500,
  compaction: 500,
  card_context: 300,
  active_skills: 200,
  board_snapshot: 200,
  recent_memories: 200,
  tool_set: 100,
};

/** Default timeout for async parts (ms). */
const ASYNC_PART_TIMEOUT_MS = 2000;

/** Maximum number of recent memories to fetch. */
const MAX_RECENT_MEMORIES = 10;

/** Trust threshold below which memories get a ⚠️ flag. */
const LOW_TRUST_THRESHOLD = 0.5;

/** AGENTS.md sections to include in Part 1 (by heading). */
const AGENTS_MD_SECTIONS = [
  "Stateless Agent Protocol",
  "Routing",
  "Quality Gates",
  "Agent Onboarding Rules",
  "Sub-Agent Dispatch",
  "Execution Ordering Rules",
];

/** Fast parts that should load within 200ms. */
const FAST_PARTS: readonly ReseedPart[] = [
  "agents_md",
  "compaction",
  "card_context",
] as const;

/** Slow parts that are loaded asynchronously. */
const SLOW_PARTS: readonly ReseedPart[] = [
  "active_skills",
  "board_snapshot",
  "recent_memories",
  "tool_set",
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────────

/** The 7 parts of the progressive reseed, in priority order. */
export type ReseedPart =
  | "agents_md"         // Part 1: AGENTS.md section-scoped
  | "compaction"        // Part 2: Compaction summary
  | "card_context"      // Part 3: Current card context
  | "active_skills"     // Part 4: Active skills listing
  | "board_snapshot"    // Part 5: Kanban board snapshot
  | "recent_memories"   // Part 6: Recent memories (trust ≥ 0.5)
  | "tool_set";          // Part 7: Available tool set

/** A single reseed section with its content. */
export interface ReseedSection {
  part: ReseedPart;
  content: string;
  tokenEstimate: number;
  /** Whether this section was loaded within the 200ms budget. */
  fastLoaded: boolean;
}

/** Result of a progressive reseed operation. */
export interface ReseedResult {
  sections: ReseedSection[];
  totalTokens: number;
  /** Whether all sections were loaded within the 200ms budget. */
  allFast: boolean;
}

/** A memory entry returned from neuralgentics memory.query. */
export interface MemoryEntry {
  id: string;
  content: string;
  trust?: number;
  sourceType?: string;
  metadata?: Record<string, unknown>;
}

/** A skill descriptor from .opencode/skills/. */
export interface SkillDescriptor {
  name: string;
  description: string;
}

/** A kanban card from the board. */
export interface KanbanCard {
  id: string;
  title: string;
  status: string;
  assignee?: string;
}

/** Result of a compaction cycle (for Part 2 summary). */
export interface CompactionSummary {
  factsExtracted: number;
  tokensBefore: number;
  tokensAfter: number;
  savingsRatio: number;
  memoryIds: string[];
}

/** Tool descriptor from the Go backend. */
export interface ToolDescriptor {
  name: string;
  serverName: string;
  description?: string;
}

/** Input for the progressive reseed. */
export interface ReseedInput {
  /** Neuralgentics client for memory.query and agent.getInitialToolSet. */
  neuralgentics: {
    call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  /** Session ID for the reseed. */
  sessionId: string;
  /** Optional compaction summary (from most recent compaction). */
  compactionSummary?: CompactionSummary;
  /** Current card context (from TASKS.md). */
  cardContext?: string;
  /** Board snapshot (current kanban state). */
  boardSnapshot?: KanbanCard[];
  /** Path to AGENTS.md file. Defaults to ./AGENTS.md. */
  agentsMdPath?: string;
  /** Path to .opencode/skills/ directory. Defaults to ./.opencode/skills/. */
  skillsPath?: string;
  /** Override timeout for async parts (ms). Default: 2000. */
  asyncTimeoutMs?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Estimate the token count for a string.
 * Conservative: 4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to fit within a token budget.
 * Adds "[...]" suffix if truncated.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 4) + " [...]";
}

/**
 * Extract relevant sections from AGENTS.md by heading.
 * Only includes sections whose headings match AGENTS_MD_SECTIONS.
 * Sub-headings (### or deeper) within a captured section are included
 * as content, not treated as section breaks.
 */
export function scopeAgentsMd(fullContent: string, sectionHeadings: string[]): string {
  const lines = fullContent.split("\n");
  const sections: string[] = [];
  let currentHeading = "";
  let currentContent: string[] = [];
  let capturing = false;

  for (const line of lines) {
    // Only ## headings (level 2) act as section boundaries.
    // ### and deeper are sub-headings treated as content within a section.
    const headingMatch = /^##\s+(.+)$/.exec(line);
    if (headingMatch) {
      // Save previous section if it was being captured
      if (capturing && currentContent.length > 0) {
        sections.push(`## ${currentHeading}\n${currentContent.join("\n")}`);
      }
      currentHeading = headingMatch[1].trim();
      currentContent = [];
      capturing = sectionHeadings.some(
        (h) => currentHeading.toLowerCase().includes(h.toLowerCase()),
      );
    } else if (capturing) {
      currentContent.push(line);
    }
  }

  // Capture last section
  if (capturing && currentContent.length > 0) {
    sections.push(`## ${currentHeading}\n${currentContent.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Format a memory entry for the reseed prompt.
 * Memories with trust < 0.5 are flagged with ⚠️.
 */
export function formatMemoryEntry(entry: MemoryEntry): string {
  const trust = entry.trust ?? 0.5;
  const prefix = trust < LOW_TRUST_THRESHOLD ? "⚠️ LOW confidence | " : "";
  const content = entry.content.length > 100
    ? entry.content.slice(0, 97) + "..."
    : entry.content;
  return `${prefix}${content}`;
}

/**
 * Apply a timeout to an async operation.
 * Returns undefined if the timeout expires.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), timeoutMs),
    ),
  ]);
}

// ─── Part Loaders ─────────────────────────────────────────────────────────────────

/**
 * Part 1: AGENTS.md section-scoped.
 * Reads AGENTS.md and extracts only relevant sections.
 * This is a synchronous/local operation (file read from disk).
 */
async function loadAgentsMd(
  agentsMdPath: string,
  sectionHeadings: string[],
  budget: number,
): Promise<ReseedSection> {
  const startTime = Date.now();
  let content: string;

  try {
    const raw = await readFile(agentsMdPath, "utf-8");
    content = scopeAgentsMd(raw, sectionHeadings);
  } catch {
    content = "[AGENTS.md not found]";
  }

  content = truncateToTokenBudget(content, budget);
  const tokens = estimateTokens(content);

  return {
    part: "agents_md",
    content,
    tokenEstimate: tokens,
    fastLoaded: (Date.now() - startTime) < 200,
  };
}

/**
 * Part 2: Compaction summary.
 * Uses data passed in from the CompactionOrchestrator.
 * This is synchronous — no I/O needed.
 */
function loadCompactionSummary(
  summary: CompactionSummary | undefined,
  budget: number,
): ReseedSection {
  let content: string;

  if (!summary) {
    content = "[No compaction summary available]";
  } else {
    content = [
      `Compaction Summary: ${summary.factsExtracted} facts extracted`,
      `Tokens: ${summary.tokensBefore} → ${summary.tokensAfter}`,
      `Savings ratio: ${summary.savingsRatio.toFixed(1)}:1`,
      `Memory IDs: ${summary.memoryIds.slice(0, 3).join(", ")}${summary.memoryIds.length > 3 ? ", ..." : ""}`,
    ].join("\n");
  }

  content = truncateToTokenBudget(content, budget);
  return {
    part: "compaction",
    content,
    tokenEstimate: estimateTokens(content),
    fastLoaded: true, // synchronous
  };
}

/**
 * Part 3: Card context.
 * Uses data passed in from the SessionManager's current card.
 * This is synchronous — no I/O needed.
 */
function loadCardContext(
  cardContext: string | undefined,
  budget: number,
): ReseedSection {
  const content = truncateToTokenBudget(
    cardContext ?? "[No current card context]",
    budget,
  );
  return {
    part: "card_context",
    content,
    tokenEstimate: estimateTokens(content),
    fastLoaded: true, // synchronous
  };
}

/**
 * Part 4: Active skills.
 * Reads skill descriptors from the .opencode/skills/ directory.
 */
async function loadActiveSkills(
  skillsPath: string | undefined,
  budget: number,
): Promise<ReseedSection> {
  const startTime = Date.now();
  let content: string;

  try {
    if (!skillsPath) {
      content = "[No skills path configured]";
    } else {
      const { readdir, readFile: readFileAsync } = await import("node:fs/promises");
      const entries = await readdir(skillsPath, { withFileTypes: true });
      const skillDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      const skills: SkillDescriptor[] = [];

      for (const dir of skillDirs.slice(0, 4)) { // top 4 skills
        try {
          const skillFile = join(skillsPath, dir, "SKILL.md");
          const raw = await readFileAsync(skillFile, "utf-8");
          // Extract name and description from YAML frontmatter
          const nameMatch = /^name:\s*(.+)$/m.exec(raw);
          const descMatch = /^description:\s*(.+)$/m.exec(raw);
          skills.push({
            name: nameMatch?.[1]?.trim() ?? dir,
            description: descMatch?.[1]?.trim() ?? "",
          });
        }	catch {
          // Skip unreadable skill files
          skills.push({ name: dir, description: "" });
        }
      }

      content = skills
        .map((s) => `- **${s.name}**: ${s.description || "(no description)"}`)
        .join("\n");
    }
  } catch {
    content = "[Skills directory not found]";
  }

  content = truncateToTokenBudget(content, budget);
  return {
    part: "active_skills",
    content,
    tokenEstimate: estimateTokens(content),
    fastLoaded: (Date.now() - startTime) < 200,
  };
}

/**
 * Part 5: Board snapshot.
 * Formats the current kanban state from passed-in data.
 */
function loadBoardSnapshot(
  cards: KanbanCard[] | undefined,
  budget: number,
): ReseedSection {
  let content: string;

  if (!cards || cards.length === 0) {
    content = "[No board state available]";
  } else {
    const lines = cards
      .slice(0, 10) // Limit to 10 cards
      .map((c) => `- ${c.id}: ${c.title} [${c.status}]${c.assignee ? ` → ${c.assignee}` : ""}`);
    content = lines.join("\n");
  }

  content = truncateToTokenBudget(content, budget);
  return {
    part: "board_snapshot",
    content,
    tokenEstimate: estimateTokens(content),
    fastLoaded: true,
  };
}

/**
 * Part 6: Recent memories from neuralgentics.
 * Fetches top-K high-trust memories. LOW confidence (<0.5) flagged with ⚠️.
 */
async function loadRecentMemories(
  neuralgentics: { call: (method: string, params: Record<string, unknown>) => Promise<unknown> },
  budget: number,
): Promise<ReseedSection> {
  const startTime = Date.now();
  let content: string;

  try {
    const result = await neuralgentics.call("memory.query", {
      query: "recent project context decisions",
      limit: MAX_RECENT_MEMORIES,
      strategy: "tiered",
    });

    const memories = (Array.isArray(result) ? result : []) as MemoryEntry[];

    if (memories.length === 0) {
      content = "[No recent memories]";
    } else {
      content = memories
        .map((m) => formatMemoryEntry(m))
        .join("\n");
    }
  } catch {
    content = "[Memory query unavailable]";
  }

  content = truncateToTokenBudget(content, budget);
  return {
    part: "recent_memories",
    content,
    tokenEstimate: estimateTokens(content),
    fastLoaded: (Date.now() - startTime) < 200,
  };
}

/**
 * Part 7: Tool set from the Go backend.
 * Calls agent.getInitialToolSet to get the current tool set.
 */
async function loadToolSet(
  neuralgentics: { call: (method: string, params: Record<string, unknown>) => Promise<unknown> },
  budget: number,
): Promise<ReseedSection> {
  const startTime = Date.now();
  let content: string;

  try {
    const result = await neuralgentics.call("agent.getInitialToolSet", {
      peerId: "default",
    });

    const data = result as { tools?: ToolDescriptor[] } | undefined;
    const tools = data?.tools ?? [];

    if (tools.length === 0) {
      content = "[No tool set available]";
    } else {
      content = tools
        .slice(0, 20) // max 20 tools
        .map((t) => `- ${t.name} (${t.serverName})`)
        .join("\n");
    }
  } catch {
    content = "[Tool set unavailable]";
  }

  content = truncateToTokenBudget(content, budget);
  return {
    part: "tool_set",
    content,
    tokenEstimate: estimateTokens(content),
    fastLoaded: (Date.now() - startTime) < 200,
  };
}

// ─── Main Reseed Function ──────────────────────────────────────────────────────────

/**
 * Generate a progressive reseed for a session.
 *
 * Parts 1-3 (AGENTS.md, compaction summary, card context) are loaded
 * synchronously from local data and are guaranteed fast (<200ms).
 *
 * Parts 4-7 (skills, board, memories, tool set) are loaded asynchronously
 * with timeouts.
 *
 * @param input - All required data for the reseed.
 * @returns A ReseedResult with sections and total token estimate.
 */
export async function generateReseed(input: ReseedInput): Promise<ReseedResult> {
  const timeoutMs = input.asyncTimeoutMs ?? ASYNC_PART_TIMEOUT_MS;
  const startTime = Date.now();

  // ── Load fast parts (1-3) in parallel ─────────────────────────────────
  const agentsMdPath = input.agentsMdPath ?? join(process.cwd(), "AGENTS.md");
  const [
    agentsMdSection,
    compactionSection,
    cardContextSection,
  ] = await Promise.all([
    loadAgentsMd(agentsMdPath, AGENTS_MD_SECTIONS, PART_BUDGET.agents_md),
    Promise.resolve(
      loadCompactionSummary(input.compactionSummary, PART_BUDGET.compaction),
    ),
    Promise.resolve(
      loadCardContext(input.cardContext, PART_BUDGET.card_context),
    ),
  ]);

  const fastSections: ReseedSection[] = [
    agentsMdSection,
    compactionSection,
    cardContextSection,
  ];

  // ── Load slow parts (4-7) with timeouts ───────────────────────────────
  const [
    skillsResult,
    boardResult,
    memoriesResult,
    toolsResult,
  ] = await Promise.allSettled([
    withTimeout(
      loadActiveSkills(input.skillsPath, PART_BUDGET.active_skills),
      timeoutMs,
    ),
    // Board snapshot is synchronous data but treat as async for consistency
    Promise.resolve(
      loadBoardSnapshot(input.boardSnapshot, PART_BUDGET.board_snapshot),
    ),
    withTimeout(
      loadRecentMemories(input.neuralgentics, PART_BUDGET.recent_memories),
      timeoutMs,
    ),
    withTimeout(
      loadToolSet(input.neuralgentics, PART_BUDGET.tool_set),
      timeoutMs,
    ),
  ]);

  const slowSections: ReseedSection[] = [
    skillsResult.status === "fulfilled" && skillsResult.value !== undefined
      ? skillsResult.value
      : makeFallbackSection("active_skills"),
    boardResult.status === "fulfilled" && boardResult.value !== undefined
      ? boardResult.value
      : makeFallbackSection("board_snapshot"),
    memoriesResult.status === "fulfilled" && memoriesResult.value !== undefined
      ? memoriesResult.value
      : makeFallbackSection("recent_memories"),
    toolsResult.status === "fulfilled" && toolsResult.value !== undefined
      ? toolsResult.value
      : makeFallbackSection("tool_set"),
  ];

  // ── Combine and enforce total token budget ─────────────────────────────
  const allSections = [...fastSections, ...slowSections];
  let totalTokens = allSections.reduce((sum, s) => sum + s.tokenEstimate, 0);

  // If over budget, truncate sections in reverse priority order
  if (totalTokens > MAX_TOTAL_TOKENS) {
    // Truncate from the end (lowest priority first)
    for (let i = allSections.length - 1; i >= 0 && totalTokens > MAX_TOTAL_TOKENS; i--) {
      const excess = totalTokens - MAX_TOTAL_TOKENS;
      const section = allSections[i];
      const newBudget = Math.max(20, section.tokenEstimate - excess);
      const truncated = truncateToTokenBudget(section.content, newBudget);
      const newEstimate = estimateTokens(truncated);
      totalTokens -= section.tokenEstimate - newEstimate;
      section.content = truncated;
      section.tokenEstimate = newEstimate;
    }
  }

  const allFast = (Date.now() - startTime) < 200;

  return {
    sections: allSections,
    totalTokens,
    allFast,
  };
}

/**
 * Check if a reseed is needed for the current session.
 *
 * A reseed is needed when:
 * - After compaction (compactionResult is provided)
 * - After a card transition (previousCard !== currentCard)
 * - After trust threshold changes (trustChangeDetected)
 */
export async function isReseedNeeded(options: {
  compactionResult?: { factsExtracted: number };
  previousCard?: string;
  currentCard?: string;
  trustChangeDetected?: boolean;
}): Promise<boolean> {
  // Reseed after compaction
  if (options.compactionResult && options.compactionResult.factsExtracted > 0) {
    return true;
  }

  // Reseed on card transition
  if (options.previousCard && options.currentCard && options.previousCard !== options.currentCard) {
    return true;
  }

  // Reseed on trust threshold change
  if (options.trustChangeDetected) {
    return true;
  }

  return false;
}

// ─── Factory for CompactionOrchestrator Integration ─────────────────────────────────

/**
 * Create a reseed function compatible with CompactionDependencies.reseed.
 *
 * This factory closes over the ReseedInput configuration and returns
 * a function matching the `(neuralgentics, sessionId) => Promise<{totalTokens}>`
 * signature expected by CompactionOrchestrator.
 *
 * @param input - Base configuration for the reseed (paths, etc.)
 * @returns A reseed function suitable for CompactionDependencies.
 */
export function createReseedFunction(
  input: Omit<ReseedInput, "neuralgentics" | "sessionId">,
): (neuralgentics: ReseedInput["neuralgentics"], sessionId: string) => Promise<{ totalTokens: number }> {
  return async (
    neuralgentics: ReseedInput["neuralgentics"],
    sessionId: string,
  ) => {
    const result = await generateReseed({ ...input, neuralgentics, sessionId });
    return { totalTokens: result.totalTokens };
  };
}

// ─── Internal Helpers for Testing ──────────────────────────────────────────────────

/** Create a fallback section for when an async part times out or fails. */
function makeFallbackSection(part: ReseedPart): ReseedSection {
  return {
    part,
    content: `[${part} unavailable]`,
    tokenEstimate: 3,
    fastLoaded: false,
  };
}