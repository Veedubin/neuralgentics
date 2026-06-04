/**
 * @neuralgentics/tui — Kanban Comments Tests (T-037)
 *
 * Tests for comment management, parsing, formatting, and collapse.
 * Covers: addComment, getComments, formatComment, collapseComments,
 * renderMarkdown, stripMarkdown, parseCommentLine, parseCommentsFromSection,
 * and parser integration with ## Comments sections.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CommentManager,
  formatComment,
  formatCommentBlock,
  collapseComments,
  renderMarkdown,
  stripMarkdown,
  parseCommentLine,
  parseCommentsFromSection,
} from "../kanban/comments.js";
import { parseKanbanBoard } from "../kanban/parser.js";
import type { Comment } from "../kanban/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock Comment with sensible defaults. */
function makeComment(overrides?: Partial<Comment>): Comment {
  return {
    id: "c-test0001",
    author: "boomerang-coder",
    timestamp: "2026-06-04T02:15:00Z",
    body: "I see this depends on T-027",
    ...overrides,
  };
}

/** Temporary TASKS.md dir for file-based tests. */
const TMP_DIR = join(import.meta.dir, "__tmp_comments_test__");
const TMP_FILE = join(TMP_DIR, "TASKS.md");

/** Sample TASKS.md content with a card that has comments. */
const TASKS_MD_WITH_COMMENTS = `# Neuralgentics Tasks

## Overview

Some overview text.

## Kanban Board (Boomerang Cycle v3)

### Ready

#### T-037 · Card Comments (P1-e)
- **Status:** running
- **Roadmap:** \`docs/roadmap-v0.1.0-p1.md#task-p1-e-comments-on-cards\`
- **Goal:** Inter-agent comment protocol on cards.
- **Depends on:** T-036
- **Comments:**
  - coder (2026-06-04 02:15): "I see this depends on T-027"
  - tester (2026-06-04 02:30): "Confirmed by running integration test"

#### T-036 · Circuit Breaker (P1-d)
- **Status:** done
- **Goal:** Circuit breaker implementation

### Blocked

_(none currently)_
`;

/** Sample TASKS.md content with ## Comments sub-section. */
const TASKS_MD_WITH_COMMENTS_SECTION = `# Neuralgentics Tasks

## Kanban Board (Boomerang Cycle v3)

### Ready

#### T-037 · Card Comments (P1-e)
- **Status:** running
- **Goal:** Inter-agent comment protocol on cards.
## Comments
  - coder (2026-06-04 02:15): "I see this depends on T-027"
  - tester (2026-06-04 02:30): "Confirmed by running integration test"

#### T-036 · Circuit Breaker (P1-d)
- **Status:** done
- **Goal:** Circuit breaker implementation

### Blocked

_(none currently)_
`;

/** Minimal TASKS.md with no comments. */
const TASKS_MD_NO_COMMENTS = `# Neuralgentics Tasks

## Kanban Board (Boomerang Cycle v3)

### Ready

#### T-037 · Card Comments (P1-e)
- **Status:** running
- **Goal:** Inter-agent comment protocol on cards.

### Done

_(none currently)_
`;

function setupTmpFile(content: string): void {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(TMP_FILE, content, "utf-8");
}

