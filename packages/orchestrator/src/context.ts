/**
 * Neuralgentics — ContextPackage Builder & Stateless Memory Operations
 *
 * Queries the MemoryAdapter for L0/L1 summaries, relevant memories,
 * and trust scores, then assembles a ContextPackage for the agent.
 *
 * Also provides stateless memory operations for storing/retrieving
 * context packages and agent wrap-ups via memini-core HTTP API.
 */

import type {
  Memory,
  ContextPackage,
  ContextPackageMetadata,
  AgentWrapUp,
  AgentWrapUpMetadata,
  Task,
  AgentRole,
  StatelessTaskResult,
  TrustSignal,
} from './types.js';
import { resolveAgent } from './routing.js';
import { buildSeedPromptObject, formatSeedPrompt } from './stateless-protocol.js';
import type { SeedPrompt } from './types.js';

// ============================================================================
// Memory Adapter Interface
// ============================================================================

export interface MemoryAdapter {
  queryMemories(query: string, limit?: number): Promise<Memory[]>;
  addMemory(content: string, metadata?: Record<string, unknown>): Promise<string>;
  adjustTrust(id: string, signal: string): Promise<void>;
  getRelatedMemories(id: string): Promise<import('./types.js').Relationship[]>;
  getTier0Summary(): Promise<string | null>;
  getTier1Summary(): Promise<string | null>;

  // Stateless agent protocol methods
  /** Retrieve a single memory by ID from memini-core */
  getMemory(id: string): Promise<Memory>;
  /** Store a context package and return the memory ID */
  storeContextPackage(
    pkg: ContextPackage,
    metadata: ContextPackageMetadata
  ): Promise<string>;
  /** Fetch an agent's wrap-up result by memory ID */
  fetchAgentWrapUp(wrapUpMemoryId: string): Promise<AgentWrapUp>;
  /** Store an agent wrap-up and return the memory ID */
  storeAgentWrapUp(
    wrapUp: AgentWrapUp,
    metadata: AgentWrapUpMetadata
  ): Promise<string>;
}

// ============================================================================
// HTTP Memory Adapter
// ============================================================================

/** Default memini-core base URL */
const DEFAULT_MEMINI_CORE_URL = 'http://localhost:8900';

/**
 * HTTP-based MemoryAdapter that communicates with memini-core
 * via plain JSON over HTTP (no MCP).
 */
export class HttpMemoryAdapter implements MemoryAdapter {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? DEFAULT_MEMINI_CORE_URL;
  }

  async queryMemories(query: string, limit = 10): Promise<Memory[]> {
    const response = await fetch(`${this.baseUrl}/memory/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!response.ok) {
      throw new Error(`queryMemories failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { results: Memory[] };
    return data.results ?? [];
  }

  async addMemory(content: string, metadata?: Record<string, unknown>): Promise<string> {
    const response = await fetch(`${this.baseUrl}/memory/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, metadata: metadata ?? {} }),
    });
    if (!response.ok) {
      throw new Error(`addMemory failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { id: string };
    return data.id;
  }

  async adjustTrust(id: string, signal: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/memory/${id}/trust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signal }),
    });
    if (!response.ok) {
      throw new Error(`adjustTrust failed: ${response.status} ${response.statusText}`);
    }
  }

  async getRelatedMemories(id: string): Promise<import('./types.js').Relationship[]> {
    const response = await fetch(`${this.baseUrl}/memory/${id}/related`);
    if (!response.ok) {
      throw new Error(`getRelatedMemories failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { relationships: import('./types.js').Relationship[] };
    return data.relationships ?? [];
  }

  async getTier0Summary(): Promise<string | null> {
    const response = await fetch(`${this.baseUrl}/memory/tier0`);
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`getTier0Summary failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { summary: string | null };
    return data.summary ?? null;
  }

  async getTier1Summary(): Promise<string | null> {
    const response = await fetch(`${this.baseUrl}/memory/tier1`);
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`getTier1Summary failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { summary: string | null };
    return data.summary ?? null;
  }

  async getMemory(id: string): Promise<Memory> {
    const response = await fetch(`${this.baseUrl}/memory/${id}`);
    if (!response.ok) {
      throw new Error(`getMemory(${id}) failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<Memory>;
  }

  async storeContextPackage(
    pkg: ContextPackage,
    metadata: ContextPackageMetadata
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/memory/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: JSON.stringify(pkg),
        sourceType: 'context_package',
        metadata,
      }),
    });
    if (!response.ok) {
      throw new Error(`storeContextPackage failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { id: string };
    return data.id;
  }

  async fetchAgentWrapUp(wrapUpMemoryId: string): Promise<AgentWrapUp> {
    const memory = await this.getMemory(wrapUpMemoryId);
    // The content is JSON-stringified in memini-core
    return JSON.parse(memory.content) as AgentWrapUp;
  }

  async storeAgentWrapUp(
    wrapUp: AgentWrapUp,
    metadata: AgentWrapUpMetadata
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/memory/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: JSON.stringify(wrapUp),
        sourceType: 'agent_wrap_up',
        metadata,
      }),
    });
    if (!response.ok) {
      throw new Error(`storeAgentWrapUp failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { id: string };
    return data.id;
  }
}

