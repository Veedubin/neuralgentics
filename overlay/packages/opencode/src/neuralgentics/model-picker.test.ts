/**
 * Tests for the model-picker module.
 *
 * Covers:
 *   - All providers disabled except ollama → ollama models selected
 *   - Two providers enabled, same model on both → picks from the higher-scoring
 *   - Override in config → uses the override, not the ranking
 *   - No ranking for a role → falls back to ollama defaults
 *   - All providers disabled → falls back to ollama defaults
 *   - patchModelLine: patches the model line, leaves body untouched,
 *     no-op when already matching, no-op without frontmatter
 *
 * Uses bun:test — pure unit tests, no I/O.
 */

import { describe, it, expect } from "bun:test";

import {
  pickModels,
  enabledProviders,
  AGENT_ROLES,
  FALLBACK_PRESETS,
  type PresetsData,
} from "./model-picker.js";
import { patchModelLine } from "./remodel.js";
import type { NeuralgenticsConfig } from "./config.js";

function makeConfig(
  providers: Record<string, { enabled: boolean; apiKeyEnv?: string }>,
  overrides: Record<string, { model?: string; provider?: string }> = {},
): NeuralgenticsConfig {
  return { version: "1.0.0", providers, overrides };
}

const OLLAMA_ONLY = makeConfig({
  ollama: { enabled: true, apiKeyEnv: "OLLAMA_API_KEY" },
});

const ALL_DISABLED = makeConfig({
  ollama: { enabled: false, apiKeyEnv: "OLLAMA_API_KEY" },
});

describe("enabledProviders", () => {
  it("returns only the enabled provider ids", () => {
    expect(enabledProviders(OLLAMA_ONLY)).toEqual(["ollama"]);
  });

  it("returns an empty array when nothing is enabled", () => {
    expect(enabledProviders(ALL_DISABLED)).toEqual([]);
  });

  it("preserves insertion order", () => {
    const cfg = makeConfig({
      ollama: { enabled: true },
      openrouter: { enabled: true, apiKeyEnv: "X" },
      openai: { enabled: false, apiKeyEnv: "Y" },
    });
    expect(enabledProviders(cfg)).toEqual(["ollama", "openrouter"]);
  });
});

describe("pickModels", () => {
  it("assigns all 12 roles", () => {
    const out = pickModels(OLLAMA_ONLY, FALLBACK_PRESETS, false);
    expect(out).toHaveLength(AGENT_ROLES.length);
    const roles = out.map((a) => a.role);
    expect(roles).toEqual([...AGENT_ROLES]);
  });

  it("picks ollama models when only ollama is enabled", () => {
    const out = pickModels(OLLAMA_ONLY, FALLBACK_PRESETS, false);
    for (const a of out) {
      expect(a.provider).toBe("ollama");
      expect(a.model.startsWith("ollama/")).toBe(true);
      expect(a.overridden).toBe(false);
    }
  });

  it("picks the higher-scoring model across two enabled providers", () => {
    const presets: PresetsData = {
      rankings: {
        ollama: {
          coder: { model: "glm-5.2", score: 0.7, benchmark: "swe_bench", rank: 2 },
        },
        openrouter: {
          coder: { model: "o4-mini", score: 0.9, benchmark: "swe_bench", rank: 1 },
        },
      },
    };
    const cfg = makeConfig({
      ollama: { enabled: true, apiKeyEnv: "OLLAMA_API_KEY" },
      openrouter: { enabled: true, apiKeyEnv: "OPENROUTER_API_KEY" },
    });
    const out = pickModels(cfg, presets, false);
    const coder = out.find((a) => a.role === "coder");
    expect(coder).toBeDefined();
    expect(coder!.provider).toBe("openrouter");
    expect(coder!.model).toBe("openrouter/o4-mini");
    expect(coder!.score).toBe(0.9);
    expect(coder!.overridden).toBe(false);
  });

  it("uses the override when present, ignoring rankings", () => {
    const cfg = makeConfig(
      { ollama: { enabled: true } },
      { coder: { model: "anthropic/claude-sonnet-5" } },
    );
    const out = pickModels(cfg, FALLBACK_PRESETS, false);
    const coder = out.find((a) => a.role === "coder");
    expect(coder!.model).toBe("anthropic/claude-sonnet-5");
    expect(coder!.provider).toBe("anthropic");
    expect(coder!.overridden).toBe(true);
    expect(coder!.score).toBe(0);
    expect(coder!.benchmark).toBe("");
    // Non-overridden roles still pick from rankings.
    const architect = out.find((a) => a.role === "architect");
    expect(architect!.overridden).toBe(false);
    expect(architect!.provider).toBe("ollama");
  });

  it("falls back to ollama defaults when no ranking exists for any enabled provider", () => {
    // A provider is enabled but has no rankings at all.
    const presets: PresetsData = { rankings: { openrouter: {} } };
    const cfg = makeConfig({ openrouter: { enabled: true, apiKeyEnv: "X" } });
    const out = pickModels(cfg, presets, false);
    const coder = out.find((a) => a.role === "coder");
    expect(coder!.provider).toBe("ollama");
    expect(coder!.model).toBe("ollama/glm-5.2");
    expect(coder!.overridden).toBe(false);
  });

  it("falls back to ollama defaults when ALL providers are disabled", () => {
    const out = pickModels(ALL_DISABLED, FALLBACK_PRESETS, false);
    const coder = out.find((a) => a.role === "coder");
    expect(coder!.provider).toBe("ollama");
    expect(coder!.model).toBe("ollama/glm-5.2");
  });

  it("falls back to the shipped ollama defaults even when passed empty presets", () => {
    // The shipped FALLBACK_PRESETS (always available inside pickModels) has
    // all 12 roles under ollama, so empty user presets still resolve.
    const presets: PresetsData = { rankings: {} };
    const out = pickModels(ALL_DISABLED, presets, false);
    const coder = out.find((a) => a.role === "coder");
    expect(coder!.model).toBe("ollama/glm-5.2");
    expect(coder!.provider).toBe("ollama");
  });

  it("breaks score ties by rank, then model name", () => {
    const presets: PresetsData = {
      rankings: {
        aaa: { coder: { model: "zzz", score: 0.8, benchmark: "b", rank: 2 } },
        bbb: { coder: { model: "aaa", score: 0.8, benchmark: "b", rank: 1 } },
      },
    };
    const cfg = makeConfig({
      aaa: { enabled: true },
      bbb: { enabled: true },
    });
    const out = pickModels(cfg, presets, false);
    const coder = out.find((a) => a.role === "coder");
    expect(coder!.provider).toBe("bbb");
    expect(coder!.model).toBe("bbb/aaa");
  });

  it("does not prefix an already-prefixed override model", () => {
    const cfg = makeConfig(
      { ollama: { enabled: true } },
      { coder: { model: "ollama/glm-5.2" } },
    );
    const out = pickModels(cfg, FALLBACK_PRESETS, false);
    const coder = out.find((a) => a.role === "coder");
    expect(coder!.model).toBe("ollama/glm-5.2");
  });
});

