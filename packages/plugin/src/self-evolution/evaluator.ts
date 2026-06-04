/**
 * Neuralgentics — Self-Evolution Gate Criteria Evaluator
 *
 * Scoring functions for the four self-evolution criteria:
 *   1. Repetition    — Pattern appeared in 3+ sessions
 *   2. Interface Clarity — Clear input/output, documented as "When X, do Y"
 *   3. Independence  — Can run without deep session context
 *   4. Time Savings  — Net positive: time saved > maintenance cost
 *
 * Each function returns a score from 0 to 1.
 * A candidate qualifies when ALL scores >= CRITERION_THRESHOLD (0.6).
 *
 * Adapted from boomerang-v3 for the Neuralgentics namespace.
 * No namespace-specific changes needed — evaluator is pure logic.
 */

import { CRITERION_THRESHOLD } from '../types.js';
import type { CriteriaScores } from '../types.js';

// Keywords suggesting clear input/output interface
const INTERFACE_CLARITY_KEYWORDS = [
  'when', 'do', 'input', 'output', 'workflow',
  'trigger', 'produce', 'generate', 'execute',
  'run', 'process', 'transform', 'convert',
  'parse', 'build', 'create', 'fetch',
  'given', 'return', 'accept', 'require',
];

// Patterns suggesting deep context-dependence (low independence)
const CONTEXT_DEPENDENT_PATTERNS = [
  /session[-_]?id/i,
  /specific\s+file/i,
  /this\s+project/i,
  /current\s+context/i,
  /only\s+in\s+this\s+case/i,
  /file\s+at\s+\/(home|tmp|var|etc)/i,
  /\.ts["']/,   // References to specific .ts files
  /\.py["']/,   // References to specific .py files
  /localhost:\d{4}/i,  // Specific port numbers
];

// Patterns suggesting high time savings potential
const HIGH_SAVINGS_PATTERNS = [
  /repeatedly/i,
  /every\s+session/i,
  /always\s+do/i,
  /common\s+task/i,
  /routine/i,
  /automat/i,
  /recurrent/i,
  /frequent/i,
];

// Patterns suggesting low time savings (complex workflows)
const LOW_SAVINGS_PATTERNS = [
  /careful\s+review/i,
  /analyze\s+deep/i,
  /evaluate\s+all/i,
  /complex\s+decision/i,
  /manual\s+review/i,
  /requires\s+human/i,
  /judgment/i,
];

/**
 * Score repetition based on trigger count.
 *
 * - triggerCount < 3  → 0.0 (hard fail)
 * - triggerCount = 3  → 0.6 (minimum threshold)
 * - triggerCount = 5  → 0.8
 * - triggerCount >= 7 → 1.0 (max)
 */
export function scoreRepetition(triggerCount: number): number {
  if (triggerCount < 3) return 0.0;
  if (triggerCount === 3) return 0.6;
  if (triggerCount <= 5) return 0.6 + (triggerCount - 3) * 0.1;
  return 1.0;
}

/**
 * Score interface clarity based on keyword presence in the pattern text.
 *
 * Checks for words that suggest a clear "When X, do Y" structure.
 * More matching keywords → higher score.
 */
export function scoreInterfaceClarity(pattern: string): number {
  if (!pattern || pattern.trim().length === 0) return 0.0;

  const lowerPattern = pattern.toLowerCase();

  // Count matching keywords
  const matchCount = INTERFACE_CLARITY_KEYWORDS.filter((kw) =>
    lowerPattern.includes(kw),
  ).length;

  // Max expected is ~4-5 keyword matches; 3+ is good clarity
  if (matchCount >= 4) return 1.0;
  if (matchCount >= 3) return 0.8;
  if (matchCount >= 2) return 0.7;
  if (matchCount >= 1) return 0.5;
  return 0.2;
}

/**
 * Score independence — whether the pattern can run without deep session context.
 *
 * Checks for context-dependent patterns that would block independent execution.
 * Fewer context-dependent patterns → higher independence score.
 *
 * @param pattern - The pattern description text
 * @param history - Array of session history strings (used to check context spread)
 */
export function scoreIndependence(pattern: string, history: string[]): number {
  if (!pattern || pattern.trim().length === 0) return 0.0;

  const lowerPattern = pattern.toLowerCase();

  // Count context-dependent pattern matches
  const dependentMatches = CONTEXT_DEPENDENT_PATTERNS.filter((regex) =>
    regex.test(lowerPattern),
  ).length;

  // Base score from pattern text
  let score: number;
  if (dependentMatches === 0) {
    score = 0.9;
  } else if (dependentMatches === 1) {
    score = 0.6;
  } else if (dependentMatches === 2) {
    score = 0.4;
  } else {
    score = 0.2;
  }

  // Adjust based on history consistency:
  // If the same pattern appears across diverse session contexts, it's more independent.
  if (history.length >= 3) {
    const uniqueContexts = new Set(
      history.map((h) => h.slice(0, 50).toLowerCase()),
    ).size;
    // High diversity in session histories → boost independence
    if (uniqueContexts >= 3) {
      score = Math.min(1.0, score + 0.1);
    } else if (uniqueContexts < 2) {
      score = Math.max(0.0, score - 0.1);
    }
  }

  return score;
}

/**
 * Score time savings — estimates whether automating this pattern saves more time
 * than the cost of maintaining the skill/agent.
 *
 * - Simple, repeated workflows → high savings
 * - Complex, judgment-based workflows → low savings
 */
export function scoreTimeSavings(pattern: string): number {
  if (!pattern || pattern.trim().length === 0) return 0.0;

  const lowerPattern = pattern.toLowerCase();

  // Check for high-savings indicators
  const highSavingsCount = HIGH_SAVINGS_PATTERNS.filter((regex) =>
    regex.test(lowerPattern),
  ).length;

  // Check for low-savings indicators
  const lowSavingsCount = LOW_SAVINGS_PATTERNS.filter((regex) =>
    regex.test(lowerPattern),
  ).length;

  // Base score from competing indicators
  if (lowSavingsCount > 0 && highSavingsCount === 0) {
    return 0.3; // Complex patterns without repetition signals
  }

  if (highSavingsCount >= 2) return 0.9;
  if (highSavingsCount === 1) return 0.7;

  // Default: moderate time savings for well-defined patterns
  if (lowerPattern.length > 20) return 0.6;
  return 0.5;
}

/**
 * Check whether all criterion scores meet the minimum threshold.
 *
 * A candidate qualifies only when ALL four scores are >= CRITERION_THRESHOLD.
 */
export function meetsThreshold(scores: CriteriaScores): boolean {
  return (
    scores.repetition >= CRITERION_THRESHOLD &&
    scores.interfaceClarity >= CRITERION_THRESHOLD &&
    scores.independence >= CRITERION_THRESHOLD &&
    scores.timeSavings >= CRITERION_THRESHOLD
  );
}

/**
 * Compute all four criteria scores for a given pattern candidate.
 *
 * @param pattern - The pattern description text
 * @param triggerCount - Number of times the pattern has been triggered
 * @param history - Array of session history strings
 * @returns Scores for each criterion (0–1 scale)
 */
export function computeAllScores(
  pattern: string,
  triggerCount: number,
  history: string[],
): CriteriaScores {
  return {
    repetition: scoreRepetition(triggerCount),
    interfaceClarity: scoreInterfaceClarity(pattern),
    independence: scoreIndependence(pattern, history),
    timeSavings: scoreTimeSavings(pattern),
  };
}