/**
 * User personalization merge for agent persona files.
 *
 * Reads `.opencode/overrides/*.md` and appends each override's content
 * to the bottom of the corresponding default agent file in `.opencode/agents/`.
 *
 * Rules (per the approved architect design):
 *   1. An override file must have the SAME basename as a default agent file
 *      (e.g. `overrides/coder.md` is appended to `agents/coder.md`).
 *   2. Override content is appended AFTER the default file's body, separated
 *      by a blank line, so the default's YAML frontmatter stays intact.
 *   3. If the override file has YAML frontmatter (a leading `---` block), it
 *      is STRIPPED — only the markdown body is appended. The default's own
 *      frontmatter wins; overrides are body-only by contract.
 *   4. Idempotent: the merged result's SHA-256 is compared against the file
 *      already on disk. If they match (already merged), the file is skipped.
 *      Re-running init/update never double-appends.
 *   5. Orphaned overrides (no matching default agent) are skipped with a
 *      warning. User files are NEVER deleted.
 *   6. The `.opencode/overrides/` directory is NEVER touched by init or
 *      update — it is read-only from the installer's perspective.
 *   7. Empty override files are a no-op (counted as skipped, not orphaned).
 *
 * This module is imported by both `init.ts` (after `copyStaticAssets()` /
 * `placeFiles()`) and `update.ts` (after the file-copy loop in
 * `updateConfigDir()`).
 */

import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";

import { backupFile } from "./backup.js";

/** Aggregate result of a single `mergePersonalizations()` run. */
export interface MergeResult {
  /** Number of default agent files that had an override applied (or were
   *  already merged and left unchanged). */
  merged: number;
  /** Number of overrides skipped because they were empty or already merged. */
  skipped: number;
  /** Number of overrides with no matching default agent file. */
  orphaned: number;
  /** Human-readable warning strings (orphans, IO errors, etc.). */
  warnings: string[];
}

/**
 * Strip a leading YAML frontmatter block from a markdown string.
 *
 * A frontmatter block starts with a line that is exactly `---` and ends with
 * the next line that is exactly `---` (or `...`). If no closing fence is
 * found, the whole input is treated as body (nothing stripped) — we'd rather
 * keep the user's content than silently drop it.
 *
 * @returns the markdown body with the frontmatter removed. Leading blank
 *          lines after the fence are trimmed so the appended body starts
 *          cleanly.
 */
export function stripYamlFrontmatter(content: string): string {
  // Only strip if the very first non-empty content is a frontmatter fence.
  // Allow a leading BOM or leading whitespace before the opening fence.
  const start = content.length - content.replace(/^\s+/, "").length;
  if (content.slice(start, start + 3) !== "---") {
    return content;
  }
  // Find the first newline after the opening fence, then walk line by line
  // looking for a closing fence line of exactly "---" (or "...").
  const afterOpen = content.indexOf("\n", start + 3);
  if (afterOpen === -1) return content; // single-line, no body — keep as-is
  const lines = content.slice(afterOpen + 1).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") {
      // Closing fence found at line i. Body is everything after it.
      const body = lines.slice(i + 1).join("\n");
      // Trim leading blank lines so the appended content starts cleanly,
      // but preserve internal/trailing structure.
      return body.replace(/^\n+/, "");
    }
  }
  // No closing fence — treat the whole input as body (do not drop content).
  return content;
}

/**
 * Read the names of every `.md` override file in `overridesDir`.
 *
 * Non-`.md` files (e.g. README.md is technically .md, but dotfiles like
 * .gitkeep) are skipped. `README.md` is explicitly skipped so users can
 * document their overrides directory without it being treated as an
 * override for an agent named "README".
 */
async function listOverrideFiles(overridesDir: string): Promise<string[]> {
  const entries = await fs.readdir(overridesDir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name.toLowerCase() === "readme.md") continue;
    result.push(entry.name);
  }
  result.sort();
  return result;
}

