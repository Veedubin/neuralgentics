/**
 * ExternalSkillsFetcher — clones/refreshes external skill repos.
 *
 * Reads external_skills.enabled from .env, runs git clone/pull for
 * each configured repo, and writes MANIFEST.json with commit SHAs
 * and attribution metadata.
 *
 * @module external_fetcher
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ============================================================================
// Types
// ============================================================================

/** Configuration for a single external skill repository. */
export interface RepoConfig {
  /** Short name used as directory name and manifest key. */
  name: string;
  /** Git clone URL. */
  url: string;
  /** SPDX license identifier. */
  license: string;
  /** Attribution string for provenance stamping. */
  attribution: string;
}

/** A single repo entry in MANIFEST.json. */
export interface ManifestRepoEntry {
  url: string;
  commit_sha: string;
  license: string;
  attribution: string;
}

/** The full MANIFEST.json structure. */
export interface Manifest {
  version: number;
  updated_at: string;
  repos: Record<string, ManifestRepoEntry>;
}

/** Result returned by fetch(). */
export interface FetchResult {
  enabled: boolean;
  manifest_path: string;
  repos: Record<string, { status: string; commit_sha: string }>;
  errors: string[];
}

/** Minimal env reader — reads KEY=value lines from a .env file. */
export interface EnvReader {
  get(key: string): string | undefined;
}

// ============================================================================
// Network error patterns for offline detection
// ============================================================================

const NETWORK_ERROR_PATTERNS = [
  "Could not resolve host",
  "Network is unreachable",
  "Connection refused",
  "Could not read from remote",
  "fatal: unable to access",
  "Operation timed out",
  "Failed to connect to",
  "SSL certificate problem",
  "connection timed out",
];

function isNetworkError(message: string): boolean {
  return NETWORK_ERROR_PATTERNS.some((p) => message.includes(p));
}

// ============================================================================
// Default Repos
// ============================================================================

/** Hardcoded list of external skill repos for Phase 2. */
export const DEFAULT_REPOS: RepoConfig[] = [
  {
    name: "ai-research-skills",
    url: "https://github.com/Orchestra-Research/AI-Research-SKILLs.git",
    license: "MIT",
    attribution:
      "Copyright 2025 Claude AI Research Skills Contributors. Used under MIT License.",
  },
  {
    name: "ui-ux-pro-max-skill",
    url: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git",
    license: "MIT",
    attribution:
      "Copyright 2024 Next Level Builder. Used under MIT License.",
  },
];

// ============================================================================
// ExecFn type (injectable for tests)
// ============================================================================

