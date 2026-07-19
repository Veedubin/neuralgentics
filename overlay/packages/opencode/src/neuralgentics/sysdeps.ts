/**
 * System dependency check + auto-install.
 *
 * Checks for required tools and offers to install missing ones:
 *   - curl (needed to install uv on Linux)
 *   - uv   (Python package runner)
 *   - node (Node.js runtime)
 *   - npx  (Node package runner)
 *
 * On Linux, also checks system ML libraries for videre-mcp by probing for
 * the actual `.so` files via `ldconfig -p` (NOT dpkg package names):
 *   - libGL.so.1        (provided by libgl1 on Debian/Ubuntu)
 *   - libglib-2.0.so.0  (provided by libglib2.0-0 on Ubuntu <=22.04,
 *                        and by libglib2.0-0t64 on Ubuntu >=24.04 due to
 *                        the time_t-64-bit "t64" transition)
 *
 * Why not dpkg: package names get renamed across distro versions (e.g. the
 * t64 transition renamed `libglib2.0-0` → `libglib2.0-0t64` on Ubuntu 24.04).
 * A `dpkg -l libglib2.0-0` check reports "not installed" forever on 24.04+
 * because the package literally no longer exists in the repo, even though
 * the library file IS present. Checking the `.so` file via `ldconfig -p` is
 * distro-agnostic and survives any future package renames — it reflects
 * what the dynamic linker will actually find at runtime.
 *
 * Install flow when deps are missing:
 *   1. Show what's missing and ask "Want me to help install these?"
 *   2. If yes:
 *      a. sudo apt-get install -y curl libgl1 libglib2.0-0t64 (Linux system packages)
 *      b. curl -LsSf https://astral.sh/uv/install.sh | sh (uv)
 *      c. source $HOME/.local/bin/env (put uv on PATH for this session)
 *   3. Re-check and return updated status
 *   4. If node/npx are missing, we can't auto-install — print instructions
 *
 * On macOS: ML libs ship with the system. uv via brew.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as readline from "node:readline";
import * as os from "node:os";
import * as path from "node:path";

export interface SysDep {
  name: string;
  present: boolean;
  installCommand?: string;
  note?: string;
  blocksInstall: boolean;
}

export interface SysDepsResult {
  deps: SysDep[];
  missing: string[];
  blockingMissing: string[];
}

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

// Cache of `ldconfig -p` output so we don't shell out on every probe.
let ldconfigCache: string | null = null;

/**
 * Return the full output of `ldconfig -p` (cached), or empty string if
 * ldconfig is unavailable (non-glibc systems, restricted sandboxes, etc).
 *
 * Tests inject a mock via the `ldconfigCache` module-level variable or
 * by overriding `execLdconfig`.
 */
export function execLdconfig(): string {
  if (ldconfigCache !== null) return ldconfigCache;
  try {
    ldconfigCache = execSync("ldconfig -p", {
      stdio: "pipe",
      shell: process.env.SHELL ?? "bash",
      encoding: "utf8",
    });
  } catch {
    ldconfigCache = "";
  }
  return ldconfigCache;
}

/** Test-only: reset the ldconfig cache between tests. */
export function _resetLdconfigCache(): void {
  ldconfigCache = null;
}

/** Test-only: inject a fake ldconfig -p output. */
export function _setLdconfigCache(fake: string): void {
  ldconfigCache = fake;
}

/**
 * Check whether a shared library is present on the system by probing for
 * its `.so` file. This is distro-agnostic and survives package renames
 * (e.g. the Ubuntu 24.04 t64 transition that renamed `libglib2.0-0` →
 * `libglib2.0-0t64`).
 *
 * Strategy (Option C — file check + ldconfig fallback):
 *   1. Check a list of well-known absolute `.so` paths.
 *   2. Fall back to `ldconfig -p` parsing, which reflects the dynamic
 *      linker's actual search path (handles Nix, conda, custom prefixes).
 *
 * Returns true if the library is found via EITHER path.
 *
 * @param soname   e.g. "libglib-2.0.so.0"
 * @param knownPaths  well-known absolute paths to probe via fs.existsSync
 */
