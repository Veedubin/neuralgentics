/**
 * System dependency check + install.
 *
 * Verifies the host has the tools required to run the MCP server fleet:
 *   - uv   (Python package runner — used by videre-mcp, markitdown, duckdb, memini-ai-dev)
 *   - node (Node.js runtime)
 *   - npx  (Node package runner — used by ssh-mcp-server, playwright, github-mcp,
 *           searxng, calculator)
 *
 * On Linux, also verifies the system ML libraries videre-mcp (Florence-2 /
 * PaddleOCR) needs:
 *   - libgl1
 *   - libglib2.0-0
 *
 * Policy:
 *   - If uv / node / npx are missing, print install instructions and return
 *     them in `missing`. The caller decides whether to exit (the homedir flow
 *     cannot proceed without these) or just warn.
 *   - If Linux system ML deps are missing, return them in `missing` with the
 *     exact `sudo apt-get install` command the user should run. We NEVER
 *     auto-sudo — the user must consent to root-level package installs.
 *   - On macOS the ML libs ship with the system, so the check is skipped.
 */

import { execSync } from "node:child_process";
import * as os from "node:os";

export interface SysDepsResult {
  /** Tools that were already present (no action taken). */
  installed: string[];
  /** Tools that were present but optional / out of scope (e.g. ML libs on mac). */
  skipped: string[];
  /** Tools / libs that are missing. The caller should surface remediation. */
  missing: string[];
}

/** Check whether a command exists on PATH. */
function hasCmd(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, {
      stdio: "pipe",
      shell: process.env.SHELL ?? "bash",
    });
    return true;
  } catch {
    return false;
  }
}

/** Get the version string of a command (for informational logging). */
function versionOf(cmd: string): string {
  try {
    return execSync(`${cmd} --version`, {
      stdio: "pipe",
      shell: process.env.SHELL ?? "bash",
    })
      .toString()
      .trim()
      .split("\n")[0];
  } catch {
    return "(unknown version)";
  }
}

/**
 * Check whether a Debian/Ubuntu package is installed (`ii` status).
 * Only meaningful on Linux + dpkg systems.
 */
function dpkgInstalled(pkg: string): boolean {
  try {
    execSync(`dpkg -l ${pkg} 2>/dev/null | grep -q '^ii'`, {
      stdio: "pipe",
      shell: process.env.SHELL ?? "bash",
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether this host is Linux (the only platform that needs the ML apt libs). */
function isLinux(): boolean {
  return os.platform() === "linux";
}

/**
 * Check + (best effort) install system dependencies required by the MCP fleet.
 *
 * @param dryRun  When true, print what would be installed but execute nothing.
 *                We still CHECK presence (so we can report what's missing).
 */
export async function checkAndInstallSystemDeps(dryRun: boolean): Promise<SysDepsResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  // --- Required runner tools -------------------------------------------------

  if (hasCmd("uv")) {
    installed.push(`uv (${versionOf("uv")})`);
  } else {
    missing.push("uv");
    process.stdout.write(
      "✗ uv is not installed. Install uv:\n" +
        "    curl -LsSf https://astral.sh/uv/install.sh | sh\n",
    );
  }

  if (hasCmd("node")) {
    installed.push(`node (${versionOf("node")})`);
  } else {
    missing.push("node");
    process.stdout.write(
      "✗ node is not installed. Install Node.js 20+:\n" +
        "    https://nodejs.org/en/download/\n",
    );
  }

  if (hasCmd("npx")) {
    installed.push(`npx (${versionOf("npx")})`);
  } else {
    missing.push("npx");
    process.stdout.write(
      "✗ npx is not installed. It ships with Node.js — install Node.js 20+:\n" +
        "    https://nodejs.org/en/download/\n",
    );
  }

  // --- videre-mcp system ML deps (Linux only) --------------------------------

  if (isLinux()) {
    const libs = ["libgl1", "libglib2.0-0"];
    const aptCmd = `sudo apt-get install -y ${libs.join(" ")}`;
    let allPresent = true;
    for (const lib of libs) {
      if (dpkgInstalled(lib)) {
        installed.push(lib);
      } else {
        allPresent = false;
        missing.push(lib);
      }
    }
    if (!allPresent) {
      if (dryRun) {
        process.stdout.write(
          `[DRY-RUN] Would install system ML deps: ${libs.join(", ")}\n` +
            `  Command: ${aptCmd}\n`,
        );
      } else {
        // NEVER auto-sudo. Surface the exact command for the user to run.
        process.stdout.write(
          "✗ videre-mcp needs system ML libraries that are missing: " +
            `${libs.join(", ")}.\n` +
            "  Run this command (requires sudo):\n" +
            `    ${aptCmd}\n`,
        );
      }
    }
  } else {
    // macOS / other: ML libs ship with the system.
    skipped.push("libgl1 (macos/system-provided)");
    skipped.push("libglib2.0-0 (macos/system-provided)");
  }

  return { installed, skipped, missing };
}