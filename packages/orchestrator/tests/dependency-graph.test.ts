/**
 * Neuralgentics — Dependency Graph Tests
 *
 * Tests for topological sort (Kahn's algorithm), parallel group identification,
 * ready/blocked task finders, and graph validation.
 */

import { describe, it, expect } from 'vitest';
import type { FineGrainedTaskEntry } from '../src/types.js';
import {
  topologicalSort,
  getParallelGroups,
  findReadyTasks,
  findBlockedTasks,
  findResolvingTasks,
  findBuildingTasks,
  validateDependencyGraph,
} from '../src/dependency-graph.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal FineGrainedTaskEntry for testing. */
function makeTask(overrides: Partial<FineGrainedTaskEntry> & Pick<FineGrainedTaskEntry, 'id' | 'targetFile'>): FineGrainedTaskEntry {
  return {
    type: 'new_file',
    agent: 'coder',
    scope: { inScope: [overrides.targetFile], outOfScope: [] },
    dependsOn: [],
    status: 'PENDING',
    priority: 'medium',
    estimatedTokens: 100,
    dispatchCount: 0,
    maxDispatches: 3,
    isDeltaTask: false,
    ...overrides,
  };
}

// ============================================================================
// Topological Sort
// ============================================================================

describe('topologicalSort', () => {
  it('should return empty array for empty input', () => {
    expect(topologicalSort([])).toEqual([]);
  });

  it('should return single task unchanged', () => {
    const task = makeTask({ id: 't1', targetFile: 'a.py' });
    const result = topologicalSort([task]);
    expect(result).toEqual([task]);
  });

  it('should sort independent tasks (no deps)', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py' });
    const result = topologicalSort([t1, t2]);
    expect(result.length).toBe(2);
    expect(result).toContainEqual(t1);
    expect(result).toContainEqual(t2);
  });

  it('should respect dependency ordering', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'models.py' });
    const t2 = makeTask({ id: 't2', targetFile: 'auth.py', dependsOn: ['t1'] });
    const t3 = makeTask({ id: 't3', targetFile: 'routes.py', dependsOn: ['t2'] });
    const result = topologicalSort([t3, t1, t2]);
    const ids = result.map((t) => t.id);
    expect(ids.indexOf('t1')).toBeLessThan(ids.indexOf('t2'));
    expect(ids.indexOf('t2')).toBeLessThan(ids.indexOf('t3'));
  });

  it('should handle diamond dependency pattern', () => {
    //     t1
    //    / \
    //   t2   t3
    //    \ /
    //     t4
    const t1 = makeTask({ id: 't1', targetFile: 'models.py' });
    const t2 = makeTask({ id: 't2', targetFile: 'auth.py', dependsOn: ['t1'] });
    const t3 = makeTask({ id: 't3', targetFile: 'config.py', dependsOn: ['t1'] });
    const t4 = makeTask({ id: 't4', targetFile: 'routes.py', dependsOn: ['t2', 't3'] });
    const result = topologicalSort([t4, t1, t2, t3]);
    const ids = result.map((t) => t.id);
    expect(ids.indexOf('t1')).toBeLessThan(ids.indexOf('t2'));
    expect(ids.indexOf('t1')).toBeLessThan(ids.indexOf('t3'));
    expect(ids.indexOf('t2')).toBeLessThan(ids.indexOf('t4'));
    expect(ids.indexOf('t3')).toBeLessThan(ids.indexOf('t4'));
  });

  it('should throw on cycle detection', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', dependsOn: ['t2'] });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', dependsOn: ['t1'] });
    expect(() => topologicalSort([t1, t2])).toThrow('Dependency cycle detected');
  });

  it('should throw on 3-node cycle', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', dependsOn: ['t3'] });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', dependsOn: ['t1'] });
    const t3 = makeTask({ id: 't3', targetFile: 'c.py', dependsOn: ['t2'] });
    expect(() => topologicalSort([t1, t2, t3])).toThrow('Dependency cycle detected');
  });

  it('should handle the 5-file auth feature from DESIGN §2.2', () => {
    const t1 = makeTask({ id: 'task_auth_001', targetFile: 'packages/auth/src/models.py' });
    const t2 = makeTask({ id: 'task_auth_002', targetFile: 'packages/auth/src/config.py' });
    const t3 = makeTask({ id: 'task_auth_003', targetFile: 'packages/auth/src/auth.py', dependsOn: ['task_auth_001', 'task_auth_002'] });
    const t4 = makeTask({ id: 'task_auth_004', targetFile: 'packages/auth/src/routes.py', dependsOn: ['task_auth_003'] });
    const t5 = makeTask({ id: 'task_auth_005', targetFile: 'tests/test_auth.py', dependsOn: ['task_auth_003', 'task_auth_004'], agent: 'tester' });

    const result = topologicalSort([t5, t3, t1, t4, t2]);
    const ids = result.map((t) => t.id);

    // t1 and t2 have no deps — they must come first
    expect(ids.indexOf('task_auth_001')).toBeLessThan(ids.indexOf('task_auth_003'));
    expect(ids.indexOf('task_auth_002')).toBeLessThan(ids.indexOf('task_auth_003'));
    // t3 depends on t1+t2, t4 depends on t3, t5 depends on t3+t4
    expect(ids.indexOf('task_auth_003')).toBeLessThan(ids.indexOf('task_auth_004'));
    expect(ids.indexOf('task_auth_003')).toBeLessThan(ids.indexOf('task_auth_005'));
    expect(ids.indexOf('task_auth_004')).toBeLessThan(ids.indexOf('task_auth_005'));
  });
});

