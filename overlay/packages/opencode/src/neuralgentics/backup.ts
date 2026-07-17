/**
 * Backup logic for the neuralgentics two-init installer.
 *
 * Before overwriting any file, back it up:
 *   - Backup dir: {configDir}/opencode-bak/
 *   - Backup filename: {originalName}-{ISO-timestamp-with-ms}.json
 *   - Files changed in the same update run share the same timestamp (down to
 *     ms) so you can see which files were moved together.
 *   - Create the backup dir if it doesn't exist (mkdir -p style)
 *   - Copy the existing file to the backup location BEFORE writing the new one
 *   - Return a list of backups made
 */

import * as path from "node:path";
import { promises as fs, existsSync } from "node:fs";

import { getBackupDir, getBackupFilePath } from "./paths.js";

/** A record of a single backup operation. */
export interface BackupRecord {
  /** The original file path (absolute) */
  originalPath: string;
  /** The backup file path (absolute) */
  backupPath: string;
}

/**
 * Back up a single file before overwriting it.
 *
 * If the file doesn't exist, returns `null` (nothing to back up).
 * Creates the backup dir if it doesn't exist.
 *
 * @param configDir — the config directory (homedir or project) containing
 *                    the file to back up
 * @param originalPath — absolute path to the file to back up
 * @param timestamp — shared ISO timestamp string (so all files in one run
 *                    share the same timestamp). If not provided, a new one is
 *                    generated.
 */
export async function backupFile(
  configDir: string,
  originalPath: string,
  timestamp?: string,
): Promise<BackupRecord | null> {
  if (!existsSync(originalPath)) return null;

  const backupDir = getBackupDir(configDir);
  await fs.mkdir(backupDir, { recursive: true });

  const originalName = path.basename(originalPath);
  const ts = timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const base = originalName.endsWith(".json")
    ? originalName.slice(0, -".json".length)
    : originalName;
  const backupPath = path.join(backupDir, `${base}-${ts}.json`);

  await fs.copyFile(originalPath, backupPath);
  return { originalPath, backupPath };
}

/**
 * Back up multiple files before overwriting them.
 *
 * All files in the same call share the same timestamp (down to ms).
 * Files that don't exist are skipped silently.
 *
 * @param configDir — the config directory
 * @param filePaths — array of absolute file paths to back up
 * @returns array of backup records (only for files that existed)
 */
export async function backupFiles(
  configDir: string,
  filePaths: string[],
): Promise<BackupRecord[]> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const records: BackupRecord[] = [];
  for (const fp of filePaths) {
    const record = await backupFile(configDir, fp, timestamp);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * Print a summary of backups made.
 */
export function printBackupSummary(records: BackupRecord[], configDir: string): void {
  if (records.length === 0) {
    process.stdout.write("No backups needed (all files were new or unchanged).\n");
    return;
  }
  const backupDir = getBackupDir(configDir);
  process.stdout.write(`Backed up ${records.length} file(s) to ${backupDir}/\n`);
  for (const r of records) {
    process.stdout.write(`  ${path.basename(r.backupPath)} (from ${path.basename(r.originalPath)})\n`);
  }
}