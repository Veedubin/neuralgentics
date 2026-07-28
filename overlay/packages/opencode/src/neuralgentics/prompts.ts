/**
 * Interactive prompts for the neuralgentics two-init installer.
 *
 * Uses a SINGLE persistent readline interface for the entire prompt
 * session. This prevents the bug where closing/reopening readline
 * causes the next question to immediately receive buffered stdin
 * (e.g. the user's Enter keypress from the previous question).
 *
 * Prompt types:
 *   1. Backend mode   — pgembed (recommended) vs team server
 *   2. Embedding mode — CPU / Auto (recommended) / GPU
 *   3. Ollama API key — optional, written to .env file
 */

import * as readline from "node:readline";
import * as path from "node:path";
import { updateEnvFile } from "./env-file.js";

/** The backend mode chosen by the user. */
export type BackendMode = "pgembed" | "team";

/** The embedding mode chosen by the user. */
export type EmbeddingMode = "cpu" | "auto" | "gpu";

/** Configuration collected from interactive prompts. */
export interface PromptConfig {
  backend: BackendMode;
  /** Only set when backend === "team" */
  teamHost?: string;
  teamPort?: string;
  teamDatabase?: string;
  teamUser?: string;
  teamPassword?: string;
  embedding: EmbeddingMode;
  ollamaApiKey?: string;
}

// ---------------------------------------------------------------------------
// Input validation helpers (Fix 1 — harden promptTeamConnection)
// ---------------------------------------------------------------------------

/**
 * Validate a port number string. Returns the trimmed input if it's an
 * integer in `[1, 65535]`, otherwise returns `null`.
 *
 * Accepts leading/trailing whitespace (caller should trim before calling,
 * but the validator is tolerant). Rejects empty, negative, out-of-range,
 * fractional, and non-numeric strings.
 *
 * Exported for unit testing.
 */
export function validatePort(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  // Must be a pure integer (no sign, no decimal point, no exponent).
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 65535) return null;
  return trimmed;
}

/**
 * Validate a hostname/IP string. Returns the trimmed input if it's
 * non-empty, contains no spaces, and contains no `:` (the `:` is rejected
 * because a DSN port is appended later; IPv6 with brackets is out of scope
 * for this interactive prompt). Otherwise returns `null`.
 *
 * Exported for unit testing.
 */
export function validateHost(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (trimmed.includes(" ")) return null;
  if (trimmed.includes(":")) return null;
  return trimmed;
}

/**
 * Validate a database name string. Returns the trimmed input if it's
 * non-empty, contains no spaces, and contains no `/` (the `/` is rejected
 * because a DSN path separator is appended later). Otherwise returns
 * `null`.
 *
 * Exported for unit testing.
 */
export function validateDatabase(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (trimmed.includes(" ")) return null;
  if (trimmed.includes("/")) return null;
  return trimmed;
}

/** Flags that control which prompts to skip. */
export interface PromptFlags {
  /** `--yes` — skip ALL prompts (use defaults) */
  yes: boolean;
  /** `--embedded` — skip backend prompt, use pgembed */
  embedded: boolean;
  /** `--team` — skip backend prompt, use team server */
  team: boolean;
  /** `--CPU-Embed` — skip embedding prompt, use cpu */
  cpuEmbed: boolean;
  /** `--Auto-Embed` — skip embedding prompt, use auto */
  autoEmbed: boolean;
  /** `--GPU-Embed` — skip embedding prompt, use gpu */
  gpuEmbed: boolean;
}

/** Default config when all prompts are skipped. */
export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  backend: "pgembed",
  embedding: "auto",
};

/**
 * A function that asks a question and returns the answer. Both the real
 * `PromptSession` and test fakes implement this.
 *
 * Exported so tests can build a fake session without subclassing.
 */
export type AskFn = (prompt: string) => Promise<string>;

/**
 * A persistent prompt session using a single readline interface.
 * Create one, ask all questions, then close it.
 *
 * Exported so tests can construct a real session (though most tests will
 * use a fake `AskFn` instead).
 */
export class PromptSession implements AskSessionLike {
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /** Ask a question and wait for the user's answer. */
  ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer: string) => {
        resolve(answer);
      });
    });
  }

  /** Close the readline interface. Call after all questions are done. */
  close(): void {
    this.rl.close();
  }
}

