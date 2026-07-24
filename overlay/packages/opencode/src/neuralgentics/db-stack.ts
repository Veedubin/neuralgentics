/**
 * Neuralgentics bundled database stack management.
 *
 * Provides `--db-start` and `--db-stop` CLI commands that manage a
 * PostgreSQL container via the shipped docker-compose.yml.
 *
 * Policy:
 *   - NEVER overwrite an existing ~/.neuralgentics/docker-compose.yml or
 *     .env — back up with a timestamp instead (same pattern as the config
 *     writer in init.ts).
 *   - `--db-stop` runs `down` (NOT `down -v`) — volumes are NEVER deleted.
 *     The Container Deletion Policy applies to our own tooling.
 *   - Degrade gracefully with a clear message if no container runtime exists.
 *
 * First-user bootstrap (v0.15.13+):
 *   After the stack is up, `--db-start` offers to create the user's first
 *   database user instead of leaving them on the default superuser. The
 *   default `neuralgentics`/`neuralgentics` superuser works but shouldn't
 *   be shared. Non-interactive flags: `--db-user <name>` and
 *   `--db-password <pw>` (with `--yes` to accept defaults).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

/** Result of a db-start or db-stop operation. */
export interface DbStackResult {
  success: boolean;
  message: string;
  /** Exit code to return from the CLI (0 = ok, 1 = error). */
  exitCode: number;
}

/** Options for `--db-start` (v0.15.13+). */
export interface DbStartOptions {
  dryRun?: boolean;
  /** Non-interactive first-user name; skips the interactive offer. */
  dbUser?: string;
  /** Non-interactive first-user password (required when dbUser is set). */
  dbPassword?: string;
  /** `--yes` — accept defaults / skip confirmations. */
  yes?: boolean;
}

/** Result of the first-user bootstrap. */
export interface CreateUserResult {
  created: boolean;
  username: string;
  /** URL-encoded DSN for the created user (or empty string on decline). */
  dsn: string;
  message: string;
}

/** The canonical DSN the user should paste into --init-project. */
export const DEFAULT_DSN =
  "postgresql://neuralgentics:neuralgentics@localhost:6200/neuralgentics";

/** Username must match this safe identifier regex (no quotes, no dashes). */
const USERNAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Where the bundled stack lives (~/.neuralgentics/). */
export function stackDir(): string {
  return path.join(os.homedir(), ".neuralgentics");
}

/**
 * Detect available container-compose runtime.
 *
 * Preference order: podman-compose, podman compose, docker compose.
 * Returns the command as a single string (for `up -d` / `down`), or null
 * if none are available.
 */
export function detectComposeRuntime(): { command: string; version: string } | null {
  const shell = process.env.SHELL ?? "bash";

  // 1. podman-compose (standalone binary)
  try {
    execSync("command -v podman-compose", { stdio: "pipe", shell });
    const version = execSync("podman-compose --version", { stdio: "pipe", shell })
      .toString()
      .trim();
    return { command: "podman-compose", version };
  } catch {
    // not found
  }

  // 2. podman compose (subcommand)
  try {
    execSync("command -v podman", { stdio: "pipe", shell });
    execSync("podman compose version", { stdio: "pipe", shell });
    return { command: "podman compose", version: "podman compose" };
  } catch {
    // not found
  }

  // 3. docker compose (v2 subcommand)
  try {
    execSync("command -v docker", { stdio: "pipe", shell });
    execSync("docker compose version", { stdio: "pipe", shell });
    return { command: "docker compose", version: "docker compose" };
  } catch {
    // not found
  }

  return null;
}

/**
 * Locate the docker-compose.yml and compose.example.env shipped in the
 * npm package (sibling of dist/, two levels up from this compiled file).
 */
function bundledStackFiles(): { compose: string; envExample: string } {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/neuralgentics/db-stack.js -> ../../docker-compose.yml
  const pkgRoot = path.join(__dirname, "..", "..");
  return {
    compose: path.join(pkgRoot, "docker-compose.yml"),
    envExample: path.join(pkgRoot, "compose.example.env"),
  };
}

/**
 * Parse a simple KEY=VALUE env file into a record. Ignores blank lines
 * and comments (lines starting with `#`). Values may contain `#` for
 * inline comments only when the value is unquoted; quoted values keep
 * the whole content.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve the effective stack config: read ~/.neuralgentics/.env if present,
 * then apply process.env overrides (compose runtimes interpolate .env, but
 * our own exec commands need the resolved values).
 */
