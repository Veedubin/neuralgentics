/**
 * Neuralgentics — ContextPackage Builder
 *
 * Queries the MemoryAdapter for L0/L1 summaries, relevant memories,
 * and trust scores, then assembles a ContextPackage for the agent.
 */

import type { Memory, ContextPackage, Task, AgentRole } from './types.js';
import { resolveAgent } from './routing.js';

export interface MemoryAdapter {
  queryMemories(query: string, limit?: number): Promise<Memory[]>;
  addMemory(content: string, metadata?: Record<string, unknown>): Promise<string>;
  adjustTrust(id: string, signal: string): Promise<void>;
  getRelatedMemories(id: string): Promise<import('./types.js').Relationship[]>;
  getTier0Summary(): Promise<string | null>;
  getTier1Summary(): Promise<string | null>;
}

/**
 * Build a ContextPackage for a task and target agent.
 *
 * Queries memory for:
 * 1. L0 summary (project context, ~100 tokens)
 * 2. L1 summary (key decisions, ~2K tokens)
 * 3. Relevant memories for the task description
 * 4. Trust scores for matched memories
 */
export async function buildContextPackage(
  task: Task,
  agent: AgentRole,
  memory: MemoryAdapter
): Promise<ContextPackage> {
  // Fetch L0/L1 summaries in parallel with relevant memories
  const [l0Summary, l1Summary, relevantMemories] = await Promise.all([
    memory.getTier0Summary().catch(() => null),
    memory.getTier1Summary().catch(() => null),
    memory.queryMemories(task.description, 10).catch(() => []),
  ]);

  // Build trust scores map from relevant memories
  const trustScores: Record<string, number> = {};
  for (const mem of relevantMemories) {
    if (mem.trustScore !== undefined) {
      trustScores[mem.id] = mem.trustScore;
    }
  }

  // Extract previous decisions from L1 summary or relevant memories
  const previousDecisions = relevantMemories
    .filter((m) => m.sourceType === 'project' || m.sourceType === 'boomerang')
    .map((m) => m.content);

  // Identify relevant file paths from memories
  const relevantFiles = relevantMemories
    .filter((m) => m.sourceType === 'file' && m.sourcePath)
    .map((m) => m.sourcePath!)
    .filter((path, idx, arr) => arr.indexOf(path) === idx); // dedupe

  // Determine scope boundaries based on task type and agent
  const scopeBoundaries = resolveScopeBoundaries(task.type, agent);

  return {
    originalUserRequest: task.userRequest,
    taskBackground: buildTaskBackground(task, relevantMemories),
    relevantFiles,
    codeSnippets: extractCodeSnippets(relevantMemories),
    previousDecisions,
    expectedOutput: resolveExpectedOutput(task.type),
    scopeBoundaries,
    errorHandling: resolveErrorHandling(task.type),
    l0Summary: l0Summary ?? undefined,
    l1Summary: l1Summary ?? undefined,
    trustScores: Object.keys(trustScores).length > 0 ? trustScores : undefined,
  };
}

/**
 * Build task background from task metadata and relevant memories.
 */
function buildTaskBackground(task: Task, memories: Memory[]): string {
  const parts: string[] = [];

  parts.push(`Task: ${task.description}`);
  parts.push(`Type: ${task.type}`);
  parts.push(`Priority: ${task.priority}`);

  if (task.files && task.files.length > 0) {
    parts.push(`Files: ${task.files.join(', ')}`);
  }

  if (memories.length > 0) {
    parts.push(`\nContext from memory (${memories.length} results):`);
    for (const mem of memories.slice(0, 5)) {
      parts.push(`- [${mem.sourceType}] ${mem.content.slice(0, 200)}`);
    }
  }

  return parts.join('\n');
}

/**
 * Extract code snippets from file-type memories.
 */
function extractCodeSnippets(memories: Memory[]): string[] {
  return memories
    .filter((m) => m.sourceType === 'file')
    .map((m) => m.content)
    .slice(0, 5);
}

/**
 * Resolve scope boundaries based on task type and agent.
 */
function resolveScopeBoundaries(
  taskType: Task['type'],
  agent: AgentRole
): { inScope: string[]; outOfScope: string[] } {
  const agentRole = resolveAgent(taskType);
  const isSameAgent = agentRole === agent;

  switch (taskType) {
    case 'code-implementation':
      return {
        inScope: ['Write/edit code', 'Implement features', 'Fix bugs'],
        outOfScope: isSameAgent
          ? ['Architecture decisions', 'Test infrastructure design']
          : [],
      };
    case 'architecture-design':
      return {
        inScope: ['System design', 'Trade-off analysis', 'Research'],
        outOfScope: ['Code implementation', 'File finding'],
      };
    case 'testing':
      return {
        inScope: ['Write tests', 'Run tests', 'Coverage analysis'],
        outOfScope: ['Implementation changes'],
      };
    case 'file-finding':
      return {
        inScope: ['Glob/find files by name', 'Map directory structure'],
        outOfScope: ['Code analysis', 'Pattern detection', 'Research'],
      };
    default:
      return {
        inScope: [`${taskType} tasks`],
        outOfScope: [],
      };
  }
}

/**
 * Resolve expected output description based on task type.
 */
function resolveExpectedOutput(taskType: Task['type']): string {
  switch (taskType) {
    case 'code-implementation':
      return 'Modified files with implementation, 100-300 word summary';
    case 'architecture-design':
      return 'Design document with trade-offs and recommendations';
    case 'testing':
      return 'Test files with coverage summary';
    case 'file-finding':
      return 'List of file paths matching query';
    case 'documentation':
      return 'Markdown documentation files';
    case 'linting':
      return 'Linting results and auto-fixes applied';
    case 'git':
      return 'Git operation result (commit hash, branch name, etc.)';
    case 'release':
      return 'Version bump, changelog, git tag';
    default:
      return 'Summary of work completed';
  }
}

/**
 * Resolve error handling strategy based on task type.
 */
function resolveErrorHandling(taskType: Task['type']): string {
  switch (taskType) {
    case 'code-implementation':
      return 'Type errors → fix types. Runtime errors → add guards. Never swallow exceptions.';
    case 'testing':
      return 'Flaky tests → add retries. Missing deps → skip with warning.';
    default:
      return 'Log errors, never swallow exceptions. Escalate to orchestrator if blocked.';
  }
}