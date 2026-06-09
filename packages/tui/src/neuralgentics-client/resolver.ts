/**
 * Binary path resolver for the Neuralgentics Go backend.
 *
 * Resolution order:
 * 1. $PATH lookup (`neuralgentics-backend`)
 * 2. $NEURALGENTICS_BACKEND_PATH environment variable
 * 3. Relative path from TUI cwd: `../neuralgentics/packages/backend-go/neuralgentics-backend`
 * 4. $NEURALGENTICS_INSTALL_PREFIX/bin/neuralgentics-backend (or ~/.neuralgentics/bin/ fallback)
 * 5. $HOME/.neuralgentics/bin/neuralgentics-backend (explicit fallback for installed prefix)
 *
 * Steps 4–5 handle the standard install paths created by scripts/install.sh,
 * which places the binary at ~/.neuralgentics/bin/neuralgentics-backend.
 *
 * This is inlined per T-020 scope (T-024 may refactor it later).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolve the path to the neuralgentics-backend binary. Throws a descriptive error if not found. */
export function resolveBackendPath(): string {
  const checked: string[] = [];

  // 1. $PATH lookup
  try {
    const result = spawnSync("which", ["neuralgentics-backend"], {
      timeout: 5000,
      encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // which not available, fall through
  }
  checked.push("$PATH (neuralgentics-backend)");

  // 2. $NEURALGENTICS_BACKEND_PATH env var
  const envPath = process.env.NEURALGENTICS_BACKEND_PATH;
  if (envPath) {
    if (existsSync(envPath)) {
      return envPath;
    }
    checked.push(`$NEURALGENTICS_BACKEND_PATH (${envPath})`);
  } else {
    checked.push("$NEURALGENTICS_BACKEND_PATH (unset)");
  }

  // 3. Relative path from CWD
  const relativePath = resolve(
    join(process.cwd(), "../neuralgentics/packages/backend-go/neuralgentics-backend"),
  );
  if (existsSync(relativePath)) {
    return relativePath;
  }
  checked.push(`../neuralgentics/packages/backend-go/neuralgentics-backend (not found)`);

  // 4. $NEURALGENTICS_INSTALL_PREFIX/bin/neuralgentics-backend
  const installPrefix = process.env.NEURALGENTICS_INSTALL_PREFIX;
  if (installPrefix) {
    const prefixPath = resolve(join(installPrefix, "bin", "neuralgentics-backend"));
    if (existsSync(prefixPath)) {
      return prefixPath;
    }
    checked.push(`$NEURALGENTICS_INSTALL_PREFIX/bin/neuralgentics-backend (${prefixPath})`);
  } else {
    checked.push("$NEURALGENTICS_INSTALL_PREFIX (unset)");
  }

  // 5. $HOME/.neuralgentics/bin/neuralgentics-backend (default install prefix)
  const homeBinPath = resolve(join(homedir(), ".neuralgentics", "bin", "neuralgentics-backend"));
  if (existsSync(homeBinPath)) {
    return homeBinPath;
  }
  checked.push(`~/.neuralgentics/bin/neuralgentics-backend (${homeBinPath})`);

  throw new Error(
    `Cannot find neuralgentics-backend. Checked: ${checked.join(", ")}`,
  );
}

/**
 * Default database URL for the Go backend.
 * The Go backend's default (localhost:5434) will fail because lib/pq defaults
 * to sslmode=require which clashes with ssl=off. This default points at the
 * dev test DB on port 6000 with sslmode=require.
 */
export const DEFAULT_DB_URL =
  "postgresql://postgres:testpassword@localhost:6000/neuralgentics_test?sslmode=require";

/** Resolve the DB URL — explicit env override wins, otherwise the dev DB default. */
export function resolveDbUrl(): string {
  return process.env.NEURALGENTICS_DB_URL ?? DEFAULT_DB_URL;
}