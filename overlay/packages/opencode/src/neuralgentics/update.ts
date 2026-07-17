/**
 * Update logic for the neuralgentics two-init installer.
 *
 * Three update modes:
 *   - updateAll()      — find all .neuralgentics-state.json files under
 *                        ~/.config/opencode/ AND under all project
 *                        directories the user has initialized
 *   - updateProject()  — only update {CWD}/.opencode/
 *   - updateHomedir()  — only update the homedir config
 *
 * For each update:
 *   1. Read .neuralgentics-state.json for installed version + file manifest
 *   2. Download latest tarball (reuse download.ts)
 *   3. For each file in new tarball:
 *      - Compute SHA-256
 *      - Compare against state file manifest
 *      - If changed: call backupFile() then write new file
 *      - If same: skip
 *      - If new: create
 *   4. Update state file with new version + manifest
 *   5. Print summary
 *   6. Print final prompt to user
 */

import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

import {
  downloadTarball,
  extractTarball,
  resolveVersion,
  verifySha256,
} from "./download.js";
import { getHomedirConfigPath, getProjectConfigPath } from "./paths.js";
import { backupFile, type BackupRecord } from "./backup.js";

/** Name of the state file inside a config directory. */
const STATE_FILENAME = ".neuralgentics-state.json";

/** Read chunk size for SHA256 computation (64 KiB). */
const CHUNK_SIZE = 64 * 1024;

/** A file record in the state file. */
interface StateFileRecord {
  sha256: string;
  user_modified: boolean;
  installed_from: string;
  last_known_shipped_sha256: string | null;
  merged: boolean | null;
}

/** The state file written by init. */
interface StateFile {
  version: number;
  installed_version: string;
  installed_at: string;
  updated_at: string;
  cli_version: string;
  source: "github";
  repo: string;
  target: string;
  files: Record<string, StateFileRecord>;
  last_backup: string | null;
  installType?: "homedir" | "project";
}

/** Result of a single update operation. */
export interface UpdateResult {
  configDir: string;
  installType: "homedir" | "project" | "unknown";
  updated: number;
  skipped: number;
  created: number;
  backups: BackupRecord[];
  fromVersion: string | null;
  toVersion: string;
}

/** Options for update operations. */
export interface UpdateOptions {
  repo: string;
  version: string; // "latest" or "X.Y.Z"
  force: boolean;
  dryRun: boolean;
}

/**
 * Compute the SHA-256 hash of a file.
 */
async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(CHUNK_SIZE);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/**
 * Read a state file from a config directory.
 */
async function readStateFile(configDir: string): Promise<StateFile | null> {
  const statePath = path.join(configDir, STATE_FILENAME);
  if (!existsSync(statePath)) return null;
  try {
    const text = await fs.readFile(statePath, "utf-8");
    return JSON.parse(text) as StateFile;
  } catch {
    return null;
  }
}

/**
 * Write a state file to a config directory.
 */
async function writeStateFile(configDir: string, state: StateFile): Promise<void> {
  const statePath = path.join(configDir, STATE_FILENAME);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Walk a directory tree and return all file paths.
 */
async function iterFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  }
  await walk(root);
  result.sort();
  return result;
}

/**
 * Update a single config directory from the tarball.
 *
 * @param configDir — the config directory to update
 * @param extractDir — the extracted tarball directory (source of new files)
 * @param newVersion — the new version string
 * @param opts — update options
 */
