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
import { fileURLToPath } from "node:url";

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
import { getHomedirConfigPath, getProjectConfigPath, getBackupDir } from "./paths.js";
import { HOMEDIR_MCP_TEMPLATES, PROJECT_MCP_TEMPLATES, type McpBlock } from "./mcp-templates.js";
import { runAllPrompts, DEFAULT_PROMPT_CONFIG, type PromptFlags, type PromptConfig, type BackendMode, type EmbeddingMode } from "./prompts.js";
import { backupFile, type BackupRecord } from "./backup.js";
import { preDownloadPackages, type PreDownloadResult } from "./install-packages.js";
import { checkAndInstallSystemDeps, type SysDepsResult } from "./sysdeps.js";
import { bootstrapDatabase, type BootstrapResult, type TeamDbConfig } from "./db-setup.js";

/**
 * Copy static assets (agent personas, skills, AGENTS.md) from the npm
 * package directory to the target config directory.
 *
 * The npm package ships `.opencode/agents/`, `.opencode/skills/`, and
 * `.opencode/AGENTS.md` alongside `dist/`. When the CLI runs via `npx`,
 * `__dirname` points to `dist/` inside the extracted package, so
 * `path.join(__dirname, "..", ".opencode")` finds the bundled assets.
 *
 * Files are copied with SHA-256 idempotency — existing files with
 * identical content are skipped (no backup created). Modified files
 * are backed up before overwrite.
 *
 * Returns the count of agents, skills, and AGENTS.md status.
 */
async function copyStaticAssets(
  targetDir: string,
  dryRun: boolean,
): Promise<{ agents: number; skills: number; agentsMd: boolean }> {
  // Find the bundled .opencode directory (sibling of dist/, two levels up from init.js)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const bundledOpencode = path.join(__dirname, "..", "..", ".opencode");
  const bundledAgents = path.join(bundledOpencode, "agents");
  const bundledSkills = path.join(bundledOpencode, "skills");
  const bundledAgentsMd = path.join(bundledOpencode, "AGENTS.md");

  let agentCount = 0;
  let skillCount = 0;
  let agentsMdCopied = false;

  // Copy agent personas
  if (existsSync(bundledAgents)) {
    const targetAgents = path.join(targetDir, "agents");
    await fs.mkdir(targetAgents, { recursive: true });
    const files = await fs.readdir(bundledAgents);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const src = path.join(bundledAgents, file);
      const dest = path.join(targetAgents, file);
      const srcContent = await fs.readFile(src, "utf-8");
      const srcHash = createHash("sha256").update(srcContent).digest("hex");
      if (existsSync(dest)) {
        const destContent = await fs.readFile(dest, "utf-8");
        const destHash = createHash("sha256").update(destContent).digest("hex");
        if (srcHash === destHash) {
          agentCount++;
          continue; // Identical, skip
        }
        // Different — back up then overwrite
        if (!dryRun) {
          await backupFile(targetAgents, file);
          await fs.writeFile(dest, srcContent, "utf-8");
        }
      } else {
        if (!dryRun) await fs.writeFile(dest, srcContent, "utf-8");
      }
      agentCount++;
    }
  }

  // Copy skills (directories with SKILL.md)
  if (existsSync(bundledSkills)) {
    const targetSkills = path.join(targetDir, "skills");
    await fs.mkdir(targetSkills, { recursive: true });
    const dirs = await fs.readdir(bundledSkills);
    for (const dir of dirs) {
      const srcDir = path.join(bundledSkills, dir);
      const stat = await fs.stat(srcDir);
      if (!stat.isDirectory()) continue;
      const destDir = path.join(targetSkills, dir);
      // Copy the entire skill directory
      await fs.mkdir(destDir, { recursive: true });
      const entries = await fs.readdir(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          await fs.mkdir(destPath, { recursive: true });
          const subEntries = await fs.readdir(srcDir + "/" + entry.name);
          for (const sub of subEntries) {
            await fs.copyFile(
              path.join(srcDir, entry.name, sub),
              path.join(destDir, entry.name, sub),
            );
          }
        } else {
          await fs.copyFile(srcPath, destPath);
        }
      }
      skillCount++;
    }
  }

  // Copy AGENTS.md (only if it doesn't exist — don't overwrite user's)
  if (existsSync(bundledAgentsMd)) {
    const destAgentsMd = path.join(targetDir, "AGENTS.md");
    if (!existsSync(destAgentsMd)) {
      if (!dryRun) {
        await fs.copyFile(bundledAgentsMd, destAgentsMd);
      }
      agentsMdCopied = true;
    }
  }

  return { agents: agentCount, skills: skillCount, agentsMd: agentsMdCopied };
}

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
  // Lazy-load + quantize (v0.9.6+) — all opt-in.
  quantize?: string; // "auto" | "fp32" | "fp16" | "int8" (default "auto")
  device?: string; // "cpu" | "cuda" | undefined (env fallback)
  noLazyLoad?: boolean; // true => EAGER=true
  idleMin?: number; // minutes before idle sidecar unloads the model
  statusPort?: number; // sidecar HTTP /status port
  embedModel?: string; // "bge-m3" | "bge-large" | "all-MiniLM-L6-v2" (default "bge-m3")
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
// Quantize + lazy-load resolution (v0.9.6+)
// ---------------------------------------------------------------------------

