/**
 * @neuralgentics/tui — Task-Scoped Model Selection (T-025)
 *
 * Routes tasks to big/small/fast models based on task type, with a
 * configurable registry. Reads defaults from `config/default.json`,
 * validates against the provider models in `.opencode/opencode.json`.
 *
 * Usage:
 *   import { getModelForTask } from "./agents/model-registry.js";
 *   const { provider, modelId } = getModelForTask("coder");
 *   // → { provider: "ollama", modelId: "deepseek-v4-pro", category: "big_model" }
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Supported task types that map to model categories. */
export type TaskType =
  | "architect"
  | "coder"
  | "explorer"
  | "tester"
  | "linter"
  | "git"
  | "writer"
  | "release"
  | "scraper";

/** Model categories — each maps to a specific model in the registry. */
export type ModelCategory = "big_model" | "small_model" | "fast_model" | "extraction_model";

/** Resolved model information returned by getModelForTask. */
export interface ModelResolution {
  /** Provider ID (e.g. "ollama") */
  provider: string;
  /** Model ID registered with the provider (e.g. "deepseek-v4-pro") */
  modelId: string;
  /** Which category this model belongs to */
  category: ModelCategory;
}

/** A single model entry in the registry config. */
export interface ModelEntry {
  /** Model ID as registered in the Ollama provider */
  modelId: string;
  /** Human-readable description */
  description?: string;
}

/** The full config file shape (config/default.json). */
export interface ModelRegistryConfig {
  $schema?: string;
  provider: {
    name: string;
    baseURL?: string;
  };
  models: Record<ModelCategory, ModelEntry>;
  routing: Record<string, ModelCategory>;
}

// ─── Default Registry ─────────────────────────────────────────────────────────

const DEFAULT_PROVIDER = "ollama";

const DEFAULT_MODELS: Record<ModelCategory, ModelEntry> = {
  big_model: {
    modelId: "deepseek-v4-pro",
    description: "Architectural decisions, design docs, complex reasoning",
  },
  small_model: {
    modelId: "devstral-small-2:24b",
    description: "Code search, file reads, simple edits, git operations",
  },
  fast_model: {
    modelId: "qwen3-coder-next",
    description: "Quick completions, status checks, linting, testing",
  },
  extraction_model: {
    modelId: "gemma4:31b",
    description: "Compaction and memory extraction (reserved for T-026)",
  },
};

const DEFAULT_ROUTING: Record<TaskType, ModelCategory> = {
  architect: "big_model",
  coder: "big_model",
  explorer: "small_model",
  tester: "fast_model",
  linter: "fast_model",
  git: "small_model",
  writer: "small_model",
  release: "small_model",
  scraper: "small_model",
};

// ─── Module-Level State ──────────────────────────────────────────────────────

/** Cached config — loaded once, reused on every call. Undefined = not yet loaded. */
let cachedConfig: ModelRegistryConfig | null = null;

/** Cached provider models from .opencode/opencode.json. Undefined = not yet loaded. */
let cachedProviderModels: Set<string> | null = null;

// ─── Config Loading ───────────────────────────────────────────────────────────

/**
 * Load and merge the model registry config from disk.
 *
 * Resolution order:
 * 1. If `configPath` is provided, read that file.
 * 2. Otherwise, try `packages/tui/config/default.json` (relative to CWD).
 * 3. If neither found, use hardcoded defaults.
 *
 * The config file overrides defaults — any model or routing entry present
 * in the file replaces the default. Missing entries fall back to defaults.
 */
export function loadConfig(configPath?: string): ModelRegistryConfig {
  if (cachedConfig) return cachedConfig;

  const searchPaths = configPath
    ? [configPath]
    : [
        resolve(process.cwd(), "packages/tui/config/default.json"),
        resolve(process.cwd(), "config/default.json"),
      ];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const fileConfig: ModelRegistryConfig = JSON.parse(raw);

        // Merge file config over defaults
        const merged: ModelRegistryConfig = {
          provider: fileConfig.provider ?? { name: DEFAULT_PROVIDER },
          models: {
            ...DEFAULT_MODELS,
            ...fileConfig.models,
          },
          routing: {
            ...DEFAULT_ROUTING,
            ...fileConfig.routing,
          },
        };

        cachedConfig = merged;
        return cachedConfig;
      } catch (err) {
        console.warn(`[model-registry] Failed to parse config at ${path}: ${err}`);
      }
    }
  }

  // No config file found — use defaults
  cachedConfig = {
    provider: { name: DEFAULT_PROVIDER },
    models: { ...DEFAULT_MODELS },
    routing: { ...DEFAULT_ROUTING },
  };

  return cachedConfig;
}

/**
 * Reset the cached config so the next call to loadConfig() will re-read from disk.
 * Useful for testing.
 */
export function resetConfig(): void {
  cachedConfig = null;
  cachedProviderModels = null;
}

// ─── Provider Model Validation ───────────────────────────────────────────────

/** Shape of the `.opencode/opencode.json` provider block. */
interface OpenCodeConfig {
  provider?: Record<string, {
    name?: string;
    api?: string;
    options?: {
      baseURL?: string;
      apiKey?: string;
    };
    models?: Record<string, { name?: string }>;
  }>;
}

/**
 * Read the registered model IDs from `.opencode/opencode.json`.
 *
 * Returns a Set of model ID strings (the keys of the `models` block under
 * the configured provider). If the file can't be read or parsed, returns
 * an empty Set (validation will be lenient).
 */