async function updateConfigDir(
  configDir: string,
  extractDir: string,
  newVersion: string,
  opts: UpdateOptions,
): Promise<UpdateResult> {
  const state = await readStateFile(configDir);
  const installType: "homedir" | "project" | "unknown" = state?.installType ?? "unknown";
  const fromVersion = state?.installed_version ?? null;

  if (opts.dryRun) {
    process.stdout.write(
      `[DRY-RUN] Would update ${configDir} from ${fromVersion ?? "none"} to ${newVersion}\n`,
    );
    return {
      configDir,
      installType,
      updated: 0,
      skipped: 0,
      created: 0,
      backups: [],
      fromVersion,
      toVersion: newVersion,
    };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const newFiles = await iterFiles(extractDir);
  const newManifest: Record<string, StateFileRecord> = {};
  let updated = 0;
  let skipped = 0;
  let created = 0;
  const backups: BackupRecord[] = [];

  for (const src of newFiles) {
    const rel = path.relative(extractDir, src).split(path.sep).join("/");
    const dest = path.join(configDir, rel);

    const newSha = await computeFileSha256(src);
    const oldRecord = state?.files[rel];

    // Compute destination directory and ensure it exists
    await fs.mkdir(path.dirname(dest), { recursive: true });

    if (oldRecord && oldRecord.sha256 === newSha && !opts.force) {
      // Same content — skip
      skipped++;
      newManifest[rel] = oldRecord;
      continue;
    }

    if (existsSync(dest) && !opts.force) {
      // File exists and differs — back up first
      const backup = await backupFile(configDir, dest, timestamp);
      if (backup !== null) backups.push(backup);
      updated++;
    } else if (!existsSync(dest)) {
      created++;
    } else {
      // force mode — back up the existing file
      const backup = await backupFile(configDir, dest, timestamp);
      if (backup !== null) backups.push(backup);
      updated++;
    }

    await fs.copyFile(src, dest);
    newManifest[rel] = {
      sha256: await computeFileSha256(dest),
      user_modified: false,
      installed_from: newVersion,
      last_known_shipped_sha256: newSha,
      merged: rel.endsWith("opencode.json") ? true : null,
    };
  }

  // Write updated state file
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const newState: StateFile = {
    version: 1,
    installed_version: newVersion,
    installed_at: state?.installed_at ?? now,
    updated_at: now,
    cli_version: state?.cli_version ?? "0.1.0",
    source: "github",
    repo: opts.repo,
    target: configDir,
    files: newManifest,
    last_backup: backups.length > 0 ? path.join(configDir, "opencode-bak") : null,
    installType: installType === "unknown" ? "project" : installType,
  };
  await writeStateFile(configDir, newState);

  return {
    configDir,
    installType,
    updated,
    skipped,
    created,
    backups,
    fromVersion,
    toVersion: newVersion,
  };
}

/**
 * Download and extract the latest tarball.
 */
async function downloadAndExtract(version: string, repo: string): Promise<{
  extractDir: string;
  version: string;
}> {
  const resolvedVersion = await resolveVersion(version, repo);
  const { tarballPath, checksumsPath } = await downloadTarball(resolvedVersion, repo);
  await verifySha256(tarballPath, checksumsPath);
  const extractDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `neuralgentics-update-${resolvedVersion}-`),
  );
  await extractTarball(tarballPath, extractDir);
  return { extractDir, version: resolvedVersion };
}

/**
 * Find all config directories with state files.
 *
 * Searches:
 *   1. The homedir config directory
 *   2. All project directories under the user's home that have
 *      .neuralgentics-state.json files
 */
async function findAllStateDirs(): Promise<string[]> {
  const dirs = new Set<string>();
  const homedirConfig = getHomedirConfigPath();
  if (existsSync(path.join(homedirConfig, STATE_FILENAME))) {
    dirs.add(homedirConfig);
  }
  // Search for project-level state files under the home directory.
  // This is a shallow search — we look for .opencode/.neuralgentics-state.json
  // in immediate subdirectories of the home dir and common project locations.
  const home = os.homedir();
  const searchRoots = [
    home,
    path.join(home, "Projects"),
    path.join(home, "projects"),
    path.join(home, "Code"),
    path.join(home, "code"),
    path.join(home, "src"),
    path.join(home, "workspace"),
  ];
  for (const root of searchRoots) {
    if (!existsSync(root)) continue;
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectConfig = path.join(root, entry.name, ".opencode");
        const stateFile = path.join(projectConfig, STATE_FILENAME);
        if (existsSync(stateFile)) {
          dirs.add(projectConfig);
        }
      }
    } catch {
      // Permission denied or other error — skip this root.
    }
  }
  return Array.from(dirs).sort();
}

/**
 * Update ALL installs under the user's home (projects + homedir).
 */
