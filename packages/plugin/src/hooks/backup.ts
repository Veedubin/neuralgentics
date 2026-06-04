/**
 * Neuralgentics — Context Backup/Restore Utilities for Compaction Hook
 *
 * Reads critical workspace files (AGENTS.md, TASKS.md) and saves them
 * to memory with high-priority metadata so they survive context compaction.
 * Provides restore function to retrieve backed-up content after compaction.
 *
 * Adapted from boomerang-v3 compaction backup for the Neuralgentics namespace.
 * Uses MemoryAdapter (HTTP JSON to memini-core) instead of PluginMemorySystem.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryAdapter } from '../adapters/memory.js';

/** Metadata for compaction backup memories */
const BACKUP_METADATA = {
  preserved: true,
  source: 'compaction_backup',
  project: 'neuralgentics',
} as const;

/**
 * Read a file from the workspace and save it to memory.
 *
 * Returns the memory ID of the saved entry. Marks the memory with
 * high-priority metadata and adjusts trust upward so it survives
 * tiered loading thresholds.
 */
export async function backupFileToMemory(
  memory: MemoryAdapter,
  workspaceRoot: string,
  filename: string,
): Promise<string> {
  const filePath = join(workspaceRoot, filename);
  const content = readFileSync(filePath, 'utf-8');

  if (!content.trim()) {
    throw new Error(`File ${filename} is empty — nothing to back up`);
  }

  const memoryId = await memory.addMemory(content, {
    ...BACKUP_METADATA,
    tags: ['compaction_backup', 'preserved_context'],
    filename,
    backedUpAt: new Date().toISOString(),
  });

  // Boost trust so memory survives tiered loading filters
  try {
    await memory.adjustTrust(memoryId, 'user_confirmed');
  } catch {
    // Trust adjustment is best-effort
  }

  return memoryId;
}

/**
 * Restore context from memory after compaction.
 *
 * Searches for the most recent compaction backups for each file
 * and returns their content for re-injection.
 */
export async function restoreContextFromMemory(
  memory: MemoryAdapter,
  workspaceRoot: string,
  files?: string[],
): Promise<{ file: string; content: string; found: boolean }[]> {
  const targetFiles = files || ['AGENTS.md', 'TASKS.md'];
  const results: { file: string; content: string; found: boolean }[] = [];

  for (const filename of targetFiles) {
    try {
      const searchResults = await memory.queryMemories(
        `compaction_backup ${filename} ${workspaceRoot}`,
        5,
      );

      // Find the most recent backup for this specific file
      const backup = searchResults.find((r) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        return meta.source === 'compaction_backup' && meta.filename === filename;
      });

      if (backup) {
        results.push({
          file: filename,
          content: backup.content,
          found: true,
        });
      } else {
        results.push({
          file: filename,
          content: '',
          found: false,
        });
      }
    } catch (err) {
      console.error(`[neuralgentics] Failed to restore ${filename}:`, err instanceof Error ? err.message : err);
      results.push({
        file: filename,
        content: '',
        found: false,
      });
    }
  }

  return results;
}