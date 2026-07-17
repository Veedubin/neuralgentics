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
import {
  CLI_VERSION,
  runInit,
  InitOptions,
  NeuralgenticsError,
  runInitHomedir,
  runInitProject,
  type InitHomedirOptions,
  type InitProjectOptions,
} from "./neuralgentics/init.js";
import type { MigrateEmbeddingsOptions } from "./neuralgentics/migrate.js";
import { updateAll, updateProject, updateHomedir, type UpdateOptions } from "./neuralgentics/update.js";

/** Sentinel for `--version` with no argument (distinguishes bare vs. with-arg). */
const CLI_VERSION_SENTINEL = "__cli__";

interface ParsedArgs {
  init: boolean;
  initHomedir: boolean;
  initProject: boolean;
  update: boolean;
  updateProject: boolean;
  updateHomedir: boolean;
  embedded: boolean;
  team: boolean;
  cpuEmbed: boolean;
  autoEmbed: boolean;
  gpuEmbed: boolean;
  target: string;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  repo: string;
  version: string; // sentinel, "latest", or "X.Y.Z"
  offline: boolean;
  withBackend: boolean;
  // Lazy-load + quantize (v0.9.6+) — all opt-in.
  quantize: string; // "auto" | "fp32" | "fp16" | "int8"
  device: string | undefined; // "cpu" | "cuda" | undefined (env fallback)
  noLazyLoad: boolean; // true => EAGER=true
  idleMin: number; // minutes before idle sidecar unloads the model
  statusPort: number; // sidecar HTTP /status port
  embedModel: string; // "bge-m3" | "bge-large" | "all-MiniLM-L6-v2"
  // migrate-embeddings subcommand
  from: string | undefined; // source model filter (default: all)
  to: string; // target model (default: bge-m3)
  batch: number; // batch size (default: 10)
  backup: boolean; // preserve old vectors (default: true)
  dryRunMigrate: boolean; // --dry-run for migrate (distinct from init --dry-run)
  command: string | undefined;
}

