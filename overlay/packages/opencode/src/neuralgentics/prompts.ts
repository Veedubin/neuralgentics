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
import { promises as fs, existsSync } from "node:fs";

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
  embedding: EmbeddingMode;
  ollamaApiKey?: string;
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
 * A persistent prompt session using a single readline interface.
 * Create one, ask all questions, then close it.
 */
class PromptSession {
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
 * Only called when backend === "team".
 */
async function promptTeamConnection(session: PromptSession): Promise<{
  host: string;
  port: string;
  database: string;
}> {
  process.stdout.write("\n  Enter your team server details:\n");
  const host = (await session.ask("  Server IP or hostname [localhost]: ")).trim() || "localhost";
  const port = (await session.ask("  Port [5432]: ")).trim() || "5432";
  const database = (await session.ask("  Database name [neuralgentics]: ")).trim() || "neuralgentics";
  return { host, port, database };
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

  // Write to .env file in config dir.
  const envPath = path.join(configDir, ".env");
  const envLine = `OLLAMA_API_KEY=${key}\n`;
  if (existsSync(envPath)) {
    // Append/update the key in existing .env
    const existing = await fs.readFile(envPath, "utf-8");
    const lines = existing.split("\n");
    const updated = new Set<string>();
    const result: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed === "") {
        result.push(line);
        continue;
      }
      const eqIdx = trimmed.indexOf("=");
      const k = eqIdx > 0 ? trimmed.slice(0, eqIdx).trim() : "";
      if (k === "OLLAMA_API_KEY") {
        result.push(envLine.trimEnd());
        updated.add("OLLAMA_API_KEY");
      } else {
        result.push(line);
      }
    }
    if (!updated.has("OLLAMA_API_KEY")) result.push(envLine.trimEnd());
    await fs.writeFile(envPath, result.join("\n") + "\n", "utf-8");
  } else {
    await fs.writeFile(envPath, envLine, "utf-8");
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
        config.teamPort = "5432";
        config.teamDatabase = "neuralgentics";
      } else {
        // Shouldn't reach here (needsBackend would be true), but just in case
        const session = new PromptSession();
        try {
          const conn = await promptTeamConnection(session);
          config.teamHost = conn.host;
          config.teamPort = conn.port;
          config.teamDatabase = conn.database;
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
      const conn = await promptTeamConnection(session);
      config.teamHost = conn.host;
      config.teamPort = conn.port;
      config.teamDatabase = conn.database;
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