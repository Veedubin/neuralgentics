/**
 * Neuralgentics — Skill Reuse Tracking + Trust Bump
 *
 * Records when a pre-existing skill is reused for a dispatched task,
 * estimates the token savings, stores a `skill_reuse` memory, and
 * attempts a trust bump on the skill's provenance memory.
 *
 * All errors are caught and logged — this module never throws.
 *
 * @module skill_reuse
 */

import type { MemoryAdapter } from "../adapters/memory.js";
import type { SkillMatchResult } from "./skill_lookup.js";

// ============================================================================
// Types
// ============================================================================

export interface RecordSkillReuseArgs {
  skill: SkillMatchResult;
  taskContext: string;
  memory: MemoryAdapter;
  baselineTokens?: number; // default 3000
}

export interface RecordSkillReuseResult {
  memoryId: string;
  savedTokens: number;
  trustBumped: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_BASELINE_TOKENS = 3000;

// ============================================================================
// estimateSavedTokens
// ============================================================================

/**
 * Estimate the number of tokens saved by reusing this skill instead of
 * generating the work from scratch. Uses a rough char/4 heuristic.
 *
 * Formula: max(0, baselineTokens - ceil(len(body + name) / 4))
 */
export function estimateSavedTokens(
  skill: SkillMatchResult,
  baselineTokens: number = DEFAULT_BASELINE_TOKENS,
): number {
  const totalChars = (skill.body?.length ?? 0) + (skill.name?.length ?? 0);
  const actualTokens = Math.ceil(totalChars / 4);
  return Math.max(0, baselineTokens - actualTokens);
}

// ============================================================================
// recordSkillReuse
// ============================================================================

/**
 * Record that a skill was reused for a task. Stores a `skill_reuse` memory
 * with provenance, attempts a trust bump on the most recent provenance
 * memory for the skill, and returns the result. NEVER throws — all errors
 * are caught, logged, and the function returns a "no-op" result.
 */
export async function recordSkillReuse(
  args: RecordSkillReuseArgs,
): Promise<RecordSkillReuseResult> {
  const { skill, taskContext, memory, baselineTokens = DEFAULT_BASELINE_TOKENS } = args;

  // Guard: empty body means we couldn't actually load the skill — skip
  if (!skill.body || skill.body.trim().length === 0) {
    return { memoryId: "", savedTokens: 0, trustBumped: false };
  }

  const savedTokens = estimateSavedTokens(skill, baselineTokens);

  // 1. Store the skill_reuse memory
  let memoryId = "";
  try {
    memoryId = await memory.addMemory(
      `Skill reused: ${skill.name}. Saved ~${savedTokens} tokens. Task: ${taskContext.slice(0, 200)}`,
      {
        type: "skill_reuse",
        skill: skill.name,
        saved_tokens: savedTokens,
        task: taskContext.slice(0, 200),
        score: skill.score,
        project: "neuralgentics",
      },
    );
  } catch (err) {
    console.warn(
      "[neuralgentics] recordSkillReuse: addMemory failed:",
      err instanceof Error ? err.message : err,
    );
    return { memoryId: "", savedTokens, trustBumped: false };
  }

  // 2. Find the most recent provenance memory for this skill and bump trust
  let trustBumped = false;
  try {
    const provenanceQuery = `skill:${skill.name} provenance`;
    const results = await memory.queryMemories(provenanceQuery, 5);
    // Pick the most recent result
    if (results.length > 0) {
      const provenance = results[0];
      await memory.adjustTrust(provenance.id, "agent_used");
      trustBumped = true;
    }
  } catch (err) {
    console.warn(
      "[neuralgentics] recordSkillReuse: trust bump failed:",
      err instanceof Error ? err.message : err,
    );
    // Don't fail — the memory was still saved
  }

  return { memoryId, savedTokens, trustBumped };
}

// ============================================================================
// capSkillBody
// ============================================================================

/** Cap a skill body at N characters, with a truncation marker. */
export function capSkillBody(body: string, maxChars: number = 4000): string {
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars) + "\n[... truncated]";
}