/**
 * Structural interface satisfied by `PromptSession` and any test fake.
 * `promptTeamConnection` and other prompt functions accept this so tests
 * can inject a scripted `ask` without touching real stdin.
 */
export interface AskSessionLike {
  ask: AskFn;
  close?(): void;
}

/**
 * Prompt for the memini-ai backend mode.
 *
 * Skipped if `--embedded` or `--team` is set.
 */
async function promptBackendMode(session: PromptSession, flags: PromptFlags): Promise<BackendMode> {
  if (flags.embedded) return "pgembed";
  if (flags.team) return "team";
  if (flags.yes) return "pgembed";

  process.stdout.write("\n? How should memini-ai store memories?\n");
  process.stdout.write("\n");
  process.stdout.write("  1. Built-in database (recommended)\n");
  process.stdout.write("     No setup needed — everything runs locally.\n");
  process.stdout.write("     Your memories are stored in a local file.\n");
  process.stdout.write("     Best for getting started or solo use.\n");
  process.stdout.write("\n");
  process.stdout.write("  2. Team server\n");
  process.stdout.write("     Connect to a shared PostgreSQL database.\n");
  process.stdout.write("     Best for teams who want shared memory across machines.\n");
  process.stdout.write("     You'll need a PostgreSQL server already running.\n");
  process.stdout.write("\n");
  const answer = await session.ask("  Enter 1 or 2 [1]: ");
  const trimmed = answer.trim();
  if (trimmed === "2" || trimmed.toLowerCase().startsWith("team")) return "team";
  return "pgembed";
}

/**
 * Prompt for team server connection details.
 *
 * Asks: host/port/database/user/password for an EXISTING PostgreSQL server.
 * The user is responsible for starting the server beforehand — see
 * `neuralgentics --db-start` for the bundled compose stack.
 * Offers to save credentials to .env.
 *
 * Each of host/port/database is re-asked until the input validates (or the
 * user accepts the default by pressing Enter). Password accepts any string
 * (empty is valid for trust auth).
 *
 * Exported so tests can call it directly with a fake `AskSessionLike`.
 */
export async function promptTeamConnection(
  session: AskSessionLike,
  configDir: string,
): Promise<{
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}> {
  process.stdout.write("\n  Team server setup — connect to an existing PostgreSQL server.\n");
  process.stdout.write("  (Don't have one yet? Run `neuralgentics --db-start` first.)\n");

  const host = await askValidated(session, "\n  Server IP or hostname [localhost]: ", validateHost, "localhost");
  const port = await askValidated(session, "  Port [6200]: ", validatePort, "6200");
  const database = await askValidated(session, "  Database name [neuralgentics]: ", validateDatabase, "neuralgentics");

  process.stdout.write("\n  Database credentials:\n");
  const user = (await session.ask("  Username [neuralgentics]: ")).trim() || "neuralgentics";
  const password = (await session.ask("  Password: ")).trim();

  // Offer to save credentials to .env
  if (password) {
    process.stdout.write("\n");
    process.stdout.write("  Save credentials to .env so you don't have to re-enter them?\n");
    const saveCreds = (await session.ask("  [Y/n]: ")).trim().toLowerCase();
    if (!saveCreds.startsWith("n")) {
      const dbUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
      const envLines = [
        `MEMINI_DB_URL=${dbUrl}`,
        `MEMINI_VECTOR_BACKEND=postgres-external`,
      ];
      // Write to BOTH .opencode/.env (for the opencode plugin config dir)
      // AND <projectRoot>/.env (one directory up — where the Go backend
      // binary looks when spawned with CWD = project root).
      // The updateEnvFile helper backs up any existing file before merge,
      // so both locations are safe to overwrite.
      const opencodeEnvPath = path.join(configDir, ".env");
      const projectRoot = path.dirname(configDir);
      const projectEnvPath = path.join(projectRoot, ".env");
      const backupPath1 = await updateEnvFile(opencodeEnvPath, envLines);
      process.stdout.write(`  ✓ Saved to ${opencodeEnvPath}\n`);
      if (backupPath1) {
        process.stdout.write(`  ✓ Backed up existing .env to ${backupPath1}\n`);
      }
      const backupPath2 = await updateEnvFile(projectEnvPath, envLines);
      process.stdout.write(`  ✓ Saved to ${projectEnvPath}\n`);
      if (backupPath2) {
        process.stdout.write(`  ✓ Backed up existing .env to ${backupPath2}\n`);
      }
      process.stdout.write("  WARNING: Do NOT commit .env to git. Add .env to .gitignore.\n");
    }
  }

  return { host, port, database, user, password };
}

