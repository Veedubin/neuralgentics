/**
 * Neuralgentics JSON-RPC Client — public API.
 *
 * Re-exports the client class, types, and resolver utilities.
 */

export { NeuralgenticsClient } from "./client.js";
export type { ClientStatus, NeuralgenticsClientEvents } from "./client.js";
export type {
  MethodName,
  MethodParams,
  MethodResult,
  MethodRegistry,
  PingResult,
  InitializeParams,
  InitializeResult,
  MemoryAddParams,
  MemoryAddResult,
  MemoryQueryParams,
  MemoryQueryResult,
  MemoryGetParams,
  MemoryGetResult,
  MemoryDeleteParams,
  MemoryDeleteResult,
  MemoryAdjustTrustParams,
  MemoryAdjustTrustResult,
  Tier0SummaryParams,
  Tier1SummaryParams,
  TierSummaryResult,
  TriggerExtractionParams,
  TriggerExtractionResult,
  PrecompressExtractionParams,
  PrecompressExtractionResult,
  GetRelationshipSummaryParams,
  GetRelationshipSummaryResult,
  RelationshipSummaryItem,
  ElevateMemoryTo1024Params,
  ElevateMemoryTo1024Result,
} from "./types.js";
export { resolveBackendPath, resolveDbUrl, DEFAULT_DB_URL } from "./resolver.js";