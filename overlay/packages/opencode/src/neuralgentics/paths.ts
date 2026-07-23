/**
 * Cross-platform path detection for the neuralgentics two-init installer.
 *
 * Detects the user's global opencode config directory based on platform:
 *   - Linux/WSL: ~/.config/opencode/
 *   - Mac:      ~/Library/Application Support/opencode/
 *   - Windows:  Out of scope (user uses WSL = Linux path).
 *
 * Exports:
 *   - getHomedirConfigPath()    — global config dir
 *   - getProjectConfigPath()    — {cwd}/.opencode/
 *   - getBackupDir(basePath)    — {basePath}/opencode-bak/
 *   - getBackupFilePath(backupDir, originalName) — timestamped backup file path
 */

import * as path from "node:path";
import * as os from "node:os";

/**
 * Returns the global opencode config directory for the current platform.
 *
 * - Linux/WSL (and any non-darwin unix): `~/.config/opencode/`
 * - Mac (darwin): `~/Library/Application Support/opencode/`
 *
 * Windows is out of scope — the user runs WSL which presents as Linux.
 */
export function getHomedirConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode");
  }
  // Linux / WSL / other unix-like — assume XDG-ish ~/.config/opencode/
  return path.join(os.homedir(), ".config", "opencode");
}

/**
 * Returns the project-level opencode config directory.
 *
 * @param cwd — working directory (defaults to `process.cwd()`)
 */
export function getProjectConfigPath(cwd?: string): string {
  return path.join(cwd ?? process.cwd(), ".opencode");
}

/**
 * Returns the backup directory path for a given base config directory.
 *
 * @param basePath — the config directory (homedir or project) that may hold
 *                   files to back up
 */
export function getBackupDir(basePath: string): string {
  return path.join(basePath, "opencode-bak");
}

/**
 * Returns the user personalization overrides directory for a config dir.
 *
 * `.opencode/overrides/` holds user-authored `.md` files named the same as
 * default agent personas (e.g. `coder.md`). On init/update, each override's
 * body (YAML frontmatter stripped) is appended to the bottom of the matching
 * default agent file. The overrides directory itself is NEVER written to
 * by init or update — it is read-only from the installer's perspective.
 *
 * @param configDir — the config directory (homedir or project `.opencode/`)
 */
export function getOverridesDir(configDir: string): string {
  return path.join(configDir, "overrides");
}

/**
 * Returns a timestamped backup file path inside `backupDir`.
 *
 * Filename format: `{originalName}-{ISO-timestamp-with-ms}.json`
 * Example: `opencode-2026-07-17T19-45-32-123Z.json`
 *
 * Files changed in the same update run share the same timestamp (down to ms),
 * so you can see which files were moved together.
 *
 * @param backupDir — the backup directory
 * @param originalName — the original file's basename (without extension is
 *                       fine; we always append `.json`)
 */
export function getBackupFilePath(backupDir: string, originalName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // originalName may already end with .json; strip it so we don't double up
  const base = originalName.endsWith(".json")
    ? originalName.slice(0, -".json".length)
    : originalName;
  return path.join(backupDir, `${base}-${ts}.json`);
}