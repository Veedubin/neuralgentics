/**
 * System dependency check + auto-install.
 *
 * Checks for required tools and offers to install missing ones:
 *   - curl (needed to install uv on Linux)
 *   - uv   (Python package runner)
 *   - node (Node.js runtime)
 *   - npx  (Node package runner)
 *
 * On Linux, also checks system ML libraries for videre-mcp:
 *   - libgl1
 *   - libglib2.0-0
 *
 * Install flow when deps are missing:
 *   1. Show what's missing and ask "Want me to help install these?"
 *   2. If yes:
 *      a. sudo apt-get install -y curl libgl1 libglib2.0-0 (Linux system packages)
 *      b. curl -LsSf https://astral.sh/uv/install.sh | sh (uv)
 *      c. source $HOME/.local/bin/env (put uv on PATH for this session)
 *   3. Re-check and return updated status
 *   4. If node/npx are missing, we can't auto-install — print instructions
 *
 * On macOS: ML libs ship with the system. uv via brew.
 */

import { execSync } from "node:child_process";
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
        if (m.startsWith("lib")) aptPkgs.push(m);
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
      if (m.startsWith("lib")) aptPkgs.push(m);
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
    const libs = [
      { pkg: "libgl1", note: "OpenGL — needed by videre-mcp (Florence-2/PaddleOCR)" },
      { pkg: "libglib2.0-0", note: "GLib — needed by videre-mcp (Florence-2/PaddleOCR)" },
    ];
    const missingLibs: string[] = [];
    for (const lib of libs) {
      if (dpkgInstalled(lib.pkg)) {
        deps.push({ name: lib.pkg, present: true, blocksInstall: false });
      } else {
        deps.push({
          name: lib.pkg,
          present: false,
          installCommand: `sudo apt-get install -y ${lib.pkg}`,
          note: lib.note,
          blocksInstall: false,
        });
        missingLibs.push(lib.pkg);
        missing.push(lib.pkg);
      }
    }
    if (missingLibs.length > 0) {
      const combined = `sudo apt-get install -y ${missingLibs.join(" ")}`;
      for (const d of deps) {
        if (!d.present && missingLibs.includes(d.name)) {
          d.installCommand = combined;
        }
      }
    }
  }

  return { deps, missing, blockingMissing };
}