/**
 * T-064 tests: /catalog and /mcp slash commands (T-CATALOG-001).
 *
 * Covers 8 test cases:
 * 1. /catalog list returns formatted server list
 * 2. /catalog add github-mcp activates via npx default
 * 3. /catalog add nonexistent returns error
 * 4. /catalog info github-mcp returns transport list
 * 5. /mcp list shows active servers
 * 6. /mcp activate github-mcp same as /catalog add
 * 7. /mcp deactivate github-mcp returns success
 * 8. /mcp with no args shows usage
 */

import { describe, test, expect, vi } from "bun:test";
import {
  handleSlashCommand,
  isWriteCommand,
  handleCatalogCommand,
  handleMCPCommand,
} from "../commands.js";
import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import type {
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
  } as unknown as NeuralgenticsClient;
}

// ─── Canned responses ────────────────────────────────────────────────────────

const CATALOG_LIST_RESPONSE = {
  servers: [
    {
      name: "github-mcp",
      description: "GitHub repository management, issues, PRs, and actions",
      category: "developer",
      capabilities: ["github", "git", "issues", "prs", "actions"],
      transports_count: 2,
      required_env: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    },
    {
      name: "filesystem",
      description: "File system read/write operations with configurable access paths",
      category: "storage",
      capabilities: ["filesystem", "read", "write"],
      transports_count: 1,
      required_env: [],
    },
  ],
};

const ACTIVATE_RESPONSE = { transport: "npx" };

const DEACTIVATE_RESPONSE = { status: "ok" };

const LIST_TRANSPORTS_RESPONSE = {
  transports: [
    {
      type: "npx",
      package: "@modelcontextprotocol/server-github",
      default: true,
      description: "Official MCP server via NPX",
    },
    {
      type: "docker",
      package: "mcp/github",
      description: "Containerized (community image)",
    },
  ],
  unavailable: [],
};

const ACTIVE_SERVERS_RESPONSE = {
  servers: [
    {
      name: "memoryManager",
      description: "Memory management",
      status: "running",
      toolsCount: 15,
    },
    {
      name: "github-mcp",
      description: "GitHub API for issues, PRs, repos, actions",
      status: "running",
      toolsCount: 22,
    },
  ],
  totalTools: 37,
};

// ─── Sync dispatch tests ─────────────────────────────────────────────────────

describe("T-CATALOG-001: /catalog and /mcp sync dispatch", () => {
  test("/catalog returns async handler signal", () => {
    const result = handleSlashCommand("/catalog");
    expect(result.command).toBe("catalog");
    expect(result.message).toContain("async handler");
  });

  test("/mcp returns async handler signal", () => {
    const result = handleSlashCommand("/mcp");
    expect(result.command).toBe("mcp");
    expect(result.message).toContain("async handler");
  });

  test("catalog is a write command", () => {
    expect(isWriteCommand("catalog")).toBe(true);
  });

  test("mcp is a write command", () => {
    expect(isWriteCommand("mcp")).toBe(true);
  });
});

// ─── /catalog async tests ────────────────────────────────────────────────────

describe("/catalog command (async)", () => {
  test("/catalog list returns formatted server list", async () => {
    const client = createMockClient({
      "broker.discoverCatalog": () => CATALOG_LIST_RESPONSE,
    });
    const result = await handleCatalogCommand(client, "/catalog list");
    expect(result.command).toBe("catalog");
    expect(result.message).toContain("MCP Catalog");
    expect(result.message).toContain("github-mcp");
    expect(result.message).toContain("filesystem");
    expect(result.message).toContain("developer");
    expect(result.message).toContain("storage");
    expect(result.refreshKanban).toBe(false);
  });

  test("/catalog add github-mcp activates via npx default", async () => {
    const client = createMockClient({
      "broker.activateFromCatalog": () => ACTIVATE_RESPONSE,
    });
    const result = await handleCatalogCommand(client, "/catalog add github-mcp");
    expect(result.command).toBe("catalog");
    expect(result.message).toContain("Activated github-mcp");
    expect(result.message).toContain("npx");
  });

  test("/catalog add nonexistent returns error", async () => {
    const client = createMockClient({});
    const result = await handleCatalogCommand(client, "/catalog add nonexistent-mcp");
    expect(result.command).toBe("catalog");
    expect(result.message).toContain("/catalog failed");
  });

  test("/catalog info github-mcp returns transport list", async () => {
    const client = createMockClient({
      "broker.listTransports": () => LIST_TRANSPORTS_RESPONSE,
    });
    const result = await handleCatalogCommand(client, "/catalog info github-mcp");
    expect(result.command).toBe("catalog");
    expect(result.message).toContain("github-mcp");
    expect(result.message).toContain("npx");
    expect(result.message).toContain("docker");
    expect(result.message).toContain("available");
  });
});

// ─── /mcp async tests ────────────────────────────────────────────────────────

describe("/mcp command (async)", () => {
  test("/mcp list shows active servers", async () => {
    const client = createMockClient({
      "broker.buildCatalog": () => ACTIVE_SERVERS_RESPONSE,
    });
    const result = await handleMCPCommand(client, "/mcp list");
    expect(result.command).toBe("mcp");
    expect(result.message).toContain("Active MCP Servers");
    expect(result.message).toContain("memoryManager");
    expect(result.message).toContain("github-mcp");
    expect(result.message).toContain("37");
  });

  test("/mcp activate github-mcp same as /catalog add", async () => {
    const client = createMockClient({
      "broker.activateFromCatalog": () => ACTIVATE_RESPONSE,
    });
    const result = await handleMCPCommand(client, "/mcp activate github-mcp");
    expect(result.command).toBe("mcp");
    expect(result.message).toContain("Activated github-mcp");
    expect(result.message).toContain("npx");
  });

  test("/mcp deactivate github-mcp returns success", async () => {
    const client = createMockClient({
      "broker.deactivateMCPServer": () => DEACTIVATE_RESPONSE,
    });
    const result = await handleMCPCommand(client, "/mcp deactivate github-mcp");
    expect(result.command).toBe("mcp");
    expect(result.message).toContain("Deactivated github-mcp");
  });

  test("/mcp with no args defaults to list", async () => {
    const client = createMockClient({
      "broker.buildCatalog": () => ACTIVE_SERVERS_RESPONSE,
    });
    const result = await handleMCPCommand(client, "/mcp");
    expect(result.command).toBe("mcp");
    expect(result.message).toContain("Active MCP Servers");
  });
});