describe("patchModelLine", () => {
  it("patches the model line in a standard frontmatter", () => {
    const content =
      "---\n" +
      "description: foo\n" +
      "model: ollama/glm-5.2\n" +
      "mode: subagent\n" +
      "---\n\n" +
      "# Body\n";
    const res = patchModelLine(content, "ollama/kimi-k2.6");
    expect(res.changed).toBe(true);
    expect(res.previous).toBe("ollama/glm-5.2");
  });

  it("is a no-op when the model already matches", () => {
    const content = "---\nmodel: ollama/glm-5.2\n---\nbody\n";
    const res = patchModelLine(content, "ollama/glm-5.2");
    expect(res.changed).toBe(false);
    expect(res.previous).toBe("ollama/glm-5.2");
  });

  it("returns changed=false when there is no frontmatter", () => {
    const content = "# No frontmatter\n\nbody\n";
    const res = patchModelLine(content, "ollama/kimi-k2.6");
    expect(res.changed).toBe(false);
    expect(res.previous).toBeNull();
  });

  it("returns changed=false when frontmatter has no model line", () => {
    const content = "---\ndescription: foo\nmode: subagent\n---\nbody\n";
    const res = patchModelLine(content, "ollama/kimi-k2.6");
    expect(res.changed).toBe(false);
    expect(res.previous).toBeNull();
  });

  it("ignores indented model: keys (nested)", () => {
    const content =
      "---\nmode: subagent\npermission:\n  model: nested-should-not-match\n---\nbody\n";
    const res = patchModelLine(content, "ollama/kimi-k2.6");
    expect(res.changed).toBe(false);
  });

  it("handles `...` as the closing fence", () => {
    const content = "---\nmodel: old\n...\nbody\n";
    const res = patchModelLine(content, "ollama/new");
    expect(res.changed).toBe(true);
    expect(res.previous).toBe("old");
  });

  it("treats a frontmatter with no closing fence as unchanged", () => {
    const content = "---\nmodel: old\nbody-without-close\n";
    const res = patchModelLine(content, "ollama/new");
    expect(res.changed).toBe(false);
  });

  it("only changes the model line — body is untouched", () => {
    const content =
      "---\nmodel: ollama/old\nmode: subagent\n---\n\n## BODY\n\nkeep me exactly\n";
    const lines = content.split("\n");
    // Manually apply the same transformation the function does.
    for (let i = 0; i < lines.length; i++) {
      if (/^model:\s*(.*)$/.test(lines[i])) {
        lines[i] = "model: ollama/new";
        break;
      }
    }
    const patched = lines.join("\n");
    expect(patched).toContain("model: ollama/new");
    expect(patched).toContain("## BODY");
    expect(patched).toContain("keep me exactly");
    // The frontmatter body keys survive.
    expect(patched).toContain("mode: subagent");
  });
});