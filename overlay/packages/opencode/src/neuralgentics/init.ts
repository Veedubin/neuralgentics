/**
 * `neuralgentics init` command — TypeScript port of the Python
 * `neuralgentics-cli/src/neuralgentics/init_cmd.py`.
 *
 * Bootstraps a project directory with the neuralgentics OpenCode plugin by:
 *   1. Resolving the requested plugin version (`latest` or `X.Y.Z`).
 *   2. Downloading + verifying the GitHub release tarball.
 *   3. Extracting + placing files per the file-placement table.
 *   4. Merging `opencode.json` (preserves user's provider/mcp/lsp/formatter).
 *   5. Running `npm install --no-audit --no-fund` in `.opencode/`.
 *   6. Interactive container prompt (podman-compose / docker).
 *   7. Writing the state file with the file manifest.
 *   8. Printing a plain-text success summary.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, existsSync, renameSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { randomBytes } from "node:crypto";

import {
  downloadTarball,
  extractTarball,
  resolveVersion,
  verifySha256,
  NetworkError,
  NeuralgenticsError as DownloadNeuralgenticsError,
  Sha256Mismatch,
  TarballCorrupt,
  ExtractionFailed,
  VersionNotFound,
} from "./download.js";

/**
 * Local base class for init-flow errors. Extends the download module's
 * `NeuralgenticsError` so all CLI errors share a single `instanceof` root
 * (callers only need to import from `init.js`).
 */
export class NeuralgenticsError extends DownloadNeuralgenticsError {}
import {
  mergeOpencodeJsonWithDiff,
  OpenCodeJsonInvalid,
  parseOpencodeJson,
  serializeOpencodeJson,
} from "./merge.js";

/** CLI version (mirrors `neuralgentics-cli/src/neuralgentics/__init__.py`). */
export const CLI_VERSION = "0.1.0";

/** Plugin entry added to the `plugin` array. */
const PLUGIN_REFERENCE = "@veedubin/neuralgentics";

/** Regex for a valid `X.Y.Z` semver. */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Top-level files that are copied only if they don't already exist. */
const COPY_IF_ABSENT = [
  "docker-compose.yml",
  "podman-compose.yml",
  "compose.example.env",
  "install.sh",
];

/** Top-level directory prefixes that are copied recursively (overwriting). */
const COPY_TREE_PREFIXES = [
  ".opencode/agents/",
  ".opencode/skills/",
  "docker/",
  "node_modules/@veedubin/neuralgentics/",
];

/** Files that are merged (not copied) when they already exist. */
const MERGE_FILES = [
  ".opencode/opencode.json",
  ".opencode/package.json",
];

/** Files that are copied only if absent (warn + skip if present). */
const COPY_IF_ABSENT_WARN = [
  ".opencode/AGENTS.md",
  ".opencode/.gitignore",
  ".opencode/package-lock.json",
];

/** Paths that are never a safe init target unless `--force` is set. */
const SCARY_PATHS = new Set(["/", "/tmp", "/tmp/"]);

/** Project markers that indicate a real project dir. */
const PROJECT_MARKERS = [
  ".git",
  "pyproject.toml",
  "package.json",
  "Cargo.toml",
  ".opencode",
];

/** Name of the state file inside `{target}/.opencode/`. */
const STATE_FILENAME = ".neuralgentics-state.json";

/** Read chunk size for SHA256 computation (64 KiB). */
const CHUNK_SIZE = 64 * 1024;

// ---------------------------------------------------------------------------
// Error subclasses (mirrors `errors.py` — exit codes preserved).
// ---------------------------------------------------------------------------

export class OpencodeNotFound extends NeuralgenticsError {
  readonly exitCode = 4;
  readonly remediation =
    "Install OpenCode, then re-run: curl -fsSL https://opencode.ai/install.sh | bash";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "OpencodeNotFound";
  }
}

export class NpmNotFound extends NeuralgenticsError {
  readonly exitCode = 5;
  readonly remediation =
    "Install Node.js 20+ from https://nodejs.org/, then re-run `npm install` in .opencode/.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "NpmNotFound";
  }
}

export class NpmInstallFailed extends NeuralgenticsError {
  readonly exitCode = 13;
  readonly remediation =
    "Check Node.js version, network, and disk space. Try running `npm install` manually.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "NpmInstallFailed";
  }
}

