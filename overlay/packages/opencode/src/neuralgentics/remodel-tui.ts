/**
 * Interactive TUI layer for `neuralgentics --remodel`.
 *
 * Wraps the non-interactive core in `remodel.ts` with a `@clack/prompts`-driven
 * flow. The TUI is a thin presentation layer — all decision logic lives in
 * pure functions exported below (so they can be unit-tested without a TTY).
 *
 * Flow:
 *   1. intro()
 *   2. Accept-all gate (confirm). If Yes → apply picks, summary, outro.
 *   3. Per-role loop (12 roles): show recommended, confirm; if No, present
 *      next-ranked alternatives from the user's ENABLED providers, with a
 *      final "I don't see my model" escape hatch into a full-model select.
 *   4. Summary + confirm "Apply these models?". If Yes → patch (via the
 *      existing `remodel.ts` patcher). If No → cancel.
 *   5. Non-interactive fallback: `--yes` or non-TTY / CI → skip all prompts,
 *      apply recommendations, print a plain-text summary.
 */

import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";

import * as clack from "@clack/prompts";
import type {
  NeuralgenticsConfig,
  ProviderConfig,
} from "./config.js";
import {
  loadConfig,
  saveConfig,
  createDefaultConfig,
  getConfigPath,
} from "./config.js";
import {
  pickModels,
  enabledProviders,
  AGENT_ROLES,
  FALLBACK_PRESETS,
  type PresetsData,
  type RankingEntry,
  type AgentAssignment,
} from "./model-picker.js";

/** One selectable alternative for the per-role `select()` prompt. */
export interface RoleAlternative {
  /** Full "provider/model" id. */
  model: string;
  /** Provider id. */
  provider: string;
  /** Human-readable reason shown as the `hint`. */
  reason: string;
  /** Benchmark score (0–1), for sorting. */
  score: number;
}

/** Options for {@link runInteractiveRemodel}. */
export interface RemodelTuiOptions {
  /** Absolute path to the `.opencode/` config directory. */
  configDir: string;
  /** Skip all prompts and apply recommendations (also auto-detected for non-TTY/CI). */
  yes?: boolean;
  /** Dry-run: no files written, no backups made. */
  dryRun?: boolean;
  /** Pre-loaded presets (defaults to loading from configDir/presets.json). */
  presets?: PresetsData;
  /** Pre-loaded config (defaults to loading from configDir). */
  config?: NeuralgenticsConfig;
}

/** Sentinel value returned by the role-select escape hatch. */
export const ESCAPE_HATCH_VALUE = "__custom__";

const PRESETS_FILENAME = "presets.json";

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested without a TTY)                            */
/* ------------------------------------------------------------------ */

/**
 * Build the ranked list of alternative models for a role, drawn from the
 * user's ENABLED providers only. The recommended pick is excluded (it is
 * shown separately). Entries are sorted by score desc, rank asc, model
 * name asc — the same ordering the picker uses.
 *
 * Null-model entries (rankings with `model: null`, present in presets.json
 * for providers that have no model for a role) are skipped.
 */
export function buildRoleAlternatives(
  role: string,
  recommended: AgentAssignment,
  config: NeuralgenticsConfig,
  presets: PresetsData,
): RoleAlternative[] {
  const alts: RoleAlternative[] = [];
  const seen = new Set<string>([recommended.model]);
  for (const provider of enabledProviders(config)) {
    const entry = presets.rankings[provider]?.[role];
    if (entry === undefined) continue;
    if (entry.model === null || entry.model === undefined) continue;
    const modelId = entry.model.includes("/") ? entry.model : `${provider}/${entry.model}`;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    alts.push({
      model: modelId,
      provider,
      reason: describeReason(entry, provider),
      score: entry.score,
    });
  }
  alts.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.model.localeCompare(b.model);
  });
  return alts;
}

