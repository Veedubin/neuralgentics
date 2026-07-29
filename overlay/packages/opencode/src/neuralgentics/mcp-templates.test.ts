/**
 * Tests for mcp-templates.ts — the MCP server template constants that the
 * neuralgentics installer writes into opencode.json's `mcp` block.
 *
 * Regression coverage for the v0.15.23 "memini-ai-dev missing --stdio" bug:
 *   Since memini-ai v1.0.0, bare `memini-ai` defaults to streamable-http
 *   transport. OpenCode local MCP speaks stdio JSON-RPC, so every project
 *   installed via `neuralgentics --init-project` got "server unavailable" for
 *   memini-ai-dev. The fix is appending `"--stdio"` to the command array.
 *
 * Also asserts the 120000ms `timeout` on the memini-ai-dev template, which
 * covers the first-ever-launch embedding-model download (MiniLM ~100MB or
 * BGE-M3 ~2.3GB) that blows past OpenCode's default MCP probe timeout.
 */

import { describe, it, expect } from "bun:test";
import { HOMEDIR_MCP_TEMPLATES, PROJECT_MCP_TEMPLATES } from "./mcp-templates.js";

describe("HOMEDIR_MCP_TEMPLATES.memini-ai-dev", () => {
  const entry = HOMEDIR_MCP_TEMPLATES["memini-ai-dev"];

  it("is enabled", () => {
    expect(entry.enabled).toBe(true);
  });

  it("command array ends with --stdio (regression: bare memini-ai defaults to http)", () => {
    expect(entry.command.at(-1)).toBe("--stdio");
  });

  it("command is uvx --from memini-ai-dev memini-ai --stdio", () => {
    expect(entry.command).toEqual([
      "uvx",
      "--from",
      "memini-ai-dev",
      "memini-ai",
      "--stdio",
    ]);
  });

  it("has a 120000ms timeout for first-launch model download", () => {
    expect(entry.timeout).toBe(120000);
  });

  it("uses pgembed defaults for DB + vector backend", () => {
    expect(entry.env?.MEMINI_DB_URL).toBe("pgembed");
    expect(entry.env?.MEMINI_VECTOR_BACKEND).toBe("pgembed");
  });
});

describe("PROJECT_MCP_TEMPLATES.memini-ai-dev", () => {
  const entry = PROJECT_MCP_TEMPLATES["memini-ai-dev"];

  it("is enabled", () => {
    expect(entry.enabled).toBe(true);
  });

  it("command array ends with --stdio (regression: bare memini-ai defaults to http)", () => {
    expect(entry.command.at(-1)).toBe("--stdio");
  });

  it("command is uvx --from memini-ai-dev memini-ai --stdio", () => {
    expect(entry.command).toEqual([
      "uvx",
      "--from",
      "memini-ai-dev",
      "memini-ai",
      "--stdio",
    ]);
  });

  it("has a 120000ms timeout for first-launch model download", () => {
    expect(entry.timeout).toBe(120000);
  });

  it("uses pgembed defaults for DB + vector backend", () => {
    expect(entry.env?.MEMINI_DB_URL).toBe("pgembed");
    expect(entry.env?.MEMINI_VECTOR_BACKEND).toBe("pgembed");
  });
});

describe("no other template silently launches memini-ai without --stdio", () => {
  // Guard against future regressions: any entry whose command references the
  // `memini-ai` binary MUST append --stdio.
  it("every memini-ai command in HOMEDIR ends with --stdio", () => {
    for (const [name, entry] of Object.entries(HOMEDIR_MCP_TEMPLATES)) {
      if (entry.command.includes("memini-ai")) {
        expect(entry.command.at(-1), `${name} missing --stdio`).toBe("--stdio");
      }
    }
  });

  it("every memini-ai command in PROJECT ends with --stdio", () => {
    for (const [name, entry] of Object.entries(PROJECT_MCP_TEMPLATES)) {
      if (entry.command.includes("memini-ai")) {
        expect(entry.command.at(-1), `${name} missing --stdio`).toBe("--stdio");
      }
    }
  });
});

describe("no template uses a separate args key (regression: OpenCode ignores args on local MCP)", () => {
  // v0.16.2 fix: OpenCode does not honor `args` on local MCP servers — the
  // server fails at startup with "server unavailable". All flags must be
  // folded into the `command` array.
  it("HOMEDIR templates have no args property", () => {
    for (const [name, entry] of Object.entries(HOMEDIR_MCP_TEMPLATES)) {
      expect(entry, `${name} should not have args`).not.toHaveProperty("args");
    }
  });

  it("PROJECT templates have no args property", () => {
    for (const [name, entry] of Object.entries(PROJECT_MCP_TEMPLATES)) {
      expect(entry, `${name} should not have args`).not.toHaveProperty("args");
    }
  });

  it("duckdb command includes all flags inline", () => {
    const entry = HOMEDIR_MCP_TEMPLATES["duckdb"];
    expect(entry.command).toEqual([
      "uvx",
      "mcp-server-motherduck",
      "--db-path",
      ":memory:",
      "--read-write",
      "--allow-switch-databases",
    ]);
  });

  it("ssh-mcp-server command includes --ssh flag inline", () => {
    const entry = HOMEDIR_MCP_TEMPLATES["ssh-mcp-server"];
    expect(entry.command[0]).toBe("npx");
    expect(entry.command[1]).toBe("-y");
    expect(entry.command[2]).toBe("@fangjunjie/ssh-mcp-server");
    expect(entry.command[3]).toContain("--ssh=");
  });
});