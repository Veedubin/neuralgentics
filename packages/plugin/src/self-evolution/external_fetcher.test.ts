/**
 * ExternalSkillsFetcher — Unit Tests
 *
 * Tests for the external skills fetcher module:
 *   - isEnabled() toggle behavior
 *   - externalDir() path construction
 *   - fetch() with disabled/enabled toggle
 *   - fetch() with fresh clone
 *   - fetch() with existing repo (git pull --ff-only)
 *   - fetch() with network errors on git pull
 *   - fetch() with network errors on git clone
 *   - readManifest() / writeManifest() round-trip
 *   - readEnvFile() parsing
 *
 * Uses bun:test with mocked exec function. No actual git commands are run.
 */

import { describe, it, expect } from "bun:test";
import {
  ExternalSkillsFetcher,
  DEFAULT_REPOS,
  readEnvFile,
} from "./external_fetcher.js";
import type { Manifest, ExecFn } from "./external_fetcher.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a mock exec function that tracks calls and returns
 * configurable responses based on the git subcommand and cwd.
 */
function createMockExec(
  responses: Map<string, { stdout: string; stderr: string; exitCode: number }>,
): ExecFn & { calls: Array<{ cmd: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];

  const exec: ExecFn & { calls: typeof calls } = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });

    // Build a key from the git subcommand + cwd for matching
    const gitSubcommand = args[0];
    const key = `${gitSubcommand}:${cwd ?? ""}`;

    // Try exact key first, then prefix match
    if (responses.has(key)) {
      return responses.get(key)!;
    }
    for (const [k, v] of responses) {
      if (key.startsWith(k) || k === key) {
        return v;
      }
    }

    // Default: successful empty response
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  exec.calls = calls;
  return exec;
}

