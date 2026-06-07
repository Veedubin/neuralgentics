/**
 * T-063 tests: Slash commands wired in T-WIRE-001.
 *
 * Covers 7 new commands:
 * 1. /tier0 [force] — getTier0Summary
 * 2. /tier1 [force] — getTier1Summary
 * 3. /peer list — listPeers
 * 4. /peer switch <id> — switchPeerContext
 * 5. /relationships <id> — getRelationshipSummary
 * 6. /decay — memory.getDecayStatus
 * 7. /extract [convo] — triggerExtraction
 */

import { describe, test, expect, vi } from "bun:test";
import {
  handleSlashCommand,
  isWriteCommand,
  handleTier0Command,
  handleTier1Command,
  handlePeerCommand,
  handleRelationshipsCommand,
  handleDecayCommand,
  handleExtractCommand,
} from "../commands.js";
import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import type {
  TierSummaryResult,
  SwitchContextResult,
  TriggerExtractionResult,
  GetRelationshipSummaryResult,
  MethodName,
  MethodParams,
  MethodResult,
} from "../neuralgentics-client/types.js";

// ─── Mock NeuralgenticsClient ─────────────────────────────────────────────────

interface MockCallMap {
  [method: string]: () => unknown;
}

function createMockClient(callMap: MockCallMap): NeuralgenticsClient {
  return {
    call: vi.fn(
      async <M extends MethodName>(
        method: M,
        _params: MethodParams<M>,
      ): Promise<MethodResult<M>> => {
        const handler = callMap[method as string];
        if (handler) return handler() as MethodResult<M>;
        throw new Error(`Unexpected call: ${method as string}`);
      },
    ),
    getTier0Summary: vi.fn(async (_forceRefresh?: boolean) => {
      return (callMap["memory.getTier0Summary"]?.() ??
        callMap["memory.getTier0Summary"]?.()) as TierSummaryResult;
    }),
    getTier1Summary: vi.fn(async (_forceRefresh?: boolean) => {
      return (callMap["memory.getTier1Summary"]?.() ??
        callMap["memory.getTier1Summary"]?.()) as TierSummaryResult;
    }),
    switchPeerContext: vi.fn(async (_peerId: string) => {
      return (callMap["peer.switchContext"]?.() ?? {}) as SwitchContextResult;
    }),
    triggerExtraction: vi.fn(async (_conversation?: string) => {
      return (callMap["memory.triggerExtraction"]?.() ??
        {}) as TriggerExtractionResult;
    }),
    getRelationshipSummary: vi.fn(async (_memoryId: string) => {
      return (callMap["memory.getRelationshipSummary"]?.() ??
        {}) as GetRelationshipSummaryResult;
    }),
  } as unknown as NeuralgenticsClient;
}

// ─── Canned responses ───────────────────────────────────────────────────────

const TIER0_RESPONSE: TierSummaryResult = {
  content: "Neuralgentics: Go-based memory backend with JSON-RPC",
  generatedAt: "2026-06-06T12:00:00Z",
  tokenCount: 42,
  tier: "L0",
};

const TIER1_RESPONSE: TierSummaryResult = {
  content: "Key decisions: PostgreSQL backend, pgvector, trust engine",
  generatedAt: "2026-06-06T12:00:00Z",
  tokenCount: 512,
  tier: "L1",
};

const SWITCH_RESPONSE: SwitchContextResult = {
  success: true,
  previousPeerId: "default",
  newPeerId: "peer-123",
  switchedAt: "2026-06-06T12:00:00Z",
};

const EXTRACT_RESPONSE: TriggerExtractionResult = {
  extracted: 3,
  memoryIds: ["mem-aaa", "mem-bbb", "mem-ccc"],
  triggeredAt: "2026-06-06T12:00:00Z",
};

const EXTRACT_EMPTY_RESPONSE: TriggerExtractionResult = {
  extracted: 0,
  memoryIds: [],
  triggeredAt: "2026-06-06T12:00:00Z",
};

const RELATIONSHIPS_RESPONSE: GetRelationshipSummaryResult = {
  memoryId: "mem-456",
  totalRelationships: 4,
  byType: { SUPERSEDES: 1, RELATED_TO: 2, DERIVED_FROM: 1 },
  related: [
    { id: "mem-789", relationshipType: "SUPERSEDES", confidence: 0.95 },
    { id: "mem-101", relationshipType: "RELATED_TO", confidence: 0.8 },
    { id: "mem-202", relationshipType: "RELATED_TO", confidence: 0.7 },
    { id: "mem-303", relationshipType: "DERIVED_FROM", confidence: 0.9 },
  ],
};

// ─── Sync dispatch tests ─────────────────────────────────────────────────────

