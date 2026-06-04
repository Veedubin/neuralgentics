/**
 * T-021 tests: Kanban parser, slash command routing, and layout integration.
 */

import { describe, test, expect } from "bun:test";
import { parseKanbanBoard, formatKanbanForPanel } from "../kanban/parser.js";
import { handleSlashCommand, isSlashCommand, type CommandDependencies } from "../commands.js";
import type { KanbanBoard, KanbanCard } from "../kanban/types.js";
import { KANBAN_STATUSES } from "../kanban/types.js";
import { CircuitBreaker } from "../kanban/circuit-breaker.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// ─── Kanban Parser Tests ──────────────────────────────────────────────────────

const SAMPLE_TASKS_MD = `# Test Project Tasks

## Overview
Test project for T-021 kanban parser.

## Kanban Board (Boomerang Cycle v3)

The board is the durable source of truth.

### Triage

_(none)_

### Todo

#### T-100 · Sample Todo Card
- **Status:** todo
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Goal:** Do something important
- **Depends on:** none
- **Blocks:** T-102

### Ready

#### T-101 · Ready Card (P0-a)
- **Status:** ready
- **Assignee:** boomerang-architect
- **Goal:** Architect something
- **Depends on:** T-100
- **Blocks:** none

### Running

_(none)_

### Blocked

_(none)_

### Done

#### T-099 · Prerequisite Card
- **Status:** done
- **Goal:** Setup Zig toolchain
- **Depends on:** none
- **Blocks:** T-100, T-101

### Archived

_(none)_
`;

