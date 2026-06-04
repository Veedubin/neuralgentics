/**
 * @neuralgentics/tui — Kanban Comment Manager (T-037)
 *
 * Manages inter-agent comments on kanban cards. Workers leave structured
 * comments with author, timestamp, and body. Comments are NOT evidence —
 * they are conversation. This implements v3 P0-a per the roadmap.
 *
 * TASKS.md comment format:
 * ```
 * #### T-XXX · Card Title
 * - **Status:** ...
 * - **Comments:**
 *   - author (2026-06-04 02:15): "Comment body here"
 *   - coder (2026-06-04 02:30): "Another comment"
 * ```
 *
 * Or as a `## Comments` sub-section:
 * ```
 * #### T-XXX · Card Title
 * - **Status:** ...
 * ## Comments
 *   - author (2026-06-04 02:15): "Comment body here"
 * ```
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Comment, KanbanCard } from "./types.js";

// ─── Comment ID Generation ──────────────────────────────────────────────────────

/** Generate a short unique comment ID (8 chars). */
function generateCommentId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "c-";
  // Use a simple random approach — Bun.crypto is available but
  // for 8-char IDs, Math.random is sufficient for our use case.
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ─── Timestamp Formatting ────────────────────────────────────────────────────────

/** Format an ISO timestamp for display (human-readable short form). */
function formatTimestampForDisplay(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (isNaN(date.getTime())) return isoTimestamp;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

// ─── Markdown Rendering ───────────────────────────────────────────────────────────

/** Supported inline markdown tokens in comment bodies. */
const MARKDOWN_PATTERNS: Array<{
  pattern: RegExp;
  replacement: (_match: string, ...groups: string[]) => string;
}> = [
  // Bold: **text**
  { pattern: /\*\*(.+?)\*\*/g, replacement: (_m, text: string) => `\x1b[1m${text}\x1b[22m` },
  // Italic: *text* (but not inside **)
  { pattern: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, replacement: (_m, text: string) => `\x1b[3m${text}\x1b[23m` },
  // Inline code: `text`
  { pattern: /`(.+?)`/g, replacement: (_m, text: string) => `\x1b[7m${text}\x1b[27m` },
  // Links: [text](url)
  { pattern: /\[(.+?)\]\((.+?)\)/g, replacement: (_m, text: string, url: string) => `${text}(${url})` },
];

/**
 * Render inline markdown in a comment body to ANSI escape sequences
 * for terminal display. Supports bold, italic, code, and links.
 */
export function renderMarkdown(body: string): string {
  let rendered = body;
  for (const { pattern, replacement } of MARKDOWN_PATTERNS) {
    rendered = rendered.replace(pattern, replacement as never);
  }
  return rendered;
}

/** Strip inline markdown tokens from a comment body for plain text output. */
export function stripMarkdown(body: string): string {
  let stripped = body;
  // Bold
  stripped = stripped.replace(/\*\*(.+?)\*\*/g, "$1");
  // Italic
  stripped = stripped.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  // Inline code
  stripped = stripped.replace(/`(.+?)`/g, "$1");
  // Links
  stripped = stripped.replace(/\[(.+?)\]\((.+?)\)/g, "$1($2)");
  return stripped;
}

// ─── Comment Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a single comment line from TASKS.md.
 *
 * Format: `  - author (YYYY-MM-DD HH:MM): "body text"`
 * or:    `  - author (ISO-timestamp): "body text"`
 */
export function parseCommentLine(line: string): Comment | null {
  // Match:  - author (timestamp): "body"
  // Also handles multi-word authors like "boomerang-coder"
  const match = line.match(/^\s*-\s+(\S+)\s+\(([^)]+)\):\s*"(.*)"/);
  if (!match) return null;

  const author = match[1]!;
  const timestamp = match[2]!;
  const body = match[3]!;

  return {
    id: generateCommentId(),
    author,
    timestamp,
    body,
  };
}

/**
 * Parse all comments from a TASKS.md card section.
 *
 * Looks for both formats:
 * 1. `## Comments` sub-section with `- author (ts): "body"` lines
 * 2. `- **Comments:**` field with count or inline comments
 */