export class OfflineNoBundle extends NeuralgenticsError {
  readonly exitCode = 15;
  readonly remediation = "Run without --offline. Bundled tarball support is planned for v0.2.0+.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "OfflineNoBundle";
  }
}

export class TargetNotDirectory extends NeuralgenticsError {
  readonly exitCode = 17;
  readonly remediation = "Create the directory or specify a different target with --target.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "TargetNotDirectory";
  }
}

export class TargetRefused extends NeuralgenticsError {
  readonly exitCode = 18;
  readonly remediation = "Use --force to proceed anyway, or pick a project directory.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "TargetRefused";
  }
}

export class BackupFailed extends NeuralgenticsError {
  readonly exitCode = 19;
  readonly remediation = "Check disk space and permissions in the target directory.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "BackupFailed";
  }
}

export class ComposeNotFound extends NeuralgenticsError {
  readonly exitCode = 11;
  readonly remediation = "Install Docker or podman-compose to set up the database containers.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "ComposeNotFound";
  }
}

export class ComposeUpFailed extends NeuralgenticsError {
  readonly exitCode = 12;
  readonly remediation = "Check the container runtime status, port conflicts, and disk space.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "ComposeUpFailed";
  }
}

// ---------------------------------------------------------------------------
// Parsed CLI options (mirrors the argparse Namespace).
// ---------------------------------------------------------------------------

export interface InitOptions {
  init: boolean;
  target: string;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  repo: string;
  version: string; // "latest" or "X.Y.Z" — "cli" sentinel handled by cli.ts
  offline: boolean;
  withBackend?: boolean;
}

// ---------------------------------------------------------------------------
// State file models (mirrors `state.py`).
// ---------------------------------------------------------------------------

interface FileRecord {
  sha256: string;
  user_modified: boolean;
  installed_from: string;
  last_known_shipped_sha256: string | null;
  merged: boolean | null;
}

