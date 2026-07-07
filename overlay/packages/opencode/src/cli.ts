#!/usr/bin/env node
/**
 * CLI entry point for the `neuralgentics` command — TypeScript port of the
 * Python `neuralgentics-cli/src/neuralgentics/cli.py`.
 *
 * Single-command bootstrap: pass `--init` (or the positional alias `init`)
 * to download + place the neuralgentics OpenCode plugin into `--target`.
 *
 * Uses Node.js `util.parseArgs` for argv parsing (Node 20+ built-in).
 */

import { parseArgs } from "node:util";
import { CLI_VERSION, runInit, InitOptions, NeuralgenticsError } from "./neuralgentics/init.js";

/** Sentinel for `--version` with no argument (distinguishes bare vs. with-arg). */
const CLI_VERSION_SENTINEL = "__cli__";

interface ParsedArgs {
  init: boolean;
  target: string;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  repo: string;
  version: string; // sentinel, "latest", or "X.Y.Z"
  offline: boolean;
  withBackend: boolean;
  command: string | undefined;
}

function parseArgv(argv: string[]): ParsedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      init: { type: "boolean", default: false },
      version: { type: "string" },
      target: { type: "string", short: "t", default: "." },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      repo: { type: "string", default: "Veedubin/neuralgentics" },
      offline: { type: "boolean", default: false },
      "with-backend": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  // version handling: bare --version is intercepted in main() before
  // parseArgs runs. Here we only see --version=<X.Y.Z> or --version X.Y.Z.
  const version = values.version ?? "latest";
  // Reconstruct positionals by re-parsing (parseArgs doesn't return them
  // when tokens:false). We use a lightweight scan instead.
  const positionals: string[] = [];
  const knownFlags = new Set([
    "--init", "--force", "--dry-run", "--yes", "-y", "--offline",
    "--with-backend", "-h", "--help",
  ]);
  const valueFlags = new Set(["--version", "--target", "-t", "--repo"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.includes("=")) continue; // --foo=bar form
    if (knownFlags.has(a)) continue;
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    // Bare `--version` (already handled in main) — skip its potential next.
    positionals.push(a);
  }

  const command = positionals.length > 0 ? positionals[0] : undefined;

  return {
    init: values.init === true,
    target: values.target ?? ".",
    force: values.force === true,
    dryRun: values["dry-run"] === true,
    yes: values.yes === true,
    repo: values.repo ?? "Veedubin/neuralgentics",
    version,
    offline: values.offline === true,
    withBackend: values["with-backend"] === true,
    command,
  };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: neuralgentics [init] [options]\n` +
      `\n` +
      `Bootstrapper CLI for the neuralgentics OpenCode plugin.\n` +
      `\n` +
      `Options:\n` +
      `  --init              Bootstrap the target directory with the neuralgentics plugin.\n` +
      `  --version [VER]     With no arg: print CLI version and exit. With arg: plugin version to install.\n` +
      `  --target, -t DIR    Directory to bootstrap (default: current directory).\n` +
      `  --force             Overwrite existing .opencode/ files even if user-modified.\n` +
      `  --dry-run           Preview all actions without writing anything.\n` +
      `  --yes, -y           Skip all confirmation prompts.\n` +
      `  --repo REPO         GitHub repository to download from (default: Veedubin/neuralgentics).\n` +
      `  --offline           Use a bundled tarball instead of downloading (not yet available).\n` +
      `  --with-backend      Set up database containers (podman-compose / docker).\n` +
      `  -h, --help          Show this help and exit.\n` +
      `\n` +
      `Positional alias: \`neuralgentics init\` is equivalent to \`--init\`.\n`,
  );
}

function formatError(err: NeuralgenticsError): string {
  return `[ERROR] ${err.message}\nSuggestion: ${err.remediation}`;
}

async function main(argv: string[]): Promise<number> {
  // Handle -h / --help before parseArgs (which doesn't know these).
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return 0;
  }

  // Handle bare `--version` (no following value) BEFORE parseArgs, because
  // `parseArgs` with type:string requires a value and errors on bare form.
  const bareVersionIdx = argv.indexOf("--version");
  if (bareVersionIdx !== -1) {
    const next = argv[bareVersionIdx + 1];
    if (next === undefined || next.startsWith("-")) {
      // Bare `--version` — print CLI version and exit 0.
      process.stdout.write(`neuralgentics ${CLI_VERSION}\n`);
      return 0;
    }
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgv(argv);
  } catch (exc) {
    process.stderr.write(
      `[ERROR] ${exc instanceof Error ? exc.message : String(exc)}\n` +
        `Run \`neuralgentics --help\` for usage.\n`,
    );
    return 2;
  }

  // --version with an explicit argument: install plugin v<version>.
  // (Bare form was handled above.) parsed.version is "latest" or "X.Y.Z".
  // If the user passed `--version=X.Y.Z`, parsed.version is that value.
  if (parsed.version !== "latest") {
    // Only treat as "print version" if it was the sentinel — which we already
    // handled above. Otherwise it's a plugin version to install.
  }

  // init requested via --init or the positional `init` alias.
  const initRequested = parsed.init || parsed.command === "init";
  if (!initRequested) {
    printHelp();
    return 0;
  }

  const opts: InitOptions = {
    init: true,
    target: parsed.target,
    force: parsed.force,
    dryRun: parsed.dryRun,
    yes: parsed.yes,
    repo: parsed.repo,
    version: parsed.version,
    offline: parsed.offline,
    withBackend: parsed.withBackend,
  };

  try {
    return await runInit(opts);
  } catch (err) {
    if (err instanceof NeuralgenticsError) {
      process.stderr.write(formatError(err) + "\n");
      return err.exitCode;
    }
    if (err instanceof Error) {
      process.stderr.write(`[ERROR] ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`[ERROR] ${String(err)}\n`);
    return 1;
  }
}

// Entry point — only run when invoked directly (not when imported).
const isDirectInvocation = process.argv[1] && (
  process.argv[1].endsWith("cli.js") ||
  process.argv[1].endsWith("cli") ||
  process.argv[1].endsWith("neuralgentics")
);
if (isDirectInvocation) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      if (err instanceof NeuralgenticsError) {
        process.stderr.write(formatError(err) + "\n");
        process.exitCode = err.exitCode;
      } else {
        process.stderr.write(`[ERROR] ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}

export { main };