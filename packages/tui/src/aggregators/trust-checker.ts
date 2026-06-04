/**
 * Trust Checker — T-035 (P1-c-ext).
 *
 * Records install/reject trust signals via NeuralgenticsClient.
 * Per Addendum 2 §6.3: installs get agent_used (+0.05), rejects get agent_ignored (-0.05).
 */

import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import type { AggregatorResult, TrustSignal } from "./types.js";

/**
 * Records install and reject trust feedback in memini-core via NeuralgenticsClient.
 *
 * Per Addendum 2 §6.3:
 * - Install → memory type "aggregator_install" + adjust trust "agent_used" on source index
 * - Reject → memory type "aggregator_reject" + adjust trust "agent_ignored" on source index
 */
export class TrustChecker {
  private readonly client: NeuralgenticsClient | null;

  /**
   * @param client - NeuralgenticsClient for trust adjustments.
   *                  Pass null to disable trust recording (e.g. in tests).
   */
  constructor(client: NeuralgenticsClient | null) {
    this.client = client;
  }

  /**
   * Record an install event.
   * Creates an "aggregator_install" memory and adjusts trust +0.05.
   */
  async recordInstall(result: AggregatorResult): Promise<void> {
    if (this.client === null) return;

    try {
      // Record the install event as a memory
      await this.client.call("memory.add", {
        content: `Installed ${result.name} from ${result.source}: ${result.description}`,
        sourceType: "aggregator_install",
        metadata: {
          type: "aggregator_install",
          aggregator: result.source,
          name: result.name,
          description: result.description,
          installCommand: result.installCommand,
          trustTier: result.trustTier,
          matchScore: result.matchScore,
          category: result.category,
          timestamp: Date.now(),
        },
      });

      // Adjust trust: installed = agent_used (+0.05)
      await this.recordTrustSignal(result.source, "agent_used");
    } catch {
      // Trust recording is best-effort; don't block on failures
    }
  }

  /**
   * Record a reject event.
   * Creates an "aggregator_reject" memory and adjusts trust -0.05.
   */
  async recordReject(result: AggregatorResult): Promise<void> {
    if (this.client === null) return;

    try {
      // Record the reject event as a memory
      await this.client.call("memory.add", {
        content: `Rejected ${result.name} from ${result.source}: ${result.description}`,
        sourceType: "aggregator_reject",
        metadata: {
          type: "aggregator_reject",
          aggregator: result.source,
          name: result.name,
          description: result.description,
          trustTier: result.trustTier,
          timestamp: Date.now(),
        },
      });

      // Adjust trust: rejected = agent_ignored (-0.05)
      await this.recordTrustSignal(result.source, "agent_ignored");
    } catch {
      // Trust recording is best-effort; don't block on failures
    }
  }

  /**
   * Record a trust signal for an aggregator source.
   * Uses NeuralgenticsClient to call memory.adjustTrust on the source's index memory.
   */
  private async recordTrustSignal(source: string, signal: TrustSignal): Promise<void> {
    if (this.client === null) return;

    try {
      // Query for the aggregator index memory for this source
      const memories = await this.client.call("memory.query", {
        query: `aggregator_index ${source}`,
        limit: 1,
        strategy: "text_only",
      });

      if (Array.isArray(memories) && memories.length > 0) {
        const indexMemory = memories[0] as { id?: string };
        if (indexMemory.id) {
          await this.client.call("memory.adjustTrust", {
            memoryId: indexMemory.id,
            signal,
          });
        }
      }
    } catch {
      // Best-effort — trust adjustment failure is non-blocking
    }
  }
}