interface StateFile {
  version: number;
  installed_version: string;
  installed_at: string;
  updated_at: string;
  cli_version: string;
  source: "github";
  repo: string;
  target: string;
  files: Record<string, FileRecord>;
  backend?: {
    enabled: boolean;
    compose_file: string;
    compose_tool: string;
    env_file: string | null;
    containers: string[];
  } | null;
  last_backup: string | null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Entry point for `neuralgentics init`. Returns the process exit code.
 */
export async function runInit(args: InitOptions): Promise<number> {
  const target = path.resolve(args.target);
  const force = args.force;
  const dryRun = args.dryRun;

  // 1. Ensure target exists (mkdir -p), refuse scary locations / symlink .opencode.
  await ensureTarget(target, force);

  // 2. Check opencode is on PATH.
  if (!isOnPath("opencode")) {
    throw new OpencodeNotFound("opencode is not installed or not on PATH.");
  }

  // Resolve the requested version, honoring --offline conflicts.
  if (args.offline && args.version === "latest") {
    throw new OfflineNoBundle(
      "Offline mode requires a bundled tarball, which is not available in this version.",
    );
  }
  const version = await resolveVersion(args.version, args.repo);

  // 3. Validate resolved version is X.Y.Z.
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Resolved version ${JSON.stringify(version)} is not X.Y.Z.`);
  }

  if (dryRun) {
    const wouldBackup = existsSync(path.join(target, ".opencode")) &&
      statSync(path.join(target, ".opencode")).isDirectory();
    const backupDirName = wouldBackup ? backupPath(target).name : null;
    printDryRunSummary(target, version, args.repo, wouldBackup, backupDirName);
    return 0;
  }

  // 4-5. Download + verify + extract.
  const extractDir = await downloadAndExtract(version, args.repo);

  // 6. Pre-flight: compute what would change vs. existing target.
  const changes = await computeChanges(extractDir, target);

  // 7. Backup the existing .opencode/ if anything would change.
  let backupPathStr: string | null = null;
  if (shouldBackup(target, changes)) {
    backupPathStr = await doBackup(target);
  }

  // 8. Place files per the file-placement table.
  const manifest = await placeFiles(extractDir, target, version, force, backupPathStr);

  // 9. Run npm install.
  await runNpmInstall(path.join(target, ".opencode"));

  // 10. Interactive container prompt.
  if (args.withBackend) {
    await bringUpBackend(target, args.yes);
  } else if (!args.yes) {
    await promptForBackend(target);
  }

  // 11. Write state file.
  await writeState(target, version, manifest, args.repo, backupPathStr);

  // 12. Print summary.
  printSuccessSummary(target, version, extractDir, backupPathStr);
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOnPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe", shell: process.env.SHELL ?? "bash" });
    return true;
  } catch {
    return false;
  }
}

async function ensureTarget(target: string, force: boolean): Promise<void> {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    // Does not exist — create it.
    await fs.mkdir(target, { recursive: true });
    stat = statSync(target);
  }
  if (!stat.isDirectory()) {
    throw new TargetNotDirectory(`${target} exists and is not a directory.`);
  }

  if (!force) {
    if (isScaryTarget(target)) {
      throw new TargetRefused(
        `Refusing to init into ${target} (looks like a home/root/tmp dir). Use --force to proceed anyway.`,
      );
    }
    const opencodePath = path.join(target, ".opencode");
    if (existsSync(opencodePath) && statSync(opencodePath).isSymbolicLink?.()) {
      throw new TargetRefused(
        `${target}/.opencode is a symlink; refusing to move it. Use --force to proceed anyway.`,
      );
    }
  }
}

function isScaryTarget(target: string): boolean {
  const resolved = path.resolve(target);
  if (SCARY_PATHS.has(resolved) || SCARY_PATHS.has(resolved + "/")) return true;
  const home = os.homedir();
  if (resolved === home) return true;
  const parent = path.dirname(resolved);
  if (parent === home) {
    return !PROJECT_MARKERS.some((m) => existsSync(path.join(resolved, m)));
  }
  return false;
}

async function downloadAndExtract(version: string, repo: string): Promise<string> {
  const { tarballPath, checksumsPath } = await downloadTarball(version, repo);
  await verifySha256(tarballPath, checksumsPath);
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), `neuralgentics-extract-${version}-`));
  await extractTarball(tarballPath, extractDir);
  return extractDir;
}

/** Classify a tarball-relative path into its destination relative to target. */
function classifyDestination(rel: string): string | null {
  if (COPY_IF_ABSENT.includes(rel) || COPY_IF_ABSENT_WARN.includes(rel) || MERGE_FILES.includes(rel)) {
    return rel;
  }
  for (const prefix of COPY_TREE_PREFIXES) {
    if (rel.startsWith(prefix)) return rel;
  }
  if (rel.startsWith(".opencode/")) return rel;
  return null;
}

async function placeFiles(
  extractDir: string,
  target: string,
  version: string,
  force: boolean,
  backupPathStr: string | null,
): Promise<Record<string, FileRecord>> {
  const manifest: Record<string, FileRecord> = {};
  const opencodeDir = path.join(target, ".opencode");
  await fs.mkdir(opencodeDir, { recursive: true });

  const files = await iterFiles(extractDir);
  for (const src of files) {
    const rel = path.relative(extractDir, src).split(path.sep).join("/");
    const destRel = classifyDestination(rel);
    if (destRel === null) {
      process.stderr.write(`Skipping unrecognised tarball entry: ${rel}\n`);
      continue;
    }

    const dest = path.join(target, destRel);
    // Where the user's *previous* version of this file lives now (after a backup).
    let prevDest = dest;
    if (backupPathStr !== null) {
      const innerRel = destRel.startsWith(".opencode/") ? destRel.slice(".opencode/".length) : destRel;
      prevDest = path.join(backupPathStr, innerRel);
    }

    let merged: boolean | null = null;
    if (destRel === ".opencode/opencode.json") {
      await mergeOpencodeJsonFile(src, dest, prevDest, force);
      merged = true;
    } else if (destRel === ".opencode/package.json") {
      await mergePackageJsonFile(src, dest, prevDest, force);
      merged = false;
    } else if (COPY_IF_ABSENT_WARN.includes(destRel)) {
      if (existsSync(dest) && !force) {
        process.stderr.write(
          `${destRel} already exists; skipping (use --force to overwrite).\n`,
        );
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      merged = false;
    } else if (COPY_IF_ABSENT.includes(destRel)) {
      if (existsSync(dest) && !force) {
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      merged = false;
    } else {
      // Copy-tree entry (agents/, skills/, docker/, node_modules/...).
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      merged = false;
    }

    const sha = await computeFileSha256(dest);
    const shippedSha = await computeFileSha256(src);
    manifest[destRel] = {
      sha256: sha,
      user_modified: false,
      installed_from: version,
      last_known_shipped_sha256: shippedSha,
      merged: destRel === ".opencode/opencode.json" ? merged : null,
    };
  }
  return manifest;
}

async function mergeOpencodeJsonFile(
  src: string,
  dest: string,
  prevDest: string,
  _force: boolean,
): Promise<void> {
  const shippedText = await fs.readFile(src, "utf-8");
  const shipped = parseOpencodeJson(shippedText);
  if (!existsSync(prevDest)) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, serializeOpencodeJson(shipped), "utf-8");
    return;
  }
  const userText = await fs.readFile(prevDest, "utf-8");
  let user: ReturnType<typeof parseOpencodeJson>;
  try {
    user = parseOpencodeJson(userText);
  } catch {
    // User's existing file is broken JSON. Their data is in the backup.
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, serializeOpencodeJson(shipped), "utf-8");
    return;
  }
  const { merged, changes } = mergeOpencodeJsonWithDiff(user, shipped);
  if (changes.length === 0) {
    if (prevDest !== dest) {
      // Restore the user's config to the new dest.
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, serializeOpencodeJson(merged), "utf-8");
    }
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, serializeOpencodeJson(merged), "utf-8");
}

async function mergePackageJsonFile(
  src: string,
  dest: string,
  prevDest: string,
  _force: boolean,
): Promise<void> {
  const shippedText = await fs.readFile(src, "utf-8");
  const shipped = JSON.parse(shippedText) as Record<string, unknown>;
  if (!existsSync(prevDest)) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, JSON.stringify(shipped, null, 2) + "\n", "utf-8");
    return;
  }
  let user: Record<string, unknown>;
  try {
    user = JSON.parse(await fs.readFile(prevDest, "utf-8")) as Record<string, unknown>;
  } catch {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, JSON.stringify(shipped, null, 2) + "\n", "utf-8");
    return;
  }
  const userDeps = (user["dependencies"] as Record<string, string> | undefined) ?? {};
  const shippedDeps = (shipped["dependencies"] as Record<string, string> | undefined) ?? {};
  // User wins on key conflict.
  user["dependencies"] = { ...shippedDeps, ...userDeps };
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify(user, null, 2) + "\n", "utf-8");
}

async function runNpmInstall(opencodeDir: string): Promise<void> {
  if (!isOnPath("npm")) {
    throw new NpmNotFound("npm is not installed or not on PATH.");
  }
  try {
    execSync("npm install --no-audit --no-fund", {
      cwd: opencodeDir,
      stdio: "pipe",
      timeout: 300_000,
    });
  } catch (exc) {
    const stderr = exc instanceof Error && "stderr" in exc
      ? String((exc as { stderr?: Buffer | string }).stderr ?? "")
      : exc instanceof Error ? exc.message : String(exc);
    throw new NpmInstallFailed(`npm install failed in ${opencodeDir}: ${stderr.trim()}`);
  }
}

async function writeState(
  target: string,
  version: string,
  manifest: Record<string, FileRecord>,
  repo: string,
  backupPathStr: string | null,
): Promise<void> {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let lastBackup: string | null = null;
  if (backupPathStr !== null) {
    const rel = path.relative(target, backupPathStr);
    lastBackup = rel && rel.length > 0 ? rel : backupPathStr;
  }
  const state: StateFile = {
    version: 1,
    installed_version: version,
    installed_at: now,
    updated_at: now,
    cli_version: CLI_VERSION,
    source: "github",
    repo,
    target,
    files: manifest,
    last_backup: lastBackup,
  };
  const statePath = path.join(target, ".opencode", STATE_FILENAME);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = statePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  // Atomic rename on the same filesystem.
  renameSync(tmp, statePath);
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function printSuccessSummary(
  target: string,
  version: string,
  extractDir: string,
  backupPathStr: string | null,
): void {
  const agentsDir = path.join(extractDir, ".opencode", "agents");
  let agents = 0;
  try {
    const entries = require("node:fs").readdirSync(agentsDir) as string[];
    agents = entries.filter((e) => e.endsWith(".md")).length;
  } catch {
    agents = 0;
  }
  const skillsDir = path.join(extractDir, ".opencode", "skills");
  let skills = 0;
  try {
    const entries = require("node:fs").readdirSync(skillsDir) as string[];
    skills = entries.filter((e) => {
      try {
        return require("node:fs").statSync(path.join(skillsDir, e)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    skills = 0;
  }
  const statePath = path.join(target, ".opencode", STATE_FILENAME);
  const useColor = shouldUseColor();
  const check = useColor ? "\u2713" : "OK";
  const backupLine = backupPathStr !== null ? `Backup:  ${backupPathStr}\n` : "";
  process.stdout.write(
    `${check} neuralgentics v${version} initialized in ${target}\n` +
      `\n` +
      `Plugin:  ${target}/.opencode/node_modules/@veedubin/neuralgentics/ (after \`npm install\`)\n` +
      `Config:  ${target}/.opencode/opencode.json\n` +
      `Agents:  ${agents} personas\n` +
      `Skills:  ${skills} skills\n` +
      `State:   ${statePath}\n` +
      backupLine +
      `\n` +
      `Next: opencode\n` +
      `\n` +
      `Alternative install: curl -fsSL ` +
      `https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash\n`,
  );
}

function printDryRunSummary(
  target: string,
  version: string,
  repo: string,
  wouldBackup: boolean,
  backupDirName: string | null,
): void {
  process.stdout.write(`WOULD initialize neuralgentics v${version} in ${target}\n`);
  process.stdout.write(
    `WOULD download tarball from github.com/${repo}/releases/download/v${version}/\n`,
  );
  process.stdout.write(
    "WOULD extract + place .opencode/agents/, .opencode/skills/, opencode.json (merged)\n",
  );
  if (wouldBackup) {
    const label = backupDirName ?? ".opencode-bak-{ts}/";
    process.stdout.write(`WOULD back up existing .opencode/ -> ${label}\n`);
  }
  process.stdout.write("WOULD run: npm install --no-audit --no-fund\n");
  process.stdout.write("WOULD write state file.\n");
}

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

async function computeChanges(
  extractDir: string,
  target: string,
): Promise<Record<string, string>> {
  const changes: Record<string, string> = {};
  const files = await iterFiles(extractDir);
  for (const src of files) {
    const rel = path.relative(extractDir, src).split(path.sep).join("/");
    const destRel = classifyDestination(rel);
    if (destRel === null) continue;
    const dest = path.join(target, destRel);

    let action: string;
    if (destRel === ".opencode/opencode.json") {
      action = await simulateMergeOpencodeJson(src, dest);
    } else if (destRel === ".opencode/package.json") {
      action = await simulateMergePackageJson(src, dest);
    } else if (COPY_IF_ABSENT_WARN.includes(destRel) || COPY_IF_ABSENT.includes(destRel)) {
      action = existsSync(dest) ? "no_change" : "would_create";
    } else {
      if (!existsSync(dest)) {
        action = "would_create";
      } else {
        action = (await sameBytes(src, dest)) ? "no_change" : "would_change";
      }
    }
    changes[destRel] = action;
  }
  return changes;
}

async function simulateMergeOpencodeJson(src: string, dest: string): Promise<string> {
  if (!existsSync(dest)) return "would_create";
  const shippedText = await fs.readFile(src, "utf-8");
  let shipped: ReturnType<typeof parseOpencodeJson>;
  try {
    shipped = parseOpencodeJson(shippedText);
  } catch {
    return "would_change";
  }
  const userText = await fs.readFile(dest, "utf-8");
  let user: ReturnType<typeof parseOpencodeJson>;
  try {
    user = parseOpencodeJson(userText);
  } catch {
    return "would_change";
  }
  try {
    const { changes } = mergeOpencodeJsonWithDiff(user, shipped);
    if (changes.length === 0) return "no_change";
    const existingCanonical = serializeOpencodeJson(user);
    const mergedCanonical = serializeOpencodeJson(
      mergeOpencodeJsonWithDiff(user, shipped).merged,
    );
    return mergedCanonical === existingCanonical ? "no_change" : "would_change";
  } catch {
    return "would_change";
  }
}

async function simulateMergePackageJson(src: string, dest: string): Promise<string> {
  if (!existsSync(dest)) return "would_create";
  let shipped: Record<string, unknown>;
  let user: Record<string, unknown>;
  try {
    shipped = JSON.parse(await fs.readFile(src, "utf-8")) as Record<string, unknown>;
  } catch {
    return "would_change";
  }
  try {
    user = JSON.parse(await fs.readFile(dest, "utf-8")) as Record<string, unknown>;
  } catch {
    return "would_change";
  }
  const shippedDeps = (shipped["dependencies"] as Record<string, string> | undefined) ?? {};
  const userDeps = (user["dependencies"] as Record<string, string> | undefined) ?? {};
  const mergedDeps = { ...shippedDeps, ...userDeps };
  const userDepsObj = userDeps as Record<string, unknown>;
  const mergedDepsObj = mergedDeps as Record<string, unknown>;
  return JSON.stringify(mergedDepsObj) === JSON.stringify(userDepsObj) ? "no_change" : "would_change";
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  return (await computeFileSha256(a)) === (await computeFileSha256(b));
}

function shouldBackup(target: string, changes: Record<string, string>): boolean {
  const opencodePath = path.join(target, ".opencode");
  if (!existsSync(opencodePath) || !statSync(opencodePath).isDirectory()) return false;
  return Object.values(changes).some((a) => a === "would_change" || a === "would_create");
}

function backupPath(target: string): { dir: string; name: string } {
  const ts = Math.floor(Date.now() / 1000);
  let base = path.join(target, `.opencode-bak-${ts}`);
  if (!existsSync(base)) {
    return { dir: base, name: path.basename(base) };
  }
  // Collision: add a short random suffix.
  while (existsSync(base)) {
    const suffix = randomBytes(2).toString("hex");
    base = path.join(target, `.opencode-bak-${ts}-${suffix}`);
  }
  return { dir: base, name: path.basename(base) };
}

async function doBackup(target: string): Promise<string> {
  const src = path.join(target, ".opencode");
  const { dir: dest } = backupPath(target);
  try {
    // fs.renameSync is atomic on the same filesystem (mirrors shutil.move).
    renameSync(src, dest);
  } catch (exc) {
    throw new BackupFailed(
      `Could not move ${src} to ${dest}: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
  return dest;
}

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

// ---------------------------------------------------------------------------
// Container bring-up (interactive prompt).
// ---------------------------------------------------------------------------

interface ComposeTool {
  tool: string;
  file: string;
}

function detectComposeTool(): ComposeTool | null {
  // Check podman-compose first (preferred on Fedora).
  try {
    execSync("command -v podman-compose", { stdio: "pipe", shell: process.env.SHELL ?? "bash" });
    return { tool: "podman-compose", file: "docker-compose.yml" };
  } catch {
    // Fall through to docker.
  }
  try {
    execSync("command -v docker", { stdio: "pipe", shell: process.env.SHELL ?? "bash" });
    return { tool: "docker", file: "docker-compose.yml" };
  } catch {
    return null;
  }
}

async function promptForBackend(target: string): Promise<void> {
  const tool = detectComposeTool();
  if (tool === null) {
    process.stdout.write(
      `\nNeither podman-compose nor docker is on PATH.\n` +
        `To set up the database containers manually, see:\n` +
        `  https://github.com/Veedubin/neuralgentics#containers\n\n`,
    );
    return;
  }
  const answer = await askQuestion(
    "Do you want to set up the database containers now? [Y/n] ",
  );
  if (answer.trim().toLowerCase().startsWith("n")) {
    process.stdout.write(
      `\nSkipping container setup. To do it later:\n` +
        `  cd ${target}\n` +
        `  cp compose.example.env .env\n` +
        `  ${tool.tool === "docker" ? "docker compose up -d" : "podman-compose up -d"}\n` +
        `Docs: https://github.com/Veedubin/neuralgentics#containers\n\n`,
    );
    return;
  }
  await bringUpBackend(target, true);
}

async function bringUpBackend(target: string, _yes: boolean): Promise<void> {
  const tool = detectComposeTool();
  if (tool === null) {
    throw new ComposeNotFound("Neither docker nor podman-compose is available on PATH.");
  }
  const composeExample = path.join(target, "compose.example.env");
  const envFile = path.join(target, ".env");
  if (existsSync(composeExample) && !existsSync(envFile)) {
    await fs.copyFile(composeExample, envFile);
  }
  try {
    const cmd = tool.tool === "docker" ? "docker compose up -d" : "podman-compose up -d";
    execSync(cmd, { cwd: target, stdio: "pipe", timeout: 120_000 });
    process.stdout.write(`\nContainers started via \`${cmd}\`.\n`);
  } catch (exc) {
    throw new ComposeUpFailed(
      `compose up -d failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
}

function askQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}