/**
 * Build the full list of candidate models across ALL enabled providers and
 * ALL roles (deduplicated, sorted). Used for the "I don't see my model"
 * escape hatch. Null entries are skipped.
 */
export function buildFullModelList(
  config: NeuralgenticsConfig,
  presets: PresetsData,
): RoleAlternative[] {
  const out: RoleAlternative[] = [];
  const seen = new Set<string>();
  for (const provider of enabledProviders(config)) {
    const roleMap = presets.rankings[provider];
    if (roleMap === undefined) continue;
    for (const role of Object.keys(roleMap)) {
      const entry = roleMap[role];
      if (entry === undefined || entry.model === null || entry.model === undefined) continue;
      const modelId = entry.model.includes("/") ? entry.model : `${provider}/${entry.model}`;
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      out.push({
        model: modelId,
        provider,
        reason: describeReason(entry, provider),
        score: entry.score,
      });
    }
  }
  out.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.model.localeCompare(b.model);
  });
  return out;
}

/**
 * Produce a short human-readable reason for a ranking entry, used as the
 * `hint` in the select prompt. Falls back to the benchmark name when no
 * score is available (the real presets.json ships scores of 0.0 with
 * `fallback: true`).
 */
export function describeReason(entry: RankingEntry, provider: string): string {
  if (entry.score > 0) {
    return `#${entry.rank} on ${entry.benchmark} (${provider}, score ${entry.score.toFixed(2)})`;
  }
  return `${entry.benchmark} fallback (${provider})`;
}

/**
 * Decide whether to run interactively. Returns `true` (non-interactive) when:
 *   - `yes` is explicitly set, OR
 *   - stdout is not a TTY, OR
 *   - a CI env var is present (CI=true / GITHUB_ACTIONS=true / etc.)
 */
export function shouldRunNonInteractive(opts: { yes?: boolean; stdout?: { isTTY?: boolean } }): boolean {
  if (opts.yes === true) return true;
  if (opts.stdout !== undefined && opts.stdout.isTTY === false) return true;
  if (process.env["CI"] === "true" || process.env["GITHUB_ACTIONS"] === "true") return true;
  return false;
}

/**
 * Given the recommended assignment and the user's choice (either the
 * recommended model id, an alternative model id, or a custom model from the
 * escape hatch), produce the final `AgentAssignment` for that role.
 */
export function resolveAssignment(
  role: string,
  recommended: AgentAssignment,
  chosenModel: string,
): AgentAssignment {
  if (chosenModel === recommended.model) return recommended;
  // Parse "provider/model" — if no slash, keep the recommended provider.
  const slash = chosenModel.indexOf("/");
  const provider = slash >= 0 ? chosenModel.slice(0, slash) : recommended.provider;
  return {
    role,
    model: chosenModel,
    provider,
    benchmark: "",
    score: 0,
    overridden: true,
  };
}

/**
 * Render the per-role summary line shown in the final review table.
 */
export function renderSummaryLine(a: AgentAssignment): string {
  const role = a.role.padEnd(14);
  const model = a.model.padEnd(40);
  const source = a.overridden ? "override" : a.provider;
  return `  ${role} ${model} ${source}`;
}

/* ------------------------------------------------------------------ */
/* Presets loader (mirrors remodel.ts but shared here)                */
/* ------------------------------------------------------------------ */

