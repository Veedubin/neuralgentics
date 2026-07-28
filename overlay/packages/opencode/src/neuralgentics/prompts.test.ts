/**
 * Tests for the --init-project hardening fixes:
 *
 * Fix 1 — `validatePort` / `validateHost` / `validateDatabase` + re-ask
 *   loop in `promptTeamConnection`.
 * Fix 2 — `updateEnvFile` backs up `.env` and preserves user-added keys.
 * Fix 3 — `runInstall` refuses to re-run when a state file exists, unless
 *   `--force` is set.
 * Fix 4 — `buildProjectOpencodeJson` throws `NeuralgenticsError` on an
 *   invalid `teamPort`.
 *
 * Uses bun:test with temp directories (mkdtemp) — never touches the real
 * config dirs. Mirrors the style of `personalizations.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs, existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  validatePort,
  validateHost,
  validateDatabase,
  promptTeamConnection,
  type AskSessionLike,
} from "./prompts.js";
import { updateEnvFile } from "./env-file.js";
import {
  buildProjectOpencodeJson,
  NeuralgenticsError,
  runInstall,
  STATE_FILENAME,
  type InstallOptions,
} from "./init.js";

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neuralgentics-prompts-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Clean up temp dirs.
  await Promise.all(
    tmpDirs.map(async (d) => {
      try {
        await fs.rm(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }),
  );
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Fake ask session — returns scripted answers in order
// ---------------------------------------------------------------------------

class FakeSession implements AskSessionLike {
  private answers: string[];
  private idx = 0;
  public prompts: string[] = [];

  constructor(answers: string[]) {
    this.answers = answers;
  }

  ask(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const ans = this.idx < this.answers.length ? this.answers[this.idx] : "";
    this.idx++;
    return Promise.resolve(ans);
  }

  close(): void {
    // no-op
  }
}

// ===========================================================================
// Fix 1 — validatePort / validateHost / validateDatabase
// ===========================================================================

describe("validatePort", () => {
  it("rejects '0' (out of range)", () => {
    expect(validatePort("0")).toBeNull();
  });

  it("rejects '-1' (negative)", () => {
    expect(validatePort("-1")).toBeNull();
  });

  it("rejects '65536' (out of range)", () => {
    expect(validatePort("65536")).toBeNull();
  });

  it("rejects 'abc' (non-numeric)", () => {
    expect(validatePort("abc")).toBeNull();
  });

  it("rejects '5.5' (fractional)", () => {
    expect(validatePort("5.5")).toBeNull();
  });

  it("rejects '' (empty)", () => {
    expect(validatePort("")).toBeNull();
  });

  it("accepts '1' (lower bound)", () => {
    expect(validatePort("1")).toBe("1");
  });

  it("accepts '65535' (upper bound)", () => {
    expect(validatePort("65535")).toBe("65535");
  });

  it("accepts '5432' (typical Postgres port)", () => {
    expect(validatePort("5432")).toBe("5432");
  });

  it("accepts '  5432  ' (trimmed)", () => {
    expect(validatePort("  5432  ")).toBe("5432");
  });
});

describe("validateHost", () => {
  it("accepts 'localhost'", () => {
    expect(validateHost("localhost")).toBe("localhost");
  });

  it("accepts an IP address", () => {
    expect(validateHost("192.168.1.10")).toBe("192.168.1.10");
  });

  it("rejects empty", () => {
    expect(validateHost("")).toBeNull();
  });

  it("rejects spaces", () => {
    expect(validateHost("my host")).toBeNull();
  });

  it("rejects ':' (would break DSN)", () => {
    expect(validateHost("host:5432")).toBeNull();
  });
});

describe("validateDatabase", () => {
  it("accepts 'neuralgentics'", () => {
    expect(validateDatabase("neuralgentics")).toBe("neuralgentics");
  });

  it("rejects empty", () => {
    expect(validateDatabase("")).toBeNull();
  });

  it("rejects spaces", () => {
    expect(validateDatabase("my db")).toBeNull();
  });

  it("rejects '/' (would break DSN path)", () => {
    expect(validateDatabase("a/b")).toBeNull();
  });
});

// ===========================================================================
// Fix 1 — promptTeamConnection re-asks on bad input
// ===========================================================================

describe("promptTeamConnection", () => {
  it("re-asks on an invalid port then accepts a valid retry", async () => {
    // Answers in order: host (Enter=default), port="abc" (invalid), port="5434"
    // (valid), db (Enter=default), user (Enter=default), password="pw",
    // saveCreds="n".
    const session = new FakeSession([
      "",        // host -> default localhost
      "abc",     // port -> invalid (non-numeric)
      "5434",    // port retry -> valid
      "",        // database -> default
      "",        // user -> default
      "pw",      // password
      "n",       // save creds? no
    ]);
    const configDir = await makeTmpDir();
    const result = await promptTeamConnection(session, configDir);
    expect(result.host).toBe("localhost");
    expect(result.port).toBe("5434");
    expect(result.database).toBe("neuralgentics");
    expect(result.user).toBe("neuralgentics");
    expect(result.password).toBe("pw");
    // The port prompt should have been asked twice (once for "abc", once for
    // "5434").
    const portPrompts = session.prompts.filter((p) => p.startsWith("  Port"));
    expect(portPrompts.length).toBe(2);
  });

  it("accepts defaults when the user presses Enter", async () => {
    const session = new FakeSession([
      "", // host default
      "", // port default
      "", // db default
      "", // user default
      "", // password (empty)
    ]);
    const configDir = await makeTmpDir();
    const result = await promptTeamConnection(session, configDir);
    expect(result.host).toBe("localhost");
    expect(result.port).toBe("6200");
    expect(result.database).toBe("neuralgentics");
    expect(result.user).toBe("neuralgentics");
    expect(result.password).toBe("");
    // Empty password means no save-creds prompt.
    expect(session.prompts.some((p) => p.includes("[Y/n]"))).toBe(false);
  });

  it("re-asks on an invalid host then accepts a valid retry", async () => {
    const session = new FakeSession([
      "bad host", // host -> invalid (has space)
      "localhost", // host retry -> valid
      "",          // port default
      "",          // db default
      "",          // user default
      "",          // password empty
    ]);
    const configDir = await makeTmpDir();
    const result = await promptTeamConnection(session, configDir);
    expect(result.host).toBe("localhost");
  });

  it("re-asks on an invalid database name then accepts a valid retry", async () => {
    const session = new FakeSession([
      "",          // host default
      "",          // port default
      "a/b",       // db -> invalid (has /)
      "neuralgentics", // db retry -> valid
      "",          // user default
      "",          // password empty
    ]);
    const configDir = await makeTmpDir();
    const result = await promptTeamConnection(session, configDir);
    expect(result.database).toBe("neuralgentics");
  });
});

// ===========================================================================
// Fix 2 — updateEnvFile
// ===========================================================================

describe("updateEnvFile", () => {
  it("creates a new .env when none exists and returns null", async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, ".env");
    const backup = await updateEnvFile(envPath, [
      "MEMINI_DB_URL=postgresql://u:p@localhost:5434/db",
      "MEMINI_VECTOR_BACKEND=postgres-external",
    ]);
    expect(backup).toBeNull();
    const content = await fs.readFile(envPath, "utf-8");
    expect(content).toContain("MEMINI_DB_URL=postgresql://u:p@localhost:5434/db");
    expect(content).toContain("MEMINI_VECTOR_BACKEND=postgres-external");
  });

  it("backs up an existing .env to env-file-*.env.bak", async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, ".env");
    await fs.writeFile(
      envPath,
      "MEMINI_DB_URL=postgresql://old:old@localhost:5/memini\n" +
        "NEURALGENTICS_DB_URL=postgresql://neural:neural@localhost:6200/neuralgentics\n",
      "utf-8",
    );
    const backup = await updateEnvFile(envPath, [
      "MEMINI_DB_URL=postgresql://neuralgentics:neuralgentics@localhost:5434/memini",
      "MEMINI_VECTOR_BACKEND=postgres-external",
    ]);
    expect(backup).not.toBeNull();
    expect(backup).toContain("env-file-");
    expect(backup).toContain(".env.bak");
    expect(existsSync(backup!)).toBe(true);
    // The backup contains the OLD content.
    const backupContent = await fs.readFile(backup!, "utf-8");
    expect(backupContent).toContain("localhost:5/memini");
  });

  it("replaces an existing MEMINI_DB_URL line", async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, ".env");
    await fs.writeFile(
      envPath,
      "MEMINI_DB_URL=postgresql://old:old@localhost:5/memini\n",
      "utf-8",
    );
    await updateEnvFile(envPath, [
      "MEMINI_DB_URL=postgresql://neuralgentics:neuralgentics@localhost:5434/memini",
    ]);
    const content = await fs.readFile(envPath, "utf-8");
    expect(content).toContain("localhost:5434/memini");
    expect(content).not.toContain("localhost:5/memini");
  });

  it("preserves user-added keys (e.g. NEURALGENTICS_DB_URL)", async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, ".env");
    await fs.writeFile(
      envPath,
      "MEMINI_DB_URL=postgresql://old:old@localhost:5/memini\n" +
        "NEURALGENTICS_DB_URL=postgresql://neural:neural@localhost:6200/neuralgentics\n" +
        "OLLAMA_API_KEY=sk-xxxxx\n",
      "utf-8",
    );
    await updateEnvFile(envPath, [
      "MEMINI_DB_URL=postgresql://new:new@localhost:5434/memini",
      "MEMINI_VECTOR_BACKEND=postgres-external",
    ]);
    const content = await fs.readFile(envPath, "utf-8");
    // The user-added keys must survive.
    expect(content).toContain("NEURALGENTICS_DB_URL=postgresql://neural:neural@localhost:6200/neuralgentics");
    expect(content).toContain("OLLAMA_API_KEY=sk-xxxxx");
    // The new keys must be present.
    expect(content).toContain("MEMINI_DB_URL=postgresql://new:new@localhost:5434/memini");
    expect(content).toContain("MEMINI_VECTOR_BACKEND=postgres-external");
  });

  it("does not create a backup when .env did not exist", async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, ".env");
    const backup = await updateEnvFile(envPath, ["KEY=value"]);
    expect(backup).toBeNull();
    // No .bak file in the dir.
    const entries = await fs.readdir(dir);
    expect(entries.some((e) => e.endsWith(".env.bak"))).toBe(false);
  });

  it("preserves comments and blank lines", async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, ".env");
    await fs.writeFile(
      envPath,
      "# a comment\n\nKEY1=old\n\n# another\nKEY2=val\n",
      "utf-8",
    );
    await updateEnvFile(envPath, ["KEY1=new"]);
    const content = await fs.readFile(envPath, "utf-8");
    expect(content).toContain("# a comment");
    expect(content).toContain("# another");
    expect(content).toContain("KEY2=val");
    expect(content).toContain("KEY1=new");
    expect(content).not.toContain("KEY1=old");
  });
});

// ===========================================================================
// Fix 3 — runInstall refuses re-run when state file exists without --force
// ===========================================================================

describe("runInstall re-install detection (Fix 3)", () => {
  it("returns 0 early when a state file exists and force=false", async () => {
    const dir = await makeTmpDir();
    // Create a fake state file to simulate a prior install.
    await fs.writeFile(
      path.join(dir, STATE_FILENAME),
      JSON.stringify({ version: 1, installed_version: "0.15.19" }, null, 2),
      "utf-8",
    );

    const args: InstallOptions = {
      target: dir,
      force: false,
      dryRun: false,
      yes: true,
      version: "0.15.19",
      embedded: false,
      team: true,
      cpuEmbed: false,
      autoEmbed: true,
      gpuEmbed: false,
    };

    const exitCode = await runInstall(args, "project");
    expect(exitCode).toBe(0);

    // The opencode.json must NOT have been written (early return).
    expect(existsSync(path.join(dir, "opencode.json"))).toBe(false);
  });

  it("proceeds when a state file exists and force=true", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, STATE_FILENAME),
      JSON.stringify({ version: 1, installed_version: "0.15.19" }, null, 2),
      "utf-8",
    );

    const args: InstallOptions = {
      target: dir,
      force: true,
      dryRun: false,
      yes: true,
      version: "0.15.19",
      embedded: false,
      team: true,
      cpuEmbed: false,
      autoEmbed: true,
      gpuEmbed: false,
    };

    // runInstall will proceed past the re-install guard (because force=true)
    // and attempt the full install. Downstream steps (system-deps check,
    // package pre-download via uvx, etc.) may take a long time or fail in the
    // test environment. We don't need the install to complete — we only need
    // to verify the guard did NOT short-circuit. So we race runInstall
    // against a short timeout and assert the guard's "Re-running detected"
    // message is absent from captured stdout.
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    const spy = (chunk: string | Uint8Array): boolean => {
      captured += chunk.toString();
      return true;
    };
    process.stdout.write = spy as typeof process.stdout.write;

    let installPromise: Promise<void> | null = null;
    try {
      installPromise = (async () => {
        try {
          await runInstall(args, "project");
        } catch {
          // Downstream failures (network, missing deps) are acceptable.
        }
      })();
      // Race the install against a 3s timeout. If the install hasn't
      // finished, that's fine — we only care about the guard message.
      await Promise.race([
        installPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }
    // The guard message must NOT appear — force=true bypassed the guard.
    expect(captured).not.toContain("Re-running --init-project detected");
  });
});

// ===========================================================================
// Fix 4 — buildProjectOpencodeJson validates teamPort
// ===========================================================================

describe("buildProjectOpencodeJson port validation (Fix 4)", () => {
  it("throws NeuralgenticsError when teamPort is '70000' (out of range)", () => {
    expect(() =>
      buildProjectOpencodeJson({
        backend: "team",
        teamHost: "localhost",
        teamPort: "70000",
        teamDatabase: "memini",
        teamUser: "neuralgentics",
        teamPassword: "neuralgentics",
        embedding: "auto",
      }),
    ).toThrow(NeuralgenticsError);
  });

  it("throws NeuralgenticsError when teamPort is 'abc' (non-numeric)", () => {
    expect(() =>
      buildProjectOpencodeJson({
        backend: "team",
        teamPort: "abc",
        embedding: "auto",
      }),
    ).toThrow(NeuralgenticsError);
  });

  it("throws NeuralgenticsError when teamPort is '5.5' (fractional)", () => {
    expect(() =>
      buildProjectOpencodeJson({
        backend: "team",
        teamPort: "5.5",
        embedding: "auto",
      }),
    ).toThrow(NeuralgenticsError);
  });

  it("throws NeuralgenticsError when teamPort is '0' (out of range)", () => {
    expect(() =>
      buildProjectOpencodeJson({
        backend: "team",
        teamPort: "0",
        embedding: "auto",
      }),
    ).toThrow(NeuralgenticsError);
  });

  it("builds a valid MEMINI_DB_URL when teamPort is '5434'", () => {
    const config = buildProjectOpencodeJson({
      backend: "team",
      teamHost: "localhost",
      teamPort: "5434",
      teamDatabase: "memini",
      teamUser: "neuralgentics",
      teamPassword: "neuralgentics",
      embedding: "auto",
    }) as { mcp: Record<string, { env: Record<string, string> }> };
    const env = config.mcp["memini-ai-dev"].env;
    expect(env.MEMINI_DB_URL).toBe(
      "postgresql://neuralgentics:neuralgentics@localhost:5434/memini",
    );
    expect(env.MEMINI_VECTOR_BACKEND).toBe("postgres-external");
  });

  it("does not validate when backend is not 'team'", () => {
    // pgembed backend — no team port to validate.
    expect(() =>
      buildProjectOpencodeJson({
        backend: "pgembed",
        embedding: "auto",
      }),
    ).not.toThrow();
  });
});