/**
 * ExternalSkillsFetcher — Integration Tests
 *
 * End-to-end tests that exercise the full ExternalSkillsFetcher pipeline
 * with mocked exec, temp directories, and real file I/O.
 *
 * Uses bun:test.
 *
 * @module external_fetcher_integration
 */

import { describe, it, expect } from "bun:test";
import {
  ExternalSkillsFetcher,
  DEFAULT_REPOS,
  readEnvFile,
} from "./external_fetcher.js";
import type { ExecFn, RepoConfig, Manifest } from "./external_fetcher.js";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ============================================================================
// Helpers
// ============================================================================

/** Create a temp directory for test isolation. */
async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `external-fetcher-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

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

    const gitSubcommand = args[0];
    const key = `${gitSubcommand}:${cwd ?? ""}`;

    if (responses.has(key)) {
      return responses.get(key)!;
    }
    for (const [k, v] of responses) {
      if (key.startsWith(k) || k === key) {
        return v;
      }
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  };
  exec.calls = calls;
  return exec;
}

// ============================================================================
// Integration Tests
// ============================================================================

describe("ExternalSkillsFetcher Integration", () => {
  // ─── Test 1: Full fetch with mocked exec ────────────────────────────────

  it("full fetch with mocked exec writes MANIFEST.json with correct provenance", async () => {
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
        stdout: "Cloning into 'ai-research-skills'...",
        stderr: "",
        exitCode: 0,
      });
      responses.set("rev-parse:", {
        stdout: "773a529b8c4d1e2f3a5b6c7d8e9f0a1b2c3d4e5f6",
        stderr: "",
        exitCode: 0,
      });

      const mockExec = createMockExec(responses);
      const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);
      const result = await fetcher.fetch();

      // Verify fetch result
      expect(result.enabled).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(Object.keys(result.repos)).toHaveLength(2);

      // Verify MANIFEST.json was written
      const manifest = await fetcher.readManifest();
      expect(manifest).not.toBeNull();
      expect(manifest!.version).toBe(1);
      expect(typeof manifest!.updated_at).toBe("string");
      expect(manifest!.updated_at.length).toBeGreaterThan(0);

      // Verify provenance fields for each repo
      for (const repo of DEFAULT_REPOS) {
        const entry = manifest!.repos[repo.name];
        expect(entry).toBeDefined();
        expect(entry.url).toBe(repo.url);
        expect(entry.commit_sha).toBe(
          "773a529b8c4d1e2f3a5b6c7d8e9f0a1b2c3d4e5f6",
        );
        expect(entry.license).toBe(repo.license);
        expect(entry.attribution).toBe(repo.attribution);
      }

      // Verify result.repos has correct status
      for (const repo of DEFAULT_REPOS) {
        expect(result.repos[repo.name].status).toBe("cloned");
        expect(result.repos[repo.name].commit_sha).toBe(
          "773a529b8c4d1e2f3a5b6c7d8e9f0a1b2c3d4e5f6",
        );
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Test 2: Offline-safe ────────────────────────────────────────────────

  it("fetch is offline-safe — network failure on git pull does not throw, records skipped-network-error", async () => {
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
      expect(result.errors[0]).toContain("git pull failed (offline?)");

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
      expect(Object.keys(manifest!.repos)).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Test 3: No-op when disabled ─────────────────────────────────────────

  it("fetch is a no-op when disabled — exec is never called", async () => {
    const tempDir = await createTempDir();
    try {
      // external_skills.enabled is unset → disabled
      const env = { get: (_key: string) => undefined };
      const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
      const mockExec: ExecFn = async (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);
      const result = await fetcher.fetch();

      expect(result.enabled).toBe(false);
      expect(Object.keys(result.repos)).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      // exec should NOT have been called
      expect(calls).toHaveLength(0);

      // Manifest should NOT have been written
      const manifest = await fetcher.readManifest();
      expect(manifest).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Test 4: First-run clone vs subsequent pull ─────────────────────────

  it("first-run clone vs subsequent pull — .git missing triggers clone, .git present triggers pull", async () => {
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
      // First call: clone succeeds
      responses.set("clone:", {
        stdout: "Cloning...",
        stderr: "",
        exitCode: 0,
      });
      // Second call: pull succeeds
      responses.set("pull:", {
        stdout: "Already up to date.",
        stderr: "",
        exitCode: 0,
      });
      // rev-parse always succeeds
      responses.set("rev-parse:", {
        stdout: "def789abc123def789abc123def789abc123def7",
        stderr: "",
        exitCode: 0,
      });

      const mockExec = createMockExec(responses);
      const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);

      // First fetch: no .git dirs → should clone
      const result1 = await fetcher.fetch();
      expect(result1.enabled).toBe(true);

      const cloneCalls1 = mockExec.calls.filter((c) => c.args[0] === "clone");
      expect(cloneCalls1.length).toBe(2);
      const pullCalls1 = mockExec.calls.filter((c) => c.args[0] === "pull");
      expect(pullCalls1.length).toBe(0);

      // Now create .git dirs to simulate existing repos
      const extDir = join(tempDir, "external_skills");
      for (const repo of DEFAULT_REPOS) {
        const gitDir = join(extDir, repo.name, ".git");
        await mkdir(gitDir, { recursive: true });
      }

      // Reset call tracking
      mockExec.calls.length = 0;

      // Second fetch: .git dirs exist → should pull
      const result2 = await fetcher.fetch();
      expect(result2.enabled).toBe(true);

      const cloneCalls2 = mockExec.calls.filter((c) => c.args[0] === "clone");
      expect(cloneCalls2.length).toBe(0);
      const pullCalls2 = mockExec.calls.filter((c) => c.args[0] === "pull");
      expect(pullCalls2.length).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Test 5: Manifest is valid JSON ─────────────────────────────────────

  it("manifest is valid JSON — write, read back, parse, verify all expected fields", async () => {
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
        stdout: "abc123def456abc123def456abc123def456abc1",
        stderr: "",
        exitCode: 0,
      });

      const mockExec = createMockExec(responses);
      const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);
      await fetcher.fetch();

      // Read the raw file and parse as JSON
      const manifestPath = join(tempDir, "external_skills", "MANIFEST.json");
      const raw = await readFile(manifestPath, "utf-8");

      // Verify it's valid JSON
      let parsed: Manifest;
      expect(() => {
        parsed = JSON.parse(raw) as Manifest;
      }).not.toThrow();

      parsed = JSON.parse(raw) as Manifest;
      expect(parsed.version).toBe(1);
      expect(typeof parsed.updated_at).toBe("string");
      expect(parsed.updated_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );

      // Verify all expected fields for each repo
      for (const repo of DEFAULT_REPOS) {
        const entry = parsed.repos[repo.name];
        expect(entry).toBeDefined();
        expect(typeof entry.url).toBe("string");
        expect(entry.url).toBe(repo.url);
        expect(typeof entry.commit_sha).toBe("string");
        expect(entry.commit_sha.length).toBeGreaterThan(0);
        expect(typeof entry.license).toBe("string");
        expect(entry.license).toBe(repo.license);
        expect(typeof entry.attribution).toBe("string");
        expect(entry.attribution).toBe(repo.attribution);
      }

      // Verify the JSON is pretty-printed (has newlines and indentation)
      expect(raw).toContain("\n");
      expect(raw).toContain("  ");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Test 6: Custom repos override ──────────────────────────────────────

  it("custom repos override — passed RepoConfig[] is used instead of DEFAULT_REPOS", async () => {
    const tempDir = await createTempDir();
    try {
      const env = {
        get: (key: string) =>
          key === "external_skills.enabled" ? "true" : undefined,
      };

      const customRepos: RepoConfig[] = [
        {
          name: "custom-repo-1",
          url: "https://github.com/example/custom1.git",
          license: "Apache-2.0",
          attribution: "Copyright 2026 Example Corp. Used under Apache-2.0.",
        },
        {
          name: "custom-repo-2",
          url: "https://github.com/example/custom2.git",
          license: "BSD-3-Clause",
          attribution: "Copyright 2026 Example Corp. Used under BSD-3-Clause.",
        },
      ];

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
        stdout: "customsha1234567890abcdef1234567890abcdef12",
        stderr: "",
        exitCode: 0,
      });

      const mockExec = createMockExec(responses);
      const fetcher = new ExternalSkillsFetcher(tempDir, env, mockExec);
      const result = await fetcher.fetch(customRepos);

      expect(result.enabled).toBe(true);
      expect(Object.keys(result.repos)).toHaveLength(2);

      // Verify custom repos were used (not DEFAULT_REPOS)
      expect(result.repos["custom-repo-1"]).toBeDefined();
      expect(result.repos["custom-repo-2"]).toBeDefined();
      expect(result.repos["ai-research-skills"]).toBeUndefined();
      expect(result.repos["ui-ux-pro-max-skill"]).toBeUndefined();

      // Verify manifest has custom repo data
      const manifest = await fetcher.readManifest();
      expect(manifest).not.toBeNull();
      expect(manifest!.repos["custom-repo-1"].url).toBe(customRepos[0].url);
      expect(manifest!.repos["custom-repo-1"].license).toBe("Apache-2.0");
      expect(manifest!.repos["custom-repo-2"].license).toBe("BSD-3-Clause");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Test 7: readEnvFile edge cases ─────────────────────────────────────

  describe("readEnvFile edge cases", () => {
    it("handles empty file", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(envPath, "", "utf-8");

        const env = readEnvFile(envPath);
        expect(env.get("ANY_KEY")).toBeUndefined();
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("handles comments-only file", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(
          envPath,
          "# This is a comment\n# Another comment\n",
          "utf-8",
        );

        const env = readEnvFile(envPath);
        expect(env.get("ANY_KEY")).toBeUndefined();
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("handles mixed quoted and unquoted values", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(
          envPath,
          [
            'UNQUOTED=plain_value',
            'DOUBLE="hello world"',
            "SINGLE='single quoted'",
            'MIXED=value_with_underscores',
            'EMPTY=""',
          ].join("\n"),
          "utf-8",
        );

        const env = readEnvFile(envPath);
        expect(env.get("UNQUOTED")).toBe("plain_value");
        expect(env.get("DOUBLE")).toBe("hello world");
        expect(env.get("SINGLE")).toBe("single quoted");
        expect(env.get("MIXED")).toBe("value_with_underscores");
        expect(env.get("EMPTY")).toBe("");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("handles missing file gracefully", () => {
      const env = readEnvFile("/nonexistent/path/.env");
      expect(env.get("ANY_KEY")).toBeUndefined();
    });

    it("handles values with equals signs inside quotes", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(
          envPath,
          'COMPLEX="key=value&other=thing"\n',
          "utf-8",
        );

        const env = readEnvFile(envPath);
        expect(env.get("COMPLEX")).toBe("key=value&other=thing");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("handles trailing whitespace in keys and values", async () => {
      const tempDir = await createTempDir();
      try {
        const envPath = join(tempDir, ".env");
        await writeFile(
          envPath,
          '  KEY  =  "spaced value"  \n',
          "utf-8",
        );

        const env = readEnvFile(envPath);
        expect(env.get("KEY")).toBe("spaced value");
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});
