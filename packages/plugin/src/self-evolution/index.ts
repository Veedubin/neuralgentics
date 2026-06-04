/**
 * Neuralgentics — Self-Evolution Gate Main Engine
 *
 * Automatically detects repeated patterns from session history
 * and qualifies them for skill/agent creation.
 *
 * Gate Logic (from handoff workflow Steps 5.1–5.5):
 *   5.1 — Check waiver flags (--no-skills, --no-agents)
 *   5.2 — Query memory for pattern candidates
 *   5.3 — Evaluate candidates against 4 criteria
 *   5.4 — Create qualified skills/agents
 *   5.5 — Track results and save to memory
 *
 * Adapted from boomerang-v3 for the Neuralgentics namespace.
 * Key change: Uses MemoryAdapter (HTTP JSON) instead of MeminiClient.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MemoryAdapter } from '../adapters/memory.js';
import { computeAllScores, meetsThreshold } from './evaluator.js';
import { generateSkillMarkdown, generateAgentEntry, patternToSkillParams } from './templates.js';
import type {
  PatternCandidate,
  PatternType,
  EvolutionResult,
  SelfEvolutionGateOptions,
  CriteriaResult,
  CriteriaScores,
} from '../types.js';

/** Default options for the self-evolution gate. */
const DEFAULT_OPTIONS: Required<SelfEvolutionGateOptions> = {
  minTriggerCount: 3,
  autoCreate: false,
  noSkills: false,
  noAgents: false,
};

/**
 * SelfEvolutionGate — detects repeated patterns and creates skills/agents.
 *
 * Uses MemoryAdapter to query session history for pattern candidates,
 * evaluates them against four criteria, and creates SKILL.md files
 * or AGENTS.md entries for qualified candidates.
 */
export class SelfEvolutionGate {
  private readonly options: Required<SelfEvolutionGateOptions>;
  private readonly memory: MemoryAdapter;