export interface StackConfig {
  stackName: string;
  dbPort: string;
  adminUser: string;
  adminPassword: string;
  adminDb: string;
}

/** Resolve the stack config from .env file + process.env. */
export function resolveStackConfig(envPath: string): StackConfig {
  let fileEnv: Record<string, string> = {};
  if (existsSync(envPath)) {
    try {
      fileEnv = parseEnvFile(
        readFileSync(envPath, "utf-8"),
      );
    } catch {
      // ignore — fall back to defaults
    }
  }
  const get = (key: string, fallback: string): string =>
    process.env[key] ?? fileEnv[key] ?? fallback;
  return {
    stackName: get("NEURALGENTICS_STACK_NAME", "neuralgentics"),
    dbPort: get("NEURALGENTICS_DB_PORT", "6200"),
    adminUser: get("NEURALGENTICS_DB_USER", "neuralgentics"),
    adminPassword: get("NEURALGENTICS_DB_PASSWORD", "neuralgentics"),
    adminDb: get("NEURALGENTICS_DB_NAME", "neuralgentics"),
  };
}

/**
 * Write the shipped compose + env files to ~/.neuralgentics/ if absent.
 * NEVER overwrite an existing file — back up with a timestamp first.
 *
 * Returns the paths to the compose file and .env.
 */