const VALID_DTYPES = new Set(["fp32", "fp16", "int8", "auto"]);

/**
 * Resolve the embedding dtype from CLI args + env, per the user's spec:
 *   - Explicit `--quantize` wins (must be fp32|fp16|int8; "auto" falls through).
 *   - `--device cuda` → fp16, `--device cpu` → int8.
 *   - NEURALGENTICS_EMBED_DEVICE env var (cuda → fp16, cpu → int8).
 *   - Default: int8 (CPU).
 */
function resolveQuantize(args: InitOptions): string {
  const explicit = args.quantize ?? "auto";
  if (!VALID_DTYPES.has(explicit)) {
    throw new NeuralgenticsError(
      `Invalid --quantize value: ${JSON.stringify(explicit)}. Expected fp32|fp16|int8|auto.`,
      "Re-run with --quantize=fp32, --quantize=fp16, --quantize=int8, or --quantize=auto.",
    );
  }
  if (explicit !== "auto") return explicit;

  const device = args.device ?? process.env.NEURALGENTICS_EMBED_DEVICE;
  if (device === "cuda") return "fp16";
  return "int8"; // cpu or unset → int8
}

/** Resolve the embedding device (for .env), CLI --device wins, then env, then "cpu". */
function resolveDevice(args: InitOptions): string {
  if (args.device) return args.device;
  return process.env.NEURALGENTICS_EMBED_DEVICE ?? "cpu";
}

interface QuantizeEnvVars {
  dtype: string;
  device: string;
  eager: string; // "true" | "false"
  idleMin: string;
  statusPort: string;
  embedModel: string;
}

function resolveQuantizeEnvVars(args: InitOptions): QuantizeEnvVars {
  return {
    dtype: resolveQuantize(args),
    device: resolveDevice(args),
    eager: args.noLazyLoad === true ? "true" : "false",
    idleMin: String(args.idleMin ?? 5),
    statusPort: String(args.statusPort ?? 50052),
    embedModel: args.embedModel ?? "bge-m3",
  };
}

/**
 * Update or create the `.env` file with the quantize + lazy-load vars.
 *
 * Non-destructive: if `.env` already exists, only the 5 quantize vars are
 * updated (all other lines preserved). If `.env` doesn't exist, a minimal
 * `.env` is created with just the quantize vars + a pointer to
 * compose.example.env for the full set.
 *
 * Called AFTER `bringUpBackend` so the existing `.env`-from-template flow
 * is not disturbed.
 */
