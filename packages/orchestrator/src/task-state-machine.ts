/**
 * Neuralgentics — Task State Machine & File Ownership Registry
 *
 * Implements the fine-grained task state machine from
 * DESIGN_fine_grained_scoping_v1.md §6, including valid transitions,
 * terminal state detection, and file-level conflict prevention via
 * the FileOwnershipRegistry.
 */

import type { TaskStatus, FileLock } from './types.js';

// ============================================================================
// State Machine Definition
// ============================================================================

/**
 * Valid state transitions for TaskStatus.
 * Keys are "from" states; values are arrays of valid "to" states.
 *
 * See DESIGN_fine_grained_scoping_v1.md §6.2 for triggers.
 */
export const TASK_STATE_MACHINE: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['READY', 'CANCELLED'],
  READY: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['COMPLETE', 'BLOCKED', 'FAILED', 'CANCELLED'],
  BLOCKED: ['RESOLVING', 'FAILED', 'CANCELLED'],
  RESOLVING: ['DEPENDENCY_BUILDING', 'FAILED', 'CANCELLED'],
  DEPENDENCY_BUILDING: ['RESUMED', 'FAILED', 'CANCELLED'],
  RESUMED: ['COMPLETE', 'BLOCKED', 'FAILED', 'CANCELLED'],
  COMPLETE: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * Check whether a transition from one TaskStatus to another is valid.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = TASK_STATE_MACHINE[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Get all valid next states from a given status.
 */
export function getNextStates(status: TaskStatus): TaskStatus[] {
  return TASK_STATE_MACHINE[status] ?? [];
}

/**
 * Check whether a status is terminal (no further transitions possible).
 * Terminal states: COMPLETE, FAILED, CANCELLED.
 */
export function isTerminal(status: TaskStatus): boolean {
  return TASK_STATE_MACHINE[status].length === 0;
}

// ============================================================================
// File Ownership Registry
// ============================================================================

/**
 * In-memory registry that prevents two agents from owning the same file
 * simultaneously. Locks are acquired at dispatch and released on
 * COMPLETE, FAILED, or CANCELLED.
 *
 * When a task is BLOCKED, the lock is held (partial work on disk
 * should not be overwritten by another agent).
 *
 * See DESIGN_fine_grained_scoping_v1.md §8.
 */
export class FileOwnershipRegistry {
  private locks: Map<string, FileLock> = new Map();

  /**
   * Try to acquire a file lock for a task.
   * Returns true if the lock was acquired, false if another task owns the file.
   *
   * A lock can be re-acquired by the same taskId (idempotent).
   * A lock can be acquired if the previous owner is in a terminal state.
   */
  acquireLock(filePath: string, taskId: string): boolean {
    const existing = this.locks.get(filePath);
    if (existing) {
      // Same task re-acquiring is idempotent
      if (existing.taskId === taskId) return true;
      // Previous owner in terminal state — allow takeover
      if (isTerminal(existing.status)) {
        this.locks.set(filePath, {
          taskId,
          status: 'ACTIVE',
          acquiredAt: Date.now(),
        });
        return true;
      }
      // Another active task owns this file
      return false;
    }
    this.locks.set(filePath, {
      taskId,
      status: 'ACTIVE',
      acquiredAt: Date.now(),
    });
    return true;
  }

  /**
   * Release a file lock. Only the owning task can release.
   * Returns true if the lock was released, false if the task didn't own it.
   */
  releaseLock(filePath: string, taskId: string): boolean {
    const existing = this.locks.get(filePath);
    if (!existing) return false;
    if (existing.taskId !== taskId) return false;
    this.locks.delete(filePath);
    return true;
  }

  /**
   * Get the task ID that owns a file, or null if unowned.
   */
  getOwner(filePath: string): string | null {
    const lock = this.locks.get(filePath);
    if (!lock) return null;
    if (isTerminal(lock.status)) return null;
    return lock.taskId;
  }

  /**
   * Update the status of a file lock (e.g., when task transitions to BLOCKED).
   * Returns true if the lock exists and belongs to the given task.
   */
  updateLockStatus(filePath: string, taskId: string, status: TaskStatus): boolean {
    const existing = this.locks.get(filePath);
    if (!existing || existing.taskId !== taskId) return false;
    existing.status = status;
    return true;
  }

  /**
   * Get all active (non-terminal) locks. Useful for crash recovery.
   */
  getActiveLocks(): ReadonlyMap<string, FileLock> {
    const active = new Map<string, FileLock>();
    for (const [path, lock] of this.locks) {
      if (!isTerminal(lock.status)) {
        active.set(path, { ...lock });
      }
    }
    return active;
  }

  /**
   * Clear all locks. Used for testing or hard reset.
   */
  clear(): void {
    this.locks.clear();
  }
}