export async function ensureStackFiles(): Promise<{ composePath: string; envPath: string; backedUp: string[] }> {
  const dir = stackDir();
  const composePath = path.join(dir, "docker-compose.yml");
  const envPath = path.join(dir, ".env");
  const backedUp: string[] = [];
  const { compose: bundledCompose, envExample: bundledEnvExample } = bundledStackFiles();

  await fs.mkdir(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  // compose file
  if (!existsSync(bundledCompose)) {
    throw new Error(
      `Bundled docker-compose.yml not found at ${bundledCompose}. ` +
        `This should ship with @veedubin/neuralgentics — report a bug.`,
    );
  }
  if (existsSync(composePath)) {
    // back up before (potentially) overwriting — never destroy user edits
    const backup = path.join(dir, `docker-compose.yml.bak-${ts}`);
    await fs.copyFile(composePath, backup);
    backedUp.push(backup);
    // Always write the latest shipped version (user keeps their .env for customisation)
    await fs.copyFile(bundledCompose, composePath);
  } else {
    await fs.copyFile(bundledCompose, composePath);
  }

  // .env — only seed if absent, never overwrite
  if (!existsSync(envPath)) {
    if (existsSync(bundledEnvExample)) {
      await fs.copyFile(bundledEnvExample, envPath);
    }
  }

  return { composePath, envPath, backedUp };
}

/** Wait for PostgreSQL to accept connections (poll via container exec). */
function waitForPostgres(composeCmd: string, composeFile: string, cfg: StackConfig, maxMs: number): boolean {
  const shell = process.env.SHELL ?? "bash";
  const deadline = Date.now() + maxMs;
  const interval = 2000;
  while (Date.now() < deadline) {
    try {
      execSync(
        `${composeCmd} -f "${composeFile}" exec -T db-server ` +
          `pg_isready -U ${cfg.adminUser} -d ${cfg.adminDb}`,
        { stdio: "pipe", shell, timeout: 10_000 },
      );
      return true;
    } catch {
      // not ready yet
    }
    // sleep interval
    execSync(`sleep ${interval / 1000}`, { stdio: "pipe", shell });
  }
  return false;
}

/**
 * Escape a password for use inside a single-quoted SQL string literal.
 * In SQL, `'` inside a single-quoted string is escaped as `''`.
 */
export function escapeSqlPassword(pw: string): string {
  return pw.replace(/'/g, "''");
}

/** Build a URL-encoded DSN for a created user. */
export function buildUserDSN(username: string, password: string, port: string, database: string): string {
  return (
    `postgresql://${encodeURIComponent(username)}:` +
    `${encodeURIComponent(password)}@localhost:${port}/${database}`
  );
}

/**
 * Create a PostgreSQL user inside the running container via `exec` psql.
 *
 * Returns `{created: true}` on success (or "already exists" treated as
 * success), `{created: false}` only on a real error.
 */
export function createFirstUser(
  composeCmd: string,
  composeFile: string,
  cfg: StackConfig,
  username: string,
  password: string,
): { created: boolean; alreadyExisted: boolean; error?: string } {
  const shell = process.env.SHELL ?? "bash";
  const escapedUser = `"${username}"`;
  const escapedPw = `'${escapeSqlPassword(password)}'`;
  const createSql = `CREATE USER ${escapedUser} WITH PASSWORD ${escapedPw};`;
  const grantSql = `GRANT ALL PRIVILEGES ON DATABASE "${cfg.adminDb}" TO ${escapedUser};`;

  // Run both statements in a single psql -c (semicolon-separated).
  const fullSql = `${createSql}\n${grantSql}`;
  const cmd =
    `${composeCmd} -f "${composeFile}" exec -T db-server ` +
    `psql -U ${cfg.adminUser} -d ${cfg.adminDb} -c "${fullSql.replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

  try {
    const out = execSync(cmd, {
      stdio: "pipe",
      shell,
      timeout: 30_000,
    }).toString();
    // PostgreSQL error for duplicate user:
    //   ERROR:  role "foo" already exists
    if (/already exists/i.test(out)) {
      return { created: true, alreadyExisted: true };
    }
    return { created: true, alreadyExisted: false };
  } catch (exc) {
    // Some runtimes put the error message on stderr which execSync surfaces
    // as an Error with .stderr. Check both the message and any stderr.
    const msg = exc instanceof Error ? (exc as Error & { stderr?: Buffer }).message : String(exc);
    const stderr = exc instanceof Error ? String((exc as Error & { stderr?: Buffer }).stderr ?? "") : "";
    const combined = `${msg}\n${stderr}`;
    if (/already exists/i.test(combined)) {
      return { created: true, alreadyExisted: true };
    }
    return { created: false, alreadyExisted: false, error: combined.split("\n")[0] };
  }
}

/**
 * Print the exact command the user can run later to create a first user
 * (used when they decline the interactive offer).
 */
function printLaterCommand(cfg: StackConfig, composeFile: string): void {
  const composeCmd = detectComposeRuntime()?.command ?? "podman-compose";
  const exampleUser = "<username>";
  const examplePw = "<password>";
  process.stdout.write(
    "\n  You declined the first-user offer. You can create a user later with:\n\n" +
      `    ${composeCmd} -f "${composeFile}" exec -T db-server \\\n` +
      `      psql -U ${cfg.adminUser} -d ${cfg.adminDb} \\\n` +
      `      -c 'CREATE USER "${exampleUser}" WITH PASSWORD '${examplePw}'; GRANT ALL PRIVILEGES ON DATABASE "${cfg.adminDb}" TO "${exampleUser}";'\n\n` +
      `  Then connect with: postgresql://${exampleUser}:${examplePw}@localhost:${cfg.dbPort}/${cfg.adminDb}\n` +
      "  NOTE: The default `neuralgentics`/`neuralgentics` superuser works but\n" +
      "        shouldn't be shared — create your own user instead.\n",
  );
}

/**
 * Interactive first-user bootstrap. Returns the DSN of the created user,
 * or an empty string if the user declined.
 */
async function offerFirstUser(
  composeCmd: string,
  composeFile: string,
  cfg: StackConfig,
  opts: DbStartOptions,
): Promise<CreateUserResult> {
  // Non-interactive path: --db-user provided.
  if (opts.dbUser !== undefined) {
    if (!USERNAME_RE.test(opts.dbUser)) {
      return {
        created: false,
        username: opts.dbUser,
        dsn: "",
        message:
          `Invalid username "${opts.dbUser}". ` +
          "Usernames must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (letters, digits, " +
          "underscore; must start with a letter or underscore).",
      };
    }
    const password = opts.dbPassword ?? "";
    if (password === "") {
      return {
        created: false,
        username: opts.dbUser,
        dsn: "",
        message:
          `--db-user "${opts.dbUser}" provided without --db-password. ` +
          "Pass --db-password <pw> (or run interactively to be prompted).",
      };
    }
    const result = createFirstUser(composeCmd, composeFile, cfg, opts.dbUser, password);
    if (!result.created) {
      return {
        created: false,
        username: opts.dbUser,
        dsn: "",
        message: `Failed to create user "${opts.dbUser}": ${result.error ?? "unknown error"}`,
      };
    }
    const dsn = buildUserDSN(opts.dbUser, password, cfg.dbPort, cfg.adminDb);
    const note = result.alreadyExisted ? " (user already existed — treated as success)" : "";
    return {
      created: true,
      username: opts.dbUser,
      dsn,
      message: `Created database user "${opts.dbUser}"${note}.`,
    };
  }

  // --yes without --db-user: skip the offer entirely.
  if (opts.yes) {
    return {
      created: false,
      username: "",
      dsn: "",
      message: "Skipped first-user bootstrap (--yes set, no --db-user).",
    };
  }

  // Interactive path.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, (a: string) => resolve(a)));

    const want = (await ask("\nCreate your first database user now? [Y/n] ")).trim().toLowerCase();
    if (want.startsWith("n")) {
      printLaterCommand(cfg, composeFile);
      return {
        created: false,
        username: "",
        dsn: "",
        message: "Declined first-user offer — printed later-command.",
      };
    }

    const defaultName = process.env.USER ?? "neuralgentics";
    let username = (await ask(`  Username [${defaultName}]: `)).trim();
    if (username === "") username = defaultName;

    if (!USERNAME_RE.test(username)) {
      process.stdout.write(
        `  Invalid username "${username}". ` +
          "Usernames must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (letters, digits, " +
          "underscore; must start with a letter or underscore). Aborting.\n",
      );
      printLaterCommand(cfg, composeFile);
      return {
        created: false,
        username,
        dsn: "",
        message: `Invalid username "${username}" — aborted.`,
      };
    }

    let password = (await ask("  Password: ")).trim();
    if (password === "") {
      process.stdout.write("  No password entered — aborting first-user creation.\n");
      printLaterCommand(cfg, composeFile);
      return {
        created: false,
        username,
        dsn: "",
        message: "No password entered — aborted.",
      };
    }

    const result = createFirstUser(composeCmd, composeFile, cfg, username, password);
    if (!result.created) {
      process.stdout.write(
        `  Failed to create user "${username}": ${result.error ?? "unknown error"}\n`,
      );
      return {
        created: false,
        username,
        dsn: "",
        message: `Failed to create user "${username}": ${result.error ?? "unknown error"}`,
      };
    }
    const dsn = buildUserDSN(username, password, cfg.dbPort, cfg.adminDb);
    const note = result.alreadyExisted ? " (user already existed — treated as success)" : "";
    process.stdout.write(`  OK Created database user "${username}"${note}.\n`);
    return {
      created: true,
      username,
      dsn,
      message: `Created database user "${username}"${note}.`,
    };
  } finally {
    rl.close();
  }
}