async function loadPresets(configDir: string): Promise<PresetsData> {
  const userPresets = path.join(configDir, PRESETS_FILENAME);
  if (!existsSync(userPresets)) {
    return FALLBACK_PRESETS;
  }
  try {
    const raw = await fs.readFile(userPresets, "utf-8");
    const parsed = JSON.parse(raw) as PresetsData;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.rankings !== "object") {
      throw new Error("missing or invalid `rankings` field");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `Failed to load ${userPresets}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Cancellation guard                                                  */
/* ------------------------------------------------------------------ */

function bailIfCancel(value: unknown): asserts value {
  if (clack.isCancel(value)) {
    clack.cancel(" remodel cancelled.");
    process.exit(0);
  }
}

/* ------------------------------------------------------------------ */
/* Interactive runner                                                   */
/* ------------------------------------------------------------------ */

/**
 * Run the interactive model-selection flow. When `yes` or non-interactive
 * conditions hold, falls back to applying the recommended picks without
 * prompts (printing a plain-text summary).
 *
 * Returns the list of final assignments (NOT the patch result — the caller
 * is responsible for applying them via `remodel.ts` patcher, or this can be
 * extended to apply directly).
 */
export async function runInteractiveRemodel(
  opts: RemodelTuiOptions,
): Promise<AgentAssignment[]> {
  const nonInteractive = shouldRunNonInteractive({ yes: opts.yes, stdout: process.stdout });

  // Load config (create default if missing, mirroring remodel.ts).
  const configPath = getConfigPath(opts.configDir);
  let config: NeuralgenticsConfig;
  let configCreated = false;
  if (opts.config !== undefined) {
    config = opts.config;
  } else if (!existsSync(configPath)) {
    config = createDefaultConfig();
    configCreated = true;
    if (!opts.dryRun) {
      await saveConfig(configPath, config);
    }
  } else {
    config = await loadConfig(configPath);
  }

  const presets = opts.presets ?? (await loadPresets(opts.configDir));

  if (configCreated && !nonInteractive) {
    clack.note(`Created default config at ${configPath}`, "Config");
  }

  const recommended = pickModels(config, presets, opts.dryRun ?? false);
  const enabled = enabledProviders(config);

  if (nonInteractive) {
    return runNonInteractive(config, recommended, enabled);
  }
  return runInteractive(config, recommended, presets, enabled, opts);
}

/** Non-interactive path: print a plain-text summary and return picks. */
async function runNonInteractive(
  _config: NeuralgenticsConfig,
  recommended: AgentAssignment[],
  enabled: string[],
): Promise<AgentAssignment[]> {
  process.stdout.write("\nNeuralgentics — Agent Model Configuration (non-interactive)\n");
  process.stdout.write(`Enabled providers: ${enabled.join(", ") || "(none)"}\n`);
  process.stdout.write("Applying recommended models:\n\n");
  for (const a of recommended) {
    process.stdout.write(renderSummaryLine(a) + "\n");
  }
  process.stdout.write("\n");
  return recommended;
}

/** Interactive path: clack prompts. */
async function runInteractive(
  config: NeuralgenticsConfig,
  recommended: AgentAssignment[],
  presets: PresetsData,
  enabled: string[],
  opts: RemodelTuiOptions,
): Promise<AgentAssignment[]> {
  clack.intro("Neuralgentics — Agent Model Configuration");
  clack.note(
    `Enabled providers: ${enabled.join(", ") || "(none)"}\n` +
      `Rankings: ${opts.presets ? "provided" : "presets.json"} (fallback built-in)`,
    "Context",
  );

  // Accept-all gate.
  const acceptAll = await clack.confirm({
    message: "Use recommended models for all 12 agent roles?",
    initialValue: true,
  });
  bailIfCancel(acceptAll);

  if (acceptAll) {
    // Show summary + outro, then return recommendations for patching.
    printReviewSummary(recommended);
    const apply = await clack.confirm({
      message: "Apply these models?",
      initialValue: true,
    });
    bailIfCancel(apply);
    if (!apply) {
      clack.cancel(" remodel cancelled — no changes made.");
      process.exit(0);
    }
    clack.outro(`Done — ${recommended.length} assignments ready to apply.`);
    return recommended;
  }

  // Per-role loop.
  const finalPicks: AgentAssignment[] = [];
  for (let i = 0; i < recommended.length; i++) {
    const rec = recommended[i];
    clack.log.step(`Agent ${i + 1}/${recommended.length} — ${rec.role}`);
    clack.log.message(
      `Recommended: ${rec.model} (${rec.provider})`,
    );
    if (!rec.overridden) {
      const recEntry = lookupEntry(rec.role, rec.provider, presets);
      if (recEntry !== null) {
        clack.log.info(`  ${describeReason(recEntry, rec.provider)}`);
      }
    }

    const useThis = await clack.confirm({
      message: `Use ${rec.model} for ${rec.role}?`,
      initialValue: true,
    });
    bailIfCancel(useThis);

    if (useThis) {
      finalPicks.push(rec);
      continue;
    }

    // Build alternatives from enabled providers.
    const alts = buildRoleAlternatives(rec.role, rec, config, presets);
    if (alts.length === 0) {
      // No alternatives — go straight to the full-model escape hatch.
      const chosen = await presentFullModelList(rec.role, config, presets);
      finalPicks.push(resolveAssignment(rec.role, rec, chosen));
      continue;
    }

    // select with alternatives + escape hatch.
    const selectOptions: { value: string; label: string; hint: string }[] = alts.map((a) => ({
      value: a.model,
      label: a.model,
      hint: a.reason,
    }));
    selectOptions.push({
      value: ESCAPE_HATCH_VALUE,
      label: "I don't see my model",
      hint: "pick from the full model list",
    });
    const choice = await clack.select({
      message: `Select a model for ${rec.role}`,
      options: selectOptions,
    });
    bailIfCancel(choice);

    if (choice === ESCAPE_HATCH_VALUE) {
      const chosen = await presentFullModelList(rec.role, config, presets);
      finalPicks.push(resolveAssignment(rec.role, rec, chosen));
    } else {
      finalPicks.push(resolveAssignment(rec.role, rec, choice as string));
    }
  }

  // Final review + confirm.
  printReviewSummary(finalPicks);
  const apply = await clack.confirm({
    message: "Apply these models?",
    initialValue: true,
  });
  bailIfCancel(apply);
  if (!apply) {
    clack.cancel(" remodel cancelled — no changes made.");
    process.exit(0);
  }

  clack.outro(`Done — ${finalPicks.length} assignments ready to apply.`);
  return finalPicks;
}

/** Look up a RankingEntry for a (role, provider) in presets. */
function lookupEntry(role: string, provider: string, presets: PresetsData): RankingEntry | null {
  const entry = presets.rankings[provider]?.[role];
  return entry ?? null;
}

/**
 * Present the full model list across all enabled providers and return the
 * chosen model id. Falls back to `select` (clack's autocomplete requires a
 * render function with a more complex signature; select is universally
 * supported and works fine for a few dozen options).
 */
async function presentFullModelList(
  role: string,
  config: NeuralgenticsConfig,
  presets: PresetsData,
): Promise<string> {
  const full = buildFullModelList(config, presets);
  if (full.length === 0) {
    // Last resort: free-text entry.
    const custom = await clack.text({
      message: `Enter a full "provider/model" id for ${role}`,
      placeholder: "ollama/kimi-k2.6",
    });
    bailIfCancel(custom);
    return custom as string;
  }
  const options: { value: string; label: string; hint: string }[] = full.map((a) => ({
    value: a.model,
    label: a.model,
    hint: a.reason,
  }));
  const choice = await clack.select({
    message: `Pick a model for ${role} (all enabled providers)`,
    options,
  });
  bailIfCancel(choice);
  return choice as string;
}

/** Print the final review table to stdout (plain text — survives non-TTY). */
function printReviewSummary(picks: AgentAssignment[]): void {
  process.stdout.write("\nFinal model assignments:\n");
  process.stdout.write("  ROLE             MODEL                                     SOURCE\n");
  process.stdout.write("  ─────────────── ───────────────────────────────────────────── ──────\n");
  for (const a of picks) {
    process.stdout.write(renderSummaryLine(a) + "\n");
  }
  process.stdout.write("\n");
}