// ============================================================================
// ContextPackage Builder
// ============================================================================

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

// ============================================================================
// Stateless Protocol Helper Functions
// ============================================================================

/**
 * Store a ContextPackage in memini-core and return the memory ID.
 *
 * This is the core of the stateless protocol: instead of passing
 * the full context inline, we store it and hand the agent a reference.
 */
export async function storeContextPackage(
  memory: MemoryAdapter,
  pkg: ContextPackage,
  task: Task,
  agent: AgentRole
): Promise<string> {
  const metadata: ContextPackageMetadata = {
    taskType: task.type,
    agentRole: agent,
    taskId: task.id,
    parentMemoryId: null,
    createdAt: new Date().toISOString(),
    project: 'neuralgentics',
    version: '1.0',
  };

  const memoryId = await memory.storeContextPackage(pkg, metadata);

  // Update the self-referencing contextMemoryId
  metadata.contextMemoryId = memoryId;

  return memoryId;
}

/**
 * Fetch a ContextPackage from memini-core by memory ID.
 */
export async function fetchContextPackage(
  memory: MemoryAdapter,
  memoryId: string
): Promise<ContextPackage> {
  const mem = await memory.getMemory(memoryId);
  return JSON.parse(mem.content) as ContextPackage;
}

/**
 * Store an agent wrap-up in memini-core and return the memory ID.
 */
export async function storeAgentWrapUp(
  memory: MemoryAdapter,
  wrapUp: AgentWrapUp,
  task: Task,
  agent: AgentRole,
  contextMemoryId: string,
  durationMs: number,
  success: boolean
): Promise<string> {
  const metadata: AgentWrapUpMetadata = {
    taskType: task.type,
    agentRole: agent,
    taskId: task.id,
    contextMemoryId,
    parentWrapUpId: null,
    createdAt: new Date().toISOString(),
    project: 'neuralgentics',
    durationMs,
    success,
  };

  return memory.storeAgentWrapUp(wrapUp, metadata);
}

/**
 * Fetch an agent wrap-up from memini-core by memory ID.
 */
export async function fetchAgentWrapUp(
  memory: MemoryAdapter,
  wrapUpMemoryId: string
): Promise<AgentWrapUp> {
  return memory.fetchAgentWrapUp(wrapUpMemoryId);
}

/**
 * Build a SeedPrompt object for stateless dispatch.
 * Stores the context in memini-core first, then returns the seed prompt.
 */
export async function buildSeedPrompt(
  memory: MemoryAdapter,
  task: Task,
  contextPackage: ContextPackage,
  agent: AgentRole
): Promise<{ seedPrompt: SeedPrompt; contextMemoryId: string }> {
  const contextMemoryId = await storeContextPackage(memory, contextPackage, task, agent);
  const seedPrompt = buildSeedPromptObject(task.description, contextMemoryId);
  return { seedPrompt, contextMemoryId };
}