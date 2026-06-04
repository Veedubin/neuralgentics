/**
 * Compaction Neuralgentics Writer (T-026)
 *
 * Stores extracted facts as Neuralgentics memories with
 * type: "extracted_fact" metadata and applies agent_used trust signal.
 */

import type { ExtractedFact, CompactionDependencies } from "./types.js";

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