export async function updateAll(opts: UpdateOptions): Promise<UpdateResult[]> {
  const { extractDir, version } = await downloadAndExtract(opts.version, opts.repo);
  const configDirs = await findAllStateDirs();
  const results: UpdateResult[] = [];
  for (const dir of configDirs) {
    try {
      const result = await updateConfigDir(dir, extractDir, version, opts);
      results.push(result);
    } catch (err) {
      process.stderr.write(
        `[ERROR] Failed to update ${dir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  printUpdateSummary(results);
  await offerPackageUpdates(opts.dryRun);
  return results;
}

/**
 * Update just THIS project (CWD).
 */
export async function updateProject(opts: UpdateOptions): Promise<UpdateResult[]> {
  const { extractDir, version } = await downloadAndExtract(opts.version, opts.repo);
  const configDir = getProjectConfigPath();
  const result = await updateConfigDir(configDir, extractDir, version, opts);
  printUpdateSummary([result]);
  await offerPackageUpdates(opts.dryRun);
  return [result];
}

/**
 * Update just the home dir.
 */
export async function updateHomedir(opts: UpdateOptions): Promise<UpdateResult[]> {
  const { extractDir, version } = await downloadAndExtract(opts.version, opts.repo);
  const configDir = getHomedirConfigPath();
  const result = await updateConfigDir(configDir, extractDir, version, opts);
  printUpdateSummary([result]);
  await offerPackageUpdates(opts.dryRun);
  return [result];
}

/**
 * Print a summary of update results.
 */
function printUpdateSummary(results: UpdateResult[]): void {
  for (const r of results) {
    process.stdout.write(
      `\nUpdated ${r.configDir}\n` +
        `  ${r.updated} files updated, ${r.skipped} skipped, ${r.created} created\n` +
        `  Version: ${r.fromVersion ?? "none"} → ${r.toVersion}\n`,
    );
    if (r.backups.length > 0) {
      process.stdout.write(`  Backups at ${path.dirname(r.backups[0].backupPath)}/\n`);
    }
  }
  // Final prompt
  const anyBackups = results.some((r) => r.backups.length > 0);
  if (anyBackups) {
    const firstBackupDir = results
      .find((r) => r.backups.length > 0)
      ?.backups[0]?.backupPath;
    if (firstBackupDir) {
      process.stdout.write(
        `\nPersonalize the updated files if needed — your old versions are backed up at ${path.dirname(firstBackupDir)}/\n`,
      );
    }
  }
}

/**
 * Offer to update MCP packages (uvx/npx cache refresh) and check system deps.
 *
 * Called after config files are updated. Runs the same dep check as init,
 * then re-warms the uvx/npx cache for all MCP servers.
 */
async function offerPackageUpdates(dryRun: boolean): Promise<void> {
  // Re-check system deps (may need updates since last install)
  process.stdout.write("\nChecking system dependencies...\n\n");
  const { checkAndInstallSystemDeps } = await import("./sysdeps.js");
  const sysDeps = await checkAndInstallSystemDeps(dryRun);

  for (const dep of sysDeps.deps) {
    if (dep.present) {
      process.stdout.write(`  ✓ ${dep.name}\n`);
    } else {
      process.stdout.write(`  ✗ ${dep.name}\n`);
    }
  }

  if (sysDeps.missing.length > 0) {
    process.stdout.write("\n");
    process.stdout.write("  Some dependencies are missing. See the messages above.\n");
  }

  // Offer to refresh MCP package cache
  process.stdout.write("\n");
  process.stdout.write("Refresh MCP server packages (updates to latest versions)?\n");
  process.stdout.write("  This re-downloads all MCP servers via uvx/npx.\n");

  if (dryRun) {
    process.stdout.write("[DRY-RUN] Would refresh all MCP packages\n");
    return;
  }

  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("  [Y/n]: ", (a: string) => { rl.close(); resolve(a); });
  });

  if (answer.trim().toLowerCase().startsWith("n")) {
    process.stdout.write("  Skipped — MCP packages will update on next opencode launch.\n");
    return;
  }

  // Re-warm the uvx/npx cache
  process.stdout.write("\nRefreshing MCP packages...\n");
  const { preDownloadPackages } = await import("./install-packages.js");
  const { HOMEDIR_MCP_TEMPLATES, PROJECT_MCP_TEMPLATES } = await import("./mcp-templates.js");
  const pkgResult = await preDownloadPackages(
    { ...HOMEDIR_MCP_TEMPLATES, ...PROJECT_MCP_TEMPLATES },
    dryRun,
  );

  process.stdout.write("\nPackages refreshed:\n");
  for (const name of pkgResult.installed) {
    process.stdout.write(`  ✓ ${name}\n`);
  }
  for (const fail of pkgResult.failed) {
    process.stdout.write(`  ✗ ${fail.name}: ${fail.error}\n`);
  }
}