function parseArgv(argv: string[]): ParsedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      init: { type: "boolean", default: false },
      "init-homedir": { type: "boolean", default: false },
      "init-project": { type: "boolean", default: false },
      update: { type: "boolean", default: false },
      "update-project": { type: "boolean", default: false },
      "update-homedir": { type: "boolean", default: false },
      embedded: { type: "boolean", default: false },
      team: { type: "boolean", default: false },
      "CPU-Embed": { type: "boolean", default: false },
      "Auto-Embed": { type: "boolean", default: false },
      "GPU-Embed": { type: "boolean", default: false },
      version: { type: "string" },
      target: { type: "string", short: "t", default: "." },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      repo: { type: "string", default: "Veedubin/neuralgentics" },
      offline: { type: "boolean", default: false },
      "with-backend": { type: "boolean", default: false },
      // Lazy-load + quantize (v0.9.6+).
      quantize: { type: "string", default: "auto" },
      "embed-dtype": { type: "string" }, // alias for --quantize (undocumented)
      device: { type: "string" }, // "cpu" | "cuda"; undefined => env fallback
      "no-lazy-load": { type: "boolean", default: false },
      "idle-min": { type: "string", default: "5" }, // numeric, parsed below
      "status-port": { type: "string", default: "50052" }, // numeric
      "embed-model": { type: "string" },
      // migrate-embeddings subcommand flags
      from: { type: "string" },
      to: { type: "string" },
      batch: { type: "string" }, // numeric, parsed below
      "no-backup": { type: "boolean", default: false },
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
    "--init", "--init-homedir", "--init-project",
    "--update", "--update-project", "--update-homedir",
    "--embedded", "--team",
    "--CPU-Embed", "--Auto-Embed", "--GPU-Embed",
    "--force", "--dry-run", "--yes", "-y", "--offline",
    "--with-backend", "--no-lazy-load", "-h", "--help",
  ]);
  const valueFlags = new Set([
    "--version", "--target", "-t", "--repo",
    "--quantize", "--embed-dtype", "--device", "--idle-min", "--status-port",
    "--embed-model",
    "--from", "--to", "--batch",
  ]);
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
    initHomedir: values["init-homedir"] === true,
    initProject: values["init-project"] === true,
    update: values.update === true,
    updateProject: values["update-project"] === true,
    updateHomedir: values["update-homedir"] === true,
    embedded: values.embedded === true,
    team: values.team === true,
    cpuEmbed: values["CPU-Embed"] === true,
    autoEmbed: values["Auto-Embed"] === true,
    gpuEmbed: values["GPU-Embed"] === true,
    target: values.target ?? ".",
    force: values.force === true,
    dryRun: values["dry-run"] === true,
    yes: values.yes === true,
    repo: values.repo ?? "Veedubin/neuralgentics",
    version,
    offline: values.offline === true,
    withBackend: values["with-backend"] === true,
    quantize: (values["embed-dtype"] ?? values.quantize ?? "auto") as string,
    device: values.device as string | undefined,
    noLazyLoad: values["no-lazy-load"] === true,
    idleMin: parseInt(values["idle-min"] ?? "5", 10),
    statusPort: parseInt(values["status-port"] ?? "50052", 10),
    embedModel: values["embed-model"] ?? "bge-m3",
    from: values.from as string | undefined,
    to: values.to ?? "bge-m3",
    batch: parseInt(values.batch ?? "10", 10),
    backup: !(values["no-backup"] === true),
    dryRunMigrate: values["dry-run"] === true,
    command,
  };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: neuralgentics [init|update] [options]\n` +
      `\n` +
      `Bootstrapper CLI for the neuralgentics OpenCode plugin.\n` +
      `\n` +
      `Init options:\n` +
      `  --init-homedir       Install global config to ~/.config/opencode/ (Linux) or ~/Library/Application Support/opencode/ (Mac).\n` +
      `  --init-project       Install project config to ./.opencode/ (CWD).\n` +
      `  --init               Alias for --init-project (backward compat).\n` +
      `\n` +
      `Update options:\n` +
      `  --update             Update ALL installs under user's home (projects + homedir).\n` +
      `  --update-project     Update just THIS project (CWD).\n` +
      `  --update-homedir     Update just the home dir.\n` +
      `\n` +
      `Backend / embedding flags:\n` +
      `  --embedded           Skip backend prompt, use pgembed (zero Docker).\n` +
      `  --team                Use team server, prompt for IP/port.\n` +
      `  --CPU-Embed           384-dim CPU only, skip embed mode prompt.\n` +
      `  --Auto-Embed          384 default + optional 1024 elevation, skip embed mode prompt.\n` +
      `  --GPU-Embed           1024-dim GPU only, skip embed mode prompt.\n` +
      `\n` +
      `General options:\n` +
      `  --version [VER]      With no arg: print CLI version and exit. With arg: plugin version to install.\n` +
      `  --target, -t DIR     Directory to bootstrap (default: current directory).\n` +
      `  --force              Overwrite existing files even if user-modified.\n` +
      `  --dry-run            Preview all actions without writing anything.\n` +
      `  --yes, -y            Skip all confirmation prompts.\n` +
      `  --repo REPO          GitHub repository to download from (default: Veedubin/neuralgentics).\n` +
      `  --offline            Use a bundled tarball instead of downloading (not yet available).\n` +
      `  --with-backend        Set up database containers (podman-compose / docker).\n` +
      `\n` +
      `Lazy-load + quantize options (opt-in, v0.9.6+):\n` +
      `  --quantize DTYPE    Embedding dtype: auto|fp32|fp16|int8 (default: auto).\n` +
      `                      auto => fp16 on cuda, int8 on cpu (or per NEURALGENTICS_EMBED_DEVICE).\n` +
      `  --device DEVICE     Embedding device override: cpu|cuda. Overrides NEURALGENTICS_EMBED_DEVICE.\n` +
      `  --no-lazy-load      Eagerly load the model at sidecar start (default: lazy-load on first embed).\n` +
      `  --idle-min MIN      Minutes of idleness before the lazy sidecar unloads the model (default: 5).\n` +
      `  --status-port PORT  Sidecar HTTP /status port (default: 50052).\n` +
      `\n` +
      `  --embed-model MODEL  Embedding model: bge-m3 (default, multilingual 8K), bge-large (English 512), or all-MiniLM-L6-v2 (fast 384). Env: NEURALGENTICS_EMBED_MODEL.\n` +
      `\n` +
      `Migrate embeddings:\n` +
      `  neuralgentics migrate-embeddings [options]\n` +
      `    --from MODEL     Only migrate memories currently using this model (default: all)\n` +
      `    --to MODEL        Target embedding model (default: bge-m3)\n` +
      `    --batch N         Memories per batch (default: 10)\n` +
      `    --dry-run         Preview what would be done without making changes\n` +
      `    --no-backup       Don't preserve old vectors in embedding_legacy column\n` +
      `\n` +
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

  // init requested via --init, --init-homedir, --init-project, or positional `init`.
  const initRequested = parsed.init || parsed.initHomedir || parsed.initProject || parsed.command === "init";
  const migrateRequested = parsed.command === "migrate-embeddings";
  const updateRequested = parsed.update || parsed.updateProject || parsed.updateHomedir;

  if (!initRequested && !migrateRequested && !updateRequested) {
    printHelp();
    return 0;
  }

  // migrate-embeddings is a parallel command, not a subcommand of init.
  if (migrateRequested) {
    const { runMigrateEmbeddings } = await import("./neuralgentics/migrate.js");
    const migrateOpts: MigrateEmbeddingsOptions = {
      from: parsed.from,
      to: parsed.to,
      batch: parsed.batch,
      dryRun: parsed.dryRunMigrate,
      backup: parsed.backup,
    };
    return await runMigrateEmbeddings(migrateOpts);
  }

  // Update flows
  if (updateRequested) {
    const updateOpts: UpdateOptions = {
      repo: parsed.repo,
      version: parsed.version,
      force: parsed.force,
      dryRun: parsed.dryRun,
    };
    try {
      if (parsed.update) {
        await updateAll(updateOpts);
      } else if (parsed.updateProject) {
        await updateProject(updateOpts);
      } else {
        await updateHomedir(updateOpts);
      }
      return 0;
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

  // Two-init flows: --init-homedir or --init-project (or legacy --init)
  if (parsed.initHomedir) {
    const opts: InitHomedirOptions = {
      target: parsed.target,
      force: parsed.force,
      dryRun: parsed.dryRun,
      yes: parsed.yes,
      repo: parsed.repo,
      version: parsed.version,
      embedded: parsed.embedded,
      team: parsed.team,
      cpuEmbed: parsed.cpuEmbed,
      autoEmbed: parsed.autoEmbed,
      gpuEmbed: parsed.gpuEmbed,
    };
    try {
      return await runInitHomedir(opts);
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

  if (parsed.initProject || parsed.init || parsed.command === "init") {
    const opts: InitProjectOptions = {
      target: parsed.target,
      force: parsed.force,
      dryRun: parsed.dryRun,
      yes: parsed.yes,
      repo: parsed.repo,
      version: parsed.version,
      embedded: parsed.embedded,
      team: parsed.team,
      cpuEmbed: parsed.cpuEmbed,
      autoEmbed: parsed.autoEmbed,
      gpuEmbed: parsed.gpuEmbed,
      withBackend: parsed.withBackend,
      offline: parsed.offline,
      quantize: parsed.quantize,
      device: parsed.device,
      noLazyLoad: parsed.noLazyLoad,
      idleMin: parsed.idleMin,
      statusPort: parsed.statusPort,
      embedModel: parsed.embedModel,
    };
    try {
      return await runInitProject(opts);
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

  // Legacy init flow (kept for backward compat when --init is used without
  // --init-homedir or --init-project). This delegates to runInit which
  // implements the original single-init behavior.
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
    quantize: parsed.quantize,
    device: parsed.device,
    noLazyLoad: parsed.noLazyLoad,
    idleMin: parsed.idleMin,
    statusPort: parsed.statusPort,
    embedModel: parsed.embedModel,
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