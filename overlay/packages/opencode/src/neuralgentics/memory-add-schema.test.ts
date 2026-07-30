/**
 * Tests for T-MEMADD-001: neuralgentics_memory_add tool schema.
 *
 * The Go backend `memory.add` RPC expects a `content` field, but the MCP
 * tool schema previously exposed `text` — causing every call to fail with
 * `-32602 Invalid params: content is required`. These tests assert the
 * schema now exposes `content` (primary) and that the tolerant aliasing
 * in `makeProxyTool` normalises a legacy `text` arg to `content` before
 * forwarding to the backend.
 */

import { describe, it, expect } from "bun:test";
import { server } from "../server.js";
import type { PluginInput, ToolDefinition } from "../server.js";

/** Minimal PluginInput for server() — backend is lazy so no spawn occurs. */
const fakeInput: PluginInput = {
  directory: "/tmp",
  worktree: "/tmp",
  serverUrl: new URL("http://localhost:0"),
};

describe("neuralgentics_memory_add tool schema (T-MEMADD-001)", () => {
  it("exposes `content` as the primary content argument", async () => {
    const hooks = await server(fakeInput);
    const tool = hooks.tool?.["neuralgentics_memory_add"] as ToolDefinition;
    expect(tool).toBeDefined();
    expect(tool.args).toBeDefined();
    expect(tool.args["content"]).toBeDefined();
    expect(tool.args["content"].type).toBe("string");
  });

  it("does NOT expose the old broken `text`-only schema", async () => {
    const hooks = await server(fakeInput);
    const tool = hooks.tool?.["neuralgentics_memory_add"] as ToolDefinition;
    // `text` should not be a declared arg anymore — the schema uses `content`.
    expect(tool.args["text"]).toBeUndefined();
  });

  it("execute() normalises legacy `text` arg to `content` before forwarding", async () => {
    const hooks = await server(fakeInput);
    const tool = hooks.tool?.["neuralgentics_memory_add"] as ToolDefinition;

    // Call with the legacy `text` arg. The tolerant aliasing in
    // makeProxyTool should normalise it to `content` before forwarding.
    // If aliasing is broken, the backend returns -32602 "content is required".
    // If aliasing works, the call reaches the backend (and may fail with a
    // DB/env error, which is fine — the point is it got past param validation).
    const result = await tool.execute(
      { text: "hello world", sourceType: "session" } as Record<string, unknown>,
      { sessionID: "s", messageID: "m", directory: "/tmp", worktree: "/tmp" },
    );
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result) as Record<string, unknown>;
    // Must NOT be the -32602 "content is required" params error.
    const errStr = String(parsed["error"] ?? parsed["result"] ?? "");
    expect(errStr).not.toContain("content is required");
    expect(errStr).not.toContain("-32602");
  });
});