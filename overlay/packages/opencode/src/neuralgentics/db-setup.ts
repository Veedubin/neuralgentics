/**
 * memini-ai database bootstrap.
 *
 * Runs `uvx --from memini-ai-dev memini-ai init` to:
 *   - pgembed mode: create the embedded Postgres data dir, start it, and run
 *     schema migrations. Zero Docker required.
 *   - team mode:    connect to a remote PostgreSQL server and run migrations
 *     against it. The connection must already work.
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

/** Connection parameters for a team-mode PostgreSQL server. */
export interface TeamDbConfig {
  host: string;
  port: string;
  database: string;
  user?: string;
  password?: string;
}

export interface BootstrapResult {
  success: boolean;
  message: string;
  details?: string;
}

/** Per-command timeout: 180 seconds (schema migrations can take a while). */
const INIT_TIMEOUT_MS = 180_000;

/**
 * Test reachability of a team PostgreSQL server before running migrations.
 *
 * Uses `psql` if available (fast, no Python deps). Falls back to a tiny
 * `uvx --with psycopg` one-liner if psql isn't on PATH. Returns true if the
 * server accepted a connection, false otherwise.
 */
function testTeamConnection(cfg: TeamDbConfig): { ok: boolean; error?: string } {
  const user = cfg.user ?? "neuralgentics";
  const password = cfg.password ?? "neuralgentics";
  const connStr =
    `postgresql://${user}:${password}@${cfg.host}:${cfg.port}/${cfg.database}`;

  // Try psql first.
  try {
    execSync(`command -v psql`, {
      stdio: "pipe",
      shell: process.env.SHELL ?? "bash",
    });
    try {
      execSync(`psql "${connStr}" -c 'SELECT 1'`, {
        stdio: "pipe",
        timeout: 15_000,
        shell: process.env.SHELL ?? "bash",
      });
      return { ok: true };
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      return { ok: false, error: msg.split("\n")[0] };
    }
  } catch {
    // psql not on PATH — fall through to Python probe.
  }

  // Fall back to a one-shot psycopg probe via uvx.
  const probe = `uvx --with "psycopg[binary]" python -c "import psycopg,sys; c=psycopg.connect('${connStr}'); c.close(); print('ok')"`;
  try {
    const out = execSync(probe, {
      stdio: "pipe",
      timeout: 60_000,
      shell: process.env.SHELL ?? "bash",
    });
    if (out.toString().trim().endsWith("ok")) return { ok: true };
    return { ok: false, error: out.toString().trim() };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return { ok: false, error: msg.split("\n")[0] };
  }
}

/**
 * Run `memini-ai init` against the configured backend.
 *
 * @param backend      "pgembed" (embedded Postgres) or "team" (remote server).
 * @param teamConfig    Required when backend === "team"; ignored for pgembed.
 * @param dryRun        When true, print what would run but execute nothing.
 */
export async function bootstrapDatabase(
  backend: "pgembed" | "team",
  teamConfig: TeamDbConfig | undefined,
  dryRun: boolean,
): Promise<BootstrapResult> {
  if (backend === "pgembed") {
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

  // backend === "team"
  if (teamConfig === undefined) {
    return {
      success: false,
      message:
        "Team backend selected but no connection config was provided. " +
        "Re-run with --team and supply host/port/database.",
    };
  }

  const user = teamConfig.user ?? "neuralgentics";
  process.stdout.write(
    `Testing connection to team PostgreSQL server at ` +
      `${teamConfig.host}:${teamConfig.port}/${teamConfig.database}...\n`,
  );

  if (dryRun) {
    process.stdout.write(
      `[DRY-RUN] Would test connection + run migrations against ` +
        `${teamConfig.host}:${teamConfig.port}/${teamConfig.database}\n`,
    );
    return {
      success: true,
      message: `team DB at ${teamConfig.host}:${teamConfig.port}/${teamConfig.database} would be initialized`,
    };
  }

  const probe = testTeamConnection(teamConfig);
  if (!probe.ok) {
    return {
      success: false,
      message:
        `Cannot connect to PostgreSQL at ${teamConfig.host}:${teamConfig.port}. ` +
        `Make sure the server is running and credentials are correct. ` +
        `Detail: ${probe.error ?? "connection refused"}`,
    };
  }

  // Connection OK — run migrations.
  const dbUrl =
    `postgresql://${user}:${teamConfig.password ?? "neuralgentics"}@` +
    `${teamConfig.host}:${teamConfig.port}/${teamConfig.database}`;
  try {
    execSync("uvx --from memini-ai-dev memini-ai init", {
      stdio: "pipe",
      timeout: INIT_TIMEOUT_MS,
      shell: process.env.SHELL ?? "bash",
      env: { ...process.env, MEMINI_DB_URL: dbUrl },
    });
    return {
      success: true,
      message:
        `team DB initialized at ${teamConfig.host}:${teamConfig.port}/${teamConfig.database}`,
      details: "Tables created (memories, thoughts, entities, relationships)",
    };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    const trimmed = msg.split("\n").slice(0, 4).join(" ").trim();
    return {
      success: false,
      message: `team DB migration failed: ${trimmed}`,
    };
  }
}