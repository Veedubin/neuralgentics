/**
 * Offline Recovery Integration Tests (T-081c)
 *
 * Tests for recovery, offline reads, and the full offline/online cycle:
 *
 * 1. checkSidecarHealth returns both clients' status
 * 2. Backend goes offline (2 failures) → checkSidecarHealth returns neuralgentics: 'offline'
 * 3. Backend recovers (1 success) → checkSidecarHealth returns neuralgentics: 'online'
 * 4. Offline mode can read TASKS.md (kanban reflects the file even when offline)
 * 5. Write commands resume when online (isWriteBlocked returns false after recovery)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { checkSidecarHealth } from "../sidecar.js";
import { parseKanbanBoard } from "../kanban/parser.js";
import { isWriteBlocked, isWriteCommand } from "../commands.js";
import type { OfflineState } from "../panels/status.js";

// ─── Mock Clients ─────────────────────────────────────────────────────────────

/** Creates a mock client with a controllable onlineStatus. */
function makeMockClient(status: "online" | "offline"): { onlineStatus: "online" | "offline" } {
  return { onlineStatus: status };
}

/** Creates a mock OpenCodeClient with controllable _recordFailure / _recordSuccess. */
function makeMockOpenCodeClient(): {
  client: import("../opencode-client/client.js").OpenCodeClient;
  recordFailure: () => void;
  recordSuccess: () => void;
} {
  // Create with autoStart: false so no real server is spawned
  const { OpenCodeClient } = require("../opencode-client/client.js");
  const client = new OpenCodeClient({ autoStart: false });

  const anyClient = client as unknown as {
    _recordFailure: () => void;
    _recordSuccess: () => void;
  };

  return {
    client,
    recordFailure: () => anyClient._recordFailure(),
    recordSuccess: () => anyClient._recordSuccess(),
  };
}

/** Creates a mock NeuralgenticsClient with controllable _recordFailure / _recordSuccess. */
function makeMockNeuralgenticsClient(): {
  client: import("../neuralgentics-client/client.js").NeuralgenticsClient;
  recordFailure: () => void;
  recordSuccess: () => void;
} {
  // Import dynamically to avoid spawning a real process
  const { NeuralgenticsClient } = require("../neuralgentics-client/client.js");
  const client = new NeuralgenticsClient({ spawn: false });

  const anyClient = client as unknown as {
    _recordFailure: () => void;
    _recordSuccess: () => void;
  };

  return {
    client,
    recordFailure: () => anyClient._recordFailure(),
    recordSuccess: () => anyClient._recordSuccess(),
  };
}

// ─── Test 1: checkSidecarHealth returns both clients' status ──────────────────

describe("checkSidecarHealth (T-081c)", () => {
  test("1: returns both clients' status when both are online", () => {
    const opencode = makeMockClient("online");
    const neuralgentics = makeMockClient("online");

    const health = checkSidecarHealth(opencode, neuralgentics);

    expect(health.opencode).toBe("online");
    expect(health.neuralgentics).toBe("online");
  });

  test("1b: returns both clients' status when both are offline", () => {
    const opencode = makeMockClient("offline");
    const neuralgentics = makeMockClient("offline");

    const health = checkSidecarHealth(opencode, neuralgentics);

    expect(health.opencode).toBe("offline");
    expect(health.neuralgentics).toBe("offline");
  });

  test("1c: returns mixed status when only one is offline", () => {
    const opencode = makeMockClient("online");
    const neuralgentics = makeMockClient("offline");

    const health = checkSidecarHealth(opencode, neuralgentics);

    expect(health.opencode).toBe("online");
    expect(health.neuralgentics).toBe("offline");
  });
});

// ─── Test 2: Backend goes offline (2 failures) → checkSidecarHealth returns offline ───

describe("checkSidecarHealth with NeuralgenticsClient transition (T-081c)", () => {
  test("2: backend goes offline after 2 consecutive failures → neuralgentics: offline", () => {
    const opencode = makeMockOpenCodeClient();
    const neuralgentics = makeMockNeuralgenticsClient();

    // Initially both online
    const initialHealth = checkSidecarHealth(opencode.client, neuralgentics.client);
    expect(initialHealth.opencode).toBe("online");
    expect(initialHealth.neuralgentics).toBe("online");

    // Simulate 2 consecutive failures on neuralgentics client
    neuralgentics.recordFailure();
    expect(neuralgentics.client.onlineStatus).toBe("online"); // Still online after 1 miss

    neuralgentics.recordFailure();
    expect(neuralgentics.client.onlineStatus).toBe("offline"); // Now offline after 2 misses

    // checkSidecarHealth should reflect the offline state
    const afterFailures = checkSidecarHealth(opencode.client, neuralgentics.client);
    expect(afterFailures.opencode).toBe("online");
    expect(afterFailures.neuralgentics).toBe("offline");
  });
});

