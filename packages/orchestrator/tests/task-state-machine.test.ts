/**
 * Neuralgentics — Task State Machine Tests
 *
 * Tests for state transition validation, terminal state detection,
 * and the FileOwnershipRegistry class.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { TaskStatus } from '../src/types.js';
import {
  TASK_STATE_MACHINE,
  canTransition,
  getNextStates,
  isTerminal,
  FileOwnershipRegistry,
} from '../src/task-state-machine.js';

// ============================================================================
// State Machine: canTransition
// ============================================================================

describe('TASK_STATE_MACHINE', () => {
  it('should define transitions for all TaskStatus values', () => {
    const allStatuses: TaskStatus[] = [
      'PENDING', 'READY', 'ACTIVE', 'BLOCKED', 'RESOLVING',
      'DEPENDENCY_BUILDING', 'RESUMED', 'COMPLETE', 'FAILED', 'CANCELLED',
    ];
    for (const status of allStatuses) {
      expect(TASK_STATE_MACHINE[status]).toBeDefined();
      expect(Array.isArray(TASK_STATE_MACHINE[status])).toBe(true);
    }
  });

  it('should have empty arrays for terminal states', () => {
    expect(TASK_STATE_MACHINE['COMPLETE']).toEqual([]);
    expect(TASK_STATE_MACHINE['FAILED']).toEqual([]);
    expect(TASK_STATE_MACHINE['CANCELLED']).toEqual([]);
  });
});

describe('canTransition', () => {
  it('should allow PENDING → READY', () => {
    expect(canTransition('PENDING', 'READY')).toBe(true);
  });

  it('should allow PENDING → CANCELLED', () => {
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
  });

  it('should allow READY → ACTIVE', () => {
    expect(canTransition('READY', 'ACTIVE')).toBe(true);
  });

  it('should allow ACTIVE → COMPLETE', () => {
    expect(canTransition('ACTIVE', 'COMPLETE')).toBe(true);
  });

  it('should allow ACTIVE → BLOCKED', () => {
    expect(canTransition('ACTIVE', 'BLOCKED')).toBe(true);
  });

  it('should allow ACTIVE → FAILED', () => {
    expect(canTransition('ACTIVE', 'FAILED')).toBe(true);
  });

  it('should allow BLOCKED → RESOLVING', () => {
    expect(canTransition('BLOCKED', 'RESOLVING')).toBe(true);
  });

  it('should allow BLOCKED → FAILED', () => {
    expect(canTransition('BLOCKED', 'FAILED')).toBe(true);
  });

  it('should allow RESOLVING → DEPENDENCY_BUILDING', () => {
    expect(canTransition('RESOLVING', 'DEPENDENCY_BUILDING')).toBe(true);
  });

  it('should allow DEPENDENCY_BUILDING → RESUMED', () => {
    expect(canTransition('DEPENDENCY_BUILDING', 'RESUMED')).toBe(true);
  });

  it('should allow RESUMED → COMPLETE', () => {
    expect(canTransition('RESUMED', 'COMPLETE')).toBe(true);
  });

  it('should allow RESUMED → BLOCKED (re-blocked after resume)', () => {
    expect(canTransition('RESUMED', 'BLOCKED')).toBe(true);
  });

  it('should allow any state → CANCELLED', () => {
    const nonTerminal: TaskStatus[] = [
      'PENDING', 'READY', 'ACTIVE', 'BLOCKED', 'RESOLVING',
      'DEPENDENCY_BUILDING', 'RESUMED',
    ];
    for (const from of nonTerminal) {
      expect(canTransition(from, 'CANCELLED')).toBe(true);
    }
  });

  it('should reject invalid transitions', () => {
    expect(canTransition('PENDING', 'ACTIVE')).toBe(false);
    expect(canTransition('PENDING', 'COMPLETE')).toBe(false);
    expect(canTransition('READY', 'COMPLETE')).toBe(false);
    expect(canTransition('COMPLETE', 'ACTIVE')).toBe(false);
    expect(canTransition('FAILED', 'READY')).toBe(false);
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
  });

  it('should reject transition from terminal states', () => {
    expect(canTransition('COMPLETE', 'ACTIVE')).toBe(false);
    expect(canTransition('FAILED', 'READY')).toBe(false);
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
  });

  it('should support the full blocker recovery flow', () => {
    // PENDING → READY → ACTIVE → BLOCKED → RESOLVING → DEPENDENCY_BUILDING → RESUMED → COMPLETE
    expect(canTransition('PENDING', 'READY')).toBe(true);
    expect(canTransition('READY', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'BLOCKED')).toBe(true);
    expect(canTransition('BLOCKED', 'RESOLVING')).toBe(true);
    expect(canTransition('RESOLVING', 'DEPENDENCY_BUILDING')).toBe(true);
    expect(canTransition('DEPENDENCY_BUILDING', 'RESUMED')).toBe(true);
    expect(canTransition('RESUMED', 'COMPLETE')).toBe(true);
  });
});

describe('getNextStates', () => {
  it('should return valid transitions for ACTIVE', () => {
    const next = getNextStates('ACTIVE');
    expect(next).toContain('COMPLETE');
    expect(next).toContain('BLOCKED');
    expect(next).toContain('FAILED');
    expect(next).toContain('CANCELLED');
    expect(next.length).toBe(4);
  });

  it('should return empty array for terminal states', () => {
    expect(getNextStates('COMPLETE')).toEqual([]);
    expect(getNextStates('FAILED')).toEqual([]);
    expect(getNextStates('CANCELLED')).toEqual([]);
  });

  it('should include CANCELLED for all non-terminal states', () => {
    const nonTerminal: TaskStatus[] = [
      'PENDING', 'READY', 'ACTIVE', 'BLOCKED', 'RESOLVING',
      'DEPENDENCY_BUILDING', 'RESUMED',
    ];
    for (const status of nonTerminal) {
      expect(getNextStates(status)).toContain('CANCELLED');
    }
  });
});

describe('isTerminal', () => {
  it('should return true for COMPLETE', () => {
    expect(isTerminal('COMPLETE')).toBe(true);
  });

  it('should return true for FAILED', () => {
    expect(isTerminal('FAILED')).toBe(true);
  });

  it('should return true for CANCELLED', () => {
    expect(isTerminal('CANCELLED')).toBe(true);
  });

  it('should return false for non-terminal states', () => {
    const nonTerminal: TaskStatus[] = [
      'PENDING', 'READY', 'ACTIVE', 'BLOCKED', 'RESOLVING',
      'DEPENDENCY_BUILDING', 'RESUMED',
    ];
    for (const status of nonTerminal) {
      expect(isTerminal(status)).toBe(false);
    }
  });
});

// ============================================================================
// FileOwnershipRegistry
// ============================================================================

describe('FileOwnershipRegistry', () => {
  let registry: FileOwnershipRegistry;

  beforeEach(() => {
    registry = new FileOwnershipRegistry();
  });

  describe('acquireLock', () => {
    it('should acquire an unowned file', () => {
      expect(registry.acquireLock('src/models.py', 'task_001')).toBe(true);
    });

    it('should allow same task to re-acquire (idempotent)', () => {
      registry.acquireLock('src/models.py', 'task_001');
      expect(registry.acquireLock('src/models.py', 'task_001')).toBe(true);
    });

    it('should reject acquisition by a different task', () => {
      registry.acquireLock('src/models.py', 'task_001');
      expect(registry.acquireLock('src/models.py', 'task_002')).toBe(false);
    });

    it('should allow takeover when previous owner is in terminal state', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.updateLockStatus('src/models.py', 'task_001', 'COMPLETE');
      expect(registry.acquireLock('src/models.py', 'task_002')).toBe(true);
    });

    it('should allow takeover after FAILED', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.updateLockStatus('src/models.py', 'task_001', 'FAILED');
      expect(registry.acquireLock('src/models.py', 'task_002')).toBe(true);
    });

    it('should NOT allow takeover while owner is ACTIVE', () => {
      registry.acquireLock('src/models.py', 'task_001');
      expect(registry.acquireLock('src/models.py', 'task_002')).toBe(false);
    });

    it('should NOT allow takeover while owner is BLOCKED', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.updateLockStatus('src/models.py', 'task_001', 'BLOCKED');
      expect(registry.acquireLock('src/models.py', 'task_002')).toBe(false);
    });
  });

  describe('releaseLock', () => {
    it('should release a lock held by the same task', () => {
      registry.acquireLock('src/models.py', 'task_001');
      expect(registry.releaseLock('src/models.py', 'task_001')).toBe(true);
    });

    it('should not release a lock held by a different task', () => {
      registry.acquireLock('src/models.py', 'task_001');
      expect(registry.releaseLock('src/models.py', 'task_002')).toBe(false);
    });

    it('should return false for unowned files', () => {
      expect(registry.releaseLock('src/unowned.py', 'task_001')).toBe(false);
    });

    it('should allow re-acquisition after release', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.releaseLock('src/models.py', 'task_001');
      expect(registry.acquireLock('src/models.py', 'task_002')).toBe(true);
    });
  });

  describe('getOwner', () => {
    it('should return the owning task ID', () => {
      registry.acquireLock('src/models.py', 'task_001');
      expect(registry.getOwner('src/models.py')).toBe('task_001');
    });

    it('should return null for unowned files', () => {
      expect(registry.getOwner('src/unowned.py')).toBeNull();
    });

    it('should return null after release', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.releaseLock('src/models.py', 'task_001');
      expect(registry.getOwner('src/models.py')).toBeNull();
    });

    it('should return null when owner is in terminal state', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.updateLockStatus('src/models.py', 'task_001', 'COMPLETE');
      expect(registry.getOwner('src/models.py')).toBeNull();
    });

    it('should return owner when status is BLOCKED (lock held)', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.updateLockStatus('src/models.py', 'task_001', 'BLOCKED');
      expect(registry.getOwner('src/models.py')).toBe('task_001');
    });
  });

  describe('updateLockStatus', () => {
    it('should update the status of an existing lock', () => {
      registry.acquireLock('src/models.py', 'task_001');
      expect(registry.updateLockStatus('src/models.py', 'task_001', 'BLOCKED')).toBe(true);
      expect(registry.getOwner('src/models.py')).toBe('task_001');
    });

    it('should fail for a non-existent lock', () => {
      expect(registry.updateLockStatus('src/missing.py', 'task_001', 'COMPLETE')).toBe(false);
    });

    it('should fail if the task is not the owner', () => {
      registry.acquireLock('src/models.py', 'task_001');
      expect(registry.updateLockStatus('src/models.py', 'task_002', 'BLOCKED')).toBe(false);
    });
  });

  describe('getActiveLocks', () => {
    it('should return all non-terminal locks', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.acquireLock('src/routes.py', 'task_002');
      const active = registry.getActiveLocks();
      expect(active.size).toBe(2);
      expect(active.get('src/models.py')?.taskId).toBe('task_001');
      expect(active.get('src/routes.py')?.taskId).toBe('task_002');
    });

    it('should exclude terminal locks', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.acquireLock('src/routes.py', 'task_002');
      registry.updateLockStatus('src/models.py', 'task_001', 'COMPLETE');
      const active = registry.getActiveLocks();
      expect(active.size).toBe(1);
      expect(active.get('src/routes.py')?.taskId).toBe('task_002');
    });

    it('should return empty map when no locks', () => {
      expect(registry.getActiveLocks().size).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all locks', () => {
      registry.acquireLock('src/models.py', 'task_001');
      registry.acquireLock('src/routes.py', 'task_002');
      registry.clear();
      expect(registry.getOwner('src/models.py')).toBeNull();
      expect(registry.getOwner('src/routes.py')).toBeNull();
    });
  });

  describe('conflict prevention scenario', () => {
    it('should prevent two tasks from targeting the same file simultaneously', () => {
      // Task 1 acquires
      expect(registry.acquireLock('src/auth.py', 'task_001')).toBe(true);
      // Task 2 is blocked
      expect(registry.acquireLock('src/auth.py', 'task_002')).toBe(false);
      // Task 1 completes and releases
      registry.releaseLock('src/auth.py', 'task_001');
      // Task 2 can now acquire
      expect(registry.acquireLock('src/auth.py', 'task_002')).toBe(true);
    });

    it('should hold lock through BLOCKED → RESOLVING → DEPENDENCY_BUILDING → RESUMED', () => {
      registry.acquireLock('src/server.py', 'task_001');
      registry.updateLockStatus('src/server.py', 'task_001', 'BLOCKED');
      expect(registry.getOwner('src/server.py')).toBe('task_001');
      registry.updateLockStatus('src/server.py', 'task_001', 'RESOLVING');
      expect(registry.getOwner('src/server.py')).toBe('task_001');
      registry.updateLockStatus('src/server.py', 'task_001', 'DEPENDENCY_BUILDING');
      expect(registry.getOwner('src/server.py')).toBe('task_001');
      registry.updateLockStatus('src/server.py', 'task_001', 'RESUMED');
      expect(registry.getOwner('src/server.py')).toBe('task_001');
      // Another task still cannot acquire
      expect(registry.acquireLock('src/server.py', 'task_002')).toBe(false);
      // Only when COMPLETE
      registry.updateLockStatus('src/server.py', 'task_001', 'COMPLETE');
      expect(registry.getOwner('src/server.py')).toBeNull();
      expect(registry.acquireLock('src/server.py', 'task_002')).toBe(true);
    });
  });
});