/** Create a temp directory for test isolation. */
async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `external-fetcher-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================================
// isEnabled() Tests
// ============================================================================

describe("ExternalSkillsFetcher", () => {
  describe("isEnabled()", () => {
    it("returns true when external_skills.enabled is 'true'", () => {
      const env = {
        get: (key: string) =>
          key === "external_skills.enabled" ? "true" : undefined,
      };
      const fetcher = new ExternalSkillsFetcher("/home/test", env);
      expect(fetcher.isEnabled()).toBe(true);
    });

    it("returns false when external_skills.enabled is 'false'", () => {
      const env = {
        get: (key: string) =>
          key === "external_skills.enabled" ? "false" : undefined,
      };
      const fetcher = new ExternalSkillsFetcher("/home/test", env);
      expect(fetcher.isEnabled()).toBe(false);
    });

    it("returns false when external_skills.enabled is unset", () => {
      const env = { get: (_key: string) => undefined };
      const fetcher = new ExternalSkillsFetcher("/home/test", env);
      expect(fetcher.isEnabled()).toBe(false);
    });

    it("returns false when external_skills.enabled has other values", () => {
      const env = {
        get: (key: string) =>
          key === "external_skills.enabled" ? "yes" : undefined,
      };
      const fetcher = new ExternalSkillsFetcher("/home/test", env);
      expect(fetcher.isEnabled()).toBe(false);
    });

    it("is case-insensitive — 'TRUE' works", () => {
      const env = {
        get: (key: string) =>
          key === "external_skills.enabled" ? "TRUE" : undefined,
      };
      const fetcher = new ExternalSkillsFetcher("/home/test", env);
      expect(fetcher.isEnabled()).toBe(true);
    });
  });

  // ============================================================================
  // externalDir() Tests
  // ============================================================================

  describe("externalDir()", () => {
    it("returns the correct path under homeDir", () => {
      const env = { get: (_key: string) => undefined };
      const fetcher = new ExternalSkillsFetcher(
        "/home/test/.neuralgentics",
        env,
      );
      expect(fetcher.externalDir()).toBe(
        "/home/test/.neuralgentics/external_skills",
      );
    });
  });

  // ============================================================================
  // fetch() Tests
  // ============================================================================

  describe("fetch()", () => {
    it("returns empty manifest when disabled without calling exec", async () => {
      const env = { get: (_key: string) => undefined }; // disabled by default
      const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
      const mockExec: ExecFn = async (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const fetcher = new ExternalSkillsFetcher("/tmp/test", env, mockExec);
      const result = await fetcher.fetch();

      expect(result.enabled).toBe(false);
      expect(Object.keys(result.repos)).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      // exec should NOT have been called
      expect(calls).toHaveLength(0);
    });

    it("clones fresh repos when enabled and no existing directories", async () => {
      const tempDir = await createTempDir();
      try {
        const env = {
          get: (key: string) =>
            key === "external_skills.enabled" ? "true" : undefined,
        };

        const responses = new Map<
          string,
          { stdout: string; stderr: string; exitCode: number }
        >();
        // git clone succeeds
        responses.set("clone:", {
          stdout: "Cloning...",
          stderr: "",
          exitCode: 0,
        });
        // git rev-parse HEAD succeeds
        responses.set("rev-parse:", {
          stdout: "abc123def456abc123def456abc123def456abc1",
          stderr: "",
          exitCode: 0,
        });

        const mockExec = createMockExec(responses);
        const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);
        const result = await fetcher.fetch();

        expect(result.enabled).toBe(true);
        expect(result.errors).toHaveLength(0);

        // Both repos should be cloned
        const cloneCalls = mockExec.calls.filter(
          (c) => c.args[0] === "clone",
        );
        expect(cloneCalls.length).toBe(2);

        // Manifest should be written
        const manifest = await fetcher.readManifest();
        expect(manifest).not.toBeNull();
        expect(manifest!.version).toBe(1);
        expect(Object.keys(manifest!.repos)).toHaveLength(2);
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("calls git pull --ff-only for existing repos with .git directory", async () => {
      const tempDir = await createTempDir();
      try {
        const env = {
          get: (key: string) =>
            key === "external_skills.enabled" ? "true" : undefined,
        };

        // Create .git directories so they look like existing repos
        const extDir = join(tempDir, "external_skills");
        for (const repo of DEFAULT_REPOS) {
          const gitDir = join(extDir, repo.name, ".git");
          await mkdir(gitDir, { recursive: true });
          // Write .git/HEAD so the stat check finds a directory
        }

        const responses = new Map<
          string,
          { stdout: string; stderr: string; exitCode: number }
        >();
        // git pull succeeds
        responses.set("pull:", {
          stdout: "Already up to date.",
          stderr: "",
          exitCode: 0,
        });
        // git rev-parse HEAD succeeds
        responses.set("rev-parse:", {
          stdout: "def789abc123def789abc123def789abc123def7",
          stderr: "",
          exitCode: 0,
        });

        const mockExec = createMockExec(responses);
        const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);
        const result = await fetcher.fetch();

        expect(result.enabled).toBe(true);
        expect(result.errors).toHaveLength(0);

        // Both repos should have pull calls (no clone)
        const pullCalls = mockExec.calls.filter(
          (c) => c.args[0] === "pull",
        );
        const cloneCalls = mockExec.calls.filter(
          (c) => c.args[0] === "clone",
        );
        expect(pullCalls.length).toBe(2);
        expect(cloneCalls.length).toBe(0);

        // Status should be "updated" for both
        for (const repo of DEFAULT_REPOS) {
          expect(result.repos[repo.name].status).toBe("updated");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("handles network errors on git pull gracefully — does NOT throw, records skipped-network-error with existing SHA", async () => {
      const tempDir = await createTempDir();
      try {
        const env = {
          get: (key: string) =>
            key === "external_skills.enabled" ? "true" : undefined,
        };

        // Create .git directories so they look like existing repos
        const extDir = join(tempDir, "external_skills");
        for (const repo of DEFAULT_REPOS) {
          const gitDir = join(extDir, repo.name, ".git");
          await mkdir(gitDir, { recursive: true });
        }

        const responses = new Map<
          string,
          { stdout: string; stderr: string; exitCode: number }
        >();
        // git pull fails with network error
        responses.set("pull:", {
          stdout: "",
          stderr: "fatal: Could not resolve host: github.com",
          exitCode: 128,
        });
        // git rev-parse HEAD succeeds (existing clone)
        responses.set("rev-parse:", {
          stdout: "aaa111bbb222ccc333ddd444eee555fff666aaa1",
          stderr: "",
          exitCode: 0,
        });

        const mockExec = createMockExec(responses);
        const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);

        // Should NOT throw
        const result = await fetcher.fetch();

        expect(result.enabled).toBe(true);
        expect(result.errors.length).toBeGreaterThanOrEqual(1);

        // Both repos should have skipped-network-error status
        for (const repo of DEFAULT_REPOS) {
          expect(result.repos[repo.name].status).toBe("skipped-network-error");
          // Should use existing HEAD SHA, not "unknown"
          expect(result.repos[repo.name].commit_sha).toBe(
            "aaa111bbb222ccc333ddd444eee555fff666aaa1",
          );
        }

        // Manifest should still be written
        const manifest = await fetcher.readManifest();
        expect(manifest).not.toBeNull();
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("handles network errors on git clone gracefully", async () => {
      const tempDir = await createTempDir();
      try {
        const env = {
          get: (key: string) =>
            key === "external_skills.enabled" ? "true" : undefined,
        };

        const responses = new Map<
          string,
          { stdout: string; stderr: string; exitCode: number }
        >();
        // git clone fails with network error
        responses.set("clone:", {
          stdout: "",
          stderr:
            "fatal: unable to access 'https://github.com/': Connection timed out",
          exitCode: 128,
        });

        const mockExec = createMockExec(responses);
        const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);
        const result = await fetcher.fetch();

        // Both repos should have skipped-network-error status
        for (const repo of DEFAULT_REPOS) {
          expect(result.repos[repo.name].status).toBe(
            "skipped-network-error",
          );
        }

        // Errors should be recorded
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("writes MANIFEST.json with correct structure and attribution", async () => {
      const tempDir = await createTempDir();
      try {
        const env = {
          get: (key: string) =>
            key === "external_skills.enabled" ? "true" : undefined,
        };

        const responses = new Map<
          string,
          { stdout: string; stderr: string; exitCode: number }
        >();
        responses.set("clone:", {
          stdout: "Cloning...",
          stderr: "",
          exitCode: 0,
        });
        responses.set("rev-parse:", {
          stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          stderr: "",
          exitCode: 0,
        });

        const mockExec = createMockExec(responses);
        const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);
        await fetcher.fetch();

        const manifest = await fetcher.readManifest();
        expect(manifest).not.toBeNull();
        expect(manifest!.version).toBe(1);
        expect(typeof manifest!.updated_at).toBe("string");
        expect(manifest!.updated_at.length).toBeGreaterThan(0);

        // Check each repo has the expected fields
        for (const repo of DEFAULT_REPOS) {
          const entry = manifest!.repos[repo.name];
          expect(entry).toBeDefined();
          expect(entry.url).toBe(repo.url);
          expect(entry.commit_sha).toBe(
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          );
          expect(entry.license).toBe(repo.license);
          expect(entry.attribution).toBe(repo.attribution);
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  // ============================================================================
  // readManifest() Tests
  // ============================================================================

  describe("readManifest()", () => {
    it("returns null when MANIFEST.json doesn't exist", async () => {
      const tempDir = await createTempDir();
      try {
        const env = { get: (_key: string) => undefined };
        const fetcher = new ExternalSkillsFetcher(tempDir, env);
        const manifest = await fetcher.readManifest();
        expect(manifest).toBeNull();
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("reads and parses a valid MANIFEST.json", async () => {
      const tempDir = await createTempDir();
      try {
        const extDir = join(tempDir, "external_skills");
        await mkdir(extDir, { recursive: true });

        const manifestData: Manifest = {
          version: 1,
          updated_at: "2026-06-24T12:00:00.000Z",
          repos: {
            "ai-research-skills": {
              url: "https://github.com/Orchestra-Research/AI-Research-SKILLs.git",
              commit_sha: "abc123",
              license: "MIT",
              attribution: "Copyright 2025",
            },
          },
        };

        await writeFile(
          join(extDir, "MANIFEST.json"),
          JSON.stringify(manifestData, null, 2),
          "utf-8",
        );

        const env = { get: (_key: string) => undefined };
        const fetcher = new ExternalSkillsFetcher(tempDir, env);
        const manifest = await fetcher.readManifest();

        expect(manifest).not.toBeNull();
        expect(manifest!.version).toBe(1);
        expect(manifest!.repos["ai-research-skills"].commit_sha).toBe("abc123");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  // ============================================================================
  // writeManifest() Tests
  // ============================================================================

  describe("writeManifest()", () => {
    it("writes a valid MANIFEST.json that can be read back", async () => {
      const tempDir = await createTempDir();
      try {
        const env = { get: (_key: string) => undefined };
        const fetcher = new ExternalSkillsFetcher(tempDir, env);

        const manifestData: Manifest = {
          version: 1,
          updated_at: "2026-06-24T12:00:00.000Z",
          repos: {
            "test-repo": {
              url: "https://example.com/test.git",
              commit_sha: "fff999",
              license: "MIT",
              attribution: "Test attribution",
            },
          },
        };

        await fetcher.writeManifest(manifestData);
        const readBack = await fetcher.readManifest();

        expect(readBack).not.toBeNull();
        expect(readBack!.version).toBe(1);
        expect(readBack!.repos["test-repo"].commit_sha).toBe("fff999");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  // ============================================================================
  // readEnvFile() Tests
  // ============================================================================

  describe("readEnvFile()", () => {
    it("parses KEY=value lines", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(envPath, "FOO=bar\nBAZ=qux\n", "utf-8");

        const env = readEnvFile(envPath);
        expect(env.get("FOO")).toBe("bar");
        expect(env.get("BAZ")).toBe("qux");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("parses KEY=\"value\" lines with double quotes", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(envPath, 'KEY="hello world"\n', "utf-8");

        const env = readEnvFile(envPath);
        expect(env.get("KEY")).toBe("hello world");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("parses KEY='value' lines with single quotes", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(envPath, "KEY='hello world'\n", "utf-8");

        const env = readEnvFile(envPath);
        expect(env.get("KEY")).toBe("hello world");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("skips comment lines starting with #", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(
          envPath,
          "# This is a comment\nKEY=value\n",
          "utf-8",
        );

        const env = readEnvFile(envPath);
        expect(env.get("KEY")).toBe("value");
        // Comment line should not produce a key
        expect(env.get("#")).toBeUndefined();
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("skips empty lines", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(envPath, "\n\nKEY=value\n\n", "utf-8");

        const env = readEnvFile(envPath);
        expect(env.get("KEY")).toBe("value");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("skips lines without = sign", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(envPath, "NOEQUALSSIGN\nKEY=value\n", "utf-8");

        const env = readEnvFile(envPath);
        expect(env.get("KEY")).toBe("value");
        expect(env.get("NOEQUALSSIGN")).toBeUndefined();
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("returns empty reader for missing file", () => {
      const env = readEnvFile("/nonexistent/path/.env");
      expect(env.get("ANY_KEY")).toBeUndefined();
    });

    it("parses external_skills.enabled=true correctly", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(
          envPath,
          "external_skills.enabled=true\nOTHER=thing\n",
          "utf-8",
        );

        const env = readEnvFile(envPath);
        expect(env.get("external_skills.enabled")).toBe("true");
        expect(env.get("OTHER")).toBe("thing");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  // ============================================================================
  // DEFAULT_REPOS Tests
  // ============================================================================

  describe("DEFAULT_REPOS", () => {
    it("contains exactly 2 repos with correct names", () => {
      expect(DEFAULT_REPOS).toHaveLength(2);
      expect(DEFAULT_REPOS[0].name).toBe("ai-research-skills");
      expect(DEFAULT_REPOS[1].name).toBe("ui-ux-pro-max-skill");
    });

    it("has MIT license for both repos", () => {
      for (const repo of DEFAULT_REPOS) {
        expect(repo.license).toBe("MIT");
      }
    });

    it("has non-empty attribution strings", () => {
      for (const repo of DEFAULT_REPOS) {
        expect(repo.attribution.length).toBeGreaterThan(0);
      }
    });
  });
});