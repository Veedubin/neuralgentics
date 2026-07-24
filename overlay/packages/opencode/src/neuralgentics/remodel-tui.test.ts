/**
 * Tests for the remodel-tui module.
 *
 * Covers the pure logic pieces that don't require a TTY:
 *   - buildRoleAlternatives: excludes recommended, filters enabled providers,
 *     skips null models, sorts by score/rank/name.
 *   - buildFullModelList: dedup across providers + roles, skips nulls, sorts.
 *   - describeReason: formats benchmark + rank + provider.
 *   - shouldRunNonInteractive: --yes, non-TTY, CI env.
 *   - resolveAssignment: recommended passthrough, alt model, custom model.
 *   - renderSummaryLine: alignment + source label.
 *   - Non-interactive end-to-end path with mocked stdout.
 *
 * Uses bun:test — pure unit tests, no TTY.
 */

import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildRoleAlternatives,
  buildFullModelList,
  describeReason,
  shouldRunNonInteractive,
  resolveAssignment,
  renderSummaryLine,
  runInteractiveRemodel,
  ESCAPE_HATCH_VALUE,
  type RoleAlternative,
} from "./remodel-tui.js";
import {
  pickModels,
  AGENT_ROLES,
  FALLBACK_PRESETS,
  type PresetsData,
  type RankingEntry,
} from "./model-picker.js";
import type { NeuralgenticsConfig } from "./config.js";

function makeConfig(
  providers: Record<string, { enabled: boolean; apiKeyEnv?: string }>,
  overrides: Record<string, { model?: string; provider?: string }> = {},
): NeuralgenticsConfig {
  return { version: "1.0.0", providers, overrides };
}

/**
 * Helper that builds a `RankingEntry` while tolerating `null` models
 * (presets.json ships null entries for providers lacking a role's model).
 * The declared interface types `model` as `string`, so we cast the null case.
 */
function entry(
  model: string | null,
  score: number,
  benchmark: string,
  rank: number,
): RankingEntry {
  return { model: model as string, score, benchmark, rank };
}

const OLLAMA_ONLY = makeConfig({
  ollama: { enabled: true, apiKeyEnv: "OLLAMA_API_KEY" },
});

describe("describeReason", () => {
  it("includes the benchmark, rank, provider, and score when score > 0", () => {
    const e = entry("kimi-k2.6", 0.85, "bfcl", 1);
    expect(describeReason(e, "ollama")).toBe("#1 on bfcl (ollama, score 0.85)");
  });

  it("uses the fallback wording when score is 0", () => {
    const e = entry("glm-5.2", 0.0, "swe_bench", 0);
    expect(describeReason(e, "ollama")).toBe("swe_bench fallback (ollama)");
  });
});

describe("buildRoleAlternatives", () => {
  it("excludes the recommended model from the alternative list", () => {
    const presets: PresetsData = {
      rankings: {
        ollama: {
          coder: entry("glm-5.2", 0.7, "swe_bench", 2),
        },
        openrouter: {
          coder: entry("o4-mini", 0.9, "swe_bench", 1),
        },
      },
    };
    const cfg = makeConfig({
      ollama: { enabled: true },
      openrouter: { enabled: true, apiKeyEnv: "X" },
    });
    const picks = pickModels(cfg, presets, false);
    const rec = picks.find((a) => a.role === "coder")!;
    // openrouter/o4-mini (0.9) is the recommendation; ollama/glm-5.2 is the alt.
    expect(rec.model).toBe("openrouter/o4-mini");
    const alts = buildRoleAlternatives("coder", rec, cfg, presets);
    expect(alts).toHaveLength(1);
    expect(alts[0].model).toBe("ollama/glm-5.2");
  });

  it("only includes models from enabled providers", () => {
    const presets: PresetsData = {
      rankings: {
        ollama: { coder: entry("glm-5.2", 0.7, "swe_bench", 2) },
        openrouter: { coder: entry("o4-mini", 0.9, "swe_bench", 1) },
      },
    };
    // openrouter disabled → only ollama models should appear (and the
    // recommended is the only ollama entry, so alternatives is empty).
    const cfg = makeConfig({ ollama: { enabled: true } });
    const picks = pickModels(cfg, presets, false);
    const rec = picks.find((a) => a.role === "coder")!;
    const alts = buildRoleAlternatives("coder", rec, cfg, presets);
    expect(alts).toHaveLength(0);
  });

  it("skips ranking entries with a null model", () => {
    const presets: PresetsData = {
      rankings: {
        ollama: { coder: entry("glm-5.2", 0.7, "swe_bench", 2) },
        openrouter: { coder: entry(null, 0.0, "swe_bench", 0) },
      },
    };
    const cfg = makeConfig({
      ollama: { enabled: true },
      openrouter: { enabled: true, apiKeyEnv: "X" },
    });
    const picks = pickModels(cfg, presets, false);
    const rec = picks.find((a) => a.role === "coder")!;
    const alts = buildRoleAlternatives("coder", rec, cfg, presets);
    expect(alts).toHaveLength(0);
  });

  it("sorts alternatives by score desc, then provider, then model", () => {
    const presets: PresetsData = {
      rankings: {
        ollama: { coder: entry("glm-5.2", 0.7, "swe_bench", 2) },
        aaa: { coder: entry("low", 0.5, "swe_bench", 5) },
        bbb: { coder: entry("high", 0.95, "swe_bench", 1) },
        zzz: { coder: entry("high2", 0.95, "swe_bench", 2) },
      },
    };
    const cfg = makeConfig({
      ollama: { enabled: true },
      aaa: { enabled: true },
      bbb: { enabled: true },
      zzz: { enabled: true },
    });
    const picks = pickModels(cfg, presets, false);
    const rec = picks.find((a) => a.role === "coder")!; // bbb/high (0.95)
    const alts = buildRoleAlternatives("coder", rec, cfg, presets);
    expect(alts.map((a) => a.model)).toEqual([
      "zzz/high2", // 0.95, provider zzz
      "ollama/glm-5.2", // 0.7
      "aaa/low", // 0.5
    ]);
  });
});

