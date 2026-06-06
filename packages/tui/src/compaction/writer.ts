/**
 * Compaction Neuralgentics Writer (T-026)
 *
 * Stores extracted facts as Neuralgentics memories with
 * type: "extracted_fact" metadata and applies agent_used trust signal.
 */

import type { ExtractedFact, CompactionCheckpoint, CompactionDependencies } from "./types.js";

// ─── Writer ─────────────────────────────────────────────────────────────────────

/**
 * Write extracted facts to Neuralgentics memory.
 *
 * Each fact is stored as a separate memory.add call with:
 * - content: the fact text
 * - sourceType: "compaction"
 * - metadata.type: "extracted_fact"
 * - metadata.confidence: the extraction confidence
 * - metadata.tags: the extraction tags
 * - metadata.compaction_timestamp: ISO timestamp
 *
 * After storing, agent_used trust signal is applied to each memory.
 *
 * @param facts - The extracted facts to store.
 * @param deps - Compaction dependencies (provides the Neuralgentics client).
 * @returns An array of memory IDs for the stored facts.
 */
export async function writeFactsToMemory(
  facts: ExtractedFact[],
  deps: CompactionDependencies,
): Promise<string[]> {
  const memoryIds: string[] = [];
  const timestamp = new Date().toISOString();

  for (const fact of facts) {
    try {
      const result = await deps.neuralgentics.call("memory.add", {
        content: fact.text,
        sourceType: "compaction",
        metadata: {
          type: "extracted_fact",
          confidence: fact.confidence,
          tags: fact.tags,
          compaction_timestamp: timestamp,
        },
      }) as { id: string };

      memoryIds.push(result.id);

      // Apply agent_used trust signal to increase trust score
      try {
        await deps.neuralgentics.call("memory.adjustTrust", {
          memoryId: result.id,
          signal: "agent_used",
        });
      } catch (trustErr: unknown) {
        // Trust signal failure is non-critical — log and continue
        const msg = trustErr instanceof Error ? trustErr.message : String(trustErr);
        console.warn(`[compaction] Failed to apply trust signal to memory ${result.id}: ${msg}`);
      }
    } catch (err: unknown) {
      // Individual fact storage failure is non-critical — log and continue
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[compaction] Failed to store fact "${fact.text.slice(0, 50)}...": ${msg}`);
    }
  }

  return memoryIds;
}

/**
 * Query stored extracted facts from Neuralgentics memory.
 *
 * @param query - Search query string.
 * @param deps - Compaction dependencies.
 * @param limit - Maximum results (default 10).
 * @returns Array of memory entries matching the query.
 */
export async function queryExtractedFacts(
  query: string,
  deps: CompactionDependencies,
  limit: number = 10,
): Promise<unknown[]> {
  try {
    const result = await deps.neuralgentics.call("memory.query", {
      query,
      limit,
      strategy: "tiered",
    }) as unknown[];

    // Filter to only extracted_fact type memories
    return Array.isArray(result)
      ? result.filter((entry: unknown) => {
          const record = entry as Record<string, unknown>;
          const metadata = record.metadata as Record<string, unknown> | undefined;
          return metadata?.type === "extracted_fact";
        })
      : [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[compaction] Failed to query extracted facts: ${msg}`);
    return [];
  }
}

/**
 * Write a compaction checkpoint to Neuralgentics memory (T-079).
 *
 * Serializes the checkpoint struct as JSON and stores it with:
 * - content: JSON-serialized CompactionCheckpoint
 * - sourceType: "compaction_checkpoint"
 * - metadata.type: "compaction_checkpoint"
 * - metadata.sessionId, metadata.timestamp, metadata.factsExtracted, etc.
 *
 * The checkpoint references extracted memory IDs by ID,
 * so it does NOT duplicate the facts themselves.
 *
 * @param checkpoint - The checkpoint data to persist.
 * @param deps - Compaction dependencies (provides the Neuralgentics client).
 * @returns The memory ID of the stored checkpoint.
 */
export async function writeCheckpoint(
  checkpoint: Omit<CompactionCheckpoint, "checkpointId">,
  deps: CompactionDependencies,
): Promise<string> {
  const content = JSON.stringify(checkpoint);

  const result = await deps.neuralgentics.call("memory.add", {
    content,
    sourceType: "compaction_checkpoint",
    metadata: {
      type: "compaction_checkpoint",
      sessionId: checkpoint.sessionId,
      timestamp: checkpoint.timestamp,
      factsExtracted: checkpoint.factsExtracted,
      tokensBefore: checkpoint.tokensBefore,
      tokensAfter: checkpoint.tokensAfter,
      savingsRatio: checkpoint.savingsRatio,
      reverted: checkpoint.reverted,
      reseeded: checkpoint.reseeded,
    },
  }) as { id: string };

  return result.id;
}

/**
 * Load the most recent compaction checkpoint from Neuralgentics memory (T-079).
 *
 * Queries for memories with sourceType "compaction_checkpoint", sorted by
 * timestamp DESC, limit 1. Returns null if no checkpoint exists or
 * if the data is corrupted (graceful degradation).
 *
 * @param sessionId - Optional session ID to filter by.
 * @param deps - Compaction dependencies (provides the Neuralgentics client).
 * @returns The most recent checkpoint, or null if none exists.
 */
export async function loadLastCheckpoint(
  deps: CompactionDependencies,
): Promise<CompactionCheckpoint | null> {
  try {
    const results = await deps.neuralgentics.call("memory.queryBySourceType", {
      sourceType: "compaction_checkpoint",
      limit: 1,
      sortBy: "createdAt",
      sortOrder: "DESC",
    }) as Array<Record<string, unknown>>;

    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    const entry = results[0];
    const content = typeof entry.content === "string"
      ? entry.content
      : JSON.stringify(entry.content ?? entry);

    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;

      // Validate required fields for graceful degradation
      if (
        typeof parsed.sessionId !== "string" ||
        typeof parsed.timestamp !== "string" ||
        typeof parsed.factsExtracted !== "number"
      ) {
        console.warn("[compaction] Checkpoint has missing or invalid required fields — treating as no checkpoint");
        return null;
      }

      return {
        checkpointId: (entry.id as string) ?? "",
        sessionId: parsed.sessionId as string,
        timestamp: parsed.timestamp as string,
        factsExtracted: parsed.factsExtracted as number,
        tokensBefore: (parsed.tokensBefore as number) ?? 0,
        tokensAfter: (parsed.tokensAfter as number) ?? 0,
        savingsRatio: (parsed.savingsRatio as number) ?? 0,
        reverted: (parsed.reverted as boolean) ?? false,
        reseeded: (parsed.reseeded as boolean) ?? false,
        confidenceScores: (parsed.confidenceScores as Record<string, number>) ?? {},
        extractedMemoryIds: (parsed.extractedMemoryIds as string[]) ?? [],
      };
    } catch (parseErr: unknown) {
      console.warn("[compaction] Failed to parse checkpoint JSON — treating as no checkpoint:", parseErr);
      return null;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[compaction] Failed to load checkpoint: ${msg}`);
    return null;
  }
}