// ─── Test 3: Backend recovers (1 success) → checkSidecarHealth returns online ──────

describe("Offline recovery (T-081c)", () => {
  test("3: backend recovers after 1 success → neuralgentics: online", () => {
    const opencode = makeMockOpenCodeClient();
    const neuralgentics = makeMockNeuralgenticsClient();

    // First, take neuralgentics offline (2 failures)
    neuralgentics.recordFailure();
    neuralgentics.recordFailure();
    expect(neuralgentics.client.onlineStatus).toBe("offline");

    // Now simulate 1 successful health check → should recover
    neuralgentics.recordSuccess();
    expect(neuralgentics.client.onlineStatus).toBe("online");

    // checkSidecarHealth should report both back online
    const health = checkSidecarHealth(opencode.client, neuralgentics.client);
    expect(health.opencode).toBe("online");
    expect(health.neuralgentics).toBe("online");
  });

  test("3b: opencode recovers after 1 success → opencode: online", () => {
    const opencode = makeMockOpenCodeClient();
    const neuralgentics = makeMockNeuralgenticsClient();

    // Take opencode offline (2 failures)
    opencode.recordFailure();
    opencode.recordFailure();
    expect(opencode.client.onlineStatus).toBe("offline");

    // 1 success → recovery
    opencode.recordSuccess();
    expect(opencode.client.onlineStatus).toBe("online");

    const health = checkSidecarHealth(opencode.client, neuralgentics.client);
    expect(health.opencode).toBe("online");
    expect(health.neuralgentics).toBe("online");
  });
});

// ─── Test 4: Offline mode can read TASKS.md ────────────────────────────────────

describe("Offline reads (T-081c)", () => {
  test("4: parseKanbanBoard works offline (reads local TASKS.md)", () => {
    // parseKanbanBoard reads from a local file — it works even when the
    // backend is offline. We verify it produces a valid KanbanBoard
    // structure without any network dependency.

    // Parse from a test TASKS.md file (the parser defaults to
    // ../../TASKS.md from the kanban/ module location, which may not
    // exist in test environments). We create a minimal temp file.
    const { writeFileSync, mkdirSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const tmpDir = join("/tmp", "tui-offline-recovery-test");
    const tmpFile = join(tmpDir, "TASKS.md");

    const taskContent = [
      "## Kanban Board (Boomerang Cycle v3)",
      "",
      "### Todo",
      "",
      "#### T-999 · Offline Test Card (P0)",
      "- **Status:** todo",
      "- **Assignee:** test",
      "",
    ].join("\n");

    // Create temp file
    try {
      mkdirSync(tmpDir, { recursive: true });
    } catch {
      // Already exists
    }
    writeFileSync(tmpFile, taskContent, "utf-8");

    // parseKanbanBoard should work without any backend connection
    const board = parseKanbanBoard(tmpFile);

    // Verify the board has the expected structure
    expect(board).toBeDefined();
    expect(board.cardCount).toBe(1);
    expect(board.columns).toBeDefined();
    expect(board.columns.length).toBeGreaterThan(0);

    // Find the todo column
    const todoCol = board.columns.find((col: { status: string }) => col.status === "todo");
    expect(todoCol).toBeDefined();
    expect(todoCol!.cards.length).toBe(1);
    expect(todoCol!.cards[0]!.id).toBe("T-999");
    expect(todoCol!.cards[0]!.title).toBe("Offline Test Card (P0)");

    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Test 5: Write commands resume when online ─────────────────────────────────

describe("Write commands resume after recovery (T-081c)", () => {
  test("5: isWriteBlocked returns false after recovery, true while offline", () => {
    // Scenario: Both clients go offline, then neuralgentics recovers
    const bothOffline: OfflineState = { opencode: "offline", neuralgentics: "offline" };
    const opencodeOffline: OfflineState = { opencode: "offline", neuralgentics: "online" };
    const neuralgenticsOffline: OfflineState = { opencode: "online", neuralgentics: "offline" };
    const bothOnline: OfflineState = { opencode: "online", neuralgentics: "online" };

    // While fully offline — writes blocked
    expect(isWriteBlocked(bothOffline)).toBe(true);

    // Only opencode recovers — writes still blocked (need both online)
    expect(isWriteBlocked(opencodeOffline)).toBe(true);

    // Only neuralgentics recovers — writes still blocked
    expect(isWriteBlocked(neuralgenticsOffline)).toBe(true);

    // Both recover — writes unblocked
    expect(isWriteBlocked(bothOnline)).toBe(false);

    // Also verify write commands are identified correctly
    expect(isWriteCommand("compact")).toBe(true);
    expect(isWriteCommand("scaffold")).toBe(true);
    expect(isWriteCommand("resume")).toBe(true);

    // Read commands should NOT be write commands
    expect(isWriteCommand("help")).toBe(false);
    expect(isWriteCommand("board")).toBe(false);
    expect(isWriteCommand("offline")).toBe(false);
  });
});