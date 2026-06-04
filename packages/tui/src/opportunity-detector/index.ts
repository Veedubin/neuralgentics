/**
 * Opportunity Detector — barrel export.
 * T-034 (P1-c, Addendum 1).
 */

export { OpportunityDetector } from "./detector.js";
export {
  runAllPatternDetectors,
  detectSequentialToolChains,
  detectRepeatedIdenticalCalls,
  detectHighCostTurns,
  detectLongCardRetries,
  detectReReadingSameFiles,
  detectMissedParallelOpportunities,
  detectManualAggregation,
  detectErrorRetryLoops,
  type PatternDetectorInput,
} from "./patterns.js";
export {
  formatOpportunityPrompt,
  formatDetailedBreakdown,
  draftCard,
  handleOpportunitiesCommand,
  type OpportunityAction,
  type PromptResult,
  type OpportunitiesCommandResult,
} from "./prompter.js";
export {
  PATTERN_LABELS,
  PATTERN_DESCRIPTIONS,
  DEFAULT_TRIGGER_THRESHOLDS,
  type PatternType,
  type ToolCallLog,
  type CardAttemptHistory,
  type CardAttempt,
  type DispatchLog,
  type Candidate,
  type CandidateEvidence,
  type RankedCandidate,
  type TriggerConditions,
  type SilencedPattern,
  type ConsideredCandidate,
  type OpportunityDetectorOptions,
} from "./types.js";