/**
 * TypeScript type definitions for all 46 Neuralgentics JSON-RPC methods.
 *
 * Core 6 methods (ping, initialize, memory.add, memory.query, memory.get,
 * memory.delete) have fully typed request params and response results.
 * Remaining 40 methods use generic Record<string, unknown> params/results
 * and can be typed later when needed.
 */

// ─── Core Method Types ────────────────────────────────────────────────────────

/** ping response — backend returns the literal string "pong" */
export type PingResult = "pong";

/** initialize params */
export interface InitializeParams {
  clientInfo?: Record<string, string>;
}

/** initialize response */
export interface InitializeResult {
  serverInfo: { name: string; version: string };
  capabilities: { memory: boolean; orchestrator: boolean; broker: boolean };
}

/** memory.add params */
export interface MemoryAddParams {
  content: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
}

/** memory.add response */
export interface MemoryAddResult {
  id: string;
}

/** memory.query params */
export interface MemoryQueryParams {
  query: string;
  limit?: number;
  strategy?: string;
}

/** memory.query response (array of memory entries) */
export type MemoryQueryResult = Record<string, unknown>[];

/** memory.get params */
export interface MemoryGetParams {
  id: string;
}

/** memory.get response (single memory entry) */
export type MemoryGetResult = Record<string, unknown>;

/** memory.delete params */
export interface MemoryDeleteParams {
  id: string;
}

/** memory.delete response */
export interface MemoryDeleteResult {
  // Empty object on success
}

/** memory.queryBySourceType params (T-079 checkpoint persistence) */
export interface MemoryQueryBySourceTypeParams {
  sourceType: string;
  limit?: number;
  sortBy?: string;
  sortOrder?: string;
}

/** memory.queryBySourceType response (array of memory entries) */
export type MemoryQueryBySourceTypeResult = Record<string, unknown>[];

/** memory.adjustTrust params */
export interface MemoryAdjustTrustParams {
  memoryId: string;
  signal: string;
}

/** memory.adjustTrust response */
export interface MemoryAdjustTrustResult {
  oldScore: number;
  newScore: number;
  adjustmentAmount: number;
}

/** peer.switchContext response */
export interface SwitchContextResult {
  success: boolean;
  previousPeerId: string;
  newPeerId: string;
  switchedAt: string; // RFC3339 timestamp
}

/** memory.getTier0Summary params */
export interface Tier0SummaryParams {
  forceRefresh?: boolean;
}

/** memory.getTier1Summary params */
export interface Tier1SummaryParams {
  forceRefresh?: boolean;
}

/** memory.getTier0Summary / memory.getTier1Summary response */
export interface TierSummaryResult {
  content: string;
  generatedAt: string; // RFC3339 timestamp
  tokenCount: number;
  tier: string; // "L0" or "L1"
}

/** memory.triggerExtraction params */
export interface TriggerExtractionParams {
  conversation?: string;
}

/** memory.triggerExtraction response */
export interface TriggerExtractionResult {
  extracted: number;
  memoryIds: string[];
  triggeredAt: string; // RFC3339 timestamp
}

/** memory.precompressExtraction params */
export interface PrecompressExtractionParams {
  contextContent?: string;
}

/** memory.precompressExtraction response */
export interface PrecompressExtractionResult {
  captured: boolean;
  contextSize: number;
  capturedAt: string; // RFC3339 timestamp
}

// ─── Method Registry ──────────────────────────────────────────────────────────
// Maps each JSON-RPC method name to its param and result types.
// Core 6 are fully typed; the rest use generic types for now.

export interface MethodRegistry {
  // Lifecycle
  "ping": { params: Record<string, never>; result: PingResult };
  "shutdown": { params: Record<string, never>; result: Record<string, string> };
  "initialize": { params: InitializeParams; result: InitializeResult };

  // Memory CRUD (core 6 — fully typed)
  "memory.add": { params: MemoryAddParams; result: MemoryAddResult };
  "memory.query": { params: MemoryQueryParams; result: MemoryQueryResult };
  "memory.get": { params: MemoryGetParams; result: MemoryGetResult };
  "memory.delete": { params: MemoryDeleteParams; result: MemoryDeleteResult };
  "memory.adjustTrust": { params: MemoryAdjustTrustParams; result: MemoryAdjustTrustResult };
  "memory.queryBySourceType": { params: MemoryQueryBySourceTypeParams; result: MemoryQueryBySourceTypeResult };

  // Memory Status
  "memory.status": { params: Record<string, never>; result: Record<string, unknown> };
  "memory.count": { params: Record<string, never>; result: { count: number } };

  // Memory Audit
  "memory.logAuditEvent": { params: Record<string, unknown>; result: { id: string } };
  "memory.getAuditLog": { params: Record<string, unknown>; result: Record<string, unknown>[] };

  // Memory Trust
  "memory.getTrustScore": { params: { memoryId: string }; result: Record<string, unknown> };
  "memory.listArchived": { params: Record<string, unknown>; result: Record<string, unknown>[] };