export function parseCommentsFromSection(lines: string[], startIndex: number): Comment[] {
  const comments: Comment[] = [];
  let inCommentsSection = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]!;

    // Stop at next card heading or section heading
    if (line.match(/^####\s+/) || (line.match(/^##\s+/) && !line.match(/^##\s+Comments/i))) {
      if (inCommentsSection) break;
      // Not in comments section yet — check if it's a ## Comments header
    }

    // Detect ## Comments section header
    if (line.match(/^##\s+Comments/i)) {
      inCommentsSection = true;
      continue;
    }

    // Parse comment lines inside ## Comments section
    if (inCommentsSection || line.match(/^\s*-\s+\S+\s+\([^)]+\):\s*"/)) {
      const comment = parseCommentLine(line);
      if (comment) {
        comments.push(comment);
      }
    }
  }

  return comments;
}

// ─── Comment Formatting ───────────────────────────────────────────────────────────

/**
 * Format a comment as a Markdown string for writing to TASKS.md.
 *
 * Output: `  - author (YYYY-MM-DD HH:MM): "body text"`
 */
export function formatComment(comment: Comment): string {
  const displayTs = formatTimestampForDisplay(comment.timestamp);
  return `  - ${comment.author} (${displayTs}): "${comment.body}"`;
}

/**
 * Format all comments for a card as a `## Comments` block.
 *
 * Output:
 * ```
 * - **Comments:**
 *   - author (2026-06-04 02:15): "Comment body"
 *   - coder (2026-06-04 02:30): "Another comment"
 * ```
 */
export function formatCommentBlock(cardId: string, comments: Comment[]): string {
  if (comments.length === 0) return "";

  const header = `- **Comments:**`;
  const commentLines = comments.map(formatComment);
  return [header, ...commentLines].join("\n");
}

// ─── Comment Collapse for TUI ─────────────────────────────────────────────────────

/**
 * Collapse a list of comments for display in the TUI panel.
 *
 * Shows `maxVisible` comments inline and a summary line for the rest.
 * Returns an array of formatted lines suitable for rendering.
 */
export function collapseComments(cardId: string, comments: Comment[], maxVisible: number = 2): string[] {
  if (comments.length === 0) return [];

  const lines: string[] = [];
  const visible = comments.slice(0, maxVisible);

  for (const comment of visible) {
    const displayTs = formatTimestampForDisplay(comment.timestamp);
    const rendered = renderMarkdown(comment.body);
    lines.push(`  @${comment.author} (${displayTs}): ${rendered}`);
  }

  const remaining = comments.length - maxVisible;
  if (remaining > 0) {
    lines.push(`  …${remaining} more comment${remaining > 1 ? "s" : ""}`);
  }

  return lines;
}

// ─── CommentManager Class ─────────────────────────────────────────────────────────

/**
 * CommentManager — manages inter-agent comments on kanban cards.
 *
 * Comments are stored in the TASKS.md file alongside the card fields.
 * The manager handles adding, retrieving, and formatting comments,
 * as well as reading/writing the TASKS.md file.
 */