export type ExecFn = (
  cmd: string,
  args: string[],
  cwd?: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Default exec implementation using node:child_process. */
const defaultExec: ExecFn = async (cmd, args, cwd) => {
  const execFileAsync = promisify(execFile);
  try {
    const result = await execFileAsync(cmd, args, {
      cwd,
      timeout: 60_000, // 60 second timeout
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (err: unknown) {
    // ExecException has code, stdout, stderr
    const execErr = err as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? execErr.message ?? String(err),
      exitCode: typeof execErr.code === "string" ? 1 : (execErr.code ?? 1),
    };
  }
};

// ============================================================================
// readEnvFile — pure file I/O .env parser (no dotenv dependency)
// ============================================================================

/**
 * Reads a .env file and returns an EnvReader.
 *
 * Parses KEY="value", KEY='value', and KEY=value lines.
 * Skips comments (lines starting with #) and empty lines.
 * Returns an empty EnvReader (get() always returns undefined) if the
 * file doesn't exist or can't be read.
 *
 * Uses synchronous I/O because .env files are small and this is
 * typically called once at startup.
 */
export function readEnvFile(filePath: string): EnvReader {
  const map = new Map<string, string>();
  try {
    // Use dynamic import-compatible require for Node.js
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      map.set(key, value);
    }
  } catch {
    // File doesn't exist → empty env.
  }
  return {
    get(key: string): string | undefined {
      return map.get(key);
    },
  };
}

// ============================================================================
// ExternalSkillsFetcher
// ============================================================================

export class ExternalSkillsFetcher {
  private readonly homeDir: string;
  private readonly env: EnvReader;
  private readonly exec: ExecFn;

  /**
   * @param homeDir — Path to ~/.neuralgentics/ (user data dir).
   * @param env — EnvReader for reading .env configuration.
   * @param exec — Injected exec function (for testing). Defaults to real child_process.
   */
  constructor(
    homeDir: string,
    env: EnvReader,
    exec: ExecFn = defaultExec,
  ) {
    this.homeDir = homeDir;
    this.env = env;
    this.exec = exec;
  }

  /** Returns true if external_skills.enabled is "true" in the env. */
  isEnabled(): boolean {
    return (this.env.get("external_skills.enabled") ?? "false").toLowerCase() === "true";
  }

  /** Returns the path to ~/.neuralgentics/external_skills/ */
  externalDir(): string {
    return join(this.homeDir, "external_skills");
  }

  /**
   * Clone or refresh all configured external skill repositories.
   *
   * 1. Reads external_skills.enabled from env. If false/unset → no-op.
   * 2. Ensures ~/.neuralgentics/external_skills/ exists.
   * 3. For each repo: clone (if missing) or git pull --ff-only.
   * 4. Captures commit SHA for each repo.
   * 5. Writes MANIFEST.json.
   *
   * @param repos — List of repo configs (default: DEFAULT_REPOS).
   * @returns FetchResult with status per repo and any errors.
   */
  async fetch(repos: RepoConfig[] = DEFAULT_REPOS): Promise<FetchResult> {
    const externalDir = this.externalDir();
    const errors: string[] = [];
    const repoResults: Record<string, { status: string; commit_sha: string }> = {};

    if (!this.isEnabled()) {
      return {
        enabled: false,
        manifest_path: join(externalDir, "MANIFEST.json"),
        repos: {},
        errors: [],
      };
    }

    // Ensure external_skills directory exists
    await mkdir(externalDir, { recursive: true });

    for (const repo of repos) {
      const repoDir = join(externalDir, repo.name);
      const gitDir = join(repoDir, ".git");

      // Check if repo directory already exists with .git
      let gitDirExists = false;
      try {
        const gitStat = await stat(gitDir);
        gitDirExists = gitStat.isDirectory();
      } catch {
        gitDirExists = false;
      }

      if (gitDirExists) {
        // Repo exists → git pull --ff-only
        const pullResult = await this.exec("git", ["pull", "--ff-only"], repoDir);
        if (pullResult.exitCode !== 0) {
          const errMsg = pullResult.stderr || pullResult.stdout;
          if (isNetworkError(errMsg)) {
            errors.push(`[${repo.name}] git pull failed (offline?): ${errMsg.trim()}`);
          } else {
            errors.push(`[${repo.name}] git pull failed: ${errMsg.trim()}`);
          }
          // Use existing clone's HEAD SHA regardless of error type
          const shaResult = await this.exec("git", ["rev-parse", "HEAD"], repoDir);
          repoResults[repo.name] = {
            status: "skipped-network-error",
            commit_sha: shaResult.exitCode === 0 ? shaResult.stdout.trim() : "unknown",
          };
          continue;
        }

        // Capture new HEAD SHA after successful pull
        const shaResult = await this.exec("git", ["rev-parse", "HEAD"], repoDir);
        repoResults[repo.name] = {
          status: "updated",
          commit_sha: shaResult.exitCode === 0 ? shaResult.stdout.trim() : "unknown",
        };
      } else {
        // Ensure parent directory exists for clone
        await mkdir(externalDir, { recursive: true });

        // Fresh clone
        const cloneResult = await this.exec("git", ["clone", "--depth", "1", repo.url, repoDir]);
        if (cloneResult.exitCode !== 0) {
          const errMsg = cloneResult.stderr || cloneResult.stdout;
          errors.push(`[${repo.name}] git clone failed: ${errMsg.trim()}`);
          repoResults[repo.name] = {
            status: "skipped-network-error",
            commit_sha: "unknown",
          };
          continue;
        }

        // Capture HEAD SHA after clone
        const shaResult = await this.exec("git", ["rev-parse", "HEAD"], repoDir);
        repoResults[repo.name] = {
          status: "cloned",
          commit_sha: shaResult.exitCode === 0 ? shaResult.stdout.trim() : "unknown",
        };
      }
    }

    // Build and write MANIFEST.json
    const manifest: Manifest = {
      version: 1,
      updated_at: new Date().toISOString(),
      repos: {},
    };
    for (const repo of repos) {
      const result = repoResults[repo.name];
      manifest.repos[repo.name] = {
        url: repo.url,
        commit_sha: result?.commit_sha ?? "unknown",
        license: repo.license,
        attribution: repo.attribution,
      };
    }

    await this.writeManifest(manifest);

    return {
      enabled: true,
      manifest_path: join(externalDir, "MANIFEST.json"),
      repos: repoResults,
      errors,
    };
  }

  /**
   * Read MANIFEST.json from disk. Returns null if the file doesn't exist
   * or can't be parsed.
   */
  async readManifest(): Promise<Manifest | null> {
    const manifestPath = join(this.externalDir(), "MANIFEST.json");
    try {
      const data = await readFile(manifestPath, "utf-8");
      return JSON.parse(data) as Manifest;
    } catch {
      return null;
    }
  }

  /**
   * Write MANIFEST.json to disk (pretty-printed).
   */
  async writeManifest(manifest: Manifest): Promise<void> {
    const manifestPath = join(this.externalDir(), "MANIFEST.json");
    await mkdir(this.externalDir(), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }
}