/**
 * Tests for T-MEMREAD-001: memory read-path wiring.
 *
 * (1) The three read-side proxy tools are exposed with tiny schemas.
 * (2) session.compacting enrichment: after the AGENTS.md backup succeeds,
 *     the handler fires memory.extractEntities with the returned memory id
 *     so the knowledge graph grows automatically — without ever blocking
 *     compaction on failure.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoBackendClient } from "./go-backend-client.js";
import { server } from "../server.js";
import type { PluginInput, ToolDefinition } from "../server.js";

const recordedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
const originalCall = GoBackendClient.prototype.call;

describe("T-MEMREAD-001 read-path tools", () => {
  const fakeInput: PluginInput = {
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://localhost:0"),
  };

  it("exposes kg_query / find_contradictions / get_related_chains with small schemas", async () => {
    const hooks = await server(fakeInput);
    for (const name of [
      "neuralgentics_kg_query",
      "neuralgentics_find_contradictions",
      "neuralgentics_get_related_chains",
    ]) {
      const tool = hooks.tool?.[name] as ToolDefinition | undefined;
      expect(tool).toBeDefined();
      expect(Object.keys(tool!.args).length).toBeLessThanOrEqual(2);
    }
    const kg = hooks.tool?.["neuralgentics_kg_query"] as ToolDefinition;
    expect(kg.args["query"]).toBeDefined();
  });
});

describe("session.compacting KG enrichment (T-MEMREAD-001)", () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ng-memread-"));
    dir = join(root, "project");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "# Test Agents\n\nmemread-probe", "utf-8");
    recordedCalls.length = 0;
    GoBackendClient.prototype.call = async function (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> {
      recordedCalls.push({ method, params: params ?? {} });
      if (method === "memory.add") return { id: "test-memory-id" };
      return {};
    };
  });

  afterEach(async () => {
    GoBackendClient.prototype.call = originalCall;
    await rm(root, { recursive: true, force: true });
  });

  it("fires extractEntities with the backup's memory id after a successful add", async () => {
    // Allow the lazy backend handle to initialise against our intercept.
    await server({ directory: dir, worktree: dir, serverUrl: new URL("http://localhost:0") });
    const hooks = await server({ directory: dir, worktree: dir, serverUrl: new URL("http://localhost:0") });
    await hooks.event?.({ event: { type: "session.compacting" } });
    // Fire-and-forget: yield a microtask turn so the void promise resolves.
    await new Promise((r) => setTimeout(r, 25));
    const methods = recordedCalls.map((c) => c.method);
    expect(methods).toContain("memory.add");
    expect(methods).toContain("memory.extractEntities");
    const ee = recordedCalls.find((c) => c.method === "memory.extractEntities");
    expect(ee?.params["memory_id"]).toBe("test-memory-id");
  });
});