/**
 * Merge user personalizations from `.opencode/overrides/` into the default
 * agent files in `.opencode/agents/`.
 *
 * See the module doc comment for the full rule set. Safe to call when
 * `overridesDir` does not exist (returns a zero-result).
 *
 * @param agentsDir    — absolute path to `.opencode/agents/` (the default
 *                       agent files, freshly copied by init/update).
 * @param overridesDir — absolute path to `.opencode/overrides/` (user
 *                       personalizations). NEVER written to by this function.
 * @param dryRun       — when true, no files are written and no backups are
 *                       made; the result reports what *would* happen based
 *                       on a content comparison.
 */
export async function mergePersonalizations(
  agentsDir: string,
  overridesDir: string,
  dryRun: boolean,
): Promise<MergeResult> {
  const result: MergeResult = { merged: 0, skipped: 0, orphaned: 0, warnings: [] };

  if (!existsSync(overridesDir)) {
    return result;
  }
  if (!existsSync(agentsDir)) {
    result.warnings.push(
      `agents directory not found at ${agentsDir}; cannot apply overrides.`,
    );
    return result;
  }

  let overrideNames: string[];
  try {
    overrideNames = await listOverrideFiles(overridesDir);
  } catch (err) {
    result.warnings.push(
      `could not read overrides directory ${overridesDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return result;
  }

  for (const name of overrideNames) {
    const overridePath = path.join(overridesDir, name);
    const defaultPath = path.join(agentsDir, name);

    if (!existsSync(defaultPath)) {
      result.orphaned++;
      result.warnings.push(
        `override "${name}" has no matching default agent file; skipped.`,
      );
      continue;
    }

    let overrideRaw: string;
    try {
      overrideRaw = await fs.readFile(overridePath, "utf-8");
    } catch (err) {
      result.warnings.push(
        `could not read override "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    const overrideBody = stripYamlFrontmatter(overrideRaw);
    if (overrideBody.trim().length === 0) {
      // Empty override (body-only after frontmatter strip) — no-op.
      result.skipped++;
      continue;
    }

    let defaultContent: string;
    try {
      defaultContent = await fs.readFile(defaultPath, "utf-8");
    } catch (err) {
      result.warnings.push(
        `could not read default agent "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // Ensure the default ends with a newline, then separate with a blank
    // line so the appended body starts on its own paragraph.
    const base = defaultContent.endsWith("\n") ? defaultContent : defaultContent + "\n";
    const mergedContent = base + "\n" + overrideBody;
    const mergedTrimmed = mergedContent.replace(/\n+$/, "") + "\n";

    // Idempotency: re-running init/update must NOT double-append. Two cases
    // count as "already merged" and are skipped without a backup or write:
    //   (a) The file on disk is byte-identical to the merged result.
    //   (b) The override body is already present at the end of the file on
    //       disk (i.e. a previous merge appended it). This catches the case
    //       where the default was updated since the last merge but the
    //       override is still appended — we detect the override body as a
    //       suffix and skip rather than re-appending.
    const onDiskSha = createHash("sha256").update(defaultContent).digest("hex");
    const mergedSha = createHash("sha256").update(mergedTrimmed).digest("hex");
    if (onDiskSha === mergedSha) {
      result.skipped++;
      continue;
    }
    const diskTrimmed = defaultContent.replace(/\n+$/, "");
    const bodyTrimmed = overrideBody.replace(/\n+$/, "");
    if (diskTrimmed.endsWith(bodyTrimmed)) {
      result.skipped++;
      continue;
    }

    if (dryRun) {
      result.merged++;
      continue;
    }

    // Back up the current (un-merged) default before overwriting, so the
    // user can recover the pristine default from the backup dir.
    try {
      await backupFile(agentsDir, defaultPath);
    } catch (err) {
      result.warnings.push(
        `could not back up default agent "${name}" before merge: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    try {
      await fs.writeFile(defaultPath, mergedTrimmed, "utf-8");
      result.merged++;
    } catch (err) {
      result.warnings.push(
        `could not write merged agent "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return result;
}