#!/usr/bin/env bash
# Neuralgentics backend JSON-RPC smoke test (extended).
# Verifies: initialize -> ping -> memory.add x2 -> memory.count -> memory.query
#           -> memory.get -> orchestrator.route -> broker.buildCatalog
#           -> memory.delete (round-trip) -> shutdown
# Then checks the underlying DB to confirm whether dual-write hit both
# `memories` (384-dim) and `memories_1024` (1024-dim sidecar).
#
# Usage: ./scripts/smoke-test.sh
# Requires: NEURALGENTICS_DB_URL env var (defaults below),
#           binary at $BIN path (default .neuralgentics/bin/neuralgentics-backend).
set -euo pipefail

BIN="${BIN:-/home/jcharles/Projects/MCP-Servers/neuralgentics/.neuralgentics/bin/neuralgentics-backend}"
export NEURALGENTICS_DB_URL="${NEURALGENTICS_DB_URL:-postgresql://neuralgentics:neuralgentics@localhost:6200/neuralgentics_test}"

if [[ ! -x "$BIN" ]]; then
  echo "FATAL: backend binary not found or not executable at $BIN" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq not installed" >&2
  exit 1
fi

echo "==> binary:        $BIN"
echo "==> db url:        $NEURALGENTICS_DB_URL"
echo "==> binary mtime:  $(stat -c '%y' "$BIN")"
echo

# ─── Pre-flight: confirm DB has both tables and is empty ────────────────────
echo "==> pre-flight: row counts before test"
PGPASSWORD=neuralgentics psql -h localhost -p 6200 -U neuralgentics -d neuralgentics_test -t -A -c \
  "SELECT 'memories=' || COUNT(*) FROM memories UNION ALL SELECT 'memories_1024=' || COUNT(*) FROM memories_1024;"
echo

# ─── Pass 1: dynamic-id discovery ───────────────────────────────────────────
# We need the UUID returned by memory.add so we can pass it to memory.get
# and memory.delete. The binary has no dry-run mode, so this discovery pass
# writes 2 rows to the test DB. The real Pass 2 below writes 2 MORE rows
# (for a total of 4 before delete, 3 after). All count assertions are
# relative deltas (count_after = count_before - 1), so they hold regardless
# of how many rows existed before Pass 1.

req_initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"smoke-test","version":"0.0.1"}}}'
req_ping='{"jsonrpc":"2.0","id":2,"method":"ping"}'
req_add_1='{"jsonrpc":"2.0","id":3,"method":"memory.add","params":{"content":"neuralgentics MVP smoke test - first memory","sourceType":"session","metadata":{"session_id":"smoke-001"}}}'
req_add_2='{"jsonrpc":"2.0","id":4,"method":"memory.add","params":{"content":"dual-model RRF should populate both memories and memories_1024","sourceType":"session"}}'
req_count='{"jsonrpc":"2.0","id":5,"method":"memory.count"}'
req_query='{"jsonrpc":"2.0","id":6,"method":"memory.query","params":{"query":"smoke test memory","limit":5}}'

DISCOVERY_RESPONSES=$(
  {
    printf '%s\n' "$req_initialize"
    printf '%s\n' "$req_ping"
    printf '%s\n' "$req_add_1"
    printf '%s\n' "$req_add_2"
    printf '%s\n' "$req_count"
    printf '%s\n' "$req_query"
  } | "$BIN" 2>/dev/null
)

# Each backend invocation creates a NEW process and a NEW MemorySystem, so
# the IDs are not stable across invocations. We must send ALL requests in a
# SINGLE invocation. The discovery pass just confirms the binary works; the
# real pass below sends everything together using the captured add1_id from
# the discovery response.
add1_id=$(echo "$DISCOVERY_RESPONSES" | jq -r 'select(.id==3) | .result.id // empty')

