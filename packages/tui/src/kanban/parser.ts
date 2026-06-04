/**
 * Kanban board parser for TASKS.md.
 *
 * Parses the `## Kanban Board (Boomerang Cycle v3)` section from a
 * TASKS.md file and returns a structured KanbanBoard object.
 *
 * Section format:
 *   ### Status        (7 sub-sections: Triage, Todo, Ready, Running, Blocked, Done, Archived)
 *   #### T-NNN · Title
 *   - **Field:** value
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanStatus, AttemptEntry, Comment } from "./types.js";
import { KANBAN_STATUSES } from "./types.js";
import { parseCommentLine } from "./comments.js";
import { parseTruncationLine } from "./attempts.js";

/** Normalize a heading like "Done" or "Running" to canonical status. */
function normalizeStatus(raw: string): KanbanStatus {
  const lower = raw.toLowerCase().trim();
  const match = KANBAN_STATUSES.find((s) => s === lower);
  if (match) return match;
  // Fuzzy match: "todo" matches "todo", etc.
  for (const s of KANBAN_STATUSES) {
    if (lower.includes(s)) return s;
  }
  return "triage"; // Default fallback
}

/** Extract the card ID from a heading like "#### T-021 · TUI App Scaffold + Panel Layout (P0-a)". */
function parseCardHeading(line: string): { id: string; title: string } | null {
  const match = line.match(/^####\s+(T-\d+)\s*·\s*(.+)$/);
  if (!match) return null;
  return { id: match[1], title: match[2].trim() };
}

/** Parse a `- **Field:** value` line into [key, value]. */
function parseFieldLine(line: string): [string, string] | null {
  // Matches: - **Key:** value  OR  - **Key** value  OR  - **Key**: value
  // The colon may be inside or outside the bold markers.
  const match = line.match(/^-\s+\*\*(.+?)\*{2}\s*:?\s*(.*)$/);
  if (!match) return null;
  // Strip trailing colon from the key name (e.g. "Assignee:" -> "Assignee")
  const key = match[1].replace(/:\s*$/, "").trim();
  return [key, match[2].trim()];
}

/** Extract the section name from `### Status` heading. */
function parseSectionHeading(line: string): KanbanStatus | null {
  const match = line.match(/^###\s+(.+)$/);
  if (!match) return null;
  return normalizeStatus(match[1]);
}

/**
 * Find the start of the kanban section in the TASKS.md content.
 * Looks for the line starting with `## Kanban Board`.
 */
function findKanbanSectionStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## Kanban Board")) return i;
  }
  return -1;
}

/**
 * Parse a TASKS.md file into a KanbanBoard structure.
 *
 * @param filePath - Absolute or relative path to the TASKS.md file.
 *   Defaults to `../../TASKS.md` (the project root from `packages/tui/src/kanban/`).
 * @returns Parsed KanbanBoard with all columns and cards.
 */
