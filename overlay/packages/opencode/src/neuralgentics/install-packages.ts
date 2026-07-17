/**
 * MCP package pre-download.
 *
 * After writing config + copying agents, pre-download every MCP server
 * package referenced in the written opencode.json so that the first
 * `opencode` launch does not block on a cold `uvx` / `npx` fetch.
 *
 * The MCP config commands use `uvx` and `npx -y` (not `uv tool install`
 * or global installs) so every launch gets the freshest version. To
 * pre-warm the cache without pinning a version, we run the same command
 * with `--help` or `--version` appended — this downloads + caches the
 * package and its deps, then exits immediately without starting the
 * MCP server.
 *
 * - `uvx` packages  → `uvx --from <pkg> <bin> --help` or `uvx <pkg> --help`
 *                     (warms the uvx ephemeral cache)
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
 * The MCP config uses `uvx` / `npx -y` for freshest-on-launch. We pre-warm
 * by running the same command with `--help` appended — this downloads +
 * caches the package and deps, then exits immediately.
 *
 * Returns `null` if the entry uses neither `uvx` nor `npx`.
 */
function buildPreDownloadCommand(entry: McpServerEntry): { cmd: string; via: "uvx" | "npx" } | null {
  const [runner, ...rest] = entry.command;
  if (runner === "uvx") {
    // Forms seen in mcp-templates.ts:
    //   ["uvx", "--from", "memini-ai-dev", "memini-ai"]  →  uvx --from memini-ai-dev memini-ai --help
    //   ["uvx", "videre-mcp[vision]"]                   →  uvx videre-mcp[vision] --help
    //   ["uvx", "markitdown-mcp"]                       →  uvx markitdown-mcp --help
    //   ["uvx", "mcp-server-motherduck"]                →  uvx mcp-server-motherduck --help
    //
    // We run the exact same uvx command + " --help" so the ephemeral
    // cache is warmed. On real launch, opencode runs the same uvx
    // command (without --help) and hits the warm cache.
    const fullCmd = entry.command.join(" ");
    return { cmd: `${fullCmd} --help`, via: "uvx" };
  }

  if (runner === "npx") {
    // Forms: ["npx", "-y", "<pkg>"]  OR  ["npx", "-y", "<pkg>@latest"]
    // We run the exact same npx command + " --help" to cache it.
    const fullCmd = entry.command.join(" ");
    return { cmd: `${fullCmd} --help`, via: "npx" };
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