/**
 * T-066 tests: /profile slash command (T-PROFILE-OCI).
 *
 * Covers 7 test cases:
 * 1. /profile (no args) shows usage
 * 2. /profile export calls broker.exportProfile and writes tarball
 * 3. /profile export with -p passphrase includes passphrase
 * 4. /profile import <path> reads file and calls broker.importProfile
 * 5. /profile import <path> --force includes force flag
 * 6. /profile list reads profile-history.json
 * 7. /profile with invalid subcommand returns usage
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { handleProfileCommand } from "../commands.js";
import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import type {
  MethodName,
  MethodParams,
  MethodResult,
} from "../neuralgentics-client/types.js";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock NeuralgenticsClient ─────────────────────────────────────────────────

interface MockCallMap {
  [method: string]: (params: any) => unknown;
}

function createMockClient(callMap: MockCallMap): NeuralgenticsClient {
  return {
    call: vi.fn(
      async <M extends MethodName>(
        method: M,
        params: MethodParams<M>,
      ): Promise<MethodResult<M>> => {
        const handler = callMap[method as string];
        if (handler) return handler(params) as MethodResult<M>;
        throw new Error(`Unexpected call: ${method as string}`);
      },
    ),
  } as unknown as NeuralgenticsClient;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EXPORT_MANIFEST = {
  version: "1.0.0",
  exported_at: "2026-06-07T18:50:00Z",
  exported_by: "test-host",
  broker_version: "0.5.0",
  file_count: 7,
};

const EXPORT_TARBALL = Buffer.from("fake-tarball-content").toString("base64");

const IMPORT_RESULT = {
  applied: 3,
  conflicts: [],
  manifest: {
    version: "1.0.0",
    exported_by: "other-host",
    exported_at: "2026-06-07T18:50:00Z",
  },
};

let tmpDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpDir = join(tmpdir(), `neuralgentics-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("/profile command (T-PROFILE-OCI)", () => {
  test("no args shows usage", async () => {
    const client = createMockClient({});
    const result = await handleProfileCommand(client, []);
    expect(result.command).toBe("profile");
    expect(result.message).toContain("Usage:");
    expect(result.message).toContain("/profile export");
    expect(result.message).toContain("/profile import");
    expect(result.message).toContain("/profile list");
  });

  test("/profile help is alias for no args", async () => {
    const client = createMockClient({});
    const result = await handleProfileCommand(client, ["help"]);
    expect(result.message).toContain("Usage:");
  });

  test("export calls broker.exportProfile and writes tarball", async () => {
    const outPath = join(tmpDir, "profile.tar.gz");
    const client = createMockClient({
      "broker.exportProfile": (params: any) => {
        expect(params.passphrase).toBe("");
        expect(params.brokerVersion).toBe("0.5.0");
        return { manifest: EXPORT_MANIFEST, tarball: EXPORT_TARBALL };
      },
    });
    const result = await handleProfileCommand(client, ["export", outPath]);
    expect(result.message).toContain(`Exported profile to: ${outPath}`);
    expect(result.message).toContain("Version: 1.0.0");
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).toString()).toBe("fake-tarball-content");
  });

  test("export with -p passphrase includes passphrase in call", async () => {
    const outPath = join(tmpDir, "profile-signed.tar.gz");
    const client = createMockClient({
      "broker.exportProfile": (params: any) => {
        expect(params.passphrase).toBe("mysecret");
        return { manifest: EXPORT_MANIFEST, tarball: EXPORT_TARBALL };
      },
    });
    const result = await handleProfileCommand(client, ["export", "-p", "mysecret", outPath]);
    expect(result.message).toContain("(signed)");
  });

  test("import reads file and calls broker.importProfile", async () => {
    const inPath = join(tmpDir, "input.tar.gz");
    require("node:fs").writeFileSync(inPath, "fake-tarball");
    const client = createMockClient({
      "broker.importProfile": (params: any) => {
        expect(params.tarball).toBe(Buffer.from("fake-tarball").toString("base64"));
        expect(params.passphrase).toBe("");
        expect(params.force).toBe(false);
        return IMPORT_RESULT;
      },
    });
    const result = await handleProfileCommand(client, ["import", inPath]);
    expect(result.message).toContain("Imported profile");
    expect(result.message).toContain("Applied: 3 MCPs");
    expect(result.message).toContain("(none)"); // no conflicts
  });

  test("import with --force includes force flag", async () => {
    const inPath = join(tmpDir, "input.tar.gz");
    require("node:fs").writeFileSync(inPath, "fake-tarball");
    const client = createMockClient({
      "broker.importProfile": (params: any) => {
        expect(params.force).toBe(true);
        return IMPORT_RESULT;
      },
    });
    await handleProfileCommand(client, ["import", inPath, "--force"]);
  });

  test("list reads profile-history.json (empty when no history)", async () => {
    const client = createMockClient({});
    const result = await handleProfileCommand(client, ["list"]);
    expect(result.message).toContain("No profile history yet");
  });

  test("invalid subcommand returns usage", async () => {
    const client = createMockClient({});
    const result = await handleProfileCommand(client, ["bogus"]);
    expect(result.message).toBe("Usage: /profile [export|import|list|help]");
  });

  test("import of nonexistent file returns error", async () => {
    const client = createMockClient({});
    const result = await handleProfileCommand(client, ["import", join(tmpDir, "does-not-exist.tar.gz")]);
    expect(result.message).toContain("Profile file not found");
  });
});
