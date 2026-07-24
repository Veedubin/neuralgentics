/**
 * Config read/write logic for `.opencode/neuralgentics.config.json`.
 *
 * The config file drives the model-assignment system (`--remodel`):
 *   - `providers`  — which LLM providers are enabled (and their API key env var)
 *   - `overrides`  — per-agent overrides that bypass the benchmark rankings
 *   - `version`    — config schema version (for future migrations)
 *
 * On first `--remodel` (or `--init` if no config exists), a default config is
 * written with only `ollama` enabled — matching the current agent assignments
 * shipped in the package.
 */

import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";

/** Schema version for the config file (bumped on breaking schema changes). */
export const CONFIG_SCHEMA_VERSION = "1.0.0";

/** Name of the config file inside a `.opencode/` directory. */
export const CONFIG_FILENAME = "neuralgentics.config.json";

/** A single provider entry in the config. */
export interface ProviderConfig {
  /** Whether this provider is enabled for model assignment. */
  enabled: boolean;
  /** Name of the env var holding the API key (e.g. "OLLAMA_API_KEY").
   *  Omitted for local providers (e.g. "dmr-local"). */
  apiKeyEnv?: string;
}

/** A per-agent override that bypasses the benchmark rankings. */
export interface AgentOverride {
  /** Full model id in "provider/model" format (e.g. "ollama/kimi-k2.6").
   *  If set, takes precedence over the `provider` field. */
  model?: string;
  /** Provider id to pin (e.g. "openrouter"). Used only when `model` is unset —
   *  the picker then chooses the highest-ranked model for this provider. */
  provider?: string;
}

/** The full config file shape. */
export interface NeuralgenticsConfig {
  version: string;
  providers: Record<string, ProviderConfig>;
  overrides: Record<string, AgentOverride>;
}

/** The default set of providers shipped with a fresh config. */
const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  ollama: { enabled: true, apiKeyEnv: "OLLAMA_API_KEY" },
  openrouter: { enabled: false, apiKeyEnv: "OPENROUTER_API_KEY" },
  openai: { enabled: false, apiKeyEnv: "OPENAI_API_KEY" },
  anthropic: { enabled: false, apiKeyEnv: "ANTHROPIC_API_KEY" },
  google: { enabled: false, apiKeyEnv: "GOOGLE_API_KEY" },
  groq: { enabled: false, apiKeyEnv: "GROQ_API_KEY" },
  kimi: { enabled: false, apiKeyEnv: "KIMI_API_KEY" },
  mammoth: { enabled: false, apiKeyEnv: "MAMMOTH_API_KEY" },
  minimax: { enabled: false, apiKeyEnv: "MINIMAX_API_KEY" },
  "dmr-local": { enabled: false },
};

/** Returns a fresh default config (ollama enabled, everything else off). */
export function createDefaultConfig(): NeuralgenticsConfig {
  return {
    version: CONFIG_SCHEMA_VERSION,
    providers: structuredClone(DEFAULT_PROVIDERS),
    overrides: {},
  };
}

/** Returns the absolute path to the config file for a given config dir. */
export function getConfigPath(configDir: string): string {
  return path.join(configDir, CONFIG_FILENAME);
}

/**
 * Load the config from `configPath`. If the file is missing, returns the
 * default config (does NOT write the file — the caller decides whether to
 * persist). If the file exists but is malformed, throws a descriptive error
 * (the caller should surface it rather than silently overwriting user data).
 */
export async function loadConfig(configPath: string): Promise<NeuralgenticsConfig> {
  if (!existsSync(configPath)) {
    return createDefaultConfig();
  }
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Config ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return normalizeConfig(parsed, configPath);
}

/**
 * Normalize a parsed JSON value into a valid `NeuralgenticsConfig`.
 *
 * Fills in missing `providers` / `overrides` / `version` fields with safe
 * defaults rather than rejecting a partial config. Unknown extra fields are
 * preserved (forward-compat) but never relied upon by the picker.
 */
function normalizeConfig(parsed: unknown, sourcePath: string): NeuralgenticsConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config ${sourcePath} must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const providersRaw = obj["providers"];
  const overridesRaw = obj["overrides"];
  const version = typeof obj["version"] === "string" ? obj["version"] : CONFIG_SCHEMA_VERSION;

  const providers: Record<string, ProviderConfig> = {};
  if (providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw)) {
    for (const [name, val] of Object.entries(providersRaw as Record<string, unknown>)) {
      if (typeof val !== "object" || val === null) continue;
      const entry = val as Record<string, unknown>;
      providers[name] = {
        enabled: entry["enabled"] === true,
        ...(typeof entry["apiKeyEnv"] === "string" ? { apiKeyEnv: entry["apiKeyEnv"] } : {}),
      };
    }
  }

  const overrides: Record<string, AgentOverride> = {};
  if (overridesRaw && typeof overridesRaw === "object" && !Array.isArray(overridesRaw)) {
    for (const [role, val] of Object.entries(overridesRaw as Record<string, unknown>)) {
      if (typeof val !== "object" || val === null) continue;
      const entry = val as Record<string, unknown>;
      const o: AgentOverride = {};
      if (typeof entry["model"] === "string") o.model = entry["model"];
      if (typeof entry["provider"] === "string") o.provider = entry["provider"];
      if (Object.keys(o).length > 0) overrides[role] = o;
    }
  }

  return { version, providers, overrides };
}

/**
 * Serialize the config to a stable JSON string (2-space indent, trailing
 * newline) and write it to `configPath`. Creates parent dirs as needed.
 */
export async function saveConfig(configPath: string, config: NeuralgenticsConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const body = JSON.stringify(config, null, 2) + "\n";
  await fs.writeFile(configPath, body, "utf-8");
}