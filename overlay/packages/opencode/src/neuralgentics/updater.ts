/**
 * Neuralgentics update interceptor.
 *
 * Intercepts OpenCode's built-in auto-updater so that vanilla upstream
 * binaries never overwrite our patched build. When an update is available
 * the user is directed to the Neuralgentics update script instead.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Base directory for the opencode source repository.
 *
 * T-UPDATER-PATH-001: this previously hardcoded the original developer's
 * machine path (`/home/jcharles/...`), which shipped to every npm user and
 * made `checkLatest()` run a doomed `git fetch` (15s timeout) against a
 * non-existent directory on every invocation. The base dir is now
 * opt-in via `NEURALGENTICS_OPENCODE_BASE_DIR`; when unset — or when the
 * directory is not a git checkout — update checking is silently skipped.
 */
const OPENCODE_BASE_DIR = process.env.NEURALGENTICS_OPENCODE_BASE_DIR ?? "";

/** True when OPENCODE_BASE_DIR points at a real git checkout. */
function isDevCheckout(): boolean {
  return (
    OPENCODE_BASE_DIR !== "" && existsSync(join(OPENCODE_BASE_DIR, ".git"))
  );
}

export class NeuralgenticsUpdater {
  static readonly IS_NEURALGENTICS = true;

  static isActive(): boolean {
    return this.IS_NEURALGENTICS;
  }

  /**
   * Check whether the opencode-base remote has newer commits than the local branch.
   *
   * @returns A human-readable message if updates exist, or `undefined` if up-to-date,
   *          if no dev checkout is configured, or if git commands fail.
   */
  static checkLatest(): string | undefined {
    // Only run git when explicitly configured with a real checkout — never
    // on end-user machines (npm installs have no opencode-base clone).
    if (!isDevCheckout()) return undefined;
    try {
      execSync("git fetch origin", {
        cwd: OPENCODE_BASE_DIR,
        stdio: "pipe",
        timeout: 15_000,
      });

      const output = execSync(
        "git rev-list --count HEAD..origin/dev",
        { cwd: OPENCODE_BASE_DIR, encoding: "utf-8", timeout: 10_000 },
      ).trim();

      const count = parseInt(output, 10);
      if (count > 0) {
        return `origin/dev is ${count} commit(s) ahead`;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Notify the user that an update is available and direct them to the
   * Neuralgentics update script (does NOT auto-apply).
   */
  static applyUpdate(): void {
    console.error(
      "[Neuralgentics] Update available. Run: ./scripts/update-opencode.sh",
    );
  }
}