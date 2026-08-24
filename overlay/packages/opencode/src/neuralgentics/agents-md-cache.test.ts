/**
 * Tests for T-AGENTSCACHE-001: per-directory AGENTS.md cache.
 *
 * loadAgentsMd previously cached ONE module-global string from the first
 * directory that called it — a second project sharing the process got the
 * first project's instructions, and edits were invisible for the whole
 * session. The cache is now keyed by resolved path and revalidated by mtime.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsMd } from "../server.js";

describe("loadAgentsMd per-directory cache (T-AGENTSCACHE-001)", () => {
  const dirs: string[] = [];

  beforeEach(async () => {
    dirs.push(await mkdtemp(join(tmpdir(), "ng-cache-a-")));
    dirs.push(await mkdtemp(join(tmpdir(), "ng-cache-b-")));
  });

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("returns each project's OWN AGENTS.md (no cross-project leakage)", async () => {
    await writeFile(join(dirs[0]!, "AGENTS.md"), "PROJECT-A-INSTRUCTIONS", "utf-8");
    await writeFile(join(dirs[1]!, "AGENTS.md"), "PROJECT-B-INSTRUCTIONS", "utf-8");

    const first = await loadAgentsMd(dirs[0]!);
    const second = await loadAgentsMd(dirs[1]!);

    expect(first).toBe("PROJECT-A-INSTRUCTIONS");
    expect(second).toBe("PROJECT-B-INSTRUCTIONS");
  });

  it("picks up edits after the initial load (mtime invalidation)", async () => {
    const file = join(dirs[0]!, "AGENTS.md");
    await writeFile(file, "VERSION-1", "utf-8");
    expect(await loadAgentsMd(dirs[0]!)).toBe("VERSION-1");

    // Ensure mtime actually differs across filesystems with coarse timestamps.
    const future = new Date(Date.now() + 2000);
    await writeFile(file, "VERSION-2", "utf-8");
    const utimes = await import("node:fs/promises");
    await utimes.utimes(file, future, future);

    expect(await loadAgentsMd(dirs[0]!)).toBe("VERSION-2");
  });

  it("falls back to the parent directory's AGENTS.md", async () => {
    // Candidate chain is dir → parent → cwd, so a project at <root>/app
    // falls back to <root>/AGENTS.md.
    const subdir = join(dirs[0]!, "app");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(subdir, { recursive: true }),
    );
    await writeFile(join(dirs[0]!, "AGENTS.md"), "PARENT-LEVEL", "utf-8");
    expect(await loadAgentsMd(subdir)).toBe("PARENT-LEVEL");
  });
});
