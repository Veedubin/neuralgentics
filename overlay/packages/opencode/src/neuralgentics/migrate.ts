/**
 * migrate-embeddings — re-embed all memories with a new model.
 *
 * Usage:
 *   neuralgentics migrate-embeddings [--from MODEL] [--to bge-m3] [--batch N] [--dry-run] [--no-backup]
 *
 * Thin wrapper that calls the Go backend's `memory.migrate_embeddings`
 * JSON-RPC method via `GoBackendClient`. The backend does all the heavy
 * lifting (batch reads, re-embed via sidecar, update DB, preserve old
 * vectors). This module just:
 *   1. Spawns the backend and waits for ready.
 *   2. Calls `memory.migrate_embeddings` with the parsed CLI options.
 *   3. Prints a human-readable summary.
 *   4. Returns 0 on success (no errors), 1 if any errors occurred.
 *
 * The migration is safe to interrupt (the Go backend handles per-row
 * commits) and supports `--dry-run` for a preview without writes.
 */

import { GoBackendClient } from "./go-backend-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrateEmbeddingsOptions {
  from?: string;
  to: string;
  batch: number;
  dryRun: boolean;
  backup: boolean;
}

/**
 * Shape of the Go backend's `memory.migrate_embeddings` result.
 *
 * All fields are returned by the backend; the TS side just casts and
 * pretty-prints them.
 */
export interface MigrateEmbeddingsResult {
  totalMemories: number;
  migratedCount: number;
  skippedCount: number;
  errorCount: number;
  fromModel: string;
  toModel: string;
  elapsedSeconds: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Backend binary path resolution
// ---------------------------------------------------------------------------

/** Resolve the Go backend binary path — same logic as `memory-client.ts`. */
function resolveBinaryPath(): string {
  return process.env.NEURALGENTICS_BACKEND_PATH ?? "neuralgentics-backend";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the embedding migration.
 *
 * @param opts - Parsed CLI options.
 * @returns Process exit code: 0 on success (no errors), 1 if errors occurred.
 */
export async function runMigrateEmbeddings(
  opts: MigrateEmbeddingsOptions,
): Promise<number> {
  const binaryPath = resolveBinaryPath();
  const client = new GoBackendClient(binaryPath);
  try {
    await client.waitForReady();

    // Show progress context (Go backend doesn't stream progress, but this
    // sets expectations so the user doesn't think it hung).
    process.stdout.write(
      `Migrating memories: ${opts.from ? `from ${opts.from}` : "all"} -> ${opts.to}\n` +
        `Backup: ${opts.backup ? "yes" : "no"}, Batch: ${opts.batch}, Dry-run: ${opts.dryRun}\n` +
        `This may take 1-2 minutes for ~80 memories (cold model load + per-memory embed).\n\n`,
    );

    const result = (await client.call(
      "memory.migrate_embeddings",
      {
        from_model: opts.from,
        to_model: opts.to,
        batch_size: opts.batch,
        dry_run: opts.dryRun,
        backup: opts.backup,
      },
      300_000, // 5 min timeout — migrations can be slow with cold model load
    )) as MigrateEmbeddingsResult;

    process.stdout.write(
      `\n${opts.dryRun ? "[DRY-RUN] " : ""}Migration ${opts.dryRun ? "preview" : "complete"}:\n` +
        `  Total memories:   ${result.totalMemories}\n` +
        `  Migrated:         ${result.migratedCount}\n` +
        `  Skipped:          ${result.skippedCount}\n` +
        `  Errors:           ${result.errorCount}\n` +
        `  From -> To:       ${result.fromModel} -> ${result.toModel}\n` +
        `  Elapsed:          ${result.elapsedSeconds.toFixed(1)}s\n`,
    );

    if (result.errors && result.errors.length > 0) {
      const preview = result.errors.slice(0, 10);
      process.stdout.write(
        `\nFirst ${preview.length} of ${result.errors.length} errors:\n` +
          preview.map((e) => `  - ${e}`).join("\n") +
          "\n",
      );
    }

    if (opts.backup && result.migratedCount > 0 && !opts.dryRun) {
      process.stdout.write(
        `\nOld vectors preserved in 'embedding_legacy' column. To rollback:\n` +
          `  UPDATE memories SET embedding = embedding_legacy, embedding_model = embedding_model_legacy WHERE embedding_legacy IS NOT NULL;\n` +
          `\nTo drop the backup columns after verifying the migration:\n` +
          `  ALTER TABLE memories DROP COLUMN embedding_legacy, DROP COLUMN embedding_model_legacy;\n`,
      );
    }

    return result.errorCount > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(
      `[ERROR] Migration failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    await client.shutdown();
  }
}