// ============================================================================
// Parallel Groups
// ============================================================================

describe('getParallelGroups', () => {
  it('should return empty array for empty input', () => {
    expect(getParallelGroups([])).toEqual([]);
  });

  it('should group single task at depth 0', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py' });
    const groups = getParallelGroups([t1]);
    expect(groups.length).toBe(1);
    expect(groups[0]).toEqual([t1]);
  });

  it('should put independent tasks in the same group', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py' });
    const groups = getParallelGroups([t1, t2]);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(2);
  });

  it('should create separate groups for dependency depths', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'models.py' });
    const t2 = makeTask({ id: 't2', targetFile: 'auth.py', dependsOn: ['t1'] });
    const t3 = makeTask({ id: 't3', targetFile: 'routes.py', dependsOn: ['t2'] });
    const groups = getParallelGroups([t1, t2, t3]);
    expect(groups.length).toBe(3);
    expect(groups[0]).toEqual([t1]);
    expect(groups[1]).toEqual([t2]);
    expect(groups[2]).toEqual([t3]);
  });

  it('should handle diamond dependency with proper depth grouping', () => {
    //     t1
    //    / \
    //   t2   t3   (both at depth 1)
    //    \ /
    //     t4      (depth 2)
    const t1 = makeTask({ id: 't1', targetFile: 'models.py' });
    const t2 = makeTask({ id: 't2', targetFile: 'auth.py', dependsOn: ['t1'] });
    const t3 = makeTask({ id: 't3', targetFile: 'config.py', dependsOn: ['t1'] });
    const t4 = makeTask({ id: 't4', targetFile: 'routes.py', dependsOn: ['t2', 't3'] });
    const groups = getParallelGroups([t1, t2, t3, t4]);
    expect(groups.length).toBe(3);
    expect(groups[0]).toEqual([t1]);
    expect(groups[1].length).toBe(2); // t2 and t3 in parallel
    expect(groups[2]).toEqual([t4]);
  });

  it('should handle 5-file auth feature grouping', () => {
    const t1 = makeTask({ id: 'task_auth_001', targetFile: 'models.py' });
    const t2 = makeTask({ id: 'task_auth_002', targetFile: 'config.py' });
    const t3 = makeTask({ id: 'task_auth_003', targetFile: 'auth.py', dependsOn: ['task_auth_001', 'task_auth_002'] });
    const t4 = makeTask({ id: 'task_auth_004', targetFile: 'routes.py', dependsOn: ['task_auth_003'] });
    const t5 = makeTask({ id: 'task_auth_005', targetFile: 'test_auth.py', dependsOn: ['task_auth_003', 'task_auth_004'], agent: 'tester' });

    const groups = getParallelGroups([t1, t2, t3, t4, t5]);
    // Depth 0: t1, t2 (parallel)
    // Depth 1: t3 (depends on both)
    // Depth 2: t4
    // Depth 3: t5
    expect(groups.length).toBe(4);
    expect(groups[0].length).toBe(2); // models + config in parallel
    expect(groups[1].length).toBe(1); // auth
    expect(groups[2].length).toBe(1); // routes
    expect(groups[3].length).toBe(1); // test
  });

  it('should throw on cycle detection', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', dependsOn: ['t2'] });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', dependsOn: ['t1'] });
    expect(() => getParallelGroups([t1, t2])).toThrow('Dependency cycle');
  });
});