export function libraryInstalled(
  soname: string,
  knownPaths: readonly string[] = [],
): boolean {
  // 1. Direct file existence check — fast, no subprocess.
  for (const p of knownPaths) {
    if (existsSync(p)) return true;
  }

  // 2. ldconfig -p parse — what the dynamic linker will actually resolve.
  const ldout = execLdconfig();
  if (ldout.length > 0) {
    // ldconfig -p lines look like:
    //   libglib-2.0.so.0 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libglib-2.0.so.0
    // The soname is always followed by whitespace then the arch tuple, so we
    // require `\s` (NOT `\b`) — `\b` would false-positive on a prefix such
    // as `libglib-2.0.so` matching the line `libglib-2.0.so.0 ...`.
    const re = new RegExp(`^\\s*${escapeRegex(soname)}\\s`, "m");
    if (re.test(ldout)) return true;
  }

  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLinux(): boolean {
  return os.platform() === "linux";
}

function isMac(): boolean {
  return os.platform() === "darwin";
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Linux ML library probe table. Exported so install logic can resolve the
 * apt package name from the lib's human-friendly name (the name in
 * `result.missing` is `lib.name`, NOT `lib.aptPkg`, because the apt name
 * can change across distro versions — e.g. t64 rename).
 *
 * NOTE: this is only meaningful on Linux. On macOS the ML libs ship with
 * the system and doCheck() skips the lib block entirely.
 */
const LINUX_ML_LIBS = [
  {
    name: "libgl1",
    soname: "libGL.so.1",
    knownPaths: [
      "/usr/lib/x86_64-linux-gnu/libGL.so.1",
      "/usr/lib64/libGL.so.1",
    ],
    aptPkg: "libgl1",
    note: "OpenGL — needed by videre-mcp (Florence-2/PaddleOCR)",
  },
  {
    name: "libglib2.0-0",
    soname: "libglib-2.0.so.0",
    knownPaths: [
      "/usr/lib/x86_64-linux-gnu/libglib-2.0.so.0",
      "/usr/lib64/libglib-2.0.so.0",
    ],
    // Ubuntu 24.04+ ships libglib2.0-0t64 (t64 transition). Ubuntu <=22.04
    // ships libglib2.0-0. We keep the legacy name as the user-facing label
    // and rely on the .so probe (not the dpkg name) for the presence check.
    aptPkg: "libglib2.0-0t64",
    note: "GLib — needed by videre-mcp (Florence-2/PaddleOCR). "
      + "Ubuntu 24.04+ package is libglib2.0-0t64 (t64 transition); "
      + "Ubuntu <=22.04 package is libglib2.0-0.",
  },
] as const;

/**
 * Resolve a lib's human-friendly name (the value in `result.missing`) to
 * its apt package name on the CURRENT distro. Some libraries were renamed
 * across distro versions (e.g. Ubuntu 22.04 ships `libglib2.0-0` but
 * Ubuntu 24.04+ ships `libglib2.0-0t64` for the t64 time_t transition).
 *
 * Strategy: ask `apt-cache show` which package name is actually available.
 * We probe a candidate list (preferred first), return the first one apt
 * recognises, and fall back to the legacy name if none match.
 *
 * Returns the input unchanged if no match — this keeps the install path
 * safe for unknown lib names.
 */
export function aptPkgFor(libName: string): string {
  // Look up the candidate list from the probe table.
  const candidates: string[] = [];
  for (const lib of LINUX_ML_LIBS) {
    if (lib.name === libName) {
      candidates.push(lib.aptPkg);
      // Also probe the legacy/non-t64 name in case we're on an older distro
      // where the rename hasn't happened. Cheap: a few apt-cache lookups.
      if (lib.aptPkg.endsWith("t64")) {
        candidates.push(lib.aptPkg.replace(/t64$/, ""));
      } else {
        candidates.push(`${lib.aptPkg}t64`);
      }
      break;
    }
  }
  if (candidates.length === 0) return libName;

  // Probe with apt-cache show (no network — reads local apt cache only).
  for (const candidate of candidates) {
    try {
      execSync(`apt-cache show ${candidate}`, {
        stdio: "pipe",
        shell: process.env.SHELL ?? "bash",
      });
      return candidate;  // apt knows about it — this is the right name
    } catch {
      // apt-cache returned non-zero (package unknown) — try next candidate
    }
  }
  return candidates[0] ?? libName;
}

/**
 * Check all system dependencies. If any are missing, offer to install them
 * automatically. Returns the final status after any installs.
 */
export async function checkAndInstallSystemDeps(dryRun: boolean): Promise<SysDepsResult> {
  // Run the check
  let result = doCheck();

  // If everything is present, we're done
  if (result.missing.length === 0) {
    return result;
  }

  // If dry-run, don't offer to install
  if (dryRun) {
    return result;
  }

  // Separate what we can auto-install vs what we can't
  // We can auto-install: uv (via curl), ML libs (via apt-get)
  // We canNOT auto-install: node/npx (needs manual download or nvm)
  const canAutoInstall = result.missing.filter(m => m === "uv" || m.startsWith("lib"));
  const cannotAutoInstall = result.missing.filter(m => m === "node" || m === "npx");

  // If only node/npx are missing, we can't help — just return the status
  if (canAutoInstall.length === 0 && cannotAutoInstall.length > 0) {
    return result;
  }

  // Offer to install what we can
  process.stdout.write("\n");
  process.stdout.write("  Some dependencies are missing. I can install them for you:\n");
  process.stdout.write("\n");

  if (canAutoInstall.includes("uv") || canAutoInstall.some(m => m.startsWith("lib"))) {
    const aptPkgs: string[] = [];
    if (isLinux()) {
      if (!hasCmd("curl")) aptPkgs.push("curl");
      for (const m of canAutoInstall) {
        if (m.startsWith("lib")) aptPkgs.push(aptPkgFor(m));
      }
    }

    if (aptPkgs.length > 0) {
      process.stdout.write(`    sudo apt-get install -y ${aptPkgs.join(" ")}\n`);
    }
    if (canAutoInstall.includes("uv")) {
      process.stdout.write("    curl -LsSf https://astral.sh/uv/install.sh | sh\n");
    }
  }

  process.stdout.write("\n");
  const answer = await ask("  Install these now? [Y/n]: ");

  if (answer.trim().toLowerCase().startsWith("n")) {
    // User declined — return the status, caller will print commands and exit
    return result;
  }

  // User said yes — install what we can
  // Step 1: apt-get install (needs sudo, but user consented)
  if (isLinux()) {
    const aptPkgs: string[] = [];
    if (!hasCmd("curl")) aptPkgs.push("curl");
    for (const m of canAutoInstall) {
      if (m.startsWith("lib")) aptPkgs.push(aptPkgFor(m));
    }
    if (aptPkgs.length > 0) {
      process.stdout.write(`\n  Installing system packages: ${aptPkgs.join(", ")}...\n`);
      try {
        execSync(`sudo apt-get install -y ${aptPkgs.join(" ")}`, {
          stdio: "inherit",
          shell: process.env.SHELL ?? "bash",
        });
        process.stdout.write("  ✓ System packages installed\n");
      } catch {
        process.stdout.write("  ✗ Could not install system packages (sudo may be required)\n");
        process.stdout.write(`    Run manually: sudo apt-get install -y ${aptPkgs.join(" ")}\n`);
      }
    }
  }

  // Step 2: install uv
  if (canAutoInstall.includes("uv")) {
    process.stdout.write("\n  Installing uv...\n");
    try {
      if (isMac() && hasCmd("brew")) {
        execSync("brew install uv", { stdio: "inherit", shell: process.env.SHELL ?? "bash" });
      } else {
        execSync("curl -LsSf https://astral.sh/uv/install.sh | sh", {
          stdio: "inherit",
          shell: process.env.SHELL ?? "bash",
        });
      }
      // Put uv on PATH for this session
      const uvBin = path.join(os.homedir(), ".local", "bin");
      if (!process.env.PATH?.includes(uvBin)) {
        process.env.PATH = `${uvBin}:${process.env.PATH ?? ""}`;
      }
      // Source the env file if it exists
      const envFile = path.join(os.homedir(), ".local", "bin", "env");
      try {
        execSync(`source ${envFile}`, { stdio: "pipe", shell: process.env.SHELL ?? "bash" });
      } catch {
        // env file may not exist — uv is already on PATH from above
      }
      process.stdout.write(`  ✓ uv installed (${versionOf("uv")})\n`);
    } catch {
      process.stdout.write("  ✗ Could not install uv automatically\n");
      process.stdout.write("    Run manually: curl -LsSf https://astral.sh/uv/install.sh | sh\n");
    }
  }

  // Re-check after installs
  process.stdout.write("\n");
  result = doCheck();
  return result;
}

/**
 * Pure check — no install, no prompting. Returns current status.
 */
function doCheck(): SysDepsResult {
  const deps: SysDep[] = [];
  const missing: string[] = [];
  const blockingMissing: string[] = [];

  // curl (needed to install uv on Linux)
  if (hasCmd("curl")) {
    deps.push({ name: "curl", present: true, blocksInstall: false });
  } else if (isLinux()) {
    deps.push({
      name: "curl",
      present: false,
      installCommand: "sudo apt-get install -y curl",
      note: "Needed to install uv",
      blocksInstall: false,
    });
    missing.push("curl");
  }

  if (hasCmd("uv")) {
    deps.push({ name: `uv (${versionOf("uv")})`, present: true, blocksInstall: false });
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
      blocksInstall: true,
    });
    missing.push("uv");
    blockingMissing.push("uv");
  }

  if (hasCmd("node")) {
    deps.push({ name: `node (${versionOf("node")})`, present: true, blocksInstall: false });
  } else {
    deps.push({
      name: "node",
      present: false,
      installCommand: "https://nodejs.org/en/download/",
      note: "Required for Node MCP servers (ssh-mcp, playwright, github-mcp, searxng, calculator)",
      blocksInstall: true,
    });
    missing.push("node");
    blockingMissing.push("node");
  }

  if (hasCmd("npx")) {
    deps.push({ name: `npx (${versionOf("npx")})`, present: true, blocksInstall: false });
  } else {
    deps.push({
      name: "npx",
      present: false,
      installCommand: "https://nodejs.org/en/download/",
      note: "Ships with Node.js",
      blocksInstall: true,
    });
    missing.push("npx");
    blockingMissing.push("npx");
  }

  if (isLinux()) {
    // Each lib entry maps a human-friendly name (used in messages) to:
    //   - soname:      the actual .so file the dynamic linker resolves
    //   - knownPaths:  well-known absolute paths to probe via fs.existsSync
    //   - aptPkg:      the Ubuntu/Debian package name (for apt-get install)
    //
    // NOTE on the "t64" transition: Ubuntu 24.04 renamed `libglib2.0-0` →
    // `libglib2.0-0t64` as part of the 64-bit time_t migration. The dpkg
    // package name changed but the .so file name (libglib-2.0.so.0) did NOT.
    // Probing the .so file is the only distro-version-agnostic check.
    const libs = LINUX_ML_LIBS;
    const missingLibs: string[] = [];
    for (const lib of libs) {
      if (libraryInstalled(lib.soname, lib.knownPaths)) {
        deps.push({ name: lib.name, present: true, blocksInstall: false });
      } else {
        deps.push({
          name: lib.name,
          present: false,
          installCommand: `sudo apt-get install -y ${lib.aptPkg}`,
          note: lib.note,
          blocksInstall: false,
        });
        missingLibs.push(lib.aptPkg);
        missing.push(lib.name);
      }
    }
    if (missingLibs.length > 0) {
      const combined = `sudo apt-get install -y ${missingLibs.join(" ")}`;
      // Rewrite installCommand for every missing lib entry to the combined
      // apt command so the user sees one command, not N.
      for (const d of deps) {
        if (!d.present && libs.some(l => l.name === d.name && missingLibs.includes(l.aptPkg))) {
          d.installCommand = combined;
        }
      }
    }
  }

  return { deps, missing, blockingMissing };
}