/**
 * Ask a question, and if the trimmed input is non-empty but fails
 * `validate`, print a clear error and re-ask until valid input (or the
 * user accepts the default by pressing Enter).
 *
 * @param session the prompt session
 * @param prompt the prompt string (includes the default hint)
 * @param validate validator returning the trimmed value or `null`
 * @param defaultValue returned when the user presses Enter (empty input)
 */
async function askValidated(
  session: AskSessionLike,
  prompt: string,
  validate: (input: string) => string | null,
  defaultValue: string,
): Promise<string> {
  while (true) {
    const answer = (await session.ask(prompt)).trim();
    if (answer === "") return defaultValue;
    const validated = validate(answer);
    if (validated !== null) return validated;
    process.stdout.write(
      `    Invalid input. Please try again (or press Enter for the default).\n`,
    );
  }
}

/**
 * Prompt for the embedding mode.
 *
 * Skipped if `--CPU-Embed`, `--Auto-Embed`, or `--GPU-Embed` is set.
 */
async function promptEmbeddingMode(session: PromptSession, flags: PromptFlags): Promise<EmbeddingMode> {
  if (flags.cpuEmbed) return "cpu";
  if (flags.autoEmbed) return "auto";
  if (flags.gpuEmbed) return "gpu";
  if (flags.yes) return "auto";

  process.stdout.write("\n? What embedding model should memini-ai use?\n");
  process.stdout.write("\n");
  process.stdout.write("  Embeddings convert text into vectors for semantic search.\n");
  process.stdout.write("  This affects how well memini-ai can find related memories.\n");
  process.stdout.write("\n");
  process.stdout.write("  1. CPU — Fast and lightweight, runs on any machine.\n");
  process.stdout.write("     Good search quality, low memory usage.\n");
  process.stdout.write("     Best for laptops, small VMs, or machines without a GPU.\n");
  process.stdout.write("\n");
  process.stdout.write("  2. Auto (recommended) — Same as CPU by default, but can\n");
  process.stdout.write("     automatically upgrade to higher quality if you add a GPU later.\n");
  process.stdout.write("     Best if you're not sure or might change hardware.\n");
  process.stdout.write("\n");
  process.stdout.write("  3. GPU — Highest quality search, but requires a dedicated\n");
  process.stdout.write("     GPU (NVIDIA CUDA or Apple Silicon MPS).\n");
  process.stdout.write("     Uses more memory and processing power.\n");
  process.stdout.write("     Best for machines with a GPU that need the best search quality.\n");
  process.stdout.write("\n");
  const answer = await session.ask("  Enter 1, 2, or 3 [2]: ");
  const trimmed = answer.trim();
  if (trimmed === "1" || trimmed.toLowerCase().startsWith("cpu")) return "cpu";
  if (trimmed === "3" || trimmed.toLowerCase().startsWith("gpu")) return "gpu";
  return "auto";
}

/**
 * Prompt for the Ollama Cloud API key.
 *
 * Skipped if `--yes` or the `OLLAMA_API_KEY` env var is already set.
 *
 * Writes the key to:
 *   1. The provider block of opencode.json as `{env:OLLAMA_API_KEY}`
 *   2. A `.env` file in the config dir with `OLLAMA_API_KEY=<key>`
 *
 * Warns the user: "Do NOT commit the .env file to git. Add .env to your .gitignore."
 */
