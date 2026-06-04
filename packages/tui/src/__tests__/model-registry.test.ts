/**
 * @neuralgentics/tui — Model Registry Tests (T-025)
 *
 * Tests for task-scoped model selection with configurable registry.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getModelForTask,
  loadConfig,
  resetConfig,
  getRegisteredModels,
  validateRegistryModels,
  getModelRegistry,
  getRoutingTable,
  type TaskType,
  type ModelResolution,
  type ModelCategory,
} from "../agents/model-registry.js";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Temporary directory for test config files. */
const TEST_DIR = join(import.meta.dir, "__test_config__");
const TEST_CONFIG_PATH = join(TEST_DIR, "default.json");
const TEST_OPENCODE_PATH = join(TEST_DIR, "opencode.json");

/** Clean up and reset module state between tests. */
function setupTestEnv(): void {
  resetConfig();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }
}

function teardownTestEnv(): void {
  resetConfig();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/** Write a test config file to disk. */
function writeTestConfig(config: Record<string, unknown>): void {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Write a test opencode.json to disk. */
function writeTestOpencodeConfig(models: Record<string, { name: string }>): void {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TEST_OPENCODE_PATH, JSON.stringify({
    provider: {
      ollama: {
        name: "Ollama Cloud",
        api: "openai",
        options: { baseURL: "https://ollama.com/v1" },
        models,
      },
    },
  }, null, 2));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("model-registry: getModelForTask", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  // ── Acceptance Criteria 1: architect → big_model ──────────────────────────
  test("architect tasks route to big_model (deepseek-v4-pro)", () => {
    const result = getModelForTask("architect");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("deepseek-v4-pro");
    expect(result.category).toBe("big_model");
  });

  // ── Acceptance Criteria 2: coder → big_model ──────────────────────────────
  test("coder tasks route to big_model (deepseek-v4-pro)", () => {
    const result = getModelForTask("coder");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("deepseek-v4-pro");
    expect(result.category).toBe("big_model");
  });

  // ── Acceptance Criteria 3: explorer → small_model ─────────────────────────
  test("explorer tasks route to small_model (devstral-small-2:24b)", () => {
    const result = getModelForTask("explorer");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("devstral-small-2:24b");
    expect(result.category).toBe("small_model");
  });

  // ── Acceptance Criteria 4: tester → fast_model ────────────────────────────
  test("tester tasks route to fast_model (qwen3-coder-next)", () => {
    const result = getModelForTask("tester");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("qwen3-coder-next");
    expect(result.category).toBe("fast_model");
  });

  // ── Acceptance Criteria 5: linter → fast_model ────────────────────────────
  test("linter tasks route to fast_model (qwen3-coder-next)", () => {
    const result = getModelForTask("linter");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("qwen3-coder-next");
    expect(result.category).toBe("fast_model");
  });

  // ── git, writer, release, scraper → small_model ───────────────────────────
  test("git tasks route to small_model (devstral-small-2:24b)", () => {
    const result = getModelForTask("git");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("devstral-small-2:24b");
    expect(result.category).toBe("small_model");
  });

  test("writer tasks route to small_model (devstral-small-2:24b)", () => {
    const result = getModelForTask("writer");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("devstral-small-2:24b");
    expect(result.category).toBe("small_model");
  });

  test("release tasks route to small_model (devstral-small-2:24b)", () => {
    const result = getModelForTask("release");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("devstral-small-2:24b");
    expect(result.category).toBe("small_model");
  });

  test("scraper tasks route to small_model (devstral-small-2:24b)", () => {
    const result = getModelForTask("scraper");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("devstral-small-2:24b");
    expect(result.category).toBe("small_model");
  });

  // ── Acceptance Criteria 6: fallback for unknown task type ──────────────────
  test("unknown task type falls back to big_model with warning", () => {
    const result = getModelForTask("nonexistent" as TaskType);
    // Should NOT throw — should return big_model
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("deepseek-v4-pro");
    expect(result.category).toBe("big_model");
  });

  // ── Acceptance Criteria 7: explicit override ─────────────────────────────
  test("explicit model override takes precedence over routing", () => {
    const result = getModelForTask("coder", "gemma4:31b");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("gemma4:31b");
    // Override always returns big_model category (no reclassification)
    expect(result.category).toBe("big_model");
  });

  // ── Explicit override with different task type ────────────────────────────
  test("override works regardless of task type", () => {
    const explorerOverride = getModelForTask("explorer", "deepseek-v4-pro");
    expect(explorerOverride.modelId).toBe("deepseek-v4-pro");
    expect(explorerOverride.provider).toBe("ollama");

    const testerOverride = getModelForTask("tester", "devstral-small-2:24b");
    expect(testerOverride.modelId).toBe("devstral-small-2:24b");
    expect(testerOverride.provider).toBe("ollama");
  });

  // ── All task types produce ModelResolution objects ─────────────────────────
  test("all 9 task types produce valid ModelResolution objects", () => {
    const taskTypes: TaskType[] = [
      "architect", "coder", "explorer", "tester", "linter",
      "git", "writer", "release", "scraper",
    ];

    for (const tt of taskTypes) {
      const result = getModelForTask(tt);
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("modelId");
      expect(result).toHaveProperty("category");
      expect(result.provider).toBe("ollama");
      expect(result.modelId.length).toBeGreaterThan(0);
      expect(result.category.length).toBeGreaterThan(0);
    }
  });
});

describe("model-registry: loadConfig", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("loads default config when no config file exists", () => {
    resetConfig();
    const config = loadConfig("/nonexistent/path/config.json");
    expect(config.provider.name).toBe("ollama");
    expect(config.models.big_model.modelId).toBe("deepseek-v4-pro");
    expect(config.models.small_model.modelId).toBe("devstral-small-2:24b");
    expect(config.models.fast_model.modelId).toBe("qwen3-coder-next");
    expect(config.routing.architect).toBe("big_model");
    expect(config.routing.coder).toBe("big_model");
  });

  test("loads config from disk and merges with defaults", () => {
    // Override only the fast_model's modelId
    writeTestConfig({
      provider: { name: "ollama" },
      models: {
        fast_model: {
          modelId: "custom-fast-model",
          description: "Custom fast model",
        },
      },
      routing: {
        tester: "big_model", // Override tester to use big_model
      },
    });

    resetConfig();
    const config = loadConfig(TEST_CONFIG_PATH);

    // Overridden values
    expect(config.models.fast_model.modelId).toBe("custom-fast-model");
    expect(config.routing.tester).toBe("big_model");

    // Defaults preserved for non-overridden entries
    expect(config.models.big_model.modelId).toBe("deepseek-v4-pro");
    expect(config.models.small_model.modelId).toBe("devstral-small-2:24b");
    expect(config.routing.architect).toBe("big_model");
  });

  test("caches config after first load", () => {
    resetConfig();
    const config1 = loadConfig("/nonexistent/path");
    const config2 = loadConfig("/nonexistent/path");
    // Same reference due to caching
    expect(config1).toBe(config2);
  });

  test("resetConfig clears cache allowing re-read", () => {
    resetConfig();
    const config1 = loadConfig("/nonexistent/path");

    resetConfig();
    const config2 = loadConfig("/nonexistent/path");

    // Different references after reset
    expect(config1).not.toBe(config2);
    // But same values
    expect(config1.models.big_model.modelId).toBe(config2.models.big_model.modelId);
  });
});

