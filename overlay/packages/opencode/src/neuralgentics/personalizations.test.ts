/**
 * Tests for the personalizations module (`.opencode/overrides/` merge).
 *
 * Covers:
 *   - stripYamlFrontmatter: no frontmatter, standard frontmatter, no closing
 *     fence (kept as-is), frontmatter with ... terminator, leading whitespace
 *   - mergePersonalizations: no overrides dir (no-op), matching override
 *     appended below default, YAML frontmatter stripped from override,
 *     idempotency (re-run does not double-append), orphan override warned +
 *     skipped, empty override skipped, README.md ignored, dry-run does not
 *     write, backup created before overwrite, warnings surface IO errors
 *
 * Uses bun:test with a temp directory per test — never touches the real
 * config dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs, existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  stripYamlFrontmatter,
  mergePersonalizations,
} from "./personalizations.js";

describe("stripYamlFrontmatter", () => {
  it("returns content unchanged when there is no frontmatter", () => {
    const input = "# Title\n\nbody text\n";
    expect(stripYamlFrontmatter(input)).toBe(input);
  });

  it("strips a standard --- ... --- frontmatter block", () => {
    const input = "---\nfoo: bar\nbaz: 1\n---\n# Body\n\ntext\n";
    expect(stripYamlFrontmatter(input)).toBe("# Body\n\ntext\n");
  });

  it("strips a frontmatter block terminated with ... ", () => {
    const input = "---\nfoo: bar\n...\nbody line\n";
    expect(stripYamlFrontmatter(input)).toBe("body line\n");
  });

  it("keeps content as-is when there is no closing fence", () => {
    const input = "---\nfoo: bar\nno closing fence\nbody\n";
    // No closing fence found — do not drop content.
    expect(stripYamlFrontmatter(input)).toBe(input);
  });

  it("trims leading blank lines after the closing fence", () => {
    const input = "---\nfoo: bar\n---\n\n\n# Body after blanks\n";
    expect(stripYamlFrontmatter(input)).toBe("# Body after blanks\n");
  });

  it("ignores a --- that appears mid-body (not at the very start)", () => {
    const input = "# Title\n\n---\n\nnot a frontmatter fence\n";
    expect(stripYamlFrontmatter(input)).toBe(input);
  });
});

describe("mergePersonalizations", () => {
  let tmpRoot: string;
  let agentsDir: string;
  let overridesDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "neuralgentics-merge-"));
    agentsDir = path.join(tmpRoot, "agents");
    overridesDir = path.join(tmpRoot, "overrides");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(overridesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("is a no-op when overridesDir does not exist", async () => {
    const res = await mergePersonalizations(agentsDir, path.join(tmpRoot, "nope"), false);
    expect(res.merged).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.orphaned).toBe(0);
    expect(res.warnings).toEqual([]);
  });

  it("warns when agentsDir does not exist", async () => {
    const res = await mergePersonalizations(
      path.join(tmpRoot, "no-agents"),
      overridesDir,
      false,
    );
    expect(res.merged).toBe(0);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toContain("agents directory not found");
  });

  it("appends an override body below the default and strips frontmatter", async () => {
    await fs.writeFile(
      path.join(agentsDir, "coder.md"),
      "---\ndescription: default\n---\n# Default coder\n\nship it.\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(overridesDir, "coder.md"),
      "---\nignored: true\n---\n## My override\n\nrun tests first.\n",
      "utf-8",
    );

    const res = await mergePersonalizations(agentsDir, overridesDir, false);
    expect(res.merged).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.orphaned).toBe(0);
    expect(res.warnings).toEqual([]);

    const merged = await fs.readFile(path.join(agentsDir, "coder.md"), "utf-8");
    // Default frontmatter preserved at the top.
    expect(merged.startsWith("---\ndescription: default\n---\n")).toBe(true);
    // Default body present.
    expect(merged).toContain("# Default coder");
    expect(merged).toContain("ship it.");
    // Override body appended (frontmatter stripped).
    expect(merged).toContain("## My override");
    expect(merged).toContain("run tests first.");
    // Override frontmatter NOT appended.
    expect(merged).not.toContain("ignored: true");
  });

  it("is idempotent — a second run does not double-append", async () => {
    await fs.writeFile(
      path.join(agentsDir, "coder.md"),
      "---\ndescription: default\n---\n# Default coder\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(overridesDir, "coder.md"),
      "## Override\n\nextra.\n",
      "utf-8",
    );

    const first = await mergePersonalizations(agentsDir, overridesDir, false);
    expect(first.merged).toBe(1);
    const afterFirst = await fs.readFile(path.join(agentsDir, "coder.md"), "utf-8");

    const second = await mergePersonalizations(agentsDir, overridesDir, false);
    expect(second.merged).toBe(0);
    expect(second.skipped).toBe(1);
    const afterSecond = await fs.readFile(path.join(agentsDir, "coder.md"), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  it("treats an orphan override (no matching default) as orphaned + warned", async () => {
    await fs.writeFile(path.join(overridesDir, "ghost.md"), "## ghost\n", "utf-8");
    const res = await mergePersonalizations(agentsDir, overridesDir, false);
    expect(res.merged).toBe(0);
    expect(res.orphaned).toBe(1);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toContain("ghost.md");
    expect(res.warnings[0]).toContain("no matching default");
    // Orphan file is NOT deleted.
    expect(existsSync(path.join(overridesDir, "ghost.md"))).toBe(true);
  });

  it("skips an empty override (body-only after frontmatter strip)", async () => {
    await fs.writeFile(
      path.join(agentsDir, "coder.md"),
      "# Default\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(overridesDir, "coder.md"),
      "---\nfoo: bar\n---\n",
      "utf-8",
    );
    const res = await mergePersonalizations(agentsDir, overridesDir, false);
    expect(res.merged).toBe(0);
    expect(res.skipped).toBe(1);
    const unchanged = await fs.readFile(path.join(agentsDir, "coder.md"), "utf-8");
    expect(unchanged).toBe("# Default\n");
  });

  it("ignores README.md in the overrides directory", async () => {
    await fs.writeFile(
      path.join(overridesDir, "README.md"),
      "# Docs\n\nnot an override\n",
      "utf-8",
    );
    const res = await mergePersonalizations(agentsDir, overridesDir, false);
    expect(res.merged).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.orphaned).toBe(0);
    // No warning about README being an orphan.
    expect(res.warnings).toEqual([]);
  });

  it("does not write or back up in dry-run mode", async () => {
    await fs.writeFile(
      path.join(agentsDir, "coder.md"),
      "# Default\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(overridesDir, "coder.md"),
      "## Override\n",
      "utf-8",
    );
    const before = await fs.readFile(path.join(agentsDir, "coder.md"), "utf-8");

    const res = await mergePersonalizations(agentsDir, overridesDir, true);
    expect(res.merged).toBe(1);

    const after = await fs.readFile(path.join(agentsDir, "coder.md"), "utf-8");
    expect(after).toBe(before);
    // No backup dir created in dry-run.
    expect(existsSync(path.join(agentsDir, "opencode-bak"))).toBe(false);
  });

  it("creates a backup of the default before overwriting", async () => {
    const original = "# Default coder\n\noriginal line\n";
    await fs.writeFile(path.join(agentsDir, "coder.md"), original, "utf-8");
    await fs.writeFile(path.join(overridesDir, "coder.md"), "## Override\n", "utf-8");

    await mergePersonalizations(agentsDir, overridesDir, false);

    // A backup file should exist in agentsDir/opencode-bak/
    const bakDir = path.join(agentsDir, "opencode-bak");
    expect(existsSync(bakDir)).toBe(true);
    const baks = await fs.readdir(bakDir);
    expect(baks.length).toBe(1);
    const backupContent = await fs.readFile(path.join(bakDir, baks[0]), "utf-8");
    expect(backupContent).toBe(original);
  });

  it("appends an override with no frontmatter verbatim (body-only)", async () => {
    await fs.writeFile(path.join(agentsDir, "writer.md"), "# Default writer\n", "utf-8");
    await fs.writeFile(path.join(overridesDir, "writer.md"), "## Override body\n", "utf-8");

    const res = await mergePersonalizations(agentsDir, overridesDir, false);
    expect(res.merged).toBe(1);
    const merged = await fs.readFile(path.join(agentsDir, "writer.md"), "utf-8");
    expect(merged).toContain("# Default writer");
    expect(merged).toContain("## Override body");
  });

  it("handles multiple overrides in one run", async () => {
    for (const name of ["coder.md", "writer.md", "tester.md"]) {
      await fs.writeFile(path.join(agentsDir, name), `# Default ${name}\n`, "utf-8");
      await fs.writeFile(path.join(overridesDir, name), `## Override ${name}\n`, "utf-8");
    }
    const res = await mergePersonalizations(agentsDir, overridesDir, false);
    expect(res.merged).toBe(3);
    expect(res.skipped).toBe(0);
    expect(res.orphaned).toBe(0);
  });
});