describe("T-WIRE-001: sync dispatch for new commands", () => {
  test("/tier0 returns async handler signal", () => {
    const result = handleSlashCommand("/tier0");
    expect(result.command).toBe("tier0");
    expect(result.message).toContain("async handler");
  });

  test("/tier1 returns async handler signal", () => {
    const result = handleSlashCommand("/tier1");
    expect(result.command).toBe("tier1");
    expect(result.message).toContain("async handler");
  });

  test("/peer returns async handler signal", () => {
    const result = handleSlashCommand("/peer");
    expect(result.command).toBe("peer");
    expect(result.message).toContain("async handler");
  });

  test("/relationships returns async handler signal", () => {
    const result = handleSlashCommand("/relationships");
    expect(result.command).toBe("relationships");
    expect(result.message).toContain("async handler");
  });

  test("/decay returns async handler signal", () => {
    const result = handleSlashCommand("/decay");
    expect(result.command).toBe("decay");
    expect(result.message).toContain("async handler");
  });

  test("/extract returns async handler signal", () => {
    const result = handleSlashCommand("/extract");
    expect(result.command).toBe("extract");
    expect(result.message).toContain("async handler");
  });
});

// ─── /tier0 async tests ───────────────────────────────────────────────────────

describe("/tier0 command (async)", () => {
  test("/tier0 calls getTier0Summary and renders result", async () => {
    const client = createMockClient({
      "memory.getTier0Summary": () => TIER0_RESPONSE,
    });
    const result = await handleTier0Command(client, "/tier0");
    expect(result.command).toBe("tier0");
    expect(result.message).toContain("Tier 0 Summary");
    expect(result.message).toContain("Neuralgentics: Go-based memory backend");
    expect(result.message).toContain("42");
    expect(result.message).toContain("L0");
    expect(result.refreshKanban).toBe(false);
  });

  test("/tier0 force calls getTier0Summary(true)", async () => {
    const client = createMockClient({
      "memory.getTier0Summary": () => TIER0_RESPONSE,
    });
    const result = await handleTier0Command(client, "/tier0 force");
    expect(result.command).toBe("tier0");
    expect(result.message).toContain("Tier 0 Summary");
    expect(client.getTier0Summary).toHaveBeenCalledWith(true);
  });

  test("/tier0 without force calls getTier0Summary(undefined)", async () => {
    const client = createMockClient({
      "memory.getTier0Summary": () => TIER0_RESPONSE,
    });
    await handleTier0Command(client, "/tier0");
    expect(client.getTier0Summary).toHaveBeenCalledWith(false);
  });

  test("/tier0 handles error gracefully", async () => {
    const client = createMockClient({});
    const result = await handleTier0Command(client, "/tier0");
    expect(result.command).toBe("tier0");
    expect(result.message).toContain("/tier0 failed");
  });
});

// ─── /tier1 async tests ───────────────────────────────────────────────────────

describe("/tier1 command (async)", () => {
  test("/tier1 calls getTier1Summary and renders result", async () => {
    const client = createMockClient({
      "memory.getTier1Summary": () => TIER1_RESPONSE,
    });
    const result = await handleTier1Command(client, "/tier1");
    expect(result.command).toBe("tier1");
    expect(result.message).toContain("Tier 1 Summary");
    expect(result.message).toContain("Key decisions");
    expect(result.message).toContain("L1");
    expect(result.message).toContain("512");
    expect(result.refreshKanban).toBe(false);
  });

  test("/tier1 force calls getTier1Summary(true)", async () => {
    const client = createMockClient({
      "memory.getTier1Summary": () => TIER1_RESPONSE,
    });
    const result = await handleTier1Command(client, "/tier1 force");
    expect(result.command).toBe("tier1");
    expect(client.getTier1Summary).toHaveBeenCalledWith(true);
  });
});

// ─── /peer async tests ────────────────────────────────────────────────────────

describe("/peer command (async)", () => {
  test("/peer list calls peer.listPeers and renders peer list", async () => {
    const client = createMockClient({
      "peer.listPeers": () => [
        { peerId: "reviewer-bot", name: "Code Reviewer", role: "collaborator" },
        { peerId: "test-bot", name: "Test Runner", role: "readonly" },
      ],
    });
    const result = await handlePeerCommand(client, "/peer list");
    expect(result.command).toBe("peer");
    expect(result.message).toContain("Peer List");
    expect(result.message).toContain("reviewer-bot");
    expect(result.message).toContain("Code Reviewer");
    expect(result.message).toContain("test-bot");
  });

  test("/peer list with no peers shows empty message", async () => {
    const client = createMockClient({
      "peer.listPeers": () => [],
    });
    const result = await handlePeerCommand(client, "/peer list");
    expect(result.command).toBe("peer");
    expect(result.message).toContain("No peers registered");
  });

  test("/peer switch calls switchPeerContext and confirms", async () => {
    const client = createMockClient({
      "peer.switchContext": () => SWITCH_RESPONSE,
    });
    const result = await handlePeerCommand(client, "/peer switch peer-123");
    expect(result.command).toBe("peer");
    expect(result.message).toContain("Switched peer context");
    expect(result.message).toContain("default");
    expect(result.message).toContain("peer-123");
    expect(client.switchPeerContext).toHaveBeenCalledWith("peer-123");
  });

  test("/peer switch without id shows usage", async () => {
    const client = createMockClient({});
    const result = await handlePeerCommand(client, "/peer switch");
    expect(result.command).toBe("peer");
    expect(result.message).toContain("specify a peer ID");
  });

  test("/peer unknown returns error", async () => {
    const client = createMockClient({});
    const result = await handlePeerCommand(client, "/peer unknown");
    expect(result.command).toBe("peer");
    expect(result.message).toContain("Unknown /peer subcommand");
  });

  test("/peer with no args shows peer list (default)", async () => {
    const client = createMockClient({
      "peer.listPeers": () => [
        { peerId: "default", name: "Owner", role: "owner" },
      ],
    });
    const result = await handlePeerCommand(client, "/peer");
    expect(result.command).toBe("peer");
    expect(result.message).toContain("Peer List");
  });
});