  // Memory Decay
  "memory.getDecayStatus": { params: Record<string, never>; result: Record<string, unknown> };
  "memory.adjustDecayRate": { params: { memoryId: string; rate: number }; result: Record<string, never> };
  "memory.triggerConsolidation": { params: Record<string, unknown>; result: Record<string, unknown> };
  "memory.listFadingMemories": { params: Record<string, unknown>; result: Record<string, unknown>[] };

  // Memory Tiered Summaries
  "memory.getTier0Summary": { params: Tier0SummaryParams; result: TierSummaryResult };
  "memory.getTier1Summary": { params: Tier1SummaryParams; result: TierSummaryResult };

  // Memory Extraction (T-EXPOSE-001c)
  "memory.triggerExtraction": { params: TriggerExtractionParams; result: TriggerExtractionResult };
  "memory.precompressExtraction": { params: PrecompressExtractionParams; result: PrecompressExtractionResult };

  // Memory Knowledge Graph
  "memory.extractEntities": { params: { text: string }; result: { entityIds: string[] } };
  "memory.queryKG": { params: Record<string, unknown>; result: Record<string, unknown> };
  "memory.searchEntities": { params: { name: string; limit?: number }; result: Record<string, unknown>[] };
  "memory.getEntitiesByType": { params: { entityType: string; limit?: number }; result: Record<string, unknown>[] };
  "memory.createEntityRelationship": { params: Record<string, unknown>; result: { id: string } };
  "memory.getEntityGraph": { params: Record<string, unknown>; result: Record<string, unknown> };
  "memory.renderGraphHTML": { params: Record<string, unknown>; result: { html: string } };

  // Memory Thought Chains
  "memory.startThoughtChain": { params: Record<string, unknown>; result: { id: string } };
  "memory.addThought": { params: Record<string, unknown>; result: { id: string } };
  "memory.getThoughtChain": { params: { chainId: string }; result: Record<string, unknown> };
  "memory.getRelatedThoughtChains": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  "memory.reviseThought": { params: Record<string, unknown>; result: Record<string, unknown> };
  "memory.branchThought": { params: Record<string, unknown>; result: Record<string, unknown> };
  "memory.pauseThoughtChain": { params: { chainId: string }; result: Record<string, never> };
  "memory.resumeThoughtChain": { params: { chainId: string }; result: Record<string, never> };
  "memory.abandonThoughtChain": { params: { chainId: string }; result: Record<string, never> };

  // Memory Dialectic
  "memory.findContradictions": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  "memory.resolveContradiction": { params: Record<string, unknown>; result: Record<string, unknown> };
  "memory.challengeMemory": { params: Record<string, unknown>; result: Record<string, unknown> };
  "memory.getDialecticHistory": { params: Record<string, unknown>; result: Record<string, unknown>[] };

  // User Profile
  "user.getProfile": { params: Record<string, unknown>; result: Record<string, unknown> };
  "user.updateProfile": { params: Record<string, unknown>; result: Record<string, unknown> };

  // Audit
  "audit.getSecuritySummary": { params: Record<string, unknown>; result: Record<string, unknown> };

  // Indexer
  "indexer.search": { params: Record<string, unknown>; result: Record<string, unknown> };
  "indexer.index": { params: Record<string, unknown>; result: Record<string, unknown> };
  "indexer.getFileContents": { params: Record<string, unknown>; result: Record<string, unknown> };

  // Orchestrator
  "orchestrator.handleTask": { params: Record<string, unknown>; result: Record<string, unknown> };
  "orchestrator.handleStateless": { params: Record<string, unknown>; result: Record<string, unknown> };
  "orchestrator.completeCycle": { params: Record<string, unknown>; result: Record<string, unknown> };
  "orchestrator.dispatch": { params: Record<string, unknown>; result: Record<string, unknown> };
  "orchestrator.route": { params: { taskType: string }; result: { agent: string } };

  // Broker
  "broker.buildCatalog": { params: Record<string, unknown>; result: Record<string, unknown> };
  "broker.call": { params: Record<string, unknown>; result: Record<string, unknown> };
  "broker.matchIntent": { params: Record<string, unknown>; result: Record<string, unknown> };

  // Peer
  "peer.listPeers": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  "peer.addPeer": { params: Record<string, unknown>; result: { id: string } };
  "peer.shareMemory": { params: Record<string, unknown>; result: { id: string } };
  "peer.getPeerMemories": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  "peer.getSharedMemories": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  "peer.switchContext": { params: { peerId: string }; result: SwitchContextResult };

  // Agent Tools (Lazy Tool Exposure)
  "agent.recordToolRequest": { params: Record<string, unknown>; result: { status: string } };
  "agent.incrementToolUse": { params: Record<string, unknown>; result: { useCount: number; bypassBroker: boolean } };
  "agent.getTools": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  "agent.getInitialToolSet": { params: Record<string, unknown>; result: { peerId: string; tools: unknown[] } };
}

/** All known method names (46 total). */
export type MethodName = keyof MethodRegistry;

/** Get the params type for a method. */
export type MethodParams<M extends MethodName> = MethodRegistry[M]["params"];

/** Get the result type for a method. */
export type MethodResult<M extends MethodName> = MethodRegistry[M]["result"];