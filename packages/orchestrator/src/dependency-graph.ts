/**
 * Neuralgentics — Dependency Graph Utilities
 *
 * Implements Kahn's algorithm for topological sorting of FineGrainedTaskEntry
 * lists, parallel group identification, and ready/blocked task discovery.
 *
 * See DESIGN_fine_grained_scoping_v1.md §3.
 */

import type { FineGrainedTaskEntry, TaskStatus } from './types.js';

// ============================================================================
// Topological Sort (Kahn's Algorithm)
// ============================================================================

/**
 * Sort tasks in dependency order using Kahn's algorithm.
 *
 * Returns a flat array of tasks in topological order (dependencies first).
 * Throws if a cycle is detected (tasks remain with non-zero in-degree after
 * processing all reachable nodes).
 *
 * See DESIGN §3.3, Step 5.
 */
export function topologicalSort(tasks: FineGrainedTaskEntry[]): FineGrainedTaskEntry[] {
  if (tasks.length === 0) return [];

  const taskMap = new Map<string, FineGrainedTaskEntry>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // Build in-degree map and adjacency list (dep → dependents)
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>(); // taskId → tasks that depend on it

  for (const task of tasks) {
    if (!inDegree.has(task.id)) {
      inDegree.set(task.id, 0);
    }
    for (const depId of task.dependsOn) {
      // Increment in-degree for this task
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      // Add edge from dep → this task
      if (!graph.has(depId)) graph.set(depId, []);
      graph.get(depId)!.push(task.id);
    }
  }

  // Collect all tasks with in-degree 0
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const sorted: FineGrainedTaskEntry[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const task = taskMap.get(currentId);
    if (task) {
      sorted.push(task);
    }

    const dependents = graph.get(currentId) ?? [];
    for (const depId of dependents) {
      const newDegree = (inDegree.get(depId) ?? 1) - 1;
      inDegree.set(depId, newDegree);
      if (newDegree === 0) {
        queue.push(depId);
      }
    }
  }

  // Cycle detection: if not all tasks are in sorted output, there's a cycle
  if (sorted.length !== tasks.length) {
    const missing = tasks.filter((t) => !sorted.some((s) => s.id === t.id));
    const missingIds = missing.map((t) => t.id).join(', ');
    throw new Error(`Dependency cycle detected. Tasks not reachable: ${missingIds}`);
  }

  return sorted;
}

// ============================================================================
// Parallel Groups
// ============================================================================

/**
 * Group tasks by topological depth. Tasks at the same depth with
 * no inter-dependencies can run in parallel.
 *
 * Returns an array of groups, where group[0] has depth 0 (no deps),
 * group[1] has depth 1, etc.
 *
 * See DESIGN §3.3, Step 6.
 */
export function getParallelGroups(tasks: FineGrainedTaskEntry[]): FineGrainedTaskEntry[][] {
  if (tasks.length === 0) return [];

  const taskMap = new Map<string, FineGrainedTaskEntry>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // Compute depth for each task
  const depths = new Map<string, number>();
  const computing = new Set<string>(); // cycle guard

  function computeDepth(taskId: string): number {
    if (depths.has(taskId)) return depths.get(taskId)!;
    if (computing.has(taskId)) {
      throw new Error(`Dependency cycle detected involving task: ${taskId}`);
    }
    computing.add(taskId);

    const task = taskMap.get(taskId);
    if (!task || task.dependsOn.length === 0) {
      computing.delete(taskId);
      depths.set(taskId, 0);
      return 0;
    }

    let maxDepDepth = 0;
    for (const depId of task.dependsOn) {
      const depDepth = computeDepth(depId);
      maxDepDepth = Math.max(maxDepDepth, depDepth);
    }

    computing.delete(taskId);
    const depth = maxDepDepth + 1;
    depths.set(taskId, depth);
    return depth;
  }

  // Compute depths for all tasks
  for (const task of tasks) {
    computeDepth(task.id);
  }

  // Group by depth
  const maxDepth = Math.max(...depths.values(), 0);
  const groups: FineGrainedTaskEntry[][] = [];
  for (let d = 0; d <= maxDepth; d++) {
    const group = tasks.filter((t) => depths.get(t.id) === d);
    if (group.length > 0) {
      groups.push(group);
    }
  }

  return groups;
}

// ============================================================================
// Ready & Blocked Task Finders
// ============================================================================

/**
 * Find tasks where all dependencies are COMPLETE.
 * These tasks can transition from PENDING to READY.
 *
 * See DESIGN §6.2: PENDING → READY trigger.
 */
export function findReadyTasks(tasks: FineGrainedTaskEntry[]): FineGrainedTaskEntry[] {
  const statusMap = new Map<string, TaskStatus>();
  for (const task of tasks) {
    statusMap.set(task.id, task.status);
  }

  return tasks.filter((task) => {
    if (task.status !== 'PENDING') return false;
    if (task.dependsOn.length === 0) return true;
    return task.dependsOn.every((depId) => statusMap.get(depId) === 'COMPLETE');
  });
}

/**
 * Find tasks that are BLOCKED (useful for orchestrator to know
 * what to resume after a dependency resolves).
 *
 * See DESIGN §6.2: ACTIVE → BLOCKED trigger.
 */
export function findBlockedTasks(tasks: FineGrainedTaskEntry[]): FineGrainedTaskEntry[] {
  return tasks.filter((task) => task.status === 'BLOCKED');
}

/**
 * Find tasks that are RESOLVING (architect is designing dependency).
 * Useful for tracking in-flight blocker resolutions.
 */
export function findResolvingTasks(tasks: FineGrainedTaskEntry[]): FineGrainedTaskEntry[] {
  return tasks.filter((task) => task.status === 'RESOLVING');
}

/**
 * Find tasks that are in DEPENDENCY_BUILDING state.
 * The dependency file is being implemented by a coder.
 */
export function findBuildingTasks(tasks: FineGrainedTaskEntry[]): FineGrainedTaskEntry[] {
  return tasks.filter((task) => task.status === 'DEPENDENCY_BUILDING');
}

/**
 * Validate the dependency graph: check for dangling references,
 * self-references, and depth warnings.
 *
 * See DESIGN §3.4: Graph Validation checks.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const MAX_DEPENDENCY_DEPTH = 5;

export function validateDependencyGraph(tasks: FineGrainedTaskEntry[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const taskIds = new Set(tasks.map((t) => t.id));

  for (const task of tasks) {
    // Self-reference check
    if (task.dependsOn.includes(task.id)) {
      errors.push(`Task ${task.id} depends on itself`);
    }

    // Dangling reference check
    for (const depId of task.dependsOn) {
      if (!taskIds.has(depId)) {
        errors.push(`Task ${task.id} depends on non-existent task ${depId}`);
      }
    }

    // Duplicate target file check
    const dupes = tasks.filter((t) => t.targetFile === task.targetFile && t.id !== task.id);
    if (dupes.length > 0) {
      errors.push(
        `Tasks ${[task.id, ...dupes.map((d) => d.id)].join(', ')} all target the same file: ${task.targetFile}`
      );
    }
  }

  // Depth check (warnings only)
  try {
    const groups = getParallelGroups(tasks);
    if (groups.length > MAX_DEPENDENCY_DEPTH) {
      warnings.push(
        `Dependency depth ${groups.length} exceeds recommended max of ${MAX_DEPENDENCY_DEPTH}. Consider re-examining decomposition.`
      );
    }
  } catch (err) {
    errors.push(`Cycle detected in dependency graph: ${(err as Error).message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}