  constructor(options: SelfEvolutionGateOptions = {}, memory: MemoryAdapter) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.memory = memory;
  }

  /**
   * Query memory for pattern candidates.
   *
   * Searches for memories tagged with pattern_type of "skill_candidate"
   * or "agent_candidate", then filters by minTriggerCount.
   */
  async findCandidates(): Promise<PatternCandidate[]> {
    if (this.options.noSkills && this.options.noAgents) {
      return [];
    }

    try {
      const results = await this.memory.queryMemories(
        'pattern_candidate trigger_count skill agent',
        10,
      );

      const candidates: PatternCandidate[] = [];

      for (const entry of results) {
        const metadata = this.parseMetadata(entry.metadata);
        const patternType = this.extractPatternType(metadata);
        const triggerCount = this.extractTriggerCount(metadata, entry.content);

        // Filter by pattern type if waiver flags are set
        if (this.options.noSkills && patternType === 'skill_candidate') continue;
        if (this.options.noAgents && patternType === 'agent_candidate') continue;

        // Filter by minimum trigger count
        if (triggerCount < this.options.minTriggerCount) continue;

        const rawSuggestedName = metadata.suggested_name;
        const suggestedName =
          typeof rawSuggestedName === 'string' && rawSuggestedName.length > 0
            ? rawSuggestedName
            : this.inferName(entry.content);

        candidates.push({
          id: entry.id,
          pattern: entry.content,
          patternType,
          triggerCount,
          suggestedName,
          confidence: 0.5, // default confidence, updated during evaluation
          criteria: {
            repetition: false,
            interfaceClarity: false,
            independence: false,
            timeSavings: false,
          },
        });
      }

      return candidates;
    } catch {
      return [];
    }
  }

  /**
   * Evaluate a candidate against the four self-evolution criteria.
   *
   * Populates the criteria booleans and updates confidence based on scores.
   */
  async evaluateCandidate(candidate: PatternCandidate): Promise<PatternCandidate> {
    // Query memory for session history related to this pattern
    const history = await this.getPatternHistory(candidate.pattern);

    // Compute scores
    const scores = computeAllScores(
      candidate.pattern,
      candidate.triggerCount,
      history,
    );

    // Convert scores to boolean criteria results
    const criteria = this.scoresToCriteria(scores);

    // Update confidence as the average of all scores
    const confidence =
      (scores.repetition +
        scores.interfaceClarity +
        scores.independence +
        scores.timeSavings) /
      4;

    return {
      ...candidate,
      criteria,
      confidence: Math.round(confidence * 100) / 100,
    };
  }

  /**
   * Run the full self-evolution gate cycle.
   *
   * Steps 5.2–5.5 from the handoff workflow:
   * 1. Find candidates
   * 2. Evaluate each one
   * 3. Create skills/agents for qualified candidates
   * 4. Track results
   */
  async run(): Promise<EvolutionResult> {
    // Find candidates
    const candidates = await this.findCandidates();

    // Evaluate each candidate
    const evaluated: PatternCandidate[] = [];
    for (const candidate of candidates) {
      const evaluatedCandidate = await this.evaluateCandidate(candidate);
      evaluated.push(evaluatedCandidate);
    }

    // Filter qualified candidates (all criteria must be true)
    const qualified = evaluated.filter((c) =>
      c.criteria.repetition &&
      c.criteria.interfaceClarity &&
      c.criteria.independence &&
      c.criteria.timeSavings,
    );

    // Create skills/agents from qualified candidates
    const created: EvolutionResult['created'] = [];
    if (this.options.autoCreate) {
      for (const candidate of qualified) {
        try {
          const result = await this.createFromCandidate(candidate);
          created.push(result);
        } catch {
          // Skip candidates that fail to create
        }
      }
    }

    // Save evolution result to memory
    if (evaluated.length > 0) {
      await this.saveEvolutionResult(evaluated.length, qualified.length, created);
    }

    return {
      evaluated: evaluated.length,
      qualified: qualified.length,
      created,
    };
  }

  /**
   * Create a skill or agent from a qualified candidate.
   *
   * - For skill candidates: Creates `.opencode/skills/{name}/SKILL.md`
   * - For agent candidates: Appends entry to AGENTS.md
   *
   * @returns The type, name, and path of the created artifact
   */
  async createFromCandidate(candidate: PatternCandidate): Promise<{
    type: 'skill' | 'agent';
    name: string;
    path: string;
  }> {
    if (candidate.patternType === 'skill_candidate') {
      return this.createSkill(candidate);
    }
    return this.createAgent(candidate);
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private async createSkill(
    candidate: PatternCandidate,
  ): Promise<{ type: 'skill'; name: string; path: string }> {
    const skillDir = join(process.cwd(), '.opencode', 'skills', candidate.suggestedName);
    const skillPath = join(skillDir, 'SKILL.md');

    // Ensure directory exists
    await mkdir(skillDir, { recursive: true });

    // Generate SKILL.md content
    const params = patternToSkillParams(candidate.pattern, candidate.suggestedName);
    const content = generateSkillMarkdown(params);

    // Write the file
    await writeFile(skillPath, content, 'utf-8');

    // Save creation to memory
    await this.memory.addMemory(
      `Created skill: ${candidate.suggestedName}. Pattern: ${candidate.pattern}. Trigger: ${candidate.triggerCount} sessions. Criteria met: all 4.`,
      {
        pattern_type: 'skill_created',
        created_from: candidate.id,
        name: candidate.suggestedName,
        project: 'neuralgentics',
      },
    );

    return { type: 'skill', name: candidate.suggestedName, path: skillPath };
  }

  private async createAgent(
    candidate: PatternCandidate,
  ): Promise<{ type: 'agent'; name: string; path: string }> {
    const agentsPath = join(process.cwd(), 'AGENTS.md');

    // Generate AGENTS.md entry — append only, never modify existing entries
    const entry = generateAgentEntry({
      name: candidate.suggestedName,
      skill: candidate.suggestedName,
      model: 'minimax-m2.7:cloud',
      description: `Auto-generated agent for: ${candidate.pattern.slice(0, 60)}`,
      justification: `Auto-created by Neuralgentics Self-Evolution Gate. Pattern trigger: ${candidate.triggerCount} sessions.`,
    });

    // Append entry to AGENTS.md
    try {
      // Read to check if file exists and has content
      const existing = await readFile(agentsPath, 'utf-8').catch(() => '');
      const separator = existing.trim().length > 0 ? '\n' : '';
      await appendFile(agentsPath, `${separator}${entry}\n`, 'utf-8');
    } catch {
      // If AGENTS.md doesn't exist, create it
      await writeFile(agentsPath, `${entry}\n`, 'utf-8');
    }

    // Save creation to memory
    await this.memory.addMemory(
      `Created agent: ${candidate.suggestedName}. Pattern: ${candidate.pattern}. Trigger: ${candidate.triggerCount} sessions. Criteria met: all 4.`,
      {
        pattern_type: 'agent_created',
        created_from: candidate.id,
        name: candidate.suggestedName,
        project: 'neuralgentics',
      },
    );

    return { type: 'agent', name: candidate.suggestedName, path: agentsPath };
  }

  private async getPatternHistory(pattern: string): Promise<string[]> {
    try {
      const results = await this.memory.queryMemories(pattern, 5);
      return results.map((r) => r.content);
    } catch {
      return [];
    }
  }

  private async saveEvolutionResult(
    evaluated: number,
    qualified: number,
    created: EvolutionResult['created'],
  ): Promise<void> {
    try {
      const summary =
        created.length > 0
          ? `Self-Evolution Gate: ${evaluated} evaluated, ${qualified} qualified, ${created.length} created: ${created.map((c) => c.name).join(', ')}`
          : `Self-Evolution Gate: ${evaluated} evaluated, ${qualified} qualified, none created`;

      await this.memory.addMemory(summary, {
        type: 'evolution_result',
        evaluated,
        qualified,
        created: created.length,
        project: 'neuralgentics',
      });
    } catch {
      // Non-critical — don't fail if memory save fails
    }
  }

  private parseMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!metadata) return {};
    return metadata;
  }

  private extractPatternType(
    metadata: Record<string, unknown>,
  ): PatternType {
    const raw = metadata.pattern_type ?? metadata.patternType ?? '';
    if (raw === 'agent_candidate') return 'agent_candidate';
    return 'skill_candidate'; // default
  }

  private extractTriggerCount(
    metadata: Record<string, unknown>,
    text: string,
  ): number {
    // Try metadata first
    const fromMeta = metadata.trigger_count ?? metadata.triggerCount;
    if (typeof fromMeta === 'number') return fromMeta;

    // Try extracting from text (e.g., "trigger_count: 5")
    const match = text.match(/trigger[_\s]count[:\s]+(\d+)/i);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }

    return 1; // Default to 1 if not specified
  }

  private inferName(pattern: string): string {
    // Generate a kebab-case name from the first few words of the pattern
    const words = pattern
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 3);

    if (words.length === 0) {
      return `auto-skill-${randomUUID().slice(0, 8)}`;
    }

    return words.join('-');
  }

  private scoresToCriteria(scores: CriteriaScores): CriteriaResult {
    return {
      repetition: scores.repetition >= 0.6,
      interfaceClarity: scores.interfaceClarity >= 0.6,
      independence: scores.independence >= 0.6,
      timeSavings: scores.timeSavings >= 0.6,
    };
  }
}