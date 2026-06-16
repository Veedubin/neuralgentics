/**
 * Neuralgentics update interceptor.
 *
 * Intercepts OpenCode's built-in auto-updater so that vanilla upstream
 * binaries never overwrite our patched build. When an update is available
 * the user is directed to the Neuralgentics update script instead.
 */

import { execSync } from "node:child_process";

/** Base directory for opencode source repository. */
const OPENCODE_BASE_DIR =
  process.env.NEURALGENTICS_OPENCODE_BASE_DIR ?? "/home/jcharles/Projects/MCP-Servers/neuralgentics/opencode-base";

export class NeuralgenticsUpdater {
  static readonly IS_NEURALGENTICS = true;

  static isActive(): boolean {
    return this.IS_NEURALGENTICS;
  }

  /**
   * Check whether the opencode-base remote has newer commits than the local branch.
   *
   * @returns A human-readable message if updates exist, or `undefined` if up-to-date.
   */
  static checkLatest(): string | undefined {
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