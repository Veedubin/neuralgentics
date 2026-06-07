/**
 * TypeScript type definitions for all 68 Neuralgentics JSON-RPC methods.
 *
 * Core 6 methods (ping, initialize, memory.add, memory.query, memory.get,
 * memory.delete) have fully typed request params and response results.
 * 25 entries are actively called or reserved for upcoming TUI commands
 * (T-WIRE-001, T-ALIGN-PARAMS). The remaining 43 are comment-marked with
 * [NOT WIRED] — they are exposed by the Go backend but have no TUI
 * slash command yet. No entries are deleted.
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

/** memory.getRelationshipSummary params */
export interface GetRelationshipSummaryParams {
  memoryId: string;
}

/** Single related memory in a relationship summary */
export interface RelationshipSummaryItem {
  id: string;
  relationshipType: string;
  confidence: number;
}

/** memory.getRelationshipSummary response */
export interface GetRelationshipSummaryResult {
  memoryId: string;
  totalRelationships: number;
  byType: Record<string, number>;
  related: RelationshipSummaryItem[];
}

// ─── Method Registry ──────────────────────────────────────────────────────────
// Maps each JSON-RPC method name to its param and result types.
// Core 6 are fully typed; the rest use generic types for now.
// Entries marked [NOT WIRED] have no TUI slash command yet (T-CLEANUP-DEAD-49).

/** memory.getInferenceChain params (T-ALIGN-PARAMS) */
export interface GetInferenceChainParams {
  startEntity: string;
  endEntity: string;
  maxDepth?: number;
}

/** A single relationship in an inference chain */
export interface InferenceChainRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  relationshipType: string;
  confidence: number;
}

/** memory.getInferenceChain result (T-ALIGN-PARAMS) */
export interface GetInferenceChainResult {
  entities: Record<string, unknown>[];
  relationships: InferenceChainRelationship[];
  inferenceChain: InferenceChainRelationship[];
}

/** memory.resolveContradiction params (T-ALIGN-PARAMS) */
export interface ResolveContradictionParams {
  memoryIdA: string;
  memoryIdB: string;
}

/** memory.challengeMemory params (T-ALIGN-PARAMS) */
export interface ChallengeMemoryParams {
  memoryId: string;
  challengeText: string;
}

/** memory.elevateMemoryTo1024 params (T-ELEVATE-001) */
export interface ElevateMemoryTo1024Params {
  memoryId: string;
  vector1024?: number[];
  trustBoost?: number;
}

/** memory.elevateMemoryTo1024 result (T-ELEVATE-001) */
export interface ElevateMemoryTo1024Result {
  memoryId: string;
  elevated: boolean;
  trustScore: number;
  vectorDim: number;
}

// ─── Broker Multi-Transport Types (T-TRANSPORT-ABSTRACTION) ─────────────────

/** Transport type for MCP server launch */
export type TransportType = 'npx' | 'uvx' | 'local' | 'docker' | 'http';

/** A single transport option for an MCP server */
export interface TransportConfig {
  type: TransportType;
  package?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  default?: boolean;
  description?: string;
}

/** Params for broker.registerMCPServer */
export interface RegisterMCPServerParams {
  name: string;
  transports: TransportConfig[];
  description?: string;
  capabilities?: string[];
}

/** Params for broker.activateMCPServer */
export interface ActivateMCPServerParams {
  name: string;
  transports: TransportConfig[];
  description?: string;
  capabilities?: string[];
  transportIndex?: number; // -1 = use default
}

