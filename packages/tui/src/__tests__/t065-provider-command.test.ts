/**
 * T-065 tests: /provider TUI slash command for runtime LLM provider switching.
 *
 * Covers 8 test cases:
 * 1. /provider (no args) shows current default ollama-cloud
 * 2. /provider ollama-cloud writes provider-pref.json
 * 3. /provider dmr-local writes provider-pref.json
 * 4. /provider openrouter writes provider-pref.json
 * 5. /provider invalid returns usage error
 * 6. /provider list calls client.providerStatus and formats
 * 7. /provider status is alias for list
 * 8. After /provider dmr-local, reading the file back shows activeProvider: "dmr-local"
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import {
  handleSlashCommand,
  isWriteCommand,
  handleProviderCommand,
} from "../commands.js";
import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import type {
  MethodName,
  MethodParams,
  MethodResult,
} from "../neuralgentics-client/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

const PROVIDER_STATUS_RESPONSE = [
  {
    name: "ollama-cloud",
    url: "https://ollama.com/v1/models",
    status: "needs_auth",
    latencyMs: 245,
  },
  {
    name: "dmr-local",
    url: "http://localhost:12434/engines/v1/models",
    status: "offline",
    latencyMs: 3002,
    error: "connection refused",
  },
  {
    name: "openrouter",
    url: "https://openrouter.ai/api/v1/models",
    status: "ok",
    latencyMs: 180,
  },
];

// ─── Temp directory for preference file tests ─────────────────────────────────

let tmpDir: string;
let origXdgConfig: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "neuralgentics-test-"));
  origXdgConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  // Restore XDG_CONFIG_HOME and clean up temp dir
  if (origXdgConfig !== undefined) {
    process.env.XDG_CONFIG_HOME = origXdgConfig;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Sync dispatch tests ─────────────────────────────────────────────────────

describe("T-DUAL-PROVIDER: /provider sync dispatch", () => {
  test("/provider returns async handler signal", () => {
    const result = handleSlashCommand("/provider");
    expect(result.command).toBe("provider");
    expect(result.message).toContain("async handler");
  });

  test("provider is a write command", () => {
    expect(isWriteCommand("provider")).toBe(true);
  });
});

// ─── /provider async tests ────────────────────────────────────────────────────

describe("/provider command (async)", () => {
  test("/provider (no args) shows current default ollama-cloud", async () => {
    const client = createMockClient({});
    const result = await handleProviderCommand(client, "/provider");
    expect(result.command).toBe("provider");
    expect(result.message).toContain("Active provider:");
    expect(result.message).toContain("ollama-cloud");
  });

  test("/provider ollama-cloud writes provider-pref.json", async () => {
    const client = createMockClient({});
    const result = await handleProviderCommand(client, "/provider ollama-cloud");
    expect(result.command).toBe("provider");
    expect(result.message).toContain("Switched active provider to: ollama-cloud");
    expect(result.message).toContain("Restart opencode TUI session");

    // Verify file was written
    const prefPath = path.join(tmpDir, "neuralgentics", "provider-pref.json");
    expect(fs.existsSync(prefPath)).toBe(true);
    const pref = JSON.parse(fs.readFileSync(prefPath, "utf-8"));
    expect(pref.activeProvider).toBe("ollama-cloud");
  });

  test("/provider dmr-local writes provider-pref.json", async () => {
    const client = createMockClient({});
    const result = await handleProviderCommand(client, "/provider dmr-local");
    expect(result.command).toBe("provider");
    expect(result.message).toContain("Switched active provider to: dmr-local");

    const prefPath = path.join(tmpDir, "neuralgentics", "provider-pref.json");
    const pref = JSON.parse(fs.readFileSync(prefPath, "utf-8"));
    expect(pref.activeProvider).toBe("dmr-local");
  });

  test("/provider openrouter writes provider-pref.json", async () => {
    const client = createMockClient({});
    const result = await handleProviderCommand(client, "/provider openrouter");
    expect(result.command).toBe("provider");
    expect(result.message).toContain("Switched active provider to: openrouter");

    const prefPath = path.join(tmpDir, "neuralgentics", "provider-pref.json");
    const pref = JSON.parse(fs.readFileSync(prefPath, "utf-8"));
    expect(pref.activeProvider).toBe("openrouter");
  });

  test("/provider invalid returns usage error", async () => {
    const client = createMockClient({});
    const result = await handleProviderCommand(client, "/provider invalid");
    expect(result.command).toBe("provider");
    expect(result.message).toContain("Usage: /provider");
    expect(result.message).toContain("Known providers:");
    expect(result.message).toContain("ollama-cloud");
  });

  test("/provider list calls client.providerStatus and formats", async () => {
    const client = createMockClient({
      "provider.status": () => PROVIDER_STATUS_RESPONSE,
    });
    const result = await handleProviderCommand(client, "/provider list");
    expect(result.command).toBe("provider");
    expect(result.message).toContain("Provider Status");
    expect(result.message).toContain("ollama-cloud");
    expect(result.message).toContain("dmr-local");
    expect(result.message).toContain("openrouter");
    expect(result.message).toContain("needs_auth");
    expect(result.message).toContain("offline");
    expect(result.message).toContain("ok");
  });

  test("/provider status is alias for list", async () => {
    const client = createMockClient({
      "provider.status": () => PROVIDER_STATUS_RESPONSE,
    });
    const result = await handleProviderCommand(client, "/provider status");
    expect(result.command).toBe("provider");
    expect(result.message).toContain("Provider Status");
    expect(result.message).toContain("ollama-cloud");
  });

  test("after /provider dmr-local, reading the file back shows activeProvider: dmr-local", async () => {
    // First switch to dmr-local
    const switchClient = createMockClient({});
    await handleProviderCommand(switchClient, "/provider dmr-local");

    // Now read the file back
    const prefPath = path.join(tmpDir, "neuralgentics", "provider-pref.json");
    const pref = JSON.parse(fs.readFileSync(prefPath, "utf-8"));
    expect(pref.activeProvider).toBe("dmr-local");
    expect(typeof pref.updatedAt).toBe("string");

    // Now call /provider with no args — should read dmr-local from the pref file
    const readClient = createMockClient({});
    const readResult = await handleProviderCommand(readClient, "/provider");
    expect(readResult.message).toContain("Active provider: dmr-local");
  });
});