/**
 * MCP package pre-download.
 *
 * After writing config + copying agents, pre-download every MCP server
 * package referenced in the written opencode.json so that the first
 * `opencode` launch does not block on a cold `uvx` / `npx` fetch.
 *
 * - `uvx` packages  → `uv tool install "<pkg>"` (warms the uv wheel cache +
 *                     installs the binary on PATH; opencode still runs the
 *                     server via `uvx`, which hits the warm cache on launch).
 *                     NOTE: the original spec said `uvx --install`, but
 *                     `uvx` (uv 0.11+) has no `--install` flag — `uv tool
 *                     install` is the supported pre-download path.
 * - `npx` packages  → `npx --yes <pkg> --help` (downloads + caches, then exits)
 *
 * One package failing does NOT abort the install — failures are collected
 * and reported in the summary so the user can remediate manually.
 */

import { execSync } from "node:child_process";

import type { McpBlock, McpServerEntry } from "./mcp-templates.js";

/** Result of pre-downloading all MCP server packages. */
export interface PreDownloadResult {
  installed: string[];
  failed: { name: string; error: string }[];
}

/** Per-package timeout: 120 seconds (matches spec). */
const PER_PACKAGE_TIMEOUT_MS = 120_000;

/**
 * Build the pre-download command for a single MCP server entry.
 *
 * Returns `null` if the entry uses neither `uvx` nor `npx` (so we skip it
 * rather than guess — e.g. a user-supplied local path command).
 *
 * NOTE: the original spec asked for `uvx --install ...`, but `uvx` (uv 0.11+)
 * has no `--install` flag. The supported pre-download path is
 * `uv tool install "<pkg>"` — it warms the wheel cache and installs the
 * binary on PATH. opencode still launches the server via `uvx ...`, which
 * hits the warm cache on first run instead of doing a cold fetch.
 */
function buildPreDownloadCommand(entry: McpServerEntry): { cmd: string; via: "uvx" | "npx" } | null {
  const [runner, ...rest] = entry.command;
  if (runner === "uvx") {
    // Forms seen in mcp-templates.ts:
    //   ["uvx", "--from", "memini-ai-dev", "memini-ai"]   →  uv tool install --force "memini-ai-dev"
    //   ["uvx", "videre-mcp[vision]"]                    →  uv tool install --force "videre-mcp[vision]"
    //   ["uvx", "markitdown-mcp"]                        →  uv tool install --force "markitdown-mcp"
    //   ["uvx", "mcp-server-motherduck"]                →  uv tool install --force "mcp-server-motherduck"
    //
    // `--force` is idempotent: it re-installs over an existing binary instead
    // of exiting non-zero (which would be reported as a failure on re-runs).
    if (rest.length >= 2 && rest[0] === "--from") {
      const fromPkg = rest[1];
      return { cmd: `uv tool install --force "${fromPkg}"`, via: "uvx" };
    }
    const pkg = rest.join(" ").trim();
    if (!pkg) return null;
    return { cmd: `uv tool install --force "${pkg}"`, via: "uvx" };
  }

  if (runner === "npx") {
    // Forms: ["npx", "-y", "<pkg>"]  OR  ["npx", "-y", "<pkg>@latest"]
    // Drop the "-y" if present; we add our own --yes.
    const pkgArgs = rest.filter((a) => a !== "-y");
    const pkg = pkgArgs.join(" ").trim();
    if (!pkg) return null;
    return {
      cmd: `npx --yes ${pkg} --help`,
      via: "npx",
    };
  }

  return null;
}

/**
 * Pre-download all MCP server packages referenced in `templates`.
 *
 * @param templates  The MCP block (HOMEDIR or PROJECT) that was written to
 *                   opencode.json. Both HOMEDIR + PROJECT are passed by the
 *                   caller so a single homedir run caches every package the
 *                   user might later enable.
 * @param dryRun     When true, print what would be installed but execute nothing.
 */
export async function preDownloadPackages(
  templates: McpBlock,
  dryRun: boolean,
): Promise<PreDownloadResult> {
  const installed: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const [name, entry] of Object.entries(templates)) {
    const built = buildPreDownloadCommand(entry);
    if (built === null) {
      // Unsupported runner (e.g. direct binary) — skip silently.
      continue;
    }
    process.stdout.write(`Installing ${name}... (${built.via})\n`);

    if (dryRun) {
      process.stdout.write(`[DRY-RUN] Would run: ${built.cmd}\n`);
      installed.push(name);
      continue;
    }

    try {
      execSync(built.cmd, {
        stdio: "pipe",
        timeout: PER_PACKAGE_TIMEOUT_MS,
        shell: process.env.SHELL ?? "bash",
      });
      installed.push(name);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      // Trim noisy stderr tails to keep the summary readable.
      const trimmed = msg.split("\n").slice(0, 3).join(" ").trim();
      failed.push({ name, error: trimmed || "command failed" });
      process.stdout.write(`  ✗ ${name} failed: ${trimmed}\n`);
    }
  }

  return { installed, failed };
}