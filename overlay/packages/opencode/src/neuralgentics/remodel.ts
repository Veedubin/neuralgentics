/**
 * `neuralgentics --remodel` command implementation.
 *
 * Re-picks agent models based on `.opencode/neuralgentics.config.json` +
 * benchmark rankings, then patches ONLY the `model:` line in each agent
 * persona's YAML frontmatter. The markdown body is never touched, and the
 * `.opencode/overrides/` directory (body-content appends) is unaffected.
 *
 * Flow:
 *   1. Load (or create) the config from `.opencode/neuralgentics.config.json`.
 *   2. Load presets — `configDir/presets.json` wins, else the shipped fallback.
 *   3. Call `pickModels(config, presets)`.
 *   4. For each agent `.md` file, patch the `model:` line in the frontmatter
 *      (with a backup if not dry-run).
 *   5. Print a summary table of assignments.
 */

import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadConfig,
  saveConfig,
  createDefaultConfig,
  getConfigPath,
  type NeuralgenticsConfig,
} from "./config.js";
import {
  pickModels,
  FALLBACK_PRESETS,
  type PresetsData,
  type AgentAssignment,
} from "./model-picker.js";
import { backupFile } from "./backup.js";

/** Result of one `--remodel` invocation. */
export interface RemodelResult {
  /** Number of agent files patched (or that would be patched in dry-run). */
  patched: number;
  /** Number of agent files skipped (no `model:` line, or already matching). */
  skipped: number;
  /** Human-readable warning strings. */
  warnings: string[];
  /** Whether a default config was created during this run. */
  configCreated: boolean;
  /** The final assignments used. */
  assignments: AgentAssignment[];
}

const PRESETS_FILENAME = "presets.json";

/** Map an agent role to its persona filename in `.opencode/agents/`. */
function roleToFileName(role: string): string {
  return `${role}.md`;
}

/** Map an agent filename (without extension) back to a role. */
function fileNameToRole(fileName: string): string {
  return fileName.endsWith(".md") ? fileName.slice(0, -".md".length) : fileName;
}

/**
 * Load presets, preferring a user-supplied `presets.json` in `configDir`,
 * falling back to the shipped fallback. A user-supplied file that exists but
 * is malformed throws (we don't silently ignore user data). A missing file is
 * a normal "pipeline hasn't run yet" state → fallback.
 */
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

/**
 * Patch the `model:` line in a markdown file's YAML frontmatter.
 *
 * The frontmatter is the block between the first `---` line and the next
 * `---` (or `...`) line. If the file has no frontmatter, no `model:` line,
 * or the model line already matches, the file is left untouched and
 * `changed=false` is returned.
 *
 * Only the single `model: <value>` line is rewritten. Everything else
 * (description, mode, steps, permission, body) is preserved byte-for-byte.
 *
 * @returns `{ changed: boolean, previous: string | null }`.
 */
export function patchModelLine(content: string, newModel: string): { changed: boolean; previous: string | null } {
  const lines = content.split("\n");
  // The first non-empty line must be a frontmatter fence.
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length || lines[start].trim() !== "---") {
    return { changed: false, previous: null };
  }
  // Find the closing fence.
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) return { changed: false, previous: null }; // no closing fence

  // Scan for a top-level `model:` key (no leading spaces) within the
  // frontmatter. Indented `model:` (under a nested block) is ignored.
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const match = /^model:\s*(.*)$/.exec(line);
    if (!match) continue;
    const previous = match[1].trim();
    if (previous === newModel) {
      return { changed: false, previous };
    }
    lines[i] = `model: ${newModel}`;
    return { changed: true, previous };
  }
  // No `model:` line in the frontmatter — leave the file unchanged.
  return { changed: false, previous: null };
}

/**
 * Print a human-readable summary table of the assignments.
 */
export function printAssignmentSummary(assignments: AgentAssignment[]): void {
  process.stdout.write("\nModel assignments:\n");
  process.stdout.write("  ROLE            MODEL                                 SCORE   SOURCE\n");
  process.stdout.write("  ─────────────── ─────────────────────────────────────── ─────── ──────\n");
  for (const a of assignments) {
    const role = a.role.padEnd(15);
    const model = a.model.padEnd(37);
    const score = (a.overridden ? "  -" : a.score.toFixed(2)).padStart(6);
    const source = a.overridden ? "override" : a.provider;
    process.stdout.write(`  ${role} ${model} ${score}   ${source}\n`);
  }
  process.stdout.write("\n");
}

/**
 * Entry point for `neuralgentics --remodel`.
 *
 * @param configDir — absolute path to the `.opencode/` directory to operate on.
 * @param dryRun    — when true, no files are written and no backups are made.
 */