export function getRegisteredModels(opencodeConfigPath?: string): Set<string> {
  if (cachedProviderModels) return cachedProviderModels;

  const searchPaths = opencodeConfigPath
    ? [opencodeConfigPath]
    : [
        resolve(process.cwd(), ".opencode/opencode.json"),
        resolve(process.cwd(), "neuralgentics/.opencode/opencode.json"),
      ];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const config: OpenCodeConfig = JSON.parse(raw);

        // Find the provider that matches our configured provider name
        const configData = loadConfig();
        const providerName = configData.provider.name ?? DEFAULT_PROVIDER;

        const providerEntry = config.provider?.[providerName];
        if (providerEntry?.models && typeof providerEntry.models === "object") {
          cachedProviderModels = new Set(Object.keys(providerEntry.models));
          return cachedProviderModels;
        }

        // No models block found — lenient: return empty set
        cachedProviderModels = new Set();
        return cachedProviderModels;
      } catch (err) {
        console.warn(`[model-registry] Failed to parse opencode config at ${path}: ${err}`);
        cachedProviderModels = new Set();
        return cachedProviderModels;
      }
    }
  }

  // No opencode.json found — can't validate, return empty set
  cachedProviderModels = new Set();
  return cachedProviderModels;
}

// ─── Main API ─────────────────────────────────────────────────────────────────

/**
 * Resolve the model to use for a given task type.
 *
 * @param taskType - The type of task to route (e.g. "coder", "explorer").
 * @param overrideModelId - Optional explicit model override. If provided,
 *   the task type's routing is ignored and this model ID is used directly.
 *   The provider is always the configured provider (default: "ollama").
 * @returns A ModelResolution with provider, modelId, and category.
 *
 * @example
 * getModelForTask("coder")
 * // → { provider: "ollama", modelId: "deepseek-v4-pro", category: "big_model" }
 *
 * @example
 * getModelForTask("coder", "gemma4:31b")
 * // → { provider: "ollama", modelId: "gemma4:31b", category: "big_model" }
 *
 * @example
 * getModelForTask("nonexistent" as any)
 * // → { provider: "ollama", modelId: "deepseek-v4-pro", category: "big_model" }
 * //   (fallback to big_model with warning)
 */
export function getModelForTask(
  taskType: TaskType | string,
  overrideModelId?: string,
): ModelResolution {
  const config = loadConfig();
  const provider = config.provider.name ?? DEFAULT_PROVIDER;

  // ── Override path: explicit model ID takes precedence ──────────────────────
  if (overrideModelId) {
    return {
      provider,
      modelId: overrideModelId,
      category: "big_model", // Override doesn't change category semantics
    };
  }

  // ── Standard routing path ──────────────────────────────────────────────────
  const category = config.routing[taskType] as ModelCategory | undefined;

  if (!category) {
    // Unknown task type → fall back to big_model with warning
    console.warn(
      `[model-registry] Unknown task type "${taskType}", falling back to big_model`,
    );
    const bigModel = config.models.big_model ?? DEFAULT_MODELS.big_model;
    return {
      provider,
      modelId: bigModel.modelId,
      category: "big_model",
    };
  }

  const modelEntry = config.models[category];
  if (!modelEntry) {
    // Category exists in routing but not in models — should not happen with valid config
    console.warn(
      `[model-registry] Category "${category}" has no model entry, falling back to big_model`,
    );
    const bigModel = config.models.big_model ?? DEFAULT_MODELS.big_model;
    return {
      provider,
      modelId: bigModel.modelId,
      category: "big_model",
    };
  }

  return {
    provider,
    modelId: modelEntry.modelId,
    category,
  };
}

/**
 * Validate that all model IDs in the registry are registered in the
 * `.opencode/opencode.json` provider models list.
 *
 * @param opts - Optional paths to config and opencode files (for testing).
 *   - `configPath` — path to model-registry config (default: auto-discover)
 *   - `opencodeConfigPath` — path to .opencode/opencode.json (default: auto-discover)
 * @returns An object with:
 *   - `valid: boolean` — true if all models are registered
 *   - `missing: string[]` — model IDs not found in the provider
 *   - `registered: string[]` — all registered model IDs
 */
export function validateRegistryModels(opts?: {
  configPath?: string;
  opencodeConfigPath?: string;
}): {
  valid: boolean;
  missing: string[];
  registered: string[];
} {
  const config = loadConfig(opts?.configPath);
  const registeredModels = getRegisteredModels(opts?.opencodeConfigPath);
  const modelIds = Object.values(config.models).map((entry) => entry.modelId);

  const missing = modelIds.filter((id) => registeredModels.size > 0 && !registeredModels.has(id));

  return {
    valid: missing.length === 0 || registeredModels.size === 0,
    missing,
    registered: Array.from(registeredModels),
  };
}

/**
 * Get all available model categories and their current assignments.
 * Useful for debugging or UI display.
 */
export function getModelRegistry(): Record<ModelCategory, ModelEntry> {
  const config = loadConfig();
  return { ...config.models };
}

/**
 * Get the current task-type routing table.
 * Useful for debugging or UI display.
 */
export function getRoutingTable(): Record<string, ModelCategory> {
  const config = loadConfig();
  return { ...config.routing };
}