async function writeEnvQuantizeVars(target: string, args: InitOptions): Promise<void> {
  const vars = resolveQuantizeEnvVars(args);
  const envPath = path.join(target, ".env");
  const lines: string[] = [
    `NEURALGENTICS_EMBED_DTYPE=${vars.dtype}`,
    `NEURALGENTICS_EMBED_DEVICE=${vars.device}`,
    `EAGER=${vars.eager}`,
    `IDLE_MIN=${vars.idleMin}`,
    `NEURALGENTICS_SIDECAR_STATUS_PORT=${vars.statusPort}`,
    `NEURALGENTICS_EMBED_MODEL=${vars.embedModel}`,
  ];

  if (!existsSync(envPath)) {
    // Create a minimal .env. The user can merge compose.example.env later.
    const header =
      "# .env — generated by `neuralgentics init` (quantize + lazy-load vars).\n" +
      "# For the full set of compose vars, see compose.example.env.\n\n";
    await fs.writeFile(envPath, header + lines.join("\n") + "\n", "utf-8");
    return;
  }

  // Update existing .env: replace the 5 quantize vars, preserve everything else.
  const existing = (await fs.readFile(envPath, "utf-8")).split("\n");
  const varKeys = new Set([
    "NEURALGENTICS_EMBED_DTYPE",
    "NEURALGENTICS_EMBED_DEVICE",
    "EAGER",
    "IDLE_MIN",
    "NEURALGENTICS_SIDECAR_STATUS_PORT",
    "NEURALGENTICS_EMBED_MODEL",
  ]);
  const updated = new Set<string>();
  const result: string[] = [];
  for (const line of existing) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") {
      result.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const key = eqIdx > 0 ? trimmed.slice(0, eqIdx).trim() : "";
    if (varKeys.has(key)) {
      // Replace with the resolved value.
      switch (key) {
        case "NEURALGENTICS_EMBED_DTYPE":
          result.push(`NEURALGENTICS_EMBED_DTYPE=${vars.dtype}`);
          break;
        case "NEURALGENTICS_EMBED_DEVICE":
          result.push(`NEURALGENTICS_EMBED_DEVICE=${vars.device}`);
          break;
        case "EAGER":
          result.push(`EAGER=${vars.eager}`);
          break;
        case "IDLE_MIN":
          result.push(`IDLE_MIN=${vars.idleMin}`);
          break;
        case "NEURALGENTICS_SIDECAR_STATUS_PORT":
          result.push(`NEURALGENTICS_SIDECAR_STATUS_PORT=${vars.statusPort}`);
          break;
        case "NEURALGENTICS_EMBED_MODEL":
          result.push(`NEURALGENTICS_EMBED_MODEL=${vars.embedModel}`);
          break;
      }
      updated.add(key);
    } else {
      result.push(line);
    }
  }
  // Append any vars that weren't already in the file.
  for (const line of lines) {
    const key = line.slice(0, line.indexOf("="));
    if (!updated.has(key)) result.push(line);
  }
  await fs.writeFile(envPath, result.join("\n"), "utf-8");
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

  // 10b. Write quantize + lazy-load vars to .env (non-destructive).
  //      Runs even in --dry-run-safe flows because .env is a plain file,
  //      but skip in dry-run to keep the dry-run truly non-writing.
  if (!dryRun) {
    await writeEnvQuantizeVars(target, args);
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

/**
 * Check whether the `neuralgentics-postgres` container is already running
 * under podman or docker. Non-destructive: only reads container state.
 */
function isPostgresRunning(): boolean {
  try {
    const podmanResult = execSync(
      "podman ps --filter name=neuralgentics-postgres --format '{{.Status}}'",
      { stdio: "pipe" },
    );
    if (podmanResult.toString().trim()) return true;
  } catch {
    // podman not installed or not on PATH — fall through to docker.
  }
  try {
    const dockerResult = execSync(
      "docker ps --filter name=neuralgentics-postgres --format '{{.Status}}'",
      { stdio: "pipe" },
    );
    if (dockerResult.toString().trim()) return true;
  } catch {
    // docker not installed or not on PATH.
  }
  return false;
}

/** Build the compose-up command string for the detected tool. */
function composeUpCommand(tool: ComposeTool): string {
  return tool.tool === "docker" ? "docker compose up -d" : "podman-compose up -d";
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
    "Do you want to set up the database containers now? [Y/n] " +
      "(containers will NOT be recreated if already running) ",
  );
  if (answer.trim().toLowerCase().startsWith("n")) {
    process.stdout.write(
      `\nTo set up the database later:\n` +
        `  1. Copy compose.example.env to .env and edit your credentials\n` +
        `  2. Run: ${composeUpCommand(tool)}\n` +
        `  Docs: https://github.com/Veedubin/neuralgentics#containers\n\n`,
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

  // 1. NEVER touch a running container — skip entirely if it's already up.
  if (isPostgresRunning()) {
    process.stdout.write(
      "neuralgentics-postgres is already running. Skipping container setup.\n",
    );
    return;
  }

  // 2. Handle .env conservatively — never overwrite an existing one.
  const composeExample = path.join(target, "compose.example.env");
  const envFile = path.join(target, ".env");
  if (existsSync(envFile)) {
    // User already has credentials — use as-is.
  } else if (existsSync(composeExample)) {
    await fs.copyFile(composeExample, envFile);
    process.stdout.write(
      `Created .env from compose.example.env. Edit it to set your database ` +
        `credentials, then run: ${composeUpCommand(tool)}\n`,
    );
    // Stop here — let the user edit credentials before starting containers.
    return;
  } else {
    process.stdout.write(
      `No .env or compose.example.env found in ${target}.\n` +
        `Create a .env with your database credentials (POSTGRES_USER, ` +
        `POSTGRES_PASSWORD, POSTGRES_DB), then run: ${composeUpCommand(tool)}\n` +
        `Docs: https://github.com/Veedubin/neuralgentics#containers\n`,
    );
    return;
  }

  // 3. .env exists and containers are not running — safe to start.
  try {
    const cmd = composeUpCommand(tool);
    execSync(cmd, { cwd: target, stdio: "pipe", timeout: 120_000 });
    process.stdout.write(
      `\nContainers started via \`${cmd}\`.\n` +
        `Database available at localhost:6200 (user/pass from .env file).\n`,
    );
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

// ---------------------------------------------------------------------------
// Two-init flows: initHomedir() + initProject()
// ---------------------------------------------------------------------------

/** Options for the homedir init flow. */
export interface InitHomedirOptions {
  target: string;       // override target dir (or ".")
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  repo: string;
  version: string;      // "latest" or "X.Y.Z"
  embedded: boolean;
  team: boolean;
  cpuEmbed: boolean;
  autoEmbed: boolean;
  gpuEmbed: boolean;
}

/** Options for the project init flow. */
export interface InitProjectOptions {
  target: string;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  repo: string;
  version: string;
  embedded: boolean;
  team: boolean;
  cpuEmbed: boolean;
  autoEmbed: boolean;
  gpuEmbed: boolean;
  withBackend: boolean;
  offline: boolean;
  quantize: string;
  device: string | undefined;
  noLazyLoad: boolean;
  idleMin: number;
  statusPort: number;
  embedModel: string;
}

/**
 * Build an opencode.json object for the homedir config.
 *
 * Contains: provider block with ollama models, LSP, formatter, compaction,
 * tool_output, small_model, server, and HOMEDIR_MCP_TEMPLATES.
 */
function buildHomedirOpencodeJson(promptConfig: PromptConfig): Record<string, unknown> {
  const embeddingDim = promptConfig.embedding === "gpu" ? "1024" : "384";

  const mcpBlock: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(HOMEDIR_MCP_TEMPLATES)) {
    mcpBlock[name] = {
      type: entry.type,
      enabled: entry.enabled,
      command: entry.command,
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.args ? { args: entry.args } : {}),
    };
  }

  return {
    "$schema": "https://opencode.ai/config.json",
    "autoupdate": true,
    "tool_output": {
      "max_lines": 10000,
      "max_bytes": 512000,
    },
    "compaction": {
      "keep": [
        "**/AGENTS.md",
        "**/TASKS.md",
        "**/CONTEXT.md",
      ],
    },
    "small_model": "ollama/gpt-oss-20b",
    "provider": {
      "ollama": {
        "name": "ollama",
        "api": "https://ollama.com/v1",
        "options": {
          "apiKey": "{env:OLLAMA_API_KEY}",
        },
        "models": {
          "kimi-k2.6": { "name": "kimi-k2.6" },
          "glm-5.2": { "name": "glm-5.2" },
          "deepseek-v4-pro": { "name": "deepseek-v4-pro" },
          "devstral-2:123b": { "name": "devstral-2:123b" },
          "deepseek-v4-flash": { "name": "deepseek-v4-flash" },
          "qwen3-coder-next": { "name": "qwen3-coder-next" },
          "minimax-m3": { "name": "minimax-m3" },
          "mistral-large-3:675b": { "name": "mistral-large-3:675b" },
          "qwen3.5": { "name": "qwen3.5" },
          "devstral-small-2:24b": { "name": "devstral-small-2:24b" },
        },
      },
    },
    "lsp": {
      "typescript": {
        "disabled": false,
        "command": ["npx", "typescript-language-server", "--stdio"],
      },
    },
    "formatter": {
      "prettier": {
        "disabled": false,
      },
    },
    "mcp": mcpBlock,
  };
}

/**
 * Build an opencode.json object for the project config.
 *
 * Contains: plugin, instructions, and PROJECT_MCP_TEMPLATES with pgembed env.
 */
function buildProjectOpencodeJson(promptConfig: PromptConfig): Record<string, unknown> {
  const mcpBlock: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(PROJECT_MCP_TEMPLATES)) {
    // Apply embedding mode to memini-ai-dev env
    const env = { ...entry.env };
    if (name === "memini-ai-dev") {
      env.MEMINI_EMBEDDING_DIM = promptConfig.embedding === "gpu" ? "1024" : "384";
      // Apply team server settings if team mode was chosen
      if (promptConfig.backend === "team") {
        const host = promptConfig.teamHost ?? "localhost";
        const port = promptConfig.teamPort ?? "5432";
        const db = promptConfig.teamDatabase ?? "neuralgentics";
        const user = promptConfig.teamUser ?? "postgres";
        const password = promptConfig.teamPassword ?? "";
        env.MEMINI_DB_URL = `postgresql://${user}:${password}@${host}:${port}/${db}`;
        env.MEMINI_VECTOR_BACKEND = "postgres-external";
      }
    }
    mcpBlock[name] = {
      type: entry.type,
      enabled: entry.enabled,
      command: entry.command,
      env,
      ...(entry.args ? { args: entry.args } : {}),
    };
  }

  return {
    "plugin": ["@veedubin/neuralgentics"],
    "instructions": ["AGENTS.md"],
    "mcp": mcpBlock,
  };
}

/**
 * Write a JSON config file, backing up the existing one first.
 */
async function writeConfigWithBackup(
  configDir: string,
  fileName: string,
  content: string,
  force: boolean,
  dryRun: boolean,
): Promise<BackupRecord | null> {
  const filePath = path.join(configDir, fileName);
  let backup: BackupRecord | null = null;

  if (existsSync(filePath)) {
    // Check idempotency via SHA-256
    const existingSha = await computeFileSha256(filePath);
    const newSha = createHash("sha256").update(content).digest("hex");
    if (existingSha === newSha && !force) {
      // Idempotent — no change needed
      return null;
    }
    if (!dryRun) {
      backup = await backupFile(configDir, filePath);
    }
  }

  if (dryRun) {
    process.stdout.write(`[DRY-RUN] Would write ${filePath}\n`);
    return null;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return backup;
}

/**
 * Write a state file for a two-init install.
 */
async function writeTwoInitState(
  configDir: string,
  version: string,
  installType: "homedir" | "project",
  files: Record<string, { path: string; sha256: string }>,
): Promise<void> {
  const statePath = path.join(configDir, STATE_FILENAME);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const state = {
    version: 1,
    installed_version: version,
    installed_at: now,
    updated_at: now,
    cli_version: CLI_VERSION,
    source: "github" as const,
    repo: "Veedubin/neuralgentics",
    target: configDir,
    files: Object.fromEntries(
      Object.entries(files).map(([k, v]) => [
        k,
        {
          sha256: v.sha256,
          user_modified: false,
          installed_from: version,
          last_known_shipped_sha256: v.sha256,
          merged: false,
        },
      ]),
    ),
    last_backup: null as string | null,
    installType,
  };
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Shared install logic for both --init-homedir and --init-project.
 *
 * The only differences are:
 *   - Target directory (homedir config path vs project config path)
 *   - Config builder (homedir config vs project config)
 *   - State type label ("homedir" vs "project")
 *   - Re-run command string for the error message
 *   - DB bootstrap only runs for team server (pgembed manages its own DB)
 */
interface InstallOptions {
  target: string;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  version: string;
  embedded: boolean;
  team: boolean;
  cpuEmbed: boolean;
  autoEmbed: boolean;
  gpuEmbed: boolean;
}

async function runInstall(
  args: InstallOptions,
  mode: "homedir" | "project",
): Promise<number> {
  const configDir = args.target && args.target !== "."
    ? path.resolve(args.target)
    : mode === "homedir"
      ? getHomedirConfigPath()
      : getProjectConfigPath();

  const label = mode === "homedir" ? "global" : "project";
  const rerunCmd = mode === "homedir" ? "--init-homedir" : "--init-project";

  process.stdout.write(`\nInstalling ${label} config to: ${configDir}\n`);

  // Run interactive prompts unless flags skip them
  const promptFlags: PromptFlags = {
    yes: args.yes,
    embedded: args.embedded,
    team: args.team,
    cpuEmbed: args.cpuEmbed,
    autoEmbed: args.autoEmbed,
    gpuEmbed: args.gpuEmbed,
  };

  if (args.dryRun) {
    const dryConfig = { ...DEFAULT_PROMPT_CONFIG };
    process.stdout.write(`[DRY-RUN] Would write ${label} config to ${configDir}\n`);
    process.stdout.write(`[DRY-RUN] Backend: ${dryConfig.backend}\n`);
    process.stdout.write(`[DRY-RUN] Embedding: ${dryConfig.embedding}\n`);
    return 0;
  }

  // CHECK SYSTEM DEPS FIRST — before writing any files.
  process.stdout.write("\nChecking system dependencies...\n\n");
  const sysDeps = await checkAndInstallSystemDeps(args.dryRun);

  for (const dep of sysDeps.deps) {
    if (dep.present) {
      process.stdout.write(`  ✓ ${dep.name}\n`);
    } else {
      process.stdout.write(`  ✗ ${dep.name}\n`);
    }
  }

  // If ANY deps are missing, show ALL install commands at once
  if (sysDeps.missing.length > 0) {
    const hasBlocking = sysDeps.blockingMissing.length > 0;

    process.stdout.write("\n");
    if (hasBlocking) {
      process.stdout.write("  The following commands need to be run before continuing:\n");
    } else {
      process.stdout.write("  Some optional dependencies are missing. Install them when ready:\n");
    }
    process.stdout.write("\n");

    const seenCmds = new Set<string>();
    for (const dep of sysDeps.deps) {
      if (!dep.present && dep.installCommand) {
        if (!seenCmds.has(dep.installCommand)) {
          seenCmds.add(dep.installCommand);
          process.stdout.write(`    ${dep.installCommand}\n`);
        }
      }
    }

    if (hasBlocking) {
      process.stdout.write("\n");
      process.stdout.write("  After installing the above, re-run:\n");
      process.stdout.write(`    neuralgentics ${rerunCmd}\n`);
      return 1;
    } else {
      process.stdout.write("\n");
      process.stdout.write("  Everything else will work without these.\n");
    }
  }

  process.stdout.write("\n");

  // All deps present — proceed with the install.
  // Create config dir BEFORE prompts (prompts write .env to this dir)
  await fs.mkdir(configDir, { recursive: true });

  const promptConfig = await runAllPrompts(configDir, promptFlags);

  // Write opencode.json (different builder per mode)
  const config = mode === "homedir"
    ? buildHomedirOpencodeJson(promptConfig)
    : buildProjectOpencodeJson(promptConfig);
  const configJson = JSON.stringify(config, null, 2) + "\n";
  await writeConfigWithBackup(configDir, "opencode.json", configJson, args.force, args.dryRun);

  // Write state file
  const sha = createHash("sha256").update(configJson).digest("hex");
  await writeTwoInitState(
    configDir,
    args.version === "latest" ? "latest" : args.version,
    mode,
    { "opencode.json": { path: "opencode.json", sha256: sha } },
  );

  // Copy agent personas, skills, AGENTS.md from the npm package
  const assets = await copyStaticAssets(configDir, args.dryRun || false);

  // Pre-download MCP packages (both modes)
  process.stdout.write("\nPre-downloading MCP packages...\n");
  const pkgResult: PreDownloadResult = await preDownloadPackages(
    { ...HOMEDIR_MCP_TEMPLATES, ...PROJECT_MCP_TEMPLATES },
    args.dryRun,
  );

  // DB bootstrap — ONLY for team server mode (pgembed manages its own DB)
  let dbResult: BootstrapResult | null = null;
  if (promptConfig.backend === "team" &&
      promptConfig.teamHost !== undefined &&
      promptConfig.teamPort !== undefined &&
      promptConfig.teamDatabase !== undefined) {
    process.stdout.write("\nSetting up team database connection...\n");
    dbResult = await bootstrapDatabase(
      promptConfig.backend,
      {
        host: promptConfig.teamHost,
        port: promptConfig.teamPort,
        database: promptConfig.teamDatabase,
        user: promptConfig.teamUser,
        password: promptConfig.teamPassword,
      },
      args.dryRun,
    );
  }

  // Print summary
  process.stdout.write(`\nOK neuralgentics ${label} config installed in ${configDir}\n`);
  process.stdout.write(`Config:  ${configDir}/opencode.json\n`);
  process.stdout.write(`Backend: ${promptConfig.backend}\n`);
  process.stdout.write(`Embed:   ${promptConfig.embedding}\n`);
  process.stdout.write(`Agents:  ${assets.agents} personas\n`);
  process.stdout.write(`Skills:  ${assets.skills} skills\n`);

  // Packages installed section
  process.stdout.write("\nPackages installed:\n");
  for (const name of pkgResult.installed) {
    process.stdout.write(`  ✓ ${name}\n`);
  }
  for (const fail of pkgResult.failed) {
    process.stdout.write(`  ✗ ${fail.name}: ${fail.error}\n`);
  }

  // Database section
  if (promptConfig.backend === "team" && dbResult !== null) {
    process.stdout.write("\nDatabase:\n");
    if (dbResult.success) {
      process.stdout.write(`  ✓ ${dbResult.message}\n`);
      if (dbResult.details) process.stdout.write(`  ✓ ${dbResult.details}\n`);
    } else {
      process.stdout.write(`  ✗ ${dbResult.message}\n`);
      process.stdout.write(
        `  ⚠ The DB is not ready. Fix the issue above, then re-run:\n` +
          `      neuralgentics ${rerunCmd}\n`,
      );
    }
  } else if (promptConfig.backend === "pgembed") {
    process.stdout.write("\nDatabase:\n");
    process.stdout.write("  ✓ Built-in database (pgembed)\n");
    process.stdout.write("    Uses a local Unix socket — no username or password needed.\n");
    process.stdout.write("    Data stored in ~/.local/share/memini-ai/pgembed/data\n");
    process.stdout.write("    To switch to a team server later, re-run with --team\n");
  }

  process.stdout.write(`\nState:   ${configDir}/${STATE_FILENAME}\n`);

  // Only offer to launch opencode after --init-project (not --init-homedir,
  // since homedir needs a project init before opencode can run).
  if (mode === "project") {
    process.stdout.write("\n");
    // Create a fresh readline for the launch question
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const launch = await new Promise<string>((resolve) => {
      rl.question("  Launch opencode now? [Y/n]: ", (answer: string) => resolve(answer));
    });
    rl.close();
    if (!launch.trim().toLowerCase().startsWith("n")) {
      process.stdout.write("\n  Starting opencode...\n\n");
      try {
        execSync("opencode", { stdio: "inherit", shell: process.env.SHELL ?? "bash" });
      } catch {
        process.stdout.write("  Could not launch opencode. Run it manually:\n");
        process.stdout.write("    opencode\n");
      }
      return 0;
    }
    process.stdout.write("\n  To start opencode, run:\n");
    process.stdout.write("    opencode\n");
  } else {
    process.stdout.write(`\nNext: neuralgentics --init-project\n`);
  }
  return 0;
}

/** Install global config to the homedir config directory. */
export async function runInitHomedir(args: InitHomedirOptions): Promise<number> {
  return runInstall(args, "homedir");
}

/** Install project config to {CWD}/.opencode/ (or --target). */
export async function runInitProject(args: InitProjectOptions): Promise<number> {
  return runInstall(args, "project");
}

// ---------------------------------------------------------------------------
// Re-exports from sibling modules (single import surface for cli.ts)
// ---------------------------------------------------------------------------

export {
  runMigrateEmbeddings,
  type MigrateEmbeddingsOptions,
  type MigrateEmbeddingsResult,
} from "./migrate.js";