export function parseKanbanBoard(filePath?: string): KanbanBoard {
  const resolvedPath = filePath
    ? resolve(filePath)
    : resolve(import.meta.dir, "../../../TASKS.md");

  const content = readFileSync(resolvedPath, "utf-8");
  const lines = content.split("\n");

  const startIndex = findKanbanSectionStart(lines);
  if (startIndex === -1) {
    // No kanban section found — return empty board
    return {
      columns: KANBAN_STATUSES.map((status) => ({ status, cards: [] })),
      cardCount: 0,
      parsedAt: new Date().toISOString(),
    };
  }

  const columns: KanbanColumn[] = KANBAN_STATUSES.map((status) => ({
    status,
    cards: [],
  }));

  let currentStatus: KanbanStatus | null = null;
  let currentCard: (Partial<KanbanCard> & { attemptHistory?: AttemptEntry[]; comments?: Comment[]; truncatedAttempts?: number; truncatedMemoryId?: string }) | null = null;
  let inAttemptsSection = false;
  let inCommentsSection = false;
  let sawCommentsField = false;
  let currentAttempt: Partial<AttemptEntry> | null = null;

  function pushCurrentCard(): void {
    if (!currentCard || !currentStatus) return;
    const col = columns.find((c) => c.status === currentStatus);
    if (col && currentCard.id && currentCard.title) {
      col.cards.push({
        id: currentCard.id,
        title: currentCard.title,
        status: currentStatus,
        assignee: currentCard.raw?.["Assignee"] ?? "unassigned",
        phase: currentCard.raw?.["Phase"] ?? "",
        roadmap: currentCard.raw?.["Roadmap"] ?? "",
        goal: currentCard.raw?.["Goal"] ?? "",
        dependsOn: parseDependsList(currentCard.raw?.["Depends on"] ?? ""),
        blocks: parseDependsList(currentCard.raw?.["Blocks"] ?? ""),
        failureCount: parseInt(currentCard.raw?.["Failure count"] ?? "0", 10) || 0,
        failureLimit: parseInt(currentCard.raw?.["Failure limit"] ?? "2", 10) || 2,
        attemptHistory: currentCard.attemptHistory ?? [],
        truncatedAttempts: currentCard.truncatedAttempts ?? 0,
        truncatedMemoryId: currentCard.truncatedMemoryId ?? "",
        comments: currentCard.comments ?? [],
        raw: currentCard.raw ?? {},
      });
    }
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === "") continue;

    // Skip _(none)_ or _(none currently...)_ placeholders
    if (line.trim().startsWith("_(")) continue;

    // Section heading: ### Status
    const sectionStatus = parseSectionHeading(line);
    if (sectionStatus) {
      pushCurrentCard();
      currentCard = null;
      currentStatus = sectionStatus;
      inAttemptsSection = false;
      currentAttempt = null;
      continue;
    }

    // Card heading: #### T-NNN · Title
    const cardHeading = parseCardHeading(line);
    if (cardHeading) {
      pushCurrentCard();
      currentCard = { id: cardHeading.id, title: cardHeading.title, raw: {}, attemptHistory: [], comments: [], truncatedAttempts: 0, truncatedMemoryId: "" };
      inAttemptsSection = false;
      inCommentsSection = false;
      sawCommentsField = false;
      currentAttempt = null;
      continue;
    }

    // Previous Attempts section heading: ## Previous Attempts
    if (currentCard && line.match(/^##\s+Previous\s+Attempts/i)) {
      inAttemptsSection = true;
      inCommentsSection = false;
      currentAttempt = null;
      continue;
    }

    // Comments section heading: ## Comments
    if (currentCard && line.match(/^##\s+Comments/i)) {
      inCommentsSection = true;
      inAttemptsSection = false;
      currentAttempt = null;
      continue;
    }

    // Attempt heading: ### Attempt N (worker, timestamp, result, N tokens)
    if (currentCard && inAttemptsSection) {
      const attemptMatch = line.match(/^###\s+Attempt\s+(\d+)\s*\(([^,]+),\s*([^,]+),\s*(✅\s*success|❌\s*failure)\s*,\s*([\d,]+)\s*tokens\)/i);
      if (attemptMatch) {
        // Push previous attempt if any
        if (currentAttempt && currentAttempt.attemptNumber !== undefined && currentAttempt.worker !== undefined) {
          currentCard.attemptHistory!.push(currentAttempt as AttemptEntry);
        }
        currentAttempt = {
          attemptNumber: parseInt(attemptMatch[1], 10),
          worker: attemptMatch[2].trim(),
          timestamp: attemptMatch[3].trim(),
          result: attemptMatch[4].includes("success") ? "success" : "failure",
          tokensSpent: parseInt(attemptMatch[5].replace(/,/g, ""), 10),
          memoryId: "",
          summary: "",
        };
        continue;
      }

      // Attempt summary line: > text
      if (currentAttempt && line.match(/^>\s+/)) {
        currentAttempt.summary = line.replace(/^>\s*/, "").trim();
        continue;
      }

      // Memory link line: Memory: `id` or [id](memory:id)
      if (currentAttempt && line.match(/^Memory:/i)) {
        const memMatch = line.match(/`([^`]+)`/);
        if (memMatch) {
          currentAttempt.memoryId = memMatch[1];
        }
        continue;
      }

      // Truncation line: "... and N more in memini-core (memory_id: <id>)"
      if (currentCard && inAttemptsSection) {
        const truncInfo = parseTruncationLine(line.trim());
        if (truncInfo) {
          currentCard.truncatedAttempts = truncInfo.count;
          currentCard.truncatedMemoryId = truncInfo.memoryId;
          continue;
        }
      }

      // Empty line inside attempts section — could be between attempts
      if (line.trim() === "") {
        continue;
      }
    }

    // Reset attempts section on any H2 that isn't "Previous Attempts"
    if (line.match(/^##\s+/) && !line.match(/^##\s+Previous\s+Attempts/i)) {
      if (currentAttempt && currentAttempt.attemptNumber !== undefined) {
        currentCard?.attemptHistory?.push(currentAttempt as AttemptEntry);
        currentAttempt = null;
      }
      inAttemptsSection = false;
    }

    // Comment line: `  - author (timestamp): "body"` (inside ## Comments section)
    if (currentCard && inCommentsSection) {
      const comment = parseCommentLine(line);
      if (comment) {
        currentCard.comments!.push(comment);
        continue;
      }
      // Non-comment lines inside ## Comments section — end the section on headers
      if (line.match(/^##\s+/) || line.match(/^####\s+/) || line.match(/^###\s+/)) {
        inCommentsSection = false;
        // Don't continue — let the line be processed by other handlers below
      }
    }

    // Inline comment lines after - **Comments:** field (not in ## Comments section)
    // These are detected as sub-value lines like:   - author (ts): "body"
    if (currentCard && !inCommentsSection && sawCommentsField) {
      const comment = parseCommentLine(line);
      if (comment) {
        currentCard.comments!.push(comment);
        continue;
      }
      // Non-matching line after Comments field — stop treating lines as comments
      sawCommentsField = false;
    }

    // Field line: - **Field:** value
    if (currentCard) {
      // Check for status override from the Status field
      const field = parseFieldLine(line);
      if (field) {
        const [key, value] = field;
        currentCard.raw![key] = value;

        // If the field is "Status", use it to override the section status
        if (key === "Status") {
          // The status may have extra text like "ready (promoted from todo)"
          // We take just the first word as the status
          currentStatus = normalizeStatus(value.split(" ")[0]);
        }

        // If the field is "Comments", flag that subsequent lines may be comment entries
        if (key === "Comments") {
          sawCommentsField = true;
        }
      }
    }
  }

  // Don't forget the last attempt in progress
  if (currentCard && currentAttempt && currentAttempt.attemptNumber !== undefined) {
    currentCard.attemptHistory?.push(currentAttempt as AttemptEntry);
  }

  // Don't forget the last card
  pushCurrentCard();

  const cardCount = columns.reduce((sum, col) => sum + col.cards.length, 0);

  return {
    columns,
    cardCount,
    parsedAt: new Date().toISOString(),
  };
}

/** Parse a comma-separated dependency list like "T-020, T-023" into an array of IDs. */
function parseDependsList(raw: string): string[] {
  if (!raw || raw === "none" || raw === "—" || raw === "-") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith("T-"));
}

/**
 * Format the kanban board as a compact text representation for the TUI panel.
 *
 * @param board - The parsed KanbanBoard
 * @param maxWidth - Maximum width of the panel (for wrapping)
 * @returns Array of formatted text lines
 */
export function formatKanbanForPanel(board: KanbanBoard, _maxWidth: number = 40): string[] {
  const lines: string[] = [];

  for (const col of board.columns) {
    const label = col.status.charAt(0).toUpperCase() + col.status.slice(1);
    const count = col.cards.length;
    lines.push(`▸ ${label} (${count})`);

    for (const card of col.cards) {
      // Truncate long titles
      const maxTitleLen = _maxWidth - 6; // "  T-NNN " prefix
      const title = card.title.length > maxTitleLen
        ? card.title.slice(0, maxTitleLen - 1) + "…"
        : card.title;
      lines.push(`  ${card.id} ${title}`);
    }

    if (col.cards.length === 0) {
      lines.push("  (empty)");
    }
  }

  return lines;
}