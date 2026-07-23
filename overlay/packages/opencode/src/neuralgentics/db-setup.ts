/**
 * memini-ai database bootstrap — pgembed (built-in) only.
 *
 * Runs `uvx --from memini-ai-dev memini-ai init` to create the embedded
 * Postgres data dir, start it, and run schema migrations. Zero Docker
 * required.
 *
 * Team mode does NOT use this function. The installer never touches the team
 * database: no probe, no migration, no pass/fail block. memini-ai
 * auto-creates its schema (CREATE EXTENSION/TABLE IF NOT EXISTS) on first
 * MCP launch, so install-time migration is unnecessary for team mode. The
 * installer just writes the config and prints an informational note.
 *
 * Policy:
 *   - A failure here MUST NOT crash the installer. The user can fix the DB
 *     later and re-run `neuralgentics --init-project` (the init is idempotent
 *     because `memini-ai init` itself is idempotent).
 *   - We surface a clear success / failure message in the summary.
 */

import { execSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

export interface BootstrapResult {
  success: boolean;
  message: string;
  details?: string;
}

/** Per-command timeout: 180 seconds (schema migrations can take a while). */
const INIT_TIMEOUT_MS = 180_000;

/**
 * Run `memini-ai init` for the embedded (pgembed) backend.
 *
 * Team mode callers should NOT invoke this function — the installer skips
 * DB work entirely for team mode (memini-ai auto-creates tables on first
 * launch).
 *
 * @param dryRun  When true, print what would run but execute nothing.
 */
export async function bootstrapDatabase(dryRun: boolean): Promise<BootstrapResult> {
  const dataDir = path.join(os.homedir(), ".local", "share", "memini-ai", "pgembed");
  process.stdout.write("Bootstrapping embedded PostgreSQL (pgembed)...\n");
  process.stdout.write("Creating database tables...\n");

  const cmd = "uvx --from memini-ai-dev memini-ai init";
  if (dryRun) {
    process.stdout.write(`[DRY-RUN] Would run: ${cmd}\n`);
    return {
      success: true,
      message: `pgembed would be initialized at ${dataDir}`,
    };
  }

  try {
    execSync(cmd, {
      stdio: "pipe",
      timeout: INIT_TIMEOUT_MS,
      shell: process.env.SHELL ?? "bash",
    });
    return {
      success: true,
      message: `pgembed ready at ${dataDir}`,
      details: "Tables created (memories, thoughts, entities, relationships)",
    };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    const trimmed = msg.split("\n").slice(0, 4).join(" ").trim();
    return {
      success: false,
      message: `pgembed bootstrap failed: ${trimmed}`,
    };
  }
}