/**
 * Tests for T-CFG-MERGE-PRUNE-001: `--reset-mcp` cleanup command.
 *
 * Pre-v0.16.7 add-only merges wrote 13 MCP servers (6 enabled) + personal
 * plugins into user configs; the updater can never remove what it added.
 * resetMcp() replaces KNOWN neuralgentics server entries with the current
 * minimal templates, drops homedir-only names from project configs,
 * strips legacy personal plugins — and preserves unknown user servers.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetMcp } from "./reset-mcp.js";

describe("resetMcp (T-CFG-MERGE-PRUNE-001)", () => {
  let dir: string;

  const writeCfg = async (obj: unknown): Promise<void> => {
    await mkdir(join(dir, ".opencode"), { recursive: true });
    await writeFile(
      join(dir, ".opencode", "opencode.json"),
      JSON.stringify(obj, null, 2) + "\n",
      "utf-8",
    );
  };
  const readCfg = (): Promise<string> =>
    readFile(join(dir, ".opencode", "opencode.json"), "utf-8");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ng-resetmcp-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resets known servers to minimal templates and drops homedir-only names", async () => {
    await writeCfg({
      plugin: ["@veedubin/neuralgentics"],
      mcp: {
        "memini-ai-dev": { type: "local", enabled: true, command: ["stale"] },
        playwright: { type: "local", enabled: true, command: ["x"] },
        searxng: { type: "local", enabled: true, command: ["x"] },
      },
    });

    const r = await resetMcp({ target: dir });
    expect(r.changed).toBe(true);
    expect(r.serversReset.sort()).toEqual(["memini-ai-dev", "playwright", "searxng"]);

    const cfg = JSON.parse(await readCfg());
    expect(Object.keys(cfg.mcp)).toEqual(["memini-ai-dev"]);
    // Restored from current template — pgembed env present, enabled.
    expect(cfg.mcp["memini-ai-dev"].enabled).toBe(true);
    expect(cfg.mcp["memini-ai-dev"].env.MEMINI_DB_URL).toBe("pgembed");
  });

  it("preserves unknown user-added servers and strips legacy personal plugins", async () => {
    await writeCfg({
      plugin: ["@veedubin/neuralgentics", "@franlol/opencode-md-table-formatter@latest"],
      mcp: {
        "memini-ai-dev": { type: "local", enabled: true, command: ["old"] },
        "my-custom-server": { type: "local", enabled: true, command: ["keep"] },
      },
    });

    const r = await resetMcp({ target: dir });
    expect(r.changed).toBe(true);
    expect(r.serversPreserved).toEqual(["my-custom-server"]);
    expect(r.pluginsRemoved).toEqual(["@franlol/opencode-md-table-formatter@latest"]);

    const cfg = JSON.parse(await readCfg());
    expect(cfg.mcp["my-custom-server"]).toBeDefined();
    expect(cfg.plugin).toEqual(["@veedubin/neuralgentics"]);
  });

  it("writes a timestamped backup before modifying", async () => {
    await writeCfg({ mcp: { playwright: { type: "local", enabled: false, command: ["x"] } } });
    const r = await resetMcp({ target: dir });
    expect(r.changed).toBe(true);
    expect(r.backupPath).toContain("opencode.json.bak-");
    const backup = JSON.parse(await readFile(r.backupPath!, "utf-8"));
    expect(backup.mcp.playwright).toBeDefined();
  });

  it("dry-run reports without writing", async () => {
    await writeCfg({ mcp: { playwright: { type: "local", enabled: true, command: ["x"] } } });
    const before = await readCfg();
    const r = await resetMcp({ target: dir, dryRun: true });
    expect(r.changed).toBe(true);
    expect(r.backupPath).toBeNull();
    expect(await readCfg()).toBe(before);
  });

  it("throws a clear error when no opencode.json exists", async () => {
    await expect(resetMcp({ target: dir })).rejects.toThrow(/No opencode.json found/);
  });
});