async function promptOllamaApiKey(
  session: PromptSession,
  configDir: string,
  flags: PromptFlags,
): Promise<string | undefined> {
  // Skip if env var is already set.
  if (process.env.OLLAMA_API_KEY) {
    return process.env.OLLAMA_API_KEY;
  }
  // Skip if --yes.
  if (flags.yes) return undefined;

  process.stdout.write("\n? Want to add your Ollama Cloud API key now?\n");
  process.stdout.write("  Get one at https://ollama.com (free tier available).\n");
  process.stdout.write("  You can skip this and add it later.\n");
  const wantKey = (await session.ask("  [y/N]: ")).trim().toLowerCase();
  if (!wantKey.startsWith("y")) {
    process.stdout.write("  Skipped — add it later in ~/.config/opencode/.env\n");
    process.stdout.write("  as: OLLAMA_API_KEY=<your-key>\n\n");
    return undefined;
  }

  const key = (await session.ask("  Enter your key: ")).trim();
  if (!key) {
    process.stdout.write("  Skipped — no key entered.\n\n");
    return undefined;
  }

  // Write to .env file in BOTH the config dir (.opencode/) AND the project
  // root (one directory up). The Go backend binary is spawned with CWD =
  // project root, so it finds <projectRoot>/.env via its fallback chain.
  // The updateEnvFile helper backs up any existing file before merge.
  const opencodeEnvPath = path.join(configDir, ".env");
  const projectRoot = path.dirname(configDir);
  const projectEnvPath = path.join(projectRoot, ".env");
  const envLines = [`OLLAMA_API_KEY=${key}`];
  const backupPath1 = await updateEnvFile(opencodeEnvPath, envLines);
  process.stdout.write(`  ✓ Saved to ${opencodeEnvPath}\n`);
  if (backupPath1) {
    process.stdout.write(`  ✓ Backed up existing .env to ${backupPath1}\n`);
  }
  const backupPath2 = await updateEnvFile(projectEnvPath, envLines);
  process.stdout.write(`  ✓ Saved to ${projectEnvPath}\n`);
  if (backupPath2) {
    process.stdout.write(`  ✓ Backed up existing .env to ${backupPath2}\n`);
  }
  process.stdout.write(
    "\n  WARNING: Do NOT commit the .env file to git. Add .env to your .gitignore.\n\n",
  );
  return key;
}

/**
 * Run all interactive prompts and return a unified config.
 *
 * Uses a single persistent readline interface for the entire session
 * to avoid the buffered-stdin bug where closing/reopening readline
 * causes the next question to receive leftover input.
 */
export async function runAllPrompts(
  configDir: string,
  flags: PromptFlags,
): Promise<PromptConfig> {
  const config: PromptConfig = { ...DEFAULT_PROMPT_CONFIG };

  // Apply flag-determined values BEFORE the early-return check.
  // These flags set the value without prompting, so we must populate
  // the config even when we skip the interactive prompt.
  if (flags.embedded) config.backend = "pgembed";
  if (flags.team) config.backend = "team";
  if (flags.cpuEmbed) config.embedding = "cpu";
  if (flags.autoEmbed) config.embedding = "auto";
  if (flags.gpuEmbed) config.embedding = "gpu";

  // Check if any prompts will actually be shown.
  // If all are skipped by flags, don't create a readline interface at all.
  const needsBackend = !flags.embedded && !flags.team && !flags.yes;
  const needsEmbedding = !flags.cpuEmbed && !flags.autoEmbed && !flags.gpuEmbed && !flags.yes;
  const needsKey = !flags.yes && !process.env.OLLAMA_API_KEY;

  if (!needsBackend && !needsEmbedding && !needsKey) {
    // All prompts skipped — but team connection details still need prompting
    // if --team was used without --yes (user needs to provide IP/port/db).
    // With --yes --team, use defaults.
    if (config.backend === "team") {
      if (flags.yes) {
        config.teamHost = "localhost";
        config.teamPort = "6200";
        config.teamDatabase = "neuralgentics";
        config.teamUser = "neuralgentics";
        config.teamPassword = "neuralgentics";
      } else {
        const session = new PromptSession();
        try {
          const conn = await promptTeamConnection(session, configDir);
          config.teamHost = conn.host;
          config.teamPort = conn.port;
          config.teamDatabase = conn.database;
          config.teamUser = conn.user;
          config.teamPassword = conn.password;
        } finally {
          session.close();
        }
      }
    }
    return config;
  }

  const session = new PromptSession();

  try {
    // 1. Backend mode
    config.backend = await promptBackendMode(session, flags);
    if (config.backend === "team") {
      const conn = await promptTeamConnection(session, configDir);
      config.teamHost = conn.host;
      config.teamPort = conn.port;
      config.teamDatabase = conn.database;
      config.teamUser = conn.user;
      config.teamPassword = conn.password;
    }

    // 2. Embedding mode
    config.embedding = await promptEmbeddingMode(session, flags);

    // 3. Ollama API key
    config.ollamaApiKey = await promptOllamaApiKey(session, configDir, flags);
  } finally {
    session.close();
  }

  return config;
}