describe("buildFullModelList", () => {
  it("deduplicates models that appear under multiple roles", () => {
    const presets: PresetsData = {
      rankings: {
        ollama: {
          coder: entry("glm-5.2", 0.7, "swe_bench", 2),
          "agent-builder": entry("glm-5.2", 0.7, "swe_bench", 2),
          architect: entry("deepseek-v4-pro", 0.72, "swe_bench", 1),
        },
      },
    };
    const cfg = makeConfig({ ollama: { enabled: true } });
    const full = buildFullModelList(cfg, presets);
    const models = full.map((a) => a.model);
    expect(models).toContain("ollama/glm-5.2");
    expect(models).toContain("ollama/deepseek-v4-pro");
    // glm-5.2 appears under 2 roles but is deduplicated.
    expect(models.filter((m) => m === "ollama/glm-5.2")).toHaveLength(1);
  });

  it("only includes enabled providers", () => {
    const presets: PresetsData = {
      rankings: {
        ollama: { coder: entry("glm-5.2", 0.7, "swe_bench", 2) },
        openrouter: { coder: entry("o4-mini", 0.9, "swe_bench", 1) },
      },
    };
    const cfg = makeConfig({ ollama: { enabled: true } }); // openrouter disabled
    const full = buildFullModelList(cfg, presets);
    expect(full.map((a) => a.model)).toEqual(["ollama/glm-5.2"]);
  });

  it("skips null-model entries", () => {
    const presets: PresetsData = {
      rankings: {
        ollama: {
          coder: entry("glm-5.2", 0.7, "swe_bench", 2),
          writer: entry(null, 0.0, "chatbot_arena", 0),
        },
      },
    };
    const cfg = makeConfig({ ollama: { enabled: true } });
    const full = buildFullModelList(cfg, presets);
    expect(full).toHaveLength(1);
    expect(full[0].model).toBe("ollama/glm-5.2");
  });

  it("returns an empty list when no enabled provider has rankings", () => {
    const presets: PresetsData = { rankings: {} };
    const cfg = makeConfig({ ollama: { enabled: true } });
    expect(buildFullModelList(cfg, presets)).toHaveLength(0);
  });
});

describe("shouldRunNonInteractive", () => {
  it("returns true when yes is set", () => {
    expect(shouldRunNonInteractive({ yes: true, stdout: { isTTY: true } })).toBe(true);
  });

  it("returns true when stdout is not a TTY", () => {
    expect(shouldRunNonInteractive({ yes: false, stdout: { isTTY: false } })).toBe(true);
  });

  it("returns false when yes is unset and stdout is a TTY and no CI env", () => {
    const savedCI = process.env["CI"];
    const savedGHA = process.env["GITHUB_ACTIONS"];
    delete process.env["CI"];
    delete process.env["GITHUB_ACTIONS"];
    try {
      expect(shouldRunNonInteractive({ yes: false, stdout: { isTTY: true } })).toBe(false);
    } finally {
      if (savedCI !== undefined) process.env["CI"] = savedCI;
      if (savedGHA !== undefined) process.env["GITHUB_ACTIONS"] = savedGHA;
    }
  });

  it("returns true when CI env is set", () => {
    const saved = process.env["CI"];
    process.env["CI"] = "true";
    try {
      expect(shouldRunNonInteractive({ yes: false, stdout: { isTTY: true } })).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["CI"];
      else process.env["CI"] = saved;
    }
  });
});

