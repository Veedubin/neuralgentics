/**
 * Tests for T-COMPACT-FIX-001: session.compacting AGENTS.md backup.
 *
 * The Go backend `memory.add` RPC declares `json:"content"` (main.go:224).
 * The event handler previously sent `{ text: content }` — a direct
 * backend.call() that bypasses makeProxyTool's tolerant aliasing — so every
 * compaction backup failed with `-32602 Invalid params: content is required`
 * and was swallowed by the catch block. These tests pin the wire format.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoBackendClient } from "./go-backend-client.js";
import { server } from "../server.js";
import type { PluginInput } from "../server.js";

/** Captured backend.call invocations. */
const recordedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
const originalCall = GoBackendClient.prototype.call;

describe("session.compacting backup (T-COMPACT-FIX-001)", () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    // Controlled two-level layout: <root>/project — so the ".." fallback
    // candidate resolves inside OUR sandbox instead of /tmp (which may
    // legitimately contain a stray AGENTS.md from other tooling).
    root = await mkdtemp(join(tmpdir(), "ng-compact-"));
    dir = join(root, "project");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "# Test Agents\n\ncompaction-backup-probe", "utf-8");
    recordedCalls.length = 0;
    // Intercept ALL backend calls without spawning the real binary.
    GoBackendClient.prototype.call = async function (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> {
      recordedCalls.push({ method, params: params ?? {} });
      return { id: "test-memory-id" };
    };
  });

  afterEach(async () => {
    GoBackendClient.prototype.call = originalCall;
    await rm(root, { recursive: true, force: true });
  });

  function makeInput(): PluginInput {
    return {
      directory: dir,
      worktree: dir,
      serverUrl: new URL("http://localhost:0"),
    };
  }

  it("sends `content` (not `text`) to memory.add on session.compacting", async () => {
    const hooks = await server(makeInput());
    await hooks.event!({ event: { type: "session.compacting" } });

    const adds = recordedCalls.filter((c) => c.method === "memory.add");
    expect(adds.length).toBe(1);
    const params = adds[0]!.params;
    expect(params.content).toBe("# Test Agents\n\ncompaction-backup-probe");
    expect(params.text).toBeUndefined();
    expect(params.sourceType).toBe("context_package");
  });

  it("does not call memory.add when no AGENTS.md exists anywhere in the candidate chain", async () => {
    await rm(join(dir, "AGENTS.md"));
    const hooks = await server(makeInput());
    await hooks.event!({ event: { type: "session.compacting" } });
    expect(recordedCalls.filter((c) => c.method === "memory.add").length).toBe(0);
  });
});