export class CommentManager {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath
      ? resolve(filePath)
      : resolve(import.meta.dir, "../../../TASKS.md");
  }

  // ── File Operations ────────────────────────────────────────────────────────

  /** Read the TASKS.md file content. */
  private readFile(): string {
    return readFileSync(this.filePath, "utf-8");
  }

  /** Write content back to TASKS.md. */
  private writeFile(content: string): void {
    writeFileSync(this.filePath, content, "utf-8");
  }

  // ── Card Location ──────────────────────────────────────────────────────────

  /**
   * Find the line index of a card heading by ID.
   * Returns the line index or -1 if not found.
   */
  private findCardHeading(lines: string[], cardId: string): number {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i]!.match(/^####\s+(T-\d+)\s*·/);
      if (match && match[1] === cardId) return i;
    }
    return -1;
  }

  /**
   * Find the next card heading or H2/H3 heading after the given line.
   * Returns the line index of the next boundary, or lines.length if none found.
   */
  private findCardEndBoundary(lines: string[], startLine: number): number {
    for (let i = startLine + 1; i < lines.length; i++) {
      // Next card heading (#### T-NNN)
      if (lines[i]!.match(/^####\s+T-\d+/)) return i;
      // Next section (### or ##) — but NOT ## Comments (which belongs to the current card)
      if (lines[i]!.match(/^##\s+/) && !lines[i]!.match(/^##\s+Comments/i)) return i;
      if (lines[i]!.match(/^###\s+/)) return i;
    }
    return lines.length;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Add a comment to a card in the TASKS.md file.
   *
   * Creates a `## Comments` section if one doesn't exist, or appends
   * to the existing section. The comment is written with proper Markdown
   * formatting and persisted to disk.
   *
   * @param cardId - The card ID (e.g., "T-037")
   * @param author - The author of the comment (agent role or user)
   * @param body - The comment body text
   * @returns The newly created Comment object
   * @throws Error if the card is not found or the body is empty
   */
  addComment(cardId: string, author: string, body: string): Comment {
    if (!body.trim()) {
      throw new Error(`Comment body cannot be empty for card ${cardId}`);
    }

    const comment: Comment = {
      id: generateCommentId(),
      author,
      timestamp: new Date().toISOString(),
      body: body.trim(),
    };

    const content = this.readFile();
    const lines = content.split("\n");
    const cardLine = this.findCardHeading(lines, cardId);

    if (cardLine === -1) {
      throw new Error(`Card ${cardId} not found in ${this.filePath}`);
    }

    const cardEnd = this.findCardEndBoundary(lines, cardLine);

    // Check if a ## Comments section already exists within this card
    let commentsSectionIndex = -1;
    for (let i = cardLine + 1; i < cardEnd; i++) {
      if (lines[i]!.match(/^##\s+Comments/i)) {
        commentsSectionIndex = i;
        break;
      }
    }

    // Check if a - **Comments:** field line already exists within this card
    let commentsFieldIndex = -1;
    for (let i = cardLine + 1; i < cardEnd; i++) {
      if (lines[i]!.match(/^\s*-\s+\*\*Comments?\s*:?\s*\*\*/i)) {
        commentsFieldIndex = i;
        break;
      }
    }

    const formattedComment = formatComment(comment);

    if (commentsSectionIndex !== -1) {
      // Append to existing ## Comments section
      // Find the last comment line in the section
      let insertIndex = commentsSectionIndex + 1;
      for (let i = commentsSectionIndex + 1; i < cardEnd; i++) {
        if (lines[i]!.match(/^\s*-\s+\S+\s+\([^)]+\):\s*"/)) {
          insertIndex = i + 1;
        } else if (lines[i]!.trim() === "" || lines[i]!.match(/^##\s+/)) {
          break;
        }
      }
      lines.splice(insertIndex, 0, formattedComment);
    } else if (commentsFieldIndex !== -1) {
      // Append after existing **Comments:** field
      // Find the last comment line after the field
      let insertIndex = commentsFieldIndex + 1;
      for (let i = commentsFieldIndex + 1; i < cardEnd; i++) {
        if (lines[i]!.match(/^\s*-\s+\S+\s+\([^)]+\):\s*"/)) {
          insertIndex = i + 1;
        } else {
          break;
        }
      }
      lines.splice(insertIndex, 0, formattedComment);
    } else {
      // No existing comments — insert a new - **Comments:** section
      // Find the last field line of the card
      let insertIndex = cardLine + 1;
      for (let i = cardLine + 1; i < cardEnd; i++) {
        if (lines[i]!.match(/^\s*-\s+\*\*/)) {
          insertIndex = i + 1;
        } else if (lines[i]!.trim() === "" || lines[i]!.match(/^##\s+/)) {
          break;
        }
      }
      lines.splice(insertIndex, 0, `- **Comments:**`, formattedComment);
    }

    this.writeFile(lines.join("\n"));
    return comment;
  }

  /**
   * Get all comments for a card.
   *
   * Reads the TASKS.md file, finds the card section, and extracts
   * all comment entries.
   *
   * @param cardId - The card ID to look up
   * @returns Array of Comment objects (may be empty)
   */
  getComments(cardId: string): Comment[] {
    const content = this.readFile();
    const lines = content.split("\n");
    const cardLine = this.findCardHeading(lines, cardId);

    if (cardLine === -1) return [];

    const cardEnd = this.findCardEndBoundary(lines, cardLine);
    return parseCommentsFromSection(lines.slice(cardLine, cardEnd), 0);
  }

  /**
   * Format a comment for TUI display.
   *
   * @param comment - The comment to format
   * @returns A formatted string with ANSI escape sequences for terminal display
   */
  formatForDisplay(comment: Comment): string {
    const displayTs = formatTimestampForDisplay(comment.timestamp);
    const rendered = renderMarkdown(comment.body);
    return `@${comment.author} (${displayTs}): ${rendered}`;
  }
}