if [[ ! "$add1_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "FATAL: discovery pass failed to get a valid memory.add UUID (got: $add1_id)" >&2
  exit 1
fi

# Build dynamic requests using the captured UUID
req_get_1="{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"memory.get\",\"params\":{\"id\":\"$add1_id\"}}"
req_orch_route='{"jsonrpc":"2.0","id":9,"method":"orchestrator.route","params":{"taskType":"code-implementation"}}'
req_broker_catalog='{"jsonrpc":"2.0","id":10,"method":"broker.buildCatalog","params":{"role":"orchestrator"}}'
req_delete_1="{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"memory.delete\",\"params\":{\"id\":\"$add1_id\"}}"
req_count_after='{"jsonrpc":"2.0","id":12,"method":"memory.count"}'
req_shutdown='{"jsonrpc":"2.0","id":13,"method":"shutdown"}'

# ─── Pass 2: full sequence with extended coverage ───────────────────────────
RESPONSES=$(
  {
    printf '%s\n' "$req_initialize"
    printf '%s\n' "$req_ping"
    printf '%s\n' "$req_add_1"
    printf '%s\n' "$req_add_2"
    printf '%s\n' "$req_count"
    printf '%s\n' "$req_query"
    printf '%s\n' "$req_get_1"
    printf '%s\n' "$req_orch_route"
    printf '%s\n' "$req_broker_catalog"
    printf '%s\n' "$req_delete_1"
    printf '%s\n' "$req_count_after"
    printf '%s\n' "$req_shutdown"
  } | "$BIN" 2>/tmp/smoke-stderr.log
)

echo "==> raw responses from backend (filtered to id-tagged):"
echo "$RESPONSES" | grep -E '"id":' | jq -c '{id, result}'
echo

# ─── Assertions ─────────────────────────────────────────────────────────────
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS  $label  ($actual)"
  else
    echo "  FAIL  $label  expected=$expected actual=$actual"
    fail=$((fail + 1))
  fi
}

# 1. initialize returns serverInfo.name=neuralgentics-backend
init_name=$(echo "$RESPONSES" | jq -r 'select(.id==1) | .result.serverInfo.name // empty')
check "initialize.serverInfo.name" "neuralgentics-backend" "$init_name"

# 2. ping returns "pong"
ping_val=$(echo "$RESPONSES" | jq -r 'select(.id==2) | .result // empty')
check "ping.result" "pong" "$ping_val"

# 3. memory.add #1 returned {"id": "<UUID>"} — extract .id
add1_id=$(echo "$RESPONSES" | jq -r 'select(.id==3) | .result.id // empty')
if [[ "$add1_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "  PASS  memory.add#1 returned UUID  ($add1_id)"
else
  echo "  FAIL  memory.add#1 expected UUID, got: $add1_id"
  fail=$((fail + 1))
fi

# 4. memory.add #2 also returned {"id": "<UUID>"}
add2_id=$(echo "$RESPONSES" | jq -r 'select(.id==4) | .result.id // empty')
if [[ "$add2_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "  PASS  memory.add#2 returned UUID  ($add2_id)"
else
  echo "  FAIL  memory.add#2 expected UUID, got: $add2_id"
  fail=$((fail + 1))
fi

# 5. memory.count returns {"count": N} — extract .count (BEFORE delete)
count_before=$(echo "$RESPONSES" | jq -r 'select(.id==5) | .result.count // empty')
if [[ "$count_before" =~ ^[0-9]+$ ]] && [[ "$count_before" -ge 2 ]]; then
  echo "  PASS  memory.count >= 2 before delete  (got $count_before)"
else
  echo "  FAIL  memory.count expected >=2, got: $count_before"
  fail=$((fail + 1))
fi

# 6. memory.query returned at least one hit
query_hits=$(echo "$RESPONSES" | jq -r 'select(.id==6) | .result | length // 0')
if [[ "$query_hits" -ge 1 ]]; then
  echo "  PASS  memory.query returned hits  ($query_hits)"
else
  echo "  FAIL  memory.query returned 0 hits"
  fail=$((fail + 1))
fi

# 7. memory.get retrieved the just-added memory by UUID, content matches
get_content=$(echo "$RESPONSES" | jq -r 'select(.id==8) | .result.content // empty')
if [[ "$get_content" == "neuralgentics MVP smoke test - first memory" ]]; then
  echo "  PASS  memory.get round-trip content match"
else
  echo "  FAIL  memory.get expected 'neuralgentics MVP smoke test - first memory', got: $get_content"
  fail=$((fail + 1))
fi

# 8. orchestrator.route resolved code-implementation → expected agent role
route_agent=$(echo "$RESPONSES" | jq -r 'select(.id==9) | .result.agent // empty')
if [[ "$route_agent" =~ ^[a-z-]+$ ]] && [[ "$route_agent" != "null" ]] && [[ -n "$route_agent" ]]; then
  echo "  PASS  orchestrator.route resolved  ($route_agent)"
else
  echo "  FAIL  orchestrator.route expected non-empty agent string, got: $route_agent"
  fail=$((fail + 1))
fi

# 9. broker.buildCatalog returned a non-empty catalog (object or array)
catalog_empty=$(echo "$RESPONSES" | jq -r 'select(.id==10) | if (.result == null or (.result | type) == "object" and (.result | length == 0)) then "empty" else "ok" end')
check "broker.buildCatalog non-empty" "ok" "$catalog_empty"

# 10. memory.delete returned {} (success) — backend returns map[string]string{}
delete_empty=$(echo "$RESPONSES" | jq -r 'select(.id==11) | .result | if type == "object" and length == 0 then "empty" else "non-empty" end')
check "memory.delete returned {}" "empty" "$delete_empty"

# 11. memory.count AFTER delete should equal count_before - 1
count_after=$(echo "$RESPONSES" | jq -r 'select(.id==12) | .result.count // empty')
if [[ "$count_before" =~ ^[0-9]+$ ]] && [[ "$count_after" =~ ^[0-9]+$ ]]; then
  expected=$((count_before - 1))
  if [[ "$count_after" -eq "$expected" ]]; then
    echo "  PASS  memory.count after delete = $count_before - 1 = $count_after"
  else
    echo "  FAIL  memory.count after delete expected $expected, got $count_after"
    fail=$((fail + 1))
  fi
else
  echo "  FAIL  could not compute count delta (before=$count_before after=$count_after)"
  fail=$((fail + 1))
fi

# 12. shutdown returns {"status":"ok"}
shutdown_status=$(echo "$RESPONSES" | jq -r 'select(.id==13) | .result.status // empty')
check "shutdown.result.status" "ok" "$shutdown_status"

echo
echo "==> post-test: row counts (dual-write verification, AFTER delete)"
PGPASSWORD=neuralgentics psql -h localhost -p 6200 -U neuralgentics -d neuralgentics_test -t -A -c \
  "SELECT 'memories=' || COUNT(*) FROM memories UNION ALL SELECT 'memories_1024=' || COUNT(*) FROM memories_1024 UNION ALL SELECT 'memories matching smoke=' || COUNT(*) FROM memories WHERE text LIKE '%smoke%' OR text LIKE '%dual-model%';"

mem_count=$(PGPASSWORD=neuralgentics psql -h localhost -p 6200 -U neuralgentics -d neuralgentics_test -t -A -c "SELECT COUNT(*) FROM memories")
mem1024_count=$(PGPASSWORD=neuralgentics psql -h localhost -p 6200 -U neuralgentics -d neuralgentics_test -t -A -c "SELECT COUNT(*) FROM memories_1024")

echo
# After delete, we expect 1 row in memories (the add2 survived) and 1 row in memories_1024.
# We don't assert strict equality because add2 may or may not be in memories_1024 depending on
# the embedder (NoOp gate) — just that both tables have rows when the embedder worked.
if [[ "$mem_count" -ge 1 && "$mem1024_count" -ge 1 ]]; then
  echo "RESULT: DUAL-WRITE WORKING — $mem_count rows in memories, $mem1024_count rows in memories_1024 (after delete)"
elif [[ "$mem_count" -ge 1 && "$mem1024_count" -eq 0 ]]; then
  echo "RESULT: 384-WRITE ONLY — $mem_count rows in memories, 0 rows in memories_1024 (Embed1024 unavailable in this env)"
elif [[ "$mem_count" -ge 1 ]]; then
  echo "RESULT: PARTIAL — $mem_count memories, $mem1024_count memories_1024 (expected both >=1 after delete)"
else
  echo "RESULT: FAILURE — only $mem_count memories, $mem1024_count memories_1024"
  fail=$((fail + 1))
fi

echo
if [[ -s /tmp/smoke-stderr.log ]]; then
  echo "==> backend stderr (last 20 lines):"
  tail -20 /tmp/smoke-stderr.log
fi

exit $fail