describe("model-registry: getRegisteredModels", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("returns empty set when no opencode.json found", () => {
    resetConfig();
    const models = getRegisteredModels("/nonexistent/path/opencode.json");
    expect(models.size).toBe(0);
  });

  test("reads model IDs from opencode.json provider block", () => {
    writeTestOpencodeConfig({
      "deepseek-v4-pro": { name: "DeepSeek V4 Pro (Cloud)" },
      "devstral-small-2:24b": { name: "Devstral Small 2 24B (Cloud)" },
      "qwen3-coder-next": { name: "Qwen3 Coder Next (Cloud)" },
      "gemma4:31b": { name: "Gemma 4 31B (Cloud)" },
    });

    resetConfig();
    const models = getRegisteredModels(TEST_OPENCODE_PATH);

    expect(models.has("deepseek-v4-pro")).toBe(true);
    expect(models.has("devstral-small-2:24b")).toBe(true);
    expect(models.has("qwen3-coder-next")).toBe(true);
    expect(models.has("gemma4:31b")).toBe(true);
    expect(models.size).toBe(4);
  });

  test("caches provider models after first read", () => {
    writeTestOpencodeConfig({
      "test-model": { name: "Test" },
    });

    resetConfig();
    const models1 = getRegisteredModels(TEST_OPENCODE_PATH);
    const models2 = getRegisteredModels(TEST_OPENCODE_PATH);
    // Same reference due to caching
    expect(models1).toBe(models2);
  });
});

describe("model-registry: validateRegistryModels", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("validates that registry models are in opencode.json", () => {
    writeTestOpencodeConfig({
      "deepseek-v4-pro": { name: "DeepSeek V4 Pro (Cloud)" },
      "devstral-small-2:24b": { name: "Devstral Small 2 24B (Cloud)" },
      "qwen3-coder-next": { name: "Qwen3 Coder Next (Cloud)" },
      "gemma4:31b": { name: "Gemma 4 31B (Cloud)" },
    });

    resetConfig();

    const result = validateRegistryModels({
      configPath: "/nonexistent/path",
      opencodeConfigPath: TEST_OPENCODE_PATH,
    });

    // All 4 registry models should be found
    expect(result.missing).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("reports missing models when not in opencode.json", () => {
    writeTestOpencodeConfig({
      "deepseek-v4-pro": { name: "DeepSeek V4 Pro (Cloud)" },
      // Missing: devstral-small-2:24b, qwen3-coder-next, gemma4:31b
    });

    resetConfig();

    const result = validateRegistryModels({
      configPath: "/nonexistent/path",
      opencodeConfigPath: TEST_OPENCODE_PATH,
    });

    expect(result.valid).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.missing).toContain("devstral-small-2:24b");
    expect(result.missing).toContain("qwen3-coder-next");
  });

  test("returns valid=true when opencode.json is missing (lenient)", () => {
    resetConfig();

    const result = validateRegistryModels({
      configPath: "/nonexistent/path",
      opencodeConfigPath: "/nonexistent/path/opencode.json",
    });

    // When no opencode.json exists, we can't validate — treat as valid
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

describe("model-registry: getModelRegistry and getRoutingTable", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("getModelRegistry returns all model categories", () => {
    resetConfig();
    const registry = getModelRegistry();

    expect(registry.big_model).toBeDefined();
    expect(registry.big_model.modelId).toBe("deepseek-v4-pro");
    expect(registry.small_model).toBeDefined();
    expect(registry.small_model.modelId).toBe("devstral-small-2:24b");
    expect(registry.fast_model).toBeDefined();
    expect(registry.fast_model.modelId).toBe("qwen3-coder-next");
    expect(registry.extraction_model).toBeDefined();
    expect(registry.extraction_model.modelId).toBe("gemma4:31b");
  });

  test("getRoutingTable returns all task-type mappings", () => {
    resetConfig();
    const routing = getRoutingTable();

    const expectedRouting: Record<string, ModelCategory> = {
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

    for (const [taskType, category] of Object.entries(expectedRouting)) {
      expect(routing[taskType]).toBe(category);
    }
  });
});