describe("resolveAssignment", () => {
  const rec: ReturnType<typeof pickModels>[number] = {
    role: "coder",
    model: "ollama/glm-5.2",
    provider: "ollama",
    benchmark: "swe_bench",
    score: 0.7,
    overridden: false,
  };

  it("returns the recommended assignment unchanged when the choice matches", () => {
    const out = resolveAssignment("coder", rec, "ollama/glm-5.2");
    expect(out).toEqual(rec);
  });

  it("builds an override assignment for a chosen alternative", () => {
    const out = resolveAssignment("coder", rec, "openrouter/o4-mini");
    expect(out.model).toBe("openrouter/o4-mini");
    expect(out.provider).toBe("openrouter");
    expect(out.overridden).toBe(true);
    expect(out.score).toBe(0);
    expect(out.benchmark).toBe("");
  });

  it("falls back to the recommended provider when the chosen model has no slash", () => {
    const out = resolveAssignment("coder", rec, "custom-model");
    expect(out.model).toBe("custom-model");
    expect(out.provider).toBe("ollama");
  });
});

describe("renderSummaryLine", () => {
  it("includes the role, model, and source label", () => {
    const a = {
      role: "coder",
      model: "ollama/glm-5.2",
      provider: "ollama",
      benchmark: "swe_bench",
      score: 0.7,
      overridden: false,
    };
    const line = renderSummaryLine(a);
    expect(line).toContain("coder");
    expect(line).toContain("ollama/glm-5.2");
    expect(line).toContain("ollama"); // source = provider
  });

  it("uses 'override' as the source when overridden", () => {
    const a = {
      role: "coder",
      model: "openrouter/o4-mini",
      provider: "openrouter",
      benchmark: "",
      score: 0,
      overridden: true,
    };
    const line = renderSummaryLine(a);
    expect(line).toContain("override");
  });
});

describe("runInteractiveRemodel (non-interactive path)", () => {
  let tmpDir: string;
  let writeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodel-tui-test-"));
    writeSpy = spyOn(process.stdout, "write");
    writeSpy.mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs non-interactively with --yes and returns the recommended picks", async () => {
    const cfg = OLLAMA_ONLY;
    const presets = FALLBACK_PRESETS;
    const picks = await runInteractiveRemodel({
      configDir: tmpDir,
      yes: true,
      dryRun: true,
      config: cfg,
      presets,
    });
    expect(picks).toHaveLength(AGENT_ROLES.length);
    for (const a of picks) {
      expect(a.provider).toBe("ollama");
      expect(a.model.startsWith("ollama/")).toBe(true);
    }
    // A default config is created in dry-run (no file write), but the TUI
    // non-interactive path writes a plain-text summary to stdout.
    expect(writeSpy).toHaveBeenCalled();
  });

  it("prints an enabled-providers line in non-interactive output", async () => {
    const cfg = makeConfig({
      ollama: { enabled: true, apiKeyEnv: "OLLAMA_API_KEY" },
      openrouter: { enabled: true, apiKeyEnv: "OPENROUTER_API_KEY" },
    });
    const presets = FALLBACK_PRESETS;
    writeSpy.mockRestore(); // capture the actual writes below
    const chunks: string[] = [];
    const captureSpy = spyOn(process.stdout, "write");
    captureSpy.mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    try {
      await runInteractiveRemodel({
        configDir: tmpDir,
        yes: true,
        dryRun: true,
        config: cfg,
        presets,
      });
    } finally {
      captureSpy.mockRestore();
    }
    const out = chunks.join("");
    expect(out).toContain("Enabled providers: ollama, openrouter");
    expect(out).toContain("Applying recommended models");
  });
});

describe("ESCAPE_HATCH_VALUE", () => {
  it("is a non-model sentinel string", () => {
    expect(typeof ESCAPE_HATCH_VALUE).toBe("string");
    expect(ESCAPE_HATCH_VALUE.includes("/")).toBe(false);
  });
});