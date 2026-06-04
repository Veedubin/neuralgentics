/**
 * Neuralgentics — Self-Evolution Gate Type Definitions
 *
 * Re-exports from the shared types module for convenience.
 * All self-evolution types live in ../types.ts to avoid duplication.
 */

export type {
  PatternType,
  CriteriaResult,
  PatternCandidate,
  EvolutionResult,
  SelfEvolutionGateOptions,
  CriteriaScores,
} from '../types.js';

export { CRITERION_THRESHOLD } from '../types.js';