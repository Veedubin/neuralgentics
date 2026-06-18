/**
 * @neuralgentics/tui — Task-Scoped Model Selection (T-025) + Model Preference Persistence (T-082)
 *
 * Routes tasks to big/small/fast models based on task type, with a
 * configurable registry. Reads defaults from `config/default.json`,
 * validates against the provider models in `.opencode/opencode.json`.
 *
 * T-082 adds session model preference persistence:
 * - setActiveModel / getActiveModel for runtime model switching
 * - saveModelPref / getModelPref for persisting preference as memory
 * - restoreModelPref for restoring preference on session resume
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
        // Self-contained install: .opencode/ lives in the install prefix
        resolve(process.env.NEURALGENTICS_INSTALL_PREFIX ?? "", ".opencode/opencode.json"),
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

// ─── Model Preference Persistence (T-082) ──────────────────────────────────────

/** Shape of a persisted model preference. */
export interface ModelPref {
  /** The model ID that was active when the preference was saved. */
  modelName: string;
  /** ISO timestamp of when this preference was saved. */
  updatedAt: string;
}

/** Default model when no preference is stored (task-based routing). */
const DEFAULT_MODEL = "kimi-k2.6";

/** In-memory cache for the active model preference. Undefined = not yet resolved. */
let activeModelCache: string | undefined;

/** NeuralgenticsClient-like interface for memory persistence. */
export interface ModelPrefClient {
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Get the currently active model ID.
 *
 * Returns the cached model preference if set, or the default model
 * (kimi-k2.6) if no preference has been established.
 */
export function getActiveModel(): string {
  return activeModelCache ?? DEFAULT_MODEL;
}

/**
 * Set the active model and persist it to memory.
 *
 * Updates the in-memory cache immediately, then persists the preference
 * via the Neuralgentics client. If the client call fails, the in-memory
 * cache is still updated (graceful degradation).
 *
 * @param modelName - The model ID to set as active (e.g. "deepseek-v4-pro").
 * @param client - NeuralgenticsClient for persisting the preference.
 * @returns The model ID that was set.
 */
export async function setActiveModel(
  modelName: string,
  client: ModelPrefClient,
): Promise<string> {
  activeModelCache = modelName;

  try {
    await saveModelPref(modelName, client);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[model-registry] Failed to persist model preference: ${msg}`);
  }

  return modelName;
}

/**
 * Save the model preference as a Neuralgentics memory entry.
 *
 * Uses sourceType "session_model_pref" to distinguish from other memories.
 *
 * @param modelName - The model ID to save.
 * @param client - NeuralgenticsClient for memory storage.
 * @returns The memory ID of the saved preference.
 */
export async function saveModelPref(
  modelName: string,
  client: ModelPrefClient,
): Promise<string> {
  const pref: ModelPref = {
    modelName,
    updatedAt: new Date().toISOString(),
  };

  const result = await client.call("memory.add", {
    content: JSON.stringify(pref),
    sourceType: "session_model_pref",
    metadata: {
      type: "session_model_pref",
      modelName,
      updatedAt: pref.updatedAt,
    },
  }) as { id: string };

  console.log(`[model-registry] Model preference saved: ${modelName} (id=${result.id})`);
  return result.id;
}

/**
 * Retrieve the most recent model preference from Neuralgentics memory.
 *
 * Queries for memories with sourceType "session_model_pref" and returns
 * the most recent one. Returns null if no preference exists or if
 * the backend is unavailable.
 *
 * @param client - NeuralgenticsClient for memory retrieval.
 * @returns The model name from the most recent preference, or null.
 */
export async function getModelPref(
  client: ModelPrefClient,
): Promise<string | null> {
  try {
    const results = await client.call("memory.queryBySourceType", {
      sourceType: "session_model_pref",
      limit: 1,
      sortBy: "createdAt",
      sortOrder: "DESC",
    }) as Array<Record<string, unknown>>;

    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    const entry = results[0];
    const content = typeof entry.content === "string"
      ? entry.content
      : JSON.stringify(entry.content ?? entry);

    try {
      const parsed = JSON.parse(content) as ModelPref;
      if (typeof parsed.modelName === "string" && parsed.modelName.length > 0) {
        return parsed.modelName;
      }
    } catch {
      // Try to extract modelName from metadata if content is not valid JSON
      const metadata = entry.metadata as Record<string, unknown> | undefined;
      if (metadata && typeof metadata.modelName === "string") {
        return metadata.modelName;
      }
    }

    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[model-registry] Failed to load model preference: ${msg}`);
    return null;
  }
}

/**
 * Restore the model preference from Neuralgentics memory.
 *
 * Queries for the most recent "session_model_pref" memory and updates
 * the in-memory cache. If no preference exists, the default model
 * (kimi-k2.6) remains active.
 *
 * @param client - NeuralgenticsClient for memory retrieval.
 * @returns The restored model name, or the default if none exists.
 */
export async function restoreModelPref(
  client: ModelPrefClient,
): Promise<string> {
  const modelName = await getModelPref(client);

  if (modelName !== null) {
    activeModelCache = modelName;
    console.log(`[model-registry] Restored model preference: ${modelName}`);
    return modelName;
  }

  // No stored preference — use default (task-based routing)
  activeModelCache = DEFAULT_MODEL;
  console.log(`[model-registry] No model preference found, using default: ${DEFAULT_MODEL}`);
  return DEFAULT_MODEL;
}

/**
 * Reset the active model preference to the default.
 *
 * Clears the in-memory cache and persists a new preference with the
 * default model name. This is triggered by `/model reset`.
 *
 * @param client - NeuralgenticsClient for memory persistence.
 * @returns The default model name.
 */
export async function resetModelPref(
  client: ModelPrefClient,
): Promise<string> {
  return setActiveModel(DEFAULT_MODEL, client);
}

/**
 * Validate that a model name exists in the provider registry.
 *
 * @param modelName - The model ID to validate.
 * @param opencodeConfigPath - Optional path to the opencode config.
 * @returns True if the model is registered, false otherwise.
 */
export function isValidModelName(modelName: string, opencodeConfigPath?: string): boolean {
  const registered = getRegisteredModels(opencodeConfigPath);
  // If we couldn't load the registry, be lenient (accept any name)
  if (registered.size === 0) return true;
  return registered.has(modelName);
}

/**
 * Get a list of all available model names from the registry.
 *
 * Useful for the `/model` command to display available models.
 *
 * @returns An array of model ID strings.
 */
export function getAvailableModels(): string[] {
  const registered = getRegisteredModels();
  if (registered.size > 0) {
    return Array.from(registered).sort();
  }
  // Fallback: return models from the config
  const config = loadConfig();
  return Object.values(config.models).map((entry) => entry.modelId);
}

/**
 * Reset the active model cache (for testing only).
 */
export function resetActiveModelCache(): void {
  activeModelCache = undefined;
}