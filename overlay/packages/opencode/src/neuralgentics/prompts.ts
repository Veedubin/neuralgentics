/**
 * Interactive prompts for the neuralgentics two-init installer.
 *
 * Uses Node's `readline` for all prompts. All prompts have a default shown in
 * brackets. If a skip flag is set (e.g. `--yes`, `--embedded`), the prompt is
 * skipped and the default is used.
 *
 * Prompt types:
 *   1. Backend mode   — pgembed (recommended) vs team server
 *   2. Embedding mode — CPU / Auto (recommended) / GPU
 *   3. Ollama API key — written into provider block + .env file
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

function askQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for the memini-ai backend mode.
 *
 * Skipped if `--embedded` or `--team` is set.
 */
export async function promptBackendMode(flags: PromptFlags): Promise<BackendMode> {
  if (flags.embedded) return "pgembed";
  if (flags.team) return "team";
  if (flags.yes) return "pgembed";

  process.stdout.write("\n? memini-ai backend:\n");
  process.stdout.write("  > pgembed (recommended — zero Docker, just works)\n");
  process.stdout.write("    team server (connect to shared PostgreSQL)\n");
  const answer = await askQuestion("\nChoose [pgembed]: ");
  const trimmed = answer.trim().toLowerCase();
  if (trimmed.startsWith("t")) return "team";
  return "pgembed";
}

/**
 * Prompt for team server connection details.
 *
 * Only called when backend === "team".
 */
export async function promptTeamConnection(): Promise<{
  host: string;
  port: string;
  database: string;
}> {
  const host = (await askQuestion("? Team server IP [localhost]: ")).trim() || "localhost";
  const port = (await askQuestion("? Team server port [5432]: ")).trim() || "5432";
  const database = (await askQuestion("? Database name [neuralgentics]: ")).trim() || "neuralgentics";
  return { host, port, database };
}

/**
 * Prompt for the embedding mode.
 *
 * Skipped if `--CPU-Embed`, `--Auto-Embed`, or `--GPU-Embed` is set.
 */
export async function promptEmbeddingMode(flags: PromptFlags): Promise<EmbeddingMode> {
  if (flags.cpuEmbed) return "cpu";
  if (flags.autoEmbed) return "auto";
  if (flags.gpuEmbed) return "gpu";
  if (flags.yes) return "auto";

  process.stdout.write("\n? Embedding mode:\n");
  process.stdout.write("  > CPU (384-dim, fast, runs anywhere)\n");
  process.stdout.write("    Auto (384-dim default + optional 1024-dim elevation) [recommended]\n");
  process.stdout.write("    GPU (1024-dim only, requires CUDA/MPS)\n");
  const answer = await askQuestion("\nChoose [auto]: ");
  const trimmed = answer.trim().toLowerCase();
  if (trimmed.startsWith("cpu")) return "cpu";
  if (trimmed.startsWith("gpu")) return "gpu";
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
export async function promptOllamaApiKey(
  configDir: string,
  flags: PromptFlags,
): Promise<string | undefined> {
  // Skip if env var is already set.
  if (process.env.OLLAMA_API_KEY) {
    return process.env.OLLAMA_API_KEY;
  }
  // Skip if --yes.
  if (flags.yes) return undefined;

  process.stdout.write("\n? Want to add your Ollama Cloud API key now? (get one at https://ollama.com)\n");
  process.stdout.write("  You can skip and add it later to ~/.config/opencode/.env\n");
  const wantKey = (await askQuestion("  [y/N]: ")).trim().toLowerCase();
  if (!wantKey.startsWith("y")) {
    process.stdout.write("  Skipped — provider will use {env:OLLAMA_API_KEY} placeholder.\n");
    process.stdout.write("  Add OLLAMA_API_KEY=<your-key> to ~/.config/opencode/.env when ready.\n\n");
    return undefined;
  }

  process.stdout.write("  > ");
  const key = (await askQuestion("")).trim();
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
 */
export async function runAllPrompts(
  configDir: string,
  flags: PromptFlags,
): Promise<PromptConfig> {
  const config: PromptConfig = { ...DEFAULT_PROMPT_CONFIG };

  // 1. Backend mode
  config.backend = await promptBackendMode(flags);
  if (config.backend === "team") {
    const conn = await promptTeamConnection();
    config.teamHost = conn.host;
    config.teamPort = conn.port;
    config.teamDatabase = conn.database;
  }

  // 2. Embedding mode
  config.embedding = await promptEmbeddingMode(flags);

  // 3. Ollama API key
  config.ollamaApiKey = await promptOllamaApiKey(configDir, flags);

  return config;
}