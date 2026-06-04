/**
 * Neuralgentics Plugin — Core Type Definitions
 *
 * Shared types for the compaction hook and self-evolution gate.
 * Compatible with the MemoryAdapter HTTP JSON interface.
 */

// ============================================================================
// Compaction Backup Types
// ============================================================================

/** Result of backing up files before compaction. */
export interface CompactionBackupResult {
  /** Whether all files were backed up successfully. */
  success: boolean;
  /** List of filenames that were backed up. */
  backedUp: string[];
  /** List of filenames that failed to back up. */
  failed: string[];
  /** Memory IDs of the backed-up entries. */
  memoryIds: string[];
}

/** Individual file status after restoring from compaction backup. */
export interface CompactionRestoreFile {
  /** The filename. */
  file: string;
  /** The restored file content (empty string if not found). */
  content: string;
  /** Whether the file was found in memory. */
  found: boolean;
}

/** Result of restoring context after compaction. */
export type CompactionRestoreResult = CompactionRestoreFile[];

// ============================================================================
// Self-Evolution Gate Types
// ============================================================================

/** The type of pattern candidate detected. */
export type PatternType = 'skill_candidate' | 'agent_candidate';

/** Criteria evaluation results for a pattern candidate. */
export interface CriteriaResult {
  /** Pattern appeared in 3+ sessions. */
  repetition: boolean;
  /** Clear input/output interface, not context-dependent. */
  interfaceClarity: boolean;
  /** Can run without full session context. */
  independence: boolean;
  /** Saves more time than maintenance costs. */
  timeSavings: boolean;
}

/** A pattern candidate detected from session history. */
export interface PatternCandidate {
  /** Unique identifier for the candidate. */
  id: string;
  /** Description of the detected pattern. */
  pattern: string;
  /** Whether this is a skill or agent candidate. */
  patternType: PatternType;
  /** Number of times this pattern has been triggered across sessions. */
  triggerCount: number;
  /** Suggested kebab-case name for the new skill/agent. */
  suggestedName: string;
  /** Confidence score (0–1) for how well the candidate matches criteria. */
  confidence: number;
  /** Individual criteria evaluation results. */
  criteria: CriteriaResult;
}

/** Result of a self-evolution gate run cycle. */
export interface EvolutionResult {
  /** Total number of candidates evaluated. */
  evaluated: number;
  /** Number of candidates that qualified (all criteria met). */
  qualified: number;
  /** Skill/agent entries created from qualified candidates. */
  created: Array<{ type: 'skill' | 'agent'; name: string; path: string }>;
}

/** Options for configuring the SelfEvolutionGate. */
export interface SelfEvolutionGateOptions {
  /** Minimum trigger count to consider a candidate (default: 3). */
  minTriggerCount?: number;
  /** Automatically create qualified skills/agents (default: false). */
  autoCreate?: boolean;
  /** Skip skill evaluation when set. */
  noSkills?: boolean;
  /** Skip agent evaluation when set. */
  noAgents?: boolean;
}

/** Scores for the four evaluation criteria (0–1 scale). */
export interface CriteriaScores {
  repetition: number;
  interfaceClarity: number;
  independence: number;
  timeSavings: number;
}

/** Minimum score threshold for each criterion. */
export const CRITERION_THRESHOLD = 0.6;