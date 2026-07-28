import { promises as fs, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const e2eDir = process.argv[2];
if (!e2eDir) {
  console.error("Usage: node e2e_init_assets.mjs <e2e-dir>");
  process.exit(1);
}

const opencodeDir = path.join(e2eDir, ".opencode");
mkdirSync(opencodeDir, { recursive: true });

const mod = await import("./dist/neuralgentics/init.js");
const result = await mod.copyStaticAssets(opencodeDir, false);

console.log("E2E_DIR:", e2eDir);
console.log("opencodeDir:", opencodeDir);
console.log("copyStaticAssets result:", JSON.stringify(result));

const rootAgents = path.join(e2eDir, "AGENTS.md");
console.log("root AGENTS.md exists:", existsSync(rootAgents));

if (existsSync(rootAgents)) {
  const content = readFileSync(rootAgents, "utf-8");
  console.log("root AGENTS.md first line:", content.split("\n")[0]);
  console.log("contains 'memini-ai':", content.includes("memini-ai"));
  console.log("contains '## Model Remodeling':", content.includes("## Model Remodeling"));
  console.log("contains quickstart/first session:", /quickstart|getting started|your first session/i.test(content));
  console.log("line count:", content.split("\n").length);
}

// File tree
function walk(dir, prefix = "") {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = prefix + e.name;
    console.log(rel + (e.isDirectory() ? "/" : ""));
    if (e.isDirectory() && !e.name.startsWith("node_modules")) walk(full, rel + "/");
  }
}

console.log("--- file tree ---");
walk(e2eDir);

// Verify opencode.json instructions would resolve
const opencodeJsonPath = path.join(opencodeDir, "opencode.json");
if (existsSync(opencodeJsonPath)) {
  const cfg = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
  console.log("opencode.json instructions:", JSON.stringify(cfg.instructions));
  if (cfg.instructions && cfg.instructions.includes("AGENTS.md")) {
    console.log("instructions resolves to root AGENTS.md:", existsSync(rootAgents));
  }
} else {
  console.log("opencode.json: not present (copyStaticAssets only copies assets, not config)");
}