/**
 * Opportunity Detector — barrel export.
 * T-034 (P1-c, Addendum 1).
 * T-085: Added opportunity cache persistence exports.
 */

export { OpportunityDetector, saveCache, restoreCache, getCachedCandidates, isOffline, setOffline } from "./detector.js";
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
  formatCachedOpportunities,
  handleCachedOpportunitiesCommand,
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
  type CandidateBase,
  type Candidate,
  type CandidateEvidence,
  type RankedCandidate,
  type CachedCandidate,
  type CachedCandidatesResult,
  type TriggerConditions,
  type SilencedPattern,
  type ConsideredCandidate,
  type OpportunityDetectorOptions,
} from "./types.js";