/**
 * `--db-start`: bring up the bundled PostgreSQL stack.
 *
 * Steps:
 *   1. Detect compose runtime (podman-compose / podman compose / docker compose).
 *   2. Write shipped docker-compose.yml + compose.example.env to ~/.neuralgentics/.
 *   3. Run `up -d`.
 *   4. Wait for pg_isready (60s max — first-boot initdb on a fresh volume
 *      plus a freshly-pulled image can exceed 30s on slower machines).
 *   5. Offer to create the user's first database user (interactive, or
 *      non-interactive via --db-user/--db-password).
 *   6. Print the DSN to paste into --init-project.
 */
export async function dbStart(opts: DbStartOptions = {}): Promise<DbStackResult> {
  const dryRun = opts.dryRun ?? false;
  const shell = process.env.SHELL ?? "bash";

  const runtime = detectComposeRuntime();
  if (runtime === null) {
    return {
      success: false,
      message:
        "No container runtime found. Install one of:\n" +
        "  - podman-compose  (dnf install podman-compose / pip install podman-compose)\n" +
        "  - podman           (dnf install podman) with `podman compose` support\n" +
        "  - docker + docker compose plugin\n" +
        "Then re-run: neuralgentics --db-start",
      exitCode: 1,
    };
  }

  process.stdout.write(`Using compose runtime: ${runtime.command} (${runtime.version})\n`);

  let composePath: string;
  let envPath: string;
  try {
    const result = await ensureStackFiles();
    composePath = result.composePath;
    envPath = result.envPath;
    if (result.backedUp.length > 0) {
      process.stdout.write(
        `Backed up existing docker-compose.yml to: ${result.backedUp[0]}\n`,
      );
    }
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return { success: false, message: msg, exitCode: 1 };
  }

  const cfg = resolveStackConfig(envPath);

  process.stdout.write(`Stack directory: ${stackDir()}\n`);
  process.stdout.write(`Compose file:     ${composePath}\n`);
  process.stdout.write(`Env file:         ${envPath}\n`);
  process.stdout.write(`Stack name:       ${cfg.stackName}\n`);
  process.stdout.write(`Container:        ${cfg.stackName}-db\n`);
  process.stdout.write(`Host port:        ${cfg.dbPort} -> 5432\n\n`);

  if (dryRun) {
    process.stdout.write(`[DRY-RUN] Would run: ${runtime.command} -f "${composePath}" up -d\n`);
    return {
      success: true,
      message: `[DRY-RUN] Would start the PostgreSQL stack`,
      exitCode: 0,
    };
  }

  // Run up -d
  try {
    execSync(`${runtime.command} -f "${composePath}" up -d`, {
      stdio: "inherit",
      shell,
      cwd: stackDir(),
      timeout: 120_000,
    });
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return {
      success: false,
      message: `Failed to start stack: ${msg}`,
      exitCode: 1,
    };
  }

  // Wait for pg_isready
  process.stdout.write("Waiting for PostgreSQL to accept connections");
  const ready = waitForPostgres(runtime.command, composePath, cfg, 60_000);
  process.stdout.write("\n");

  if (!ready) {
    return {
      success: false,
      message:
        "PostgreSQL container started but did not become ready within 60s.\n" +
        "Compose logs: " + runtime.command + ` -f "${composePath}" logs db-server\n` +
        `Container logs: podman logs ${cfg.stackName}-db ` +
        `(or: docker logs ${cfg.stackName}-db)`,
      exitCode: 1,
    };
  }

  process.stdout.write("\nOK PostgreSQL stack is running.\n\n");

  // ── First-user bootstrap ────────────────────────────────────────────────
  const userResult = await offerFirstUser(runtime.command, composePath, cfg, opts);

  // Final output: the DSN to paste into --init-project.
  process.stdout.write("\nNext step — run:\n");
  process.stdout.write("    neuralgentics --init-project\n");
  process.stdout.write("\n");
  process.stdout.write("When prompted for the team server connection, use:\n");
  if (userResult.created && userResult.dsn !== "") {
    process.stdout.write(`    ${userResult.dsn}\n`);
    process.stdout.write(`  (your new user "${userResult.username}")\n`);
  } else {
    process.stdout.write(`    ${DEFAULT_DSN}\n`);
    process.stdout.write("(or just accept the defaults — they match the bundled stack)\n");
  }
  process.stdout.write("\n");

  if (!userResult.created && userResult.username !== "") {
    process.stderr.write(`[WARN] ${userResult.message}\n`);
  }

  return {
    success: true,
    message: `PostgreSQL stack started at localhost:${cfg.dbPort}`,
    exitCode: 0,
  };
}