function cleanupTmpDir(): void {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

// ─── parseCommentLine Tests ───────────────────────────────────────────────────

describe("parseCommentLine", () => {
  test("parse a standard comment line", () => {
    const line = '  - coder (2026-06-04 02:15): "I see this depends on T-027"';
    const comment = parseCommentLine(line);
    expect(comment).not.toBeNull();
    expect(comment!.author).toBe("coder");
    expect(comment!.timestamp).toBe("2026-06-04 02:15");
    expect(comment!.body).toBe("I see this depends on T-027");
  });

  test("parse comment with hyphenated author", () => {
    const line = '  - boomerang-coder (2026-06-04 15:30): "Build failed"';
    const comment = parseCommentLine(line);
    expect(comment).not.toBeNull();
    expect(comment!.author).toBe("boomerang-coder");
    expect(comment!.body).toBe("Build failed");
  });

  test("parse comment with ISO timestamp", () => {
    const line = '  - architect (2026-06-04T15:30:00Z): "Design review needed"';
    const comment = parseCommentLine(line);
    expect(comment).not.toBeNull();
    expect(comment!.timestamp).toBe("2026-06-04T15:30:00Z");
  });

  test("parse comment with markdown in body", () => {
    const line = '  - coder (2026-06-04 10:00): "The **auth module** needs a fix for `token` refresh"';
    const comment = parseCommentLine(line);
    expect(comment).not.toBeNull();
    expect(comment!.body).toBe("The **auth module** needs a fix for `token` refresh");
  });

  test("return null for non-comment line (field line)", () => {
    const line = "- **Status:** running";
    expect(parseCommentLine(line)).toBeNull();
  });

  test("return null for empty line", () => {
    expect(parseCommentLine("")).toBeNull();
    expect(parseCommentLine("   ")).toBeNull();
  });

  test("return null for heading line", () => {
    expect(parseCommentLine("### Ready")).toBeNull();
    expect(parseCommentLine("#### T-037 · Title")).toBeNull();
  });
});

// ─── parseCommentsFromSection Tests ──────────────────────────────────────────

describe("parseCommentsFromSection", () => {
  test("parse comments from lines with ## Comments header", () => {
    const lines = [
      "#### T-037 · Card Comments (P1-e)",
      "- **Status:** running",
      "## Comments",
      '  - coder (2026-06-04 02:15): "I see this depends on T-027"',
      '  - tester (2026-06-04 02:30): "Confirmed by running integration test"',
    ];
    const comments = parseCommentsFromSection(lines, 0);
    expect(comments.length).toBe(2);
    expect(comments[0]!.author).toBe("coder");
    expect(comments[1]!.author).toBe("tester");
  });

  test("parse returns empty array when no comments present", () => {
    const lines = [
      "#### T-037 · Card Comments (P1-e)",
      "- **Status:** running",
      "- **Goal:** Some goal",
    ];
    const comments = parseCommentsFromSection(lines, 0);
    expect(comments.length).toBe(0);
  });

  test("stops at next card heading", () => {
    const lines = [
      "#### T-037 · Card Comments (P1-e)",
      "- **Status:** running",
      "## Comments",
      '  - coder (2026-06-04 02:15): "Comment on T-037"',
      "#### T-038 · Another Card",
      "- **Status:** done",
    ];
    const comments = parseCommentsFromSection(lines, 0);
    expect(comments.length).toBe(1);
    expect(comments[0]!.author).toBe("coder");
  });

  test("stops at next section heading (non-Comments)", () => {
    const lines = [
      "#### T-037 · Card Comments (P1-e)",
      "- **Status:** running",
      "## Comments",
      '  - coder (2026-06-04 02:15): "Comment on T-037"',
      "## Previous Attempts",
    ];
    const comments = parseCommentsFromSection(lines, 0);
    // "## Previous Attempts" is NOT "## Comments" so it ends the section
    // But parseCommentsFromSection will stop because it hits a non-Comments H2
    expect(comments.length).toBe(1);
  });
});

// ─── formatComment Tests ──────────────────────────────────────────────────────

describe("formatComment", () => {
  test("format a single comment", () => {
    const comment = makeComment();
    const formatted = formatComment(comment);
    expect(formatted).toContain("boomerang-coder");
    expect(formatted).toContain("(2026-06-04 02:15)");
    expect(formatted).toContain('"I see this depends on T-027"');
  });

  test("format preserves body text verbatim", () => {
    const comment = makeComment({ body: "The **auth module** needs fix" });
    const formatted = formatComment(comment);
    expect(formatted).toContain('"The **auth module** needs fix"');
  });

  test("format uses short display timestamp", () => {
    const comment = makeComment({ timestamp: "2026-06-04T15:30:00Z" });
    const formatted = formatComment(comment);
    expect(formatted).toContain("(2026-06-04 15:30)");
  });
});

// ─── formatCommentBlock Tests ─────────────────────────────────────────────────

describe("formatCommentBlock", () => {
  test("format empty comments returns empty string", () => {
    expect(formatCommentBlock("T-037", [])).toBe("");
  });

  test("format single comment with header", () => {
    const comments: Comment[] = [
      makeComment({ author: "coder", body: "First comment" }),
    ];
    const block = formatCommentBlock("T-037", comments);
    expect(block).toContain("- **Comments:**");
    expect(block).toContain('"First comment"');
  });

  test("format multiple comments", () => {
    const comments: Comment[] = [
      makeComment({ author: "coder", body: "First" }),
      makeComment({ author: "tester", body: "Second" }),
    ];
    const block = formatCommentBlock("T-037", comments);
    expect(block).toContain("coder");
    expect(block).toContain("tester");
    expect(block).toContain('"First"');
    expect(block).toContain('"Second"');
  });
});

// ─── collapseComments Tests ────────────────────────────────────────────────────

describe("collapseComments", () => {
  test("return empty array for empty comments", () => {
    expect(collapseComments("T-037", [])).toEqual([]);
  });

  test("show all comments when count <= maxVisible", () => {
    const comments: Comment[] = [
      makeComment({ author: "coder", body: "First" }),
      makeComment({ author: "tester", body: "Second" }),
    ];
    const lines = collapseComments("T-037", comments, 2);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("@coder");
    expect(lines[1]).toContain("@tester");
  });

  test("collapse comments with 'N more comments' when count > maxVisible", () => {
    const comments: Comment[] = [
      makeComment({ author: "c1", body: "First" }),
      makeComment({ author: "c2", body: "Second" }),
      makeComment({ author: "c3", body: "Third" }),
      makeComment({ author: "c4", body: "Fourth" }),
      makeComment({ author: "c5", body: "Fifth" }),
    ];
    const lines = collapseComments("T-037", comments, 2);
    expect(lines.length).toBe(3); // 2 visible + 1 "…3 more comments"
    expect(lines[2]).toContain("3 more comments");
  });

  test("use default maxVisible of 2", () => {
    const comments: Comment[] = [
      makeComment({ author: "c1", body: "A" }),
      makeComment({ author: "c2", body: "B" }),
      makeComment({ author: "c3", body: "C" }),
    ];
    const lines = collapseComments("T-037", comments);
    expect(lines.length).toBe(3); // 2 visible + 1 "…1 more comment"
    expect(lines[2]).toContain("1 more comment");
  });
});

// ─── renderMarkdown Tests ──────────────────────────────────────────────────────

describe("renderMarkdown", () => {
  test("render bold text", () => {
    const result = renderMarkdown("This is **bold** text");
    expect(result).toContain("\x1b[1mbold\x1b[22m");
  });

  test("render italic text", () => {
    const result = renderMarkdown("This is *italic* text");
    expect(result).toContain("\x1b[3mitalic\x1b[23m");
  });

  test("render inline code", () => {
    const result = renderMarkdown("Use `code` here");
    expect(result).toContain("\x1b[7mcode\x1b[27m");
  });

  test("render link as text+url", () => {
    const result = renderMarkdown("See [docs](https://example.com)");
    expect(result).toContain("docs(https://example.com)");
  });

  test("leave plain text unchanged", () => {
    const plain = "No markdown here";
    expect(renderMarkdown(plain)).toBe(plain);
  });
});

// ─── stripMarkdown Tests ──────────────────────────────────────────────────────

describe("stripMarkdown", () => {
  test("strip bold markers", () => {
    expect(stripMarkdown("This is **bold**")).toBe("This is bold");
  });

  test("strip italic markers", () => {
    expect(stripMarkdown("This is *italic*")).toBe("This is italic");
  });

  test("strip code markers", () => {
    expect(stripMarkdown("Use `code` here")).toBe("Use code here");
  });

  test("strip link to text+url", () => {
    expect(stripMarkdown("See [docs](https://example.com)")).toBe("See docs(https://example.com)");
  });

  test("leave plain text unchanged", () => {
    const plain = "No markdown here";
    expect(stripMarkdown(plain)).toBe(plain);
  });
});

// ─── CommentManager — File-Based Tests ─────────────────────────────────────────

describe("CommentManager (file-based)", () => {
  beforeEach(() => {
    cleanupTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  test("addComment to card with no existing comments", () => {
    setupTmpFile(TASKS_MD_NO_COMMENTS);

    const manager = new CommentManager(TMP_FILE);
    const comment = manager.addComment("T-037", "coder", "New comment from coder");

    expect(comment.author).toBe("coder");
    expect(comment.body).toBe("New comment from coder");
    expect(comment.timestamp).toBeTruthy();
    expect(comment.id).toMatch(/^c-[a-z0-9]{8}$/);
  });

  test("addComment to card with existing inline comments", () => {
    setupTmpFile(TASKS_MD_WITH_COMMENTS);

    const manager = new CommentManager(TMP_FILE);
    const comment = manager.addComment("T-037", "architect", "Design review needed");

    expect(comment.author).toBe("architect");
    expect(comment.body).toBe("Design review needed");

    // Verify the comment was persisted
    const comments = manager.getComments("T-037");
    expect(comments.length).toBe(3); // 2 existing + 1 new
    expect(comments[2]!.author).toBe("architect");
  });

  test("getComments returns existing comments from inline section", () => {
    setupTmpFile(TASKS_MD_WITH_COMMENTS);

    const manager = new CommentManager(TMP_FILE);
    const comments = manager.getComments("T-037");

    expect(comments.length).toBe(2);
    expect(comments[0]!.author).toBe("coder");
    expect(comments[0]!.body).toBe("I see this depends on T-027");
    expect(comments[1]!.author).toBe("tester");
    expect(comments[1]!.body).toBe("Confirmed by running integration test");
  });

  test("getComments returns existing comments from ## Comments section", () => {
    setupTmpFile(TASKS_MD_WITH_COMMENTS_SECTION);

    const manager = new CommentManager(TMP_FILE);
    const comments = manager.getComments("T-037");

    expect(comments.length).toBe(2);
    expect(comments[0]!.author).toBe("coder");
    expect(comments[1]!.author).toBe("tester");
  });

  test("getComments returns empty array for card with no comments", () => {
    setupTmpFile(TASKS_MD_NO_COMMENTS);

    const manager = new CommentManager(TMP_FILE);
    const comments = manager.getComments("T-037");

    expect(comments).toEqual([]);
  });

  test("getComments returns empty array for nonexistent card", () => {
    setupTmpFile(TASKS_MD_NO_COMMENTS);

    const manager = new CommentManager(TMP_FILE);
    const comments = manager.getComments("T-NONEXISTENT");

    expect(comments).toEqual([]);
  });

  test("addComment rejects empty body", () => {
    setupTmpFile(TASKS_MD_NO_COMMENTS);

    const manager = new CommentManager(TMP_FILE);
    expect(() => manager.addComment("T-037", "coder", "")).toThrow("Comment body cannot be empty");
    expect(() => manager.addComment("T-037", "coder", "   ")).toThrow("Comment body cannot be empty");
  });

  test("addComment rejects nonexistent card", () => {
    setupTmpFile(TASKS_MD_NO_COMMENTS);

    const manager = new CommentManager(TMP_FILE);
    expect(() => manager.addComment("T-NONEXISTENT", "coder", "Comment")).toThrow("Card T-NONEXISTENT not found");
  });

  test("comments survive TASKS.md re-parse (idempotent)", () => {
    setupTmpFile(TASKS_MD_NO_COMMENTS);

    const manager = new CommentManager(TMP_FILE);

    // Add two comments
    manager.addComment("T-037", "coder", "First comment");
    manager.addComment("T-037", "tester", "Second comment");

    // Re-parse the file
    const board = parseKanbanBoard(TMP_FILE);

    // Find the card
    const allCards = board.columns.flatMap((col) => col.cards);
    const card = allCards.find((c) => c.id === "T-037");
    expect(card).toBeDefined();
    expect(card!.comments.length).toBe(2);
    expect(card!.comments[0]!.author).toBe("coder");
    expect(card!.comments[1]!.author).toBe("tester");
  });

  test("add comment then add another — both persist", () => {
    setupTmpFile(TASKS_MD_NO_COMMENTS);

    const manager = new CommentManager(TMP_FILE);
    manager.addComment("T-037", "coder", "First comment");
    manager.addComment("T-037", "tester", "Second comment");

    const comments = manager.getComments("T-037");
    expect(comments.length).toBe(2);
    expect(comments[0]!.body).toBe("First comment");
    expect(comments[1]!.body).toBe("Second comment");
  });

  test("addComment to card with ## Comments section", () => {
    setupTmpFile(TASKS_MD_WITH_COMMENTS_SECTION);

    const manager = new CommentManager(TMP_FILE);
    const comment = manager.addComment("T-037", "architect", "Added to section format");

    expect(comment.author).toBe("architect");

    const comments = manager.getComments("T-037");
    expect(comments.length).toBe(3); // 2 original + 1 new
  });

  test("formatForDisplay renders comment with ANSI escape codes", () => {
    const manager = new CommentManager(TMP_FILE); // File doesn't need to exist for this test
    const comment = makeComment({
      author: "coder",
      timestamp: "2026-06-04T14:30:00Z",
      body: "The **auth module** needs a fix",
    });

    const display = manager.formatForDisplay(comment);
    expect(display).toContain("@coder");
    expect(display).toContain("(2026-06-04 14:30)");
    expect(display).toContain("auth module"); // Bold rendered with ANSI
  });
});

// ─── Parser Integration Tests ──────────────────────────────────────────────────

describe("Parser integration with comments", () => {
  test("parse TASKS.md with inline comments field", () => {
    setupTmpFile(TASKS_MD_WITH_COMMENTS);

    const board = parseKanbanBoard(TMP_FILE);
    const allCards = board.columns.flatMap((col) => col.cards);
    const card = allCards.find((c) => c.id === "T-037");

    expect(card).toBeDefined();
    expect(card!.comments.length).toBe(2);
    expect(card!.comments[0]!.author).toBe("coder");
    expect(card!.comments[0]!.body).toBe("I see this depends on T-027");
    expect(card!.comments[1]!.author).toBe("tester");
    expect(card!.comments[1]!.body).toBe("Confirmed by running integration test");
  });

  test("parse TASKS.md with ## Comments section", () => {
    setupTmpFile(TASKS_MD_WITH_COMMENTS_SECTION);

    const board = parseKanbanBoard(TMP_FILE);
    const allCards = board.columns.flatMap((col) => col.cards);
    const card = allCards.find((c) => c.id === "T-037");

    expect(card).toBeDefined();
    expect(card!.comments.length).toBe(2);
    expect(card!.comments[0]!.author).toBe("coder");
    expect(card!.comments[1]!.author).toBe("tester");
  });

  test("parse TASKS.md with no comments returns empty array", () => {
    setupTmpFile(TASKS_MD_NO_COMMENTS);

    const board = parseKanbanBoard(TMP_FILE);
    const allCards = board.columns.flatMap((col) => col.cards);
    const card = allCards.find((c) => c.id === "T-037");

    expect(card).toBeDefined();
    expect(card!.comments).toEqual([]);
  });

  test("comments are scoped to their card — not leaked to other cards", () => {
    setupTmpFile(TASKS_MD_WITH_COMMENTS);

    const board = parseKanbanBoard(TMP_FILE);
    const allCards = board.columns.flatMap((col) => col.cards);
    const t37 = allCards.find((c) => c.id === "T-037");
    const t36 = allCards.find((c) => c.id === "T-036");

    expect(t37).toBeDefined();
    expect(t36).toBeDefined();
    expect(t37!.comments.length).toBe(2);
    expect(t36!.comments.length).toBe(0); // T-036 should have no comments
  });
});