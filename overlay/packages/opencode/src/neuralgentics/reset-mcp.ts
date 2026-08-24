/**
 * reset-mcp.ts — T-CFG-MERGE-PRUNE-001
 *
 * `neuralgentics --reset-mcp` — opt-in cleanup for user configs polluted by
 * the pre-v0.16.7 add-only merge, which shipped the maintainer's personal
 * `.opencode/opencode.json` (13 MCP servers, 6 enabled, personal plugins)
 * into every install. The updater can never remove entries it once added,
 * so this command does it explicitly and conservatively:
 *
 *   - MCP: only entries whose name matches a KNOWN neuralgentics-shipped
 *     template are replaced with the current (minimal) templates; unknown
 *     / user-added servers are preserved untouched.
 *   - Plugins: only known-personal plugin references ("@franlol/") removed;
 *     everything else preserved.
 *   - A timestamped backup of opencode.json is written next to it first.
 *
 * Usage:
 *   neuralgentics --reset-mcp [--target <dir>] [--dry-run] [--yes]
 */

import { readFile, writeFile, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_MCP_TEMPLATES, HOMEDIR_MCP_TEMPLATES } from "./mcp-templates.js";
import type { McpBlock } from "./mcp-templates.js";

/** Every server name the installer has ever shipped — the pollution set. */
export const KNOWN_SERVER_NAMES = new Set([
  ...Object.keys(HOMEDIR_MCP_TEMPLATES),
  ...Object.keys(PROJECT_MCP_TEMPLATES),
]);

/** Plugin references that were never product intent. */
const LEGACY_PLUGIN_MARKERS = ["@franlol/"];

export interface ResetMcpResult {
  changed: boolean;
  /** Server names that were replaced/removed from the config. */
  serversReset: string[];
  /** Plugin refs removed. */
  pluginsRemoved: string[];
  /** Servers left alone because they are not neuralgentics-known. */
  serversPreserved: string[];
  backupPath: string | null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite `<target>/.opencode/opencode.json`, replacing known MCP entries
 * with current minimal templates and stripping legacy personal plugins.
 */
export async function resetMcp(opts: {
  target?: string;
  dryRun?: boolean;
}): Promise<ResetMcpResult> {
  const target = opts.target ?? ".";
  const cfgPath = join(target, ".opencode", "opencode.json");

  if (!(await fileExists(cfgPath))) {
    throw new Error(`No opencode.json found at ${cfgPath} — nothing to reset.`);
  }

  const raw = await readFile(cfgPath, "utf-8");
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `opencode.json is not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix it manually first.`,
    );
  }

  const result: ResetMcpResult = {
    changed: false,
    serversReset: [],
    pluginsRemoved: [],
    serversPreserved: [],
    backupPath: null,
  };

  // ── MCP block ─────────────────────────────────────────────────────────
  const mcp = (cfg["mcp"] ?? {}) as McpBlock;
  const nextMcp: McpBlock = {};
  for (const [name, entry] of Object.entries(mcp)) {
    if (KNOWN_SERVER_NAMES.has(name)) {
      if (name in PROJECT_MCP_TEMPLATES) {
        // Project-scoped server: restore the current minimal template.
        nextMcp[name] = JSON.parse(JSON.stringify(PROJECT_MCP_TEMPLATES[name]));
      }
      // Homedir-only names are dropped entirely from project configs.
      result.serversReset.push(name);
      result.changed = true;
    } else {
      result.serversPreserved.push(name);
      nextMcp[name] = entry;
    }
  }
  cfg["mcp"] = nextMcp;

  // ── Plugin array ──────────────────────────────────────────────────────
  if (Array.isArray(cfg["plugin"])) {
    const plugins = cfg["plugin"] as string[];
    const kept = plugins.filter((p) => {
      if (typeof p === "string" && LEGACY_PLUGIN_MARKERS.some((m) => p.includes(m))) {
        result.pluginsRemoved.push(p);
        return false;
      }
      return true;
    });
    if (kept.length !== plugins.length) {
      cfg["plugin"] = kept;
      result.changed = true;
    }
  }

  if (!result.changed || opts.dryRun) {
    return result; // nothing to write
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${cfgPath}.bak-${stamp}`;
  await copyFile(cfgPath, backupPath);
  result.backupPath = backupPath;

  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  void readFile; // keep import used if lints tighten later
  return result;
}