describe("Kanban Parser", () => {
  test("parses a TASKS.md file into a KanbanBoard", () => {
    const tmpDir = join(import.meta.dir, "__tmp_test_kanban__");
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, "TASKS.md");
    writeFileSync(tmpFile, SAMPLE_TASKS_MD, "utf-8");

    try {
      const board = parseKanbanBoard(tmpFile);
      expect(board).toBeDefined();
      expect(board.cardCount).toBe(3); // T-100, T-101, T-099
      expect(board.columns).toHaveLength(7); // 7 statuses

      // Check Ready column
      const readyCol = board.columns.find((c) => c.status === "ready");
      expect(readyCol).toBeDefined();
      expect(readyCol!.cards).toHaveLength(1);
      expect(readyCol!.cards[0].id).toBe("T-101");
      expect(readyCol!.cards[0].title).toContain("Ready Card");
      expect(readyCol!.cards[0].assignee).toBe("boomerang-architect");

      // Check Done column
      const doneCol = board.columns.find((c) => c.status === "done");
      expect(doneCol).toBeDefined();
      expect(doneCol!.cards).toHaveLength(1);
      expect(doneCol!.cards[0].id).toBe("T-099");
      expect(doneCol!.cards[0].blocks).toEqual(["T-100", "T-101"]);

      // Check depends_on parsing
      const todoCol = board.columns.find((c) => c.status === "todo");
      expect(todoCol).toBeDefined();
      expect(todoCol!.cards[0].dependsOn).toEqual([]); // "none" -> []
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty board when no kanban section found", () => {
    const tmpDir = join(import.meta.dir, "__tmp_test_empty__");
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, "NO_KANBAN.md");
    writeFileSync(tmpFile, "# Just a title\n\nNo kanban here.\n", "utf-8");

    try {
      const board = parseKanbanBoard(tmpFile);
      expect(board.cardCount).toBe(0);
      expect(board.columns).toHaveLength(7);
      for (const col of board.columns) {
        expect(col.cards).toHaveLength(0);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parses the actual project TASKS.md", () => {
    // This test uses the real TASKS.md at the project root
    const realTasksPath = join(import.meta.dir, "../../../TASKS.md");
    let board: KanbanBoard;
    try {
      board = parseKanbanBoard(realTasksPath);
    } catch {
      // If the file doesn't exist in test env, skip
      console.log("Skipping real TASKS.md test — file not found");
      return;
    }

    // Should have at least 3 cards (the Done section has at least T-019, T-020, T-024)
    expect(board.cardCount).toBeGreaterThanOrEqual(3);
    expect(board.columns).toHaveLength(7);

    // At least one card in Done column (T-019 is always done)
    const doneCol = board.columns.find((c) => c.status === "done");
    expect(doneCol).toBeDefined();
    expect(doneCol!.cards.length).toBeGreaterThanOrEqual(1);
  });

  test("formatKanbanForPanel produces output lines", () => {
    const board: KanbanBoard = {
      columns: [
        { status: "triage", cards: [] },
        { status: "todo", cards: [] },
        {
          status: "ready",
          cards: [
            {
              id: "T-021",
              title: "TUI App Scaffold",
              status: "ready",
              assignee: "boomerang-coder",
              phase: "v0.1.0 P0",
              roadmap: "",
              goal: "Build TUI",
              dependsOn: [],
              blocks: [],
              raw: { Status: "ready" },
              failureCount: 0,
              failureLimit: 2,
              attemptHistory: [],
              truncatedAttempts: 0,
              truncatedMemoryId: "",
              comments: [],
            },
          ],
        },
        { status: "running", cards: [] },
        { status: "blocked", cards: [] },
        { status: "done", cards: [] },
        { status: "archived", cards: [] },
      ],
      cardCount: 1,
      parsedAt: new Date().toISOString(),
    };

    const lines = formatKanbanForPanel(board, 40);
    expect(lines.length).toBeGreaterThan(0);
    // Should contain "Ready" header
    expect(lines.some((l) => l.includes("Ready"))).toBe(true);
    // Should contain card T-021
    expect(lines.some((l) => l.includes("T-021"))).toBe(true);
  });

  test("KANBAN_STATUSES has 7 entries", () => {
    expect(KANBAN_STATUSES).toHaveLength(7);
    expect(KANBAN_STATUSES).toContain("triage");
    expect(KANBAN_STATUSES).toContain("todo");
    expect(KANBAN_STATUSES).toContain("ready");
    expect(KANBAN_STATUSES).toContain("running");
    expect(KANBAN_STATUSES).toContain("blocked");
    expect(KANBAN_STATUSES).toContain("done");
    expect(KANBAN_STATUSES).toContain("archived");
  });
});

// ─── Slash Command Tests ───────────────────────────────────────────────────────

describe("Slash Command Routing", () => {
  test("/help returns available commands list", () => {
    const result = handleSlashCommand("/help");
    expect(result.command).toBe("help");
    expect(result.message).toContain("/compact");
    expect(result.message).toContain("/board");
    expect(result.message).toContain("/chain");
    expect(result.refreshKanban).toBe(false);
  });

  test("/board triggers kanban refresh", () => {
    const result = handleSlashCommand("/board");
    expect(result.command).toBe("board");
    expect(result.refreshKanban).toBe(true);
    expect(result.message).toContain("Refreshing");
  });

  test("async commands return handler redirect message", () => {
    // /memory and /chain require async handlers (NeuralgenticsClient)
    const asyncCmds = ["/memory", "/chain"];
    for (const cmd of asyncCmds) {
      const result = handleSlashCommand(cmd);
      expect(result.message).toContain("async handler");
      expect(result.refreshKanban).toBe(false);
    }
  });

  test("/resume without args shows usage", () => {
    const result = handleSlashCommand("/resume");
    expect(result.command).toBe("resume");
    expect(result.message).toContain("specify a card ID");
    expect(result.refreshKanban).toBe(false);
  });

  test("/resume without circuit breaker shows unavailable", () => {
    const result = handleSlashCommand("/resume T-036");
    expect(result.command).toBe("resume");
    expect(result.message).toContain("circuit breaker not available");
    expect(result.refreshKanban).toBe(false);
  });

  test("/resume with circuit breaker resets failure count", () => {
    const breaker = new CircuitBreaker({ failureLimit: 2 });
    const card: KanbanCard = {
      id: "T-036",
      title: "Test Card",
      status: "running",
      assignee: "coder",
      phase: "P1",
      roadmap: "v0.1.0",
      goal: "Test",
      dependsOn: [],
      blocks: [],
      failureCount: 0,
      failureLimit: 2,
      attemptHistory: [],
      truncatedAttempts: 0,
      truncatedMemoryId: "",
      comments: [],
      raw: {},
    };
    breaker.registerCard(card);
    breaker.recordFailure(card, "coder", "Test fail", 100, "mem-1");

    const result = handleSlashCommand("/resume T-036", { circuitBreaker: breaker });
    expect(result.command).toBe("resume");
    expect(result.message).toContain("resumed");
    expect(result.refreshKanban).toBe(true);
  });

  test("/harness shows role and skills", () => {
    const result = handleSlashCommand("/harness");
    expect(result.command).toBe("harness");
    expect(result.message).toContain("Agent Harness");
    expect(result.refreshKanban).toBe(false);
  });

  test("/review without kanban board shows error", () => {
    const result = handleSlashCommand("/review");
    expect(result.command).toBe("review");
    expect(result.message).toContain("kanban board not loaded");
    expect(result.refreshKanban).toBe(true);
  });

  test("/scaffold without title shows usage", () => {
    const result = handleSlashCommand("/scaffold");
    expect(result.command).toBe("scaffold");
    expect(result.message).toContain("specify a card title");
    expect(result.refreshKanban).toBe(false);
  });

  test("/scaffold with title generates template", () => {
    const result = handleSlashCommand("/scaffold Implement WebSocket transport");
    expect(result.command).toBe("scaffold");
    expect(result.message).toContain("WebSocket transport");
    expect(result.message).toContain("T-??? · Implement WebSocket transport");
    expect(result.clipboardContent).toBeDefined();
    expect(result.refreshKanban).toBe(false);
  });

  test("/opportunities returns detector message (T-034)", () => {
    // Without an OpportunityDetector, returns "not available" message
    const result = handleSlashCommand("/opportunities");
    expect(result.command).toBe("opportunities");
    expect(result.message).toContain("not available");
    expect(result.refreshKanban).toBe(false);
  });

  test("/spend returns token accounting message (T-033)", () => {
    // Without a TokenCounter, returns "not available" message
    const result = handleSlashCommand("/spend");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("not available");
    expect(result.refreshKanban).toBe(false);
  });

  test("/compact returns _compact_ signal (T-026)", () => {
    const result = handleSlashCommand("/compact");
    expect(result.command).toBe("compact");
    expect(result.message).toBe("_compact_");
    expect(result.refreshKanban).toBe(false);
  });

  test("unknown slash command returns error message", () => {
    const result = handleSlashCommand("/unknowncmd");
    expect(result.command).toBe("unknown");
    expect(result.message).toContain("Unknown command");
  });

  test("non-slash input echoes back", () => {
    const result = handleSlashCommand("hello world");
    expect(result.command).toBe("echo");
    expect(result.message).toBe("hello world");
    expect(result.refreshKanban).toBe(false);
  });

  test("isSlashCommand detects slash prefix", () => {
    expect(isSlashCommand("/help")).toBe(true);
    expect(isSlashCommand("  /board")).toBe(true);
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
  });
});