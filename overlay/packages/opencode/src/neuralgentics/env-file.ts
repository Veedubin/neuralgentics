/**
 * `.env` file merge helper for the neuralgentics two-init installer.
 *
 * Provides `updateEnvFile()` — a non-destructive merge that:
 *   1. Backs up the existing `.env` (if present) to
 *      `env-file-YYYY-MM-DDTHH-MM-SSZ.env.bak` in the same directory (the
 *      SAME timestamp convention as `opencode.json` backups in
 *      `writeConfigWithBackup`).
 *   2. Merges new key=value lines in — replacing an existing line with the
 *      same key, or appending if the key is not present.
 *   3. Preserves comments, blank lines, and user-added keys that aren't in
 *      the new lines.
 *   4. Returns the backup path (or `null` if no existing file was backed up).
 *
 * This consolidates the ad-hoc `.env` merge logic that previously lived
 * inline in `promptTeamConnection` and `promptOllamaApiKey` (which silently
 * overwrote `MEMINI_DB_URL` without any backup, and which had no consistent
 * backup semantics across the two callers).
 */

import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";

/**
 * Merge `newLines` (each `KEY=VALUE`) into the `.env` file at `envPath`.
 *
 * - If `.env` does not exist: writes `newLines` as a new file, returns `null`.
 * - If `.env` exists: backs it up, then rewrites it with merged content,
 *   returns the absolute backup path.
 *
 * Merge semantics:
 *   - Comment lines (`#...`) and blank lines are preserved verbatim.
 *   - For non-comment lines, the key is the substring before the first `=`.
 *   - If a new line's key matches an existing line's key, the existing line
 *     is replaced by the new one.
 *   - New keys not already present are appended at the end.
 *
 * @param envPath absolute path to the `.env` file
 * @param newLines array of `KEY=VALUE` strings to merge in
 * @returns the absolute backup path, or `null` if no backup was made
 */
export async function updateEnvFile(
  envPath: string,
  newLines: string[],
): Promise<string | null> {
  // Index new lines by key for lookup.
  const newByKey = new Map<string, string>();
  for (const line of newLines) {
    const eqIdx = line.indexOf("=");
    const key = eqIdx > 0 ? line.slice(0, eqIdx).trim() : "";
    if (key) newByKey.set(key, line);
  }

  if (!existsSync(envPath)) {
    // No existing file — just write the new lines.
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(envPath, newLines.join("\n") + "\n", "utf-8");
    return null;
  }

  // Existing file — back it up first.
  const existing = await fs.readFile(envPath, "utf-8");
  const backupPath = makeEnvBackupPath(envPath);
  await fs.copyFile(envPath, backupPath);

  // Merge: preserve comments/blanks, replace matching keys, append new keys.
  const existingLines = existing.split("\n");
  const updated = new Set<string>();
  const result: string[] = [];
  for (const line of existingLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") {
      result.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const key = eqIdx > 0 ? trimmed.slice(0, eqIdx).trim() : "";
    const replacement = key ? newByKey.get(key) : undefined;
    if (replacement) {
      result.push(replacement);
      updated.add(key);
    } else {
      // Preserve user-added keys not in the new lines.
      result.push(line);
    }
  }
  for (const line of newLines) {
    const eqIdx = line.indexOf("=");
    const key = eqIdx > 0 ? line.slice(0, eqIdx).trim() : "";
    if (key && !updated.has(key)) result.push(line);
  }

  await fs.writeFile(envPath, result.join("\n") + "\n", "utf-8");
  return backupPath;
}

/**
 * Build a `.env` backup path using the SAME timestamp convention as
 * `opencode.json` backups in `writeConfigWithBackup` / `backupFile`:
 * `YYYY-MM-DDTHH-MM-SSZ` (colons replaced with dashes so the filename is
 * safe on all filesystems).
 *
 * The backup file is named `env-file-{timestamp}.env.bak` and lives in the
 * same directory as the original `.env`.
 */
function makeEnvBackupPath(envPath: string): string {
  const dir = path.dirname(envPath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/\.\d+Z$/, "Z");
  return path.join(dir, `env-file-${ts}.env.bak`);
}