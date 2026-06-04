/**
 * Compaction Module — Public API (T-026)
 *
 * Re-exports the compaction pipeline components.
 */

export { CompactionOrchestrator } from "./orchestrator.js";
export { TokenMonitor } from "./monitor.js";
export { filterMessages, estimateMessageTokens } from "./filter.js";
export { extractFacts, parseExtractionResponse } from "./extractor.js";
export { writeFactsToMemory, queryExtractedFacts } from "./writer.js";
export {
  DEFAULT_COMPACTION_CONFIG,
  EXTRACTION_PROMPT,
} from "./types.js";
export type {
  CompactionConfig,
  CompactionResult,
  CompactionStatus,
  CompactionEvents,
  CompactionDependencies,
  ExtractedFact,
  ExtractionResponse,
  FilteredMessage,
  FilterResult,
} from "./types.js";