// ─── /relationships async tests ───────────────────────────────────────────────

describe("/relationships command (async)", () => {
  test("/relationships <id> calls getRelationshipSummary and renders", async () => {
    const client = createMockClient({
      "memory.getRelationshipSummary": () => RELATIONSHIPS_RESPONSE,
    });
    const result = await handleRelationshipsCommand(
      client,
      "/relationships mem-456",
    );
    expect(result.command).toBe("relationships");
    expect(result.message).toContain("Relationships");
    expect(result.message).toContain("4");
    expect(result.message).toContain("SUPERSEDES");
    expect(result.message).toContain("RELATED_TO");
    expect(result.message).toContain("DERIVED_FROM");
    expect(result.refreshKanban).toBe(false);
    expect(client.getRelationshipSummary).toHaveBeenCalledWith("mem-456");
  });

  test("/relationships without id shows usage", async () => {
    const client = createMockClient({});
    const result = await handleRelationshipsCommand(client, "/relationships");
    expect(result.command).toBe("relationships");
    expect(result.message).toContain("specify a memory ID");
  });
});

// ─── /decay async tests ───────────────────────────────────────────────────────

describe("/decay command (async)", () => {
  test("/decay calls memory.getDecayStatus and renders", async () => {
    const client = createMockClient({
      "memory.getDecayStatus": () => ({
        enabled: true,
        totalMemories: 83,
        fadingMemories: 2,
        archivedMemories: 12,
        stats: { avgTrust: 0.72, decayRunsToday: 3 },
      }),
    });
    const result = await handleDecayCommand(client);
    expect(result.command).toBe("decay");
    expect(result.message).toContain("Decay Status");
    expect(result.message).toContain("true");
    expect(result.message).toContain("83");
    expect(result.message).toContain("avgTrust");
    expect(result.refreshKanban).toBe(false);
  });
});

// ─── /extract async tests ──────────────────────────────────────────────────────

describe("/extract command (async)", () => {
  test("/extract with no args calls triggerExtraction(undefined)", async () => {
    const client = createMockClient({
      "memory.triggerExtraction": () => EXTRACT_EMPTY_RESPONSE,
    });
    const result = await handleExtractCommand(client, "/extract");
    expect(result.command).toBe("extract");
    expect(result.message).toContain("Extraction Result");
    expect(result.message).toContain("0 memories");
    expect(client.triggerExtraction).toHaveBeenCalledWith(undefined);
  });

  test("/extract with text calls triggerExtraction(text)", async () => {
    const client = createMockClient({
      "memory.triggerExtraction": () => EXTRACT_RESPONSE,
    });
    const result = await handleExtractCommand(
      client,
      "/extract some text here",
    );
    expect(result.command).toBe("extract");
    expect(result.message).toContain("3 memories");
    expect(result.message).toContain("mem-aaa");
    expect(client.triggerExtraction).toHaveBeenCalledWith("some text here");
  });
});

// ─── WRITE_COMMANDS membership tests ──────────────────────────────────────────

describe("WRITE_COMMANDS includes new write commands", () => {
  test("extract is a write command", () => {
    expect(isWriteCommand("extract")).toBe(true);
  });

  test("peer is a write command (mixed read/write)", () => {
    expect(isWriteCommand("peer")).toBe(true);
  });

  test("tier0 is NOT a write command", () => {
    expect(isWriteCommand("tier0")).toBe(false);
  });

  test("tier1 is NOT a write command", () => {
    expect(isWriteCommand("tier1")).toBe(false);
  });

  test("relationships is NOT a write command", () => {
    expect(isWriteCommand("relationships")).toBe(false);
  });

  test("decay is NOT a write command", () => {
    expect(isWriteCommand("decay")).toBe(false);
  });
});
