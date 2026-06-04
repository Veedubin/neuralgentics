/**
 * Neuralgentics — Compaction Hook
 *
 * Preserves critical context during OpenCode compaction.
 *
 * When OpenCode compacts a session (prune: true, auto: true), it aggressively
 * removes context to fit within the reserved token budget. This hook intercepts
 * the `session.compacting` event to back up AGENTS.md, TASKS.md, and other
 * critical files to memory before they're lost.
 *
 * Dual activation:
 *   1. Event handler: `session.compacting` event from OpenCode
 *   2. MCP tool: `neuralgentics_compaction_backup` for explicit invocation
 *
 * Adapted from boomerang-v3 for the Neuralgentics namespace.
 * Uses MemoryAdapter (HTTP JSON) instead of PluginMemorySystem.
 */

import { backupFileToMemory, restoreContextFromMemory } from './backup.js';
import type { MemoryAdapter } from '../adapters/memory.js';
import type { CompactionBackupResult, CompactionRestoreResult } from '../types.js';

/** Files to back up before compaction */
const CRITICAL_FILES: readonly string[] = [
  'AGENTS.md',
  'TASKS.md',
] as const;

/**
 * Handle session compaction event.
 *
 * Called by OpenCode when `session.compacting` fires,
 * or explicitly via the `neuralgentics_compaction_backup` MCP tool.
 *
 * Reads each critical file from the workspace root, saves full content
 * to memory with high-priority metadata, and records a compaction event.
 */
export async function handleCompaction(
  memory: MemoryAdapter,
  workspaceRoot: string,
): Promise<CompactionBackupResult> {
  const backedUp: string[] = [];
  const failed: string[] = [];
  const memoryIds: string[] = [];

  for (const filename of CRITICAL_FILES) {
    try {
      const memoryId = await backupFileToMemory(
        memory,
        workspaceRoot,
        filename,
      );
      backedUp.push(filename);
      memoryIds.push(memoryId);
    } catch (err) {
      console.error(`[neuralgentics] Failed to back up ${filename}:`, err instanceof Error ? err.message : err);
      failed.push(filename);
    }
  }

  // Record the compaction event itself
  const eventText = [
    `Compaction event at ${new Date().toISOString()}`,
    `Workspace: ${workspaceRoot}`,
    `Backed up: ${backedUp.join(', ') || 'none'}`,
    `Failed: ${failed.join(', ') || 'none'}`,
  ].join('\n');

  try {
    const eventMemoryId = await memory.addMemory(eventText, {
      type: 'compaction_event',
      preserved: true,
      source: 'compaction_backup',
      backedUp,
      failed,
      project: 'neuralgentics',
    });
    memoryIds.push(eventMemoryId);

    // Mark compaction event memory as sticky (low decay)
    try {
      await memory.adjustTrust(eventMemoryId, 'user_confirmed');
    } catch {
      // Trust adjustment is best-effort
    }
  } catch (err) {
    console.error('[neuralgentics] Failed to record compaction event:', err instanceof Error ? err.message : err);
  }

  const success = failed.length === 0;

  if (success) {
    console.log(`[neuralgentics] Compaction backup complete: ${backedUp.join(', ')}`);
  } else {
    console.warn(`[neuralgentics] Compaction backup partial: ${backedUp.join(', ')} (failed: ${failed.join(', ')})`);
  }

  return { success, backedUp, failed, memoryIds };
}

/**
 * Restore context after compaction.
 *
 * Queries memory for the latest compaction backups and returns
 * the content for re-injection into the session.
 */
export async function restoreAfterCompaction(
  memory: MemoryAdapter,
  workspaceRoot: string,
  files?: string[],
): Promise<CompactionRestoreResult> {
  return restoreContextFromMemory(memory, workspaceRoot, files);
}