/** Result for broker.activateMCPServer */
export interface ActivateMCPServerResult {
  transport: string; // The transport.Type that succeeded
}

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
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.status": { params: Record<string, never>; result: Record<string, unknown> };
  "memory.count": { params: Record<string, never>; result: { count: number } };

  // Memory Audit
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.logAuditEvent": { params: Record<string, unknown>; result: { id: string } };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.getAuditLog": { params: Record<string, unknown>; result: Record<string, unknown>[] };

  // Memory Trust
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.getTrustScore": { params: { memoryId: string }; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.listArchived": { params: Record<string, unknown>; result: Record<string, unknown>[] };

  // Memory Decay
  "memory.getDecayStatus": { params: Record<string, never>; result: Record<string, unknown> };
  "memory.adjustDecayRate": { params: { memoryId: string; rate: number }; result: Record<string, never> };
  "memory.triggerConsolidation": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.listFadingMemories": { params: Record<string, unknown>; result: Record<string, unknown>[] };

  // Memory Tiered Summaries
  "memory.getTier0Summary": { params: Tier0SummaryParams; result: TierSummaryResult };
  "memory.getTier1Summary": { params: Tier1SummaryParams; result: TierSummaryResult };

  // Memory Extraction (T-EXPOSE-001c)
  "memory.triggerExtraction": { params: TriggerExtractionParams; result: TriggerExtractionResult };
  "memory.precompressExtraction": { params: PrecompressExtractionParams; result: PrecompressExtractionResult };

  // Memory Knowledge Graph
  "memory.extractEntities": { params: { memoryId: string }; result: { entityIds: string[] } };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.getInferenceChain": { params: GetInferenceChainParams; result: GetInferenceChainResult };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.queryKG": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.searchEntities": { params: { name: string; limit?: number }; result: Record<string, unknown>[] };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.getEntitiesByType": { params: { entityType: string; limit?: number }; result: Record<string, unknown>[] };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.createEntityRelationship": { params: Record<string, unknown>; result: { id: string } };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.getEntityGraph": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.renderGraphHTML": { params: Record<string, unknown>; result: { html: string } };
  "memory.getRelationshipSummary": { params: GetRelationshipSummaryParams; result: GetRelationshipSummaryResult };

  // Memory Thought Chains
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.startThoughtChain": { params: Record<string, unknown>; result: { id: string } };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.addThought": { params: Record<string, unknown>; result: { id: string } };
  "memory.getThoughtChain": { params: { chainId: string }; result: Record<string, unknown> };
  "memory.getRelatedThoughtChains": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.reviseThought": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.branchThought": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.pauseThoughtChain": { params: { chainId: string }; result: Record<string, never> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.resumeThoughtChain": { params: { chainId: string }; result: Record<string, never> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.abandonThoughtChain": { params: { chainId: string }; result: Record<string, never> };

  // Memory Dialectic
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.findContradictions": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  "memory.resolveContradiction": { params: ResolveContradictionParams; result: Record<string, unknown> };
  "memory.challengeMemory": { params: ChallengeMemoryParams; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.getDialecticHistory": { params: Record<string, unknown>; result: Record<string, unknown>[] };

  // Memory Dual-Model RRF Elevation (T-ELEVATE-001)
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "memory.elevateMemoryTo1024": { params: ElevateMemoryTo1024Params; result: ElevateMemoryTo1024Result };

  // User Profile
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "user.getProfile": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "user.updateProfile": { params: Record<string, unknown>; result: Record<string, unknown> };

  // Audit
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "audit.getSecuritySummary": { params: Record<string, unknown>; result: Record<string, unknown> };

  // Indexer
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "indexer.search": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "indexer.index": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "indexer.getFileContents": { params: Record<string, unknown>; result: Record<string, unknown> };

  // Orchestrator
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "orchestrator.handleTask": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "orchestrator.handleStateless": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "orchestrator.completeCycle": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "orchestrator.dispatch": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "orchestrator.route": { params: { taskType: string }; result: { agent: string } };

  // Broker
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "broker.buildCatalog": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "broker.call": { params: Record<string, unknown>; result: Record<string, unknown> };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "broker.matchIntent": { params: Record<string, unknown>; result: Record<string, unknown> };

  // Broker Multi-Transport (T-TRANSPORT-ABSTRACTION)
  "broker.registerMCPServer": { params: RegisterMCPServerParams; result: { status: string } };
  "broker.activateMCPServer": { params: ActivateMCPServerParams; result: ActivateMCPServerResult };

  // Peer
  "peer.listPeers": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "peer.addPeer": { params: Record<string, unknown>; result: { id: string } };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "peer.shareMemory": { params: Record<string, unknown>; result: { id: string } };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "peer.getPeerMemories": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "peer.getSharedMemories": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  "peer.switchContext": { params: { peerId: string }; result: SwitchContextResult };

  // Agent Tools (Lazy Tool Exposure)
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "agent.recordToolRequest": { params: Record<string, unknown>; result: { status: string } };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "agent.incrementToolUse": { params: Record<string, unknown>; result: { useCount: number; bypassBroker: boolean } };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "agent.getTools": { params: Record<string, unknown>; result: Record<string, unknown>[] };
  // [NOT WIRED] — exposed by Go backend but no TUI slash command yet
  "agent.getInitialToolSet": { params: Record<string, unknown>; result: { peerId: string; tools: unknown[] } };
}

/** All known method names (68 total). */
export type MethodName = keyof MethodRegistry;

/** Get the params type for a method. */
export type MethodParams<M extends MethodName> = MethodRegistry[M]["params"];

/** Get the result type for a method. */
export type MethodResult<M extends MethodName> = MethodRegistry[M]["result"];