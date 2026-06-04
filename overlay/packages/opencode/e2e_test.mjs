/**
 * E2E test for GoBackendClient — drives the Go backend binary
 * end-to-end over stdio JSON-RPC without requiring a TUI restart.
 *
 * Usage:
 *   node e2e_test.mjs
 *   npm run test:e2e
 *
 * Exits 0 on success, 1 on failure with a clear error message.
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GoBackendClient } from "./dist/neuralgentics/go-backend-client.js";

// ── Resolve binary path ────────────────────────────────────────────────
// Use env override if provided, otherwise relative to this file's location.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BINARY_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "backend-go",
  "neuralgentics-backend",
);

const binaryPath = process.env.NEURALGENTICS_BACKEND_PATH || DEFAULT_BINARY_PATH;

// ── Pre-flight: binary must exist ──────────────────────────────────────
if (!existsSync(binaryPath)) {
  console.error(
    `FAIL: Go backend binary not found at "${binaryPath}".\n` +
      "Build it first: cd packages/backend-go && go build -o neuralgentics-backend ./cmd/server",
  );
  process.exitCode = 1;
  process.exit(1);
}

// ── Set DB URL for the Go backend ──────────────────────────────────────
// Default to the dev DB on 5436 with sslmode=require (matches DEFAULT_DB_URL in the client).
process.env.NEURALGENTICS_DB_URL =
  process.env.NEURALGENTICS_DB_URL ||
  "postgresql://postgres:testpassword@localhost:5436/neuralgentics_test?sslmode=require";

// UUID regex for validating memory IDs
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let client;

try {
  // ── Step 1: Construct client ───────────────────────────────────────────
  console.log("1. Constructing GoBackendClient...");
  client = new GoBackendClient(binaryPath);

  // ── Step 2: waitForReady ───────────────────────────────────────────────
  console.log("2. Waiting for backend ready signal...");
  await client.waitForReady(10_000);
  console.log("   ✓ Backend ready");

  // ── Step 3: ping ────────────────────────────────────────────────────────
  console.log("3. Calling ping...");
  const pong = await client.call("ping", {});
  assert.strictEqual(pong, "pong", `Expected "pong", got ${JSON.stringify(pong)}`);
  console.log("   ✓ ping → pong");

  // ── Step 4: memory.add ─────────────────────────────────────────────────
  const content = `e2e overlay test ${Date.now()}`;
  console.log(`4. Calling memory.add with content: "${content}"...`);
  // source_type must be one of: session, file, web, boomerang, project, thought,
  // context_package, agent_wrap_up (enforced by DB CHECK constraint).
  const addResult = await client.call("memory.add", {
    content,
    sourceType: "project",
    metadata: { test: "item5" },
  });

  // The Go backend returns { id: "<uuid>" } — extract the ID string.
  assert.ok(
    addResult != null && typeof addResult === "object",
    `Expected memory result object, got ${typeof addResult}: ${JSON.stringify(addResult)}`,
  );
  const memoryId = addResult.id ?? addResult;
  assert.ok(
    typeof memoryId === "string" && UUID_RE.test(memoryId),
    `Expected UUID ID string, got: ${JSON.stringify(memoryId)}`,
  );
  console.log(`   ✓ memory.add returned ID: ${memoryId}`);

  // ── Step 5: memory.query ───────────────────────────────────────────────
  console.log("5. Calling memory.query...");
  const queryResult = await client.call("memory.query", {
    query: "e2e overlay test",
    limit: 1,
  });

  // The Go backend returns an array-like result with memory objects.
  assert.ok(
    queryResult != null,
    `Expected non-null query result, got ${JSON.stringify(queryResult)}`,
  );

  // The result shape depends on the Go backend's query implementation.
  // It could be an array directly, or an object with a results/memories field.
  const memories = Array.isArray(queryResult)
    ? queryResult
    : Array.isArray(queryResult?.memories)
      ? queryResult.memories
      : Array.isArray(queryResult?.results)
        ? queryResult.results
        : null;

  assert.ok(
    memories != null && Array.isArray(memories) && memories.length > 0,
    `Expected non-empty array of memories, got: ${JSON.stringify(queryResult).slice(0, 300)}`,
  );

  // Verify the returned memory contains our test content.
  const found = memories.some(
    (m) => m.content && m.content.includes("e2e overlay test"),
  );
  assert.ok(
    found,
    `Expected to find memory with "e2e overlay test", got: ${JSON.stringify(memories[0]).slice(0, 300)}`,
  );
  console.log(`   ✓ memory.query returned matching memory`);

  // ── Step 6: shutdown ───────────────────────────────────────────────────
  console.log("6. Shutting down backend...");
  await client.shutdown();
  console.log("   ✓ Backend shut down");

  console.log("\n✅ All E2E tests passed!");
  process.exitCode = 0;
} catch (err) {
  console.error(`\n❌ E2E test FAILED: ${err.message}`);
  if (err.stack) {
    // Only show first line of stack for clarity — not full Node internals.
    const firstLine = err.stack.split("\n").slice(0, 3).join("\n");
    console.error(firstLine);
  }

  // Attempt graceful cleanup — kill the subprocess if it's still running.
  if (client) {
    try {
      await client.shutdown();
    } catch {
      // Best effort — ignore if the process is already dead.
    }
  }
  process.exitCode = 1;
  process.exit(1);
}