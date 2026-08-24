#!/usr/bin/env node
/**
 * gen-template-config.mjs — T-CFG-SHIP-001
 *
 * Generates the CLEAN template `.opencode/opencode.json` that ships inside
 * the GitHub release tarball, using the same builders the interactive
 * installer uses. This replaces the previous behaviour of copying the
 * maintainer's personal `.opencode/opencode.json` (13 MCP servers, 6
 * enabled, personal plugins) into every user-facing archive — the primary
 * token-bloat source identified in the 2026-08-24 review.
 *
 * Usage:
 *   node scripts/gen-template-config.mjs [outfile]
 *
 * Must be run AFTER `npx tsc` (imports ./dist/neuralgentics/init.js).
 * With no argument, writes to stdout.
 */

import { buildProjectOpencodeJson } from "../dist/neuralgentics/init.js";

const DEFAULTS = { backend: "pgembed", embedding: "auto" };
const json = JSON.stringify(buildProjectOpencodeJson(DEFAULTS), null, 2) + "\n";

if (process.argv[2]) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.argv[2], json, "utf-8");
} else {
  process.stdout.write(json);
}
