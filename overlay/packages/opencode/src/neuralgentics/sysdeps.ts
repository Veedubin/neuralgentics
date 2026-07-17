/**
 * System dependency check.
 *
 * Verifies the host has the tools required to run the MCP server fleet:
 *   - uv   (Python package runner — used by videre-mcp, markitdown, duckdb, memini-ai-dev)
 *   - node (Node.js runtime)
 *   - npx  (Node package runner — used by ssh-mcp-server, playwright, github-mcp,
 *           searxng, calculator)
 *
 * On Linux, also verifies the system ML libraries videre-mcp needs:
 *   - libgl1
 *   - libglib2.0-0
 *
 * Policy:
 *   - This function ONLY checks and collects results. It does NOT print anything.
 *   - The caller (init.ts) prints a clean summary with ✓/✗ and install commands.
 *   - If uv / node / npx are missing, the caller should exit gracefully.
 *   - If Linux system ML deps are missing, the caller surfaces the exact
 *     sudo apt-get install command. We NEVER auto-sudo.
 *   - On macOS the ML libs ship with the system, so the check is skipped.
 */

import { execSync } from "node:child_process";
import * as os from "node:os";

export interface SysDep {
  /** Display name (e.g. "uv 0.11.26", "node v22.22.1", "libgl1") */
  name: string;
  /** Whether the dep is present on this system */
  present: boolean;
  /** Install command to run if missing (empty if present) */
  installCommand?: string;
  /** Short note about what this dep is for */
  note?: string;
}

export interface SysDepsResult {
  /** All checked deps with their status */
  deps: SysDep[];
  /** Convenience: names of missing deps */
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

/** Whether this host is macOS. */
function isMac(): boolean {
  return os.platform() === "darwin";
}

/**
 * Check all system dependencies required by the MCP fleet.
 *
 * Does NOT print anything — returns a structured result for the caller
 * to format and print.
 */
export async function checkAndInstallSystemDeps(_dryRun: boolean): Promise<SysDepsResult> {
  const deps: SysDep[] = [];
  const missing: string[] = [];

  // --- Required runner tools ---

  if (hasCmd("uv")) {
    deps.push({ name: `uv (${versionOf("uv")})`, present: true });
  } else {
    const isMacWithBrew = isMac() && hasCmd("brew");
    const installCmd = isMacWithBrew
      ? "brew install uv"
      : "curl -LsSf https://astral.sh/uv/install.sh | sh";
    deps.push({
      name: "uv",
      present: false,
      installCommand: installCmd,
      note: "Required for Python MCP servers (memini-ai-dev, videre-mcp, markitdown, duckdb)",
    });
    missing.push("uv");
  }

  if (hasCmd("node")) {
    deps.push({ name: `node (${versionOf("node")})`, present: true });
  } else {
    deps.push({
      name: "node",
      present: false,
      installCommand: "https://nodejs.org/en/download/",
      note: "Required for Node MCP servers (ssh-mcp, playwright, github-mcp, searxng, calculator)",
    });
    missing.push("node");
  }

  if (hasCmd("npx")) {
    deps.push({ name: `npx (${versionOf("npx")})`, present: true });
  } else {
    deps.push({
      name: "npx",
      present: false,
      installCommand: "https://nodejs.org/en/download/",
      note: "Ships with Node.js",
    });
    missing.push("npx");
  }

  // --- videre-mcp system ML deps (Linux only) ---

  if (isLinux()) {
    const libs = [
      { pkg: "libgl1", note: "OpenGL — needed by videre-mcp (Florence-2/PaddleOCR)" },
      { pkg: "libglib2.0-0", note: "GLib — needed by videre-mcp (Florence-2/PaddleOCR)" },
    ];
    const missingLibs: string[] = [];
    for (const lib of libs) {
      if (dpkgInstalled(lib.pkg)) {
        deps.push({ name: lib.pkg, present: true });
      } else {
        deps.push({
          name: lib.pkg,
          present: false,
          installCommand: `sudo apt-get install -y ${lib.pkg}`,
          note: lib.note,
        });
        missingLibs.push(lib.pkg);
        missing.push(lib.pkg);
      }
    }
    // If any ML libs are missing, add a combined install command hint
    if (missingLibs.length > 0) {
      // Replace individual installCommands with the combined one
      const combined = `sudo apt-get install -y ${missingLibs.join(" ")}`;
      for (const d of deps) {
        if (!d.present && missingLibs.includes(d.name)) {
          d.installCommand = combined;
        }
      }
    }
  }

  return { deps, missing };
}