/**
 * `--db-stop`: bring down the bundled PostgreSQL stack.
 *
 * Runs `down` (NOT `down -v`) — volumes are NEVER deleted. The Container
 * Deletion Policy applies to our own tooling.
 */
export async function dbStop(dryRun: boolean): Promise<DbStackResult> {
  const shell = process.env.SHELL ?? "bash";

  const runtime = detectComposeRuntime();
  if (runtime === null) {
    return {
      success: false,
      message:
        "No container runtime found. Install podman-compose, podman, or docker.\n" +
        "If the stack was started with a different runtime, stop it manually.",
      exitCode: 1,
    };
  }

  const composePath = path.join(stackDir(), "docker-compose.yml");
  if (!existsSync(composePath)) {
    return {
      success: false,
      message:
        `No docker-compose.yml found at ${composePath}.\n` +
        "Run `neuralgentics --db-start` first to create the stack.",
      exitCode: 1,
    };
  }

  if (dryRun) {
    process.stdout.write(
      `[DRY-RUN] Would run: ${runtime.command} -f "${composePath}" down\n` +
        "(volumes are NEVER deleted — `down` without `-v`)\n",
    );
    return {
      success: true,
      message: "[DRY-RUN] Would stop the PostgreSQL stack (volumes preserved)",
      exitCode: 0,
    };
  }

  try {
    // NOTE: `down` without `-v` — volumes preserved.
    execSync(`${runtime.command} -f "${composePath}" down`, {
      stdio: "inherit",
      shell,
      cwd: stackDir(),
      timeout: 60_000,
    });
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return {
      success: false,
      message: `Failed to stop stack: ${msg}`,
      exitCode: 1,
    };
  }

  process.stdout.write("\nOK PostgreSQL stack stopped (volumes preserved).\n");
  process.stdout.write("To restart: neuralgentics --db-start\n");
  process.stdout.write("Data is safe in the neuralgentics-db volume.\n");

  return {
    success: true,
    message: "PostgreSQL stack stopped (volumes preserved)",
    exitCode: 0,
  }
}