export async function remodel(configDir: string, dryRun: boolean): Promise<RemodelResult> {
  const result: RemodelResult = {
    patched: 0,
    skipped: 0,
    warnings: [],
    configCreated: false,
    assignments: [],
  };

  // 1. Load config — create a default if missing.
  const configPath = getConfigPath(configDir);
  let config: NeuralgenticsConfig;
  if (!existsSync(configPath)) {
    config = createDefaultConfig();
    result.configCreated = true;
    if (!dryRun) {
      await saveConfig(configPath, config);
      process.stdout.write(`Created default config at ${configPath}\n`);
    } else {
      process.stdout.write(`[DRY-RUN] Would create default config at ${configPath}\n`);
    }
  } else {
    try {
      config = await loadConfig(configPath);
    } catch (err) {
      throw new Error(
        `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Load presets.
  const presets = await loadPresets(configDir);

  // 3. Pick models.
  const assignments = pickModels(config, presets, dryRun);
  result.assignments = assignments;

  // 4. Patch each agent .md file.
  const agentsDir = path.join(configDir, "agents");
  if (!existsSync(agentsDir)) {
    result.warnings.push(`agents directory not found at ${agentsDir}; nothing to patch.`);
    printAssignmentSummary(assignments);
    return result;
  }

  const byRole = new Map<string, AgentAssignment>();
  for (const a of assignments) byRole.set(a.role, a);

  const files = await fs.readdir(agentsDir);
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const role = fileNameToRole(file);
    const assignment = byRole.get(role);
    if (assignment === undefined) {
      result.warnings.push(`no assignment for agent "${role}" (file ${file} left unchanged)`);
      result.skipped++;
      continue;
    }
    const filePath = path.join(agentsDir, file);
    const content = await fs.readFile(filePath, "utf-8");
    const { changed, previous } = patchModelLine(content, assignment.model);
    if (!changed) {
      result.skipped++;
      continue;
    }
    if (dryRun) {
      process.stdout.write(
        `[DRY-RUN] Would patch ${file}: model: ${previous ?? "?"} -> ${assignment.model}\n`,
      );
      result.patched++;
      continue;
    }
    // Back up before writing (non-destructive).
    try {
      await backupFile(agentsDir, filePath);
    } catch (err) {
      result.warnings.push(
        `could not back up ${file} before patching: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.skipped++;
      continue;
    }
    const newContent = applyPatch(content, assignment.model);
    await fs.writeFile(filePath, newContent, "utf-8");
    process.stdout.write(`Patched ${file}: model: ${previous} -> ${assignment.model}\n`);
    result.patched++;
  }

  // 5. Summary.
  printAssignmentSummary(assignments);
  return result;
}

/**
 * Patch agent `.md` files for a pre-computed set of assignments.
 *
 * This is the patch-only half of {@link remodel}, factored out so the
 * interactive TUI (`remodel-tui.ts`) can gather picks via prompts and then
 * delegate the file patching here without re-running the picker. `dryRun`
 * controls whether files are actually written.
 *
 * @param configDir   absolute path to the `.opencode/` directory.
 * @param assignments the assignments to apply (one per role).
 * @param dryRun       when true, no files are written and no backups are made.
 */
export async function patchAssignments(
  configDir: string,
  assignments: AgentAssignment[],
  dryRun: boolean,
): Promise<RemodelResult> {
  const result: RemodelResult = {
    patched: 0,
    skipped: 0,
    warnings: [],
    configCreated: false,
    assignments,
  };

  const agentsDir = path.join(configDir, "agents");
  if (!existsSync(agentsDir)) {
    result.warnings.push(`agents directory not found at ${agentsDir}; nothing to patch.`);
    printAssignmentSummary(assignments);
    return result;
  }

  const byRole = new Map<string, AgentAssignment>();
  for (const a of assignments) byRole.set(a.role, a);

  const files = await fs.readdir(agentsDir);
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const role = fileNameToRole(file);
    const assignment = byRole.get(role);
    if (assignment === undefined) {
      result.warnings.push(`no assignment for agent "${role}" (file ${file} left unchanged)`);
      result.skipped++;
      continue;
    }
    const filePath = path.join(agentsDir, file);
    const content = await fs.readFile(filePath, "utf-8");
    const { changed, previous } = patchModelLine(content, assignment.model);
    if (!changed) {
      result.skipped++;
      continue;
    }
    if (dryRun) {
      process.stdout.write(
        `[DRY-RUN] Would patch ${file}: model: ${previous ?? "?"} -> ${assignment.model}\n`,
      );
      result.patched++;
      continue;
    }
    try {
      await backupFile(agentsDir, filePath);
    } catch (err) {
      result.warnings.push(
        `could not back up ${file} before patching: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.skipped++;
      continue;
    }
    const newContent = applyPatch(content, assignment.model);
    await fs.writeFile(filePath, newContent, "utf-8");
    process.stdout.write(`Patched ${file}: model: ${previous} -> ${assignment.model}\n`);
    result.patched++;
  }

  printAssignmentSummary(assignments);
  return result;
}

/** Apply `patchModelLine` to a file's content and return the new content. */
function applyPatch(content: string, newModel: string): string {
  const lines = content.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length || lines[start].trim() !== "---") return content;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) return content;
  for (let i = start + 1; i < end; i++) {
    if (/^model:\s*(.*)$/.test(lines[i])) {
      lines[i] = `model: ${newModel}`;
      return lines.join("\n");
    }
  }
  return content;
}