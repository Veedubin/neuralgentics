/**
 * Compaction Loop Types (T-026)
 *
 * Defines the interfaces for the 75% auto-compaction pipeline:
 * monitor → filter → extract (gemma4:31b) → write → revert → reseed
 */

import type { ChatMessage } from "../opencode-client/types.js";

// ─── Compaction Status ──────────────────────────────────────────────────────────

/** The current state of the compaction engine. */
export type CompactionStatus =
  | "idle"            // No compaction in progress
  | "monitoring"      // Actively monitoring token usage
  | "compacting"      // Compaction pipeline is running
  | "queued"          // Compaction queued (mid-prompt, will run after response)
  | "disabled";       // Extraction model unavailable, compaction disabled

// ─── Extracted Fact ─────────────────────────────────────────────────────────────

/** A single fact extracted from the conversation during compaction. */
export interface ExtractedFact {
  /** The factual statement extracted from the conversation. */
  text: string;
  /** Confidence score 0-1 as determined by the extraction model. */
  confidence: number;
  /** Tags categorizing the fact (e.g. "decision", "constraint", "api"). */
  tags: string[];
}

// ─── Compaction Result ──────────────────────────────────────────────────────────

/** Result of a completed compaction cycle. */
export interface CompactionResult {
  /** Number of facts extracted and stored as memories. */
  factsExtracted: number;
  /** IDs of the stored memory entries for each extracted fact. */
  memoryIds: string[];
  /** Estimated token count before compaction. */
  tokensBefore: number;
  /** Estimated token count after compaction (reseed prompt). */
  tokensAfter: number;
  /** The savings ratio (tokensBefore / max(tokensSpent, 1)). */
  savingsRatio: number;
  /** Whether the session was reverted after extraction. */
  reverted: boolean;
  /** Whether the reseed was triggered. */
  reseeded: boolean;
  /** Number of messages filtered out. */
  messagesFiltered: number;
  /** Wall-clock duration of the compaction cycle in ms. */
  durationMs: number;
}

// ─── Compaction Config ──────────────────────────────────────────────────────────

/** Configuration for the compaction engine. */
export interface CompactionConfig {
  /** Token usage percentage that triggers auto-compaction (0-1, default 0.75). */
  threshold: number;
  /** The extraction model ID (default: "gemma4:31b"). */
  extractionModelId: string;
  /** The provider for the extraction model (default: "ollama"). */
  extractionProvider: string;
  /** Maximum tokens to spend on the extraction prompt (default: 500). */
  maxExtractionPromptTokens: number;
  /** Minimum savings ratio required (default: 10 for ≥10:1). */
  minSavingsRatio: number;
  /** Whether auto-compaction is enabled (default: true). */
  autoCompactEnabled: boolean;
  /** Maximum number of facts to extract per compaction cycle (default: 50). */
  maxFactsPerCycle: number;
  /** Maximum filtered content length in characters before truncation (default: 50000). */
  maxFilteredContentChars: number;
}

/** Default compaction config values. */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  threshold: 0.75,
  extractionModelId: "gemma4:31b",
  extractionProvider: "ollama",
  maxExtractionPromptTokens: 500,
  minSavingsRatio: 10,
  autoCompactEnabled: true,
  maxFactsPerCycle: 50,
  maxFilteredContentChars: 50000,
};

// ─── Compaction Events ──────────────────────────────────────────────────────────

/** Events emitted by the compaction orchestrator. */
export interface CompactionEvents {
  /** Compaction status changed. */
  statusChange: (status: CompactionStatus) => void;
  /** A compaction cycle completed. */
  compactionComplete: (result: CompactionResult) => void;
  /** An error occurred during compaction. */
  error: (error: Error) => void;
  /** Token threshold reached (compaction about to start or queue). */
  thresholdReached: (tokenPercent: number) => void;
}

// ─── Filter Pipeline ────────────────────────────────────────────────────────────

/** A message that passed through the filter. */
export interface FilteredMessage {
  /** Original message content (may be truncated). */
  content: string;
  /** Message role. */
  role: "user" | "assistant";
  /** Whether this message was identified as high-signal. */
  highSignal: boolean;
  /** Approximate token count for this message. */
  tokenEstimate: number;
}

/** Result of the filter pipeline. */
export interface FilterResult {
  /** Messages that passed the filter, in order. */
  messages: FilteredMessage[];
  /** Total estimated tokens in the filtered content. */
  totalTokens: number;
  /** Number of original messages that were filtered out. */
  filteredOut: number;
  /** The concatenated text ready for extraction. */
  extractionText: string;
}

// ─── Extraction ──────────────────────────────────────────────────────────────────

/** The extraction prompt template. Kept to ~50 tokens per spec. */
export const EXTRACTION_PROMPT = `Extract the most important facts from this conversation. Return JSON: {facts: [{text, confidence, tags}]}. Confidence 0-1.`;

/** Raw response from the extraction model. */
export interface ExtractionResponse {
  facts: ExtractedFact[];
}

// ─── Dependencies ────────────────────────────────────────────────────────────────

/** Dependencies injected into the compaction orchestrator. */
export interface CompactionDependencies {
  /** Neuralgentics client for memory.add, memory.adjustTrust, memory.query. */
  neuralgentics: {
    call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  /** Session manager for revert() and messages(). */
  session: {
    revert: (sessionId?: string | null, messageId?: string) => Promise<{ sessionId: string; messagesRemoved: number }>;
    messages: (sessionId?: string | null) => Promise<ChatMessage[]>;
    sessionId: string | null;
    status: string;
  };
  /** Reseed function (T-028 stub). Returns tokens used. */
  reseed: (neuralgentics: CompactionDependencies["neuralgentics"], sessionId: string) => Promise<{ totalTokens: number }>;
  /** Token count provider — returns current token usage. */
  getTokenCount: () => { used: number; limit: number };
  /** Model availability check — resolves true if extraction model is reachable. */
  isModelAvailable: (modelId: string, provider: string) => Promise<boolean>;
  /** Call the extraction model (LLM inference). */
  callExtractionModel: (modelId: string, provider: string, prompt: string) => Promise<string>;
}