// ============================================================================
// Ready & Blocked Finders
// ============================================================================

describe('findReadyTasks', () => {
  it('should find PENDING tasks with no dependencies', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'PENDING' });
    const result = findReadyTasks([t1]);
    expect(result).toEqual([t1]);
  });

  it('should find PENDING tasks whose deps are all COMPLETE', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'COMPLETE' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', status: 'PENDING', dependsOn: ['t1'] });
    const result = findReadyTasks([t1, t2]);
    expect(result).toEqual([t2]);
  });

  it('should NOT find tasks whose deps are not COMPLETE', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'ACTIVE' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', status: 'PENDING', dependsOn: ['t1'] });
    const result = findReadyTasks([t1, t2]);
    expect(result).toEqual([]);
  });

  it('should NOT find tasks that are already READY or ACTIVE', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'READY' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', status: 'ACTIVE' });
    const result = findReadyTasks([t1, t2]);
    expect(result).toEqual([]);
  });

  it('should find multiple ready tasks', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'PENDING' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', status: 'PENDING' });
    const t3 = makeTask({ id: 't3', targetFile: 'c.py', status: 'COMPLETE' });
    const t4 = makeTask({ id: 't4', targetFile: 'd.py', status: 'PENDING', dependsOn: ['t3'] });
    const result = findReadyTasks([t1, t2, t3, t4]);
    expect(result.length).toBe(3);
    expect(result.map((t) => t.id).sort()).toEqual(['t1', 't2', 't4']);
  });

  it('should require ALL deps to be COMPLETE', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'COMPLETE' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', status: 'ACTIVE' });
    const t3 = makeTask({ id: 't3', targetFile: 'c.py', status: 'PENDING', dependsOn: ['t1', 't2'] });
    const result = findReadyTasks([t1, t2, t3]);
    expect(result).toEqual([]);
  });
});

describe('findBlockedTasks', () => {
  it('should find BLOCKED tasks', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'BLOCKED' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', status: 'ACTIVE' });
    const result = findBlockedTasks([t1, t2]);
    expect(result).toEqual([t1]);
  });

  it('should return empty when no tasks are blocked', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'ACTIVE' });
    expect(findBlockedTasks([t1])).toEqual([]);
  });
});

describe('findResolvingTasks', () => {
  it('should find RESOLVING tasks', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'RESOLVING' });
    expect(findResolvingTasks([t1])).toEqual([t1]);
  });
});

describe('findBuildingTasks', () => {
  it('should find DEPENDENCY_BUILDING tasks', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', status: 'DEPENDENCY_BUILDING' });
    expect(findBuildingTasks([t1])).toEqual([t1]);
  });
});

// ============================================================================
// Validation
// ============================================================================

describe('validateDependencyGraph', () => {
  it('should validate a correct graph', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py' });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', dependsOn: ['t1'] });
    const result = validateDependencyGraph([t1, t2]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should detect self-referencing dependency', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', dependsOn: ['t1'] });
    const result = validateDependencyGraph([t1]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('depends on itself'))).toBe(true);
  });

  it('should detect dangling dependency reference', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', dependsOn: ['nonexistent'] });
    const result = validateDependencyGraph([t1]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('non-existent task'))).toBe(true);
  });

  it('should detect duplicate target files', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'src/models.py' });
    const t2 = makeTask({ id: 't2', targetFile: 'src/models.py' });
    const result = validateDependencyGraph([t1, t2]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('same file'))).toBe(true);
  });

  it('should detect cycles', () => {
    const t1 = makeTask({ id: 't1', targetFile: 'a.py', dependsOn: ['t2'] });
    const t2 = makeTask({ id: 't2', targetFile: 'b.py', dependsOn: ['t1'] });
    const result = validateDependencyGraph([t1, t2]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Cycle'))).toBe(true);
  });

  it('should warn on deep dependency chains (>5)', () => {
    const tasks: FineGrainedTaskEntry[] = [];
    for (let i = 0; i < 7; i++) {
      tasks.push(makeTask({
        id: `t${i}`,
        targetFile: `file${i}.py`,
        dependsOn: i === 0 ? [] : [`t${i - 1}`],
      }));
    }
    const result = validateDependencyGraph(tasks);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('exceeds recommended max'))).toBe(true);
  });

  it('should return valid for empty graph', () => {
    const result = validateDependencyGraph([]);
    expect(result.valid).toBe(true);
  });
});