/**
 * Neuralgentics — Stateless Agent Protocol
 *
 * Constants and helpers for the stateless dispatch protocol where
 * agents receive a seed prompt (task + memory_id) instead of
 * the full ContextPackage inline.
 */

import type { SeedPrompt, StatelessTaskResult } from './types.js';

// ============================================================================
// Seed Prompt Template
// ============================================================================

/**
 * Template for the seed prompt given to agents.
 * Placeholders: {task}, {memoryId}
 */
export const SEED_PROMPT_TEMPLATE = `---
## Task
{task}

## Memory Context
Your full context package is stored in memini-core at memory ID: \`{memoryId}\`

## Protocol (MANDATORY — Do NOT skip)

### 1. Context Retrieval
On start, fetch your context package:
\`\`\`
GET http://localhost:8900/memory/{memoryId}
\`\`\`
The response contains a JSON ContextPackage with:
- \`taskBackground\` — task details and memory context
- \`relevantFiles\` — files to examine
- \`codeSnippets\` — relevant code excerpts
- \`previousDecisions\` — prior architectural decisions
- \`scopeBoundaries\` — what is IN/OUT of scope
- \`expectedOutput\` — what the orchestrator expects
- \`l0Summary\` / \`l1Summary\` — project overview and key decisions

### 2. Memory Queries (during work)
Query memini-core as needed:
\`\`\`
POST http://localhost:8900/memory/query
Body: { "query": "your search terms", "limit": 10 }
\`\`\`

### 3. Wrap-Up Storage (before returning)
Build a wrap-up JSON and store it:
\`\`\`
POST http://localhost:8900/memory/add
Body: {
  "content": "JSON string with { summary, filesModified, filesCreated, followUpTasks, errors, warnings }",
  "sourceType": "agent_wrap_up",
  "metadata": {
    "taskType": "<taskType>",
    "agentRole": "<agentRole>",
    "taskId": "<taskId>",
    "contextMemoryId": "{memoryId}",
    "durationMs": <actual_duration>,
    "success": true
  }
}
\`\`\`

### 4. Trust Signal
Adjust trust on the context memory:
\`\`\`
POST http://localhost:8900/memory/{memoryId}/trust
Body: { "signal": "agent_used" }
\`\`\`

### 5. Return Format
Return ONLY this to the orchestrator:
\`\`\`
{memory_id: "<wrap_up_memory_id>", description: "<one-line summary>"}
\`\`\`
---`;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Type guard: check if a dispatch result is a stateless (memeory-backed)
 * result rather than an inline ContextPackage result.
 */
export function isStatelessDispatch(
  result: unknown
): result is { agent: string; contextMemoryId: string; seedPrompt: SeedPrompt } {
  if (typeof result !== 'object' || result === null) return false;
  const obj = result as Record<string, unknown>;
  return (
    typeof obj.contextMemoryId === 'string' &&
    typeof obj.seedPrompt === 'object' &&
    obj.seedPrompt !== null &&
    typeof (obj.seedPrompt as Record<string, unknown>).memoryId === 'string'
  );
}

/**
 * Type guard: check if an agent return value follows the StatelessTaskResult shape.
 */
export function isStatelessTaskResult(
  result: unknown
): result is StatelessTaskResult {
  if (typeof result !== 'object' || result === null) return false;
  const obj = result as Record<string, unknown>;
  return typeof obj.memory_id === 'string' && typeof obj.description === 'string';
}

/**
 * Build a seed prompt string from a task description and memory ID.
 * Substitutes placeholders in SEED_PROMPT_TEMPLATE.
 */
export function formatSeedPrompt(task: string, memoryId: string): string {
  return SEED_PROMPT_TEMPLATE.replaceAll('{task}', task).replaceAll(
    '{memoryId}',
    memoryId
  );
}

/**
 * Build a SeedPrompt object from task description and memory ID.
 */
export function buildSeedPromptObject(task: string, memoryId: string): SeedPrompt {
  return {
    task,
    memoryId,
    prompt: formatSeedPrompt(task, memoryId),
  };
}