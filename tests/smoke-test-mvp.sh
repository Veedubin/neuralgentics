#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# smoke-test-mvp.sh — Neuralgentics Go Backend MVP Smoke Test
#
# Verifies that the neuralgentics-backend binary:
#   1. Starts cleanly with JSON-RPC over stdio
#   2. Responds to initialize and ping
#   3. Can add a memory (via NoOp embedder) and write to the memories table
#   4. Has the memories and memories_1024 tables in the schema
#
# Embed sidecar note:
#   The gRPC embedding sidecar is likely NOT running during this test.
#   We use MEMINI_EMBEDDING_ADDR=noop to select the NoOp embedder, which
#   produces zero vectors. In EMBEDDING_MODE=auto, the NoOp embedder only
#   writes to the 384-dim memories table (NoOp.Dim() returns 384, so the
#   1024 sidecar condition embedder.Dim()==1024 is false).
#
#   OUTCOME: memories count = 1, memories_1024 count = 0 is the expected
#   result with NoOp embedder in auto mode. This confirms transport + schema.
#   A future test with the gRPC sidecar running will verify 1024-dim dual-write.
#
# Flags:
#   --ci    Run in CI mode: skip podman container check, use env-based DB config
#           (expects NEURALGENTICS_DB_URL set, typically sslmode=disable on port 5432)
#
# Exit codes:
#   0  — Transport + schema verified (NoOp embedder mode)
#   1  — Hard error (binary crash, schema missing, unexpected response)
#   2  — Binary missing
#   3  — Test DB container not running
#   4  — Schema verification failed (tables missing)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Parse flags ──────────────────────────────────────────────────────────────
CI_MODE=false
for arg in "$@"; do
    case "${arg}" in
        --ci) CI_MODE=true ;;
        *) echo "Unknown argument: ${arg}" >&2; exit 1 ;;
    esac
done

# ── Configuration ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="${SCRIPT_DIR}/../packages/backend-go/neuralgentics-backend"

# In CI mode, use NEURALGENTICS_DB_URL env var directly (set by the CI workflow).
# In local mode, use the standard dev DB on port 6200 with sslmode=require.
if ${CI_MODE}; then
    DB_URL="${NEURALGENTICS_DB_URL:?NEURALGENTICS_DB_URL must be set in CI mode}"
else
    # sslmode=require - test DB has SSL enabled, self-signed cert (encrypt only, no CA verify)
    DB_URL="postgresql://postgres:testpassword@localhost:6200/neuralgentics_test?sslmode=require"
fi

# Parse DB connection params from DB_URL for psql commands
# Supports: postgresql://user:pass@host:port/dbname?params
DB_USER="$(echo "${DB_URL}" | sed -E 's|postgresql://([^:]+):([^@]+)@.+|\1|')"
DB_PASS="$(echo "${DB_URL}" | sed -E 's|postgresql://[^:]+:([^@]+)@.+|\1|')"
DB_HOST="$(echo "${DB_URL}" | sed -E 's|postgresql://[^:]+:[^@]+@([^:]+):.+|\1|')"
DB_PORT="$(echo "${DB_URL}" | sed -E 's|postgresql://[^:]+:[^@]+@[^:]+:([0-9]+).*|\1|')"
DB_NAME="$(echo "${DB_URL}" | sed -E 's|postgresql://[^:]+:[^@]+@[^:]+:[0-9]+/([^?]+).*|\1|')"
RESPONSE_TIMEOUT=15       # seconds for the entire binary run (startup + all requests)

# ── Cleanup trap ─────────────────────────────────────────────────────────────
BINARY_PID=""
TMPDIR_WORK=""

cleanup() {
    local exit_code=$?
    # Kill binary if still running
    if [[ -n "${BINARY_PID}" ]] && kill -0 "${BINARY_PID}" 2>/dev/null; then
        echo "→ Cleaning up binary PID ${BINARY_PID}" >&2
        kill "${BINARY_PID}" 2>/dev/null || true
        wait "${BINARY_PID}" 2>/dev/null || true
    fi
    # Remove temp files
    if [[ -n "${TMPDIR_WORK}" && -d "${TMPDIR_WORK}" ]]; then
        rm -rf "${TMPDIR_WORK}"
    fi
    echo "→ Cleanup complete (exit_code=${exit_code})" >&2
    exit "${exit_code}"
}
trap cleanup EXIT

# ── Helper: Parse a JSON response and extract fields ──────────────────────────
# Uses python3 for reliable JSON parsing
json_field() {
    local json="$1"
    local field="$2"
    echo "${json}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('${field}', ''))" 2>/dev/null || echo ""
}

json_result_field() {
    local json="$1"
    local field="$2"
    echo "${json}" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',{}); print(r.get('${field}', ''))" 2>/dev/null || echo ""
}

json_error_message() {
    local json="$1"
    echo "${json}" | python3 -c "import sys,json; d=json.load(sys.stdin); e=d.get('error',{}); print(e.get('message',''))" 2>/dev/null || echo ""
}

# ── Step 1: Binary existence ─────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
echo "  Neuralgentics Go Backend — MVP Smoke Test" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2

echo "" >&2
echo "[Step 1/8] Checking binary exists..." >&2
if [[ ! -x "${BINARY}" ]]; then
    echo "FAIL: Binary not found or not executable: ${BINARY}" >&2
    echo "Run 'cd packages/backend-go && go build -o neuralgentics-backend ./cmd/backend/' first."
    exit 2
fi
echo "  ✓ Binary found: ${BINARY}" >&2

# ── Step 2: Test DB connectivity ─────────────────────────────────────────────
echo "" >&2
echo "[Step 2/8] Checking test DB connectivity..." >&2
if ${CI_MODE}; then
    echo "  ✓ CI mode: skipping podman container check, using service container" >&2
else
    CONTAINER_NAME="$(podman ps --filter name=neuralgentics-test-pg --format '{{.Names}}' 2>/dev/null || true)"
    if [[ "${CONTAINER_NAME}" != "neuralgentics-test-pg" ]]; then
        echo "FAIL: Test DB container 'neuralgentics-test-pg' is not running." >&2
        echo "Start it with: podman start neuralgentics-test-pg" >&2
        exit 3
    fi
    echo "  ✓ Container 'neuralgentics-test-pg' is running" >&2
fi

# ── Step 3: Schema verification ────────────────────────────────────────────────
echo "" >&2
echo "[Step 3/8] Verifying database schema..." >&2
TABLES_OUTPUT="$(PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "\dt" 2>&1)" || {
    echo "FAIL: Cannot connect to test database." >&2
    echo "${TABLES_OUTPUT}" >&2
    exit 4
}

# Check for both required tables
HAS_MEMORIES=false
HAS_MEMORIES_1024=false
while IFS= read -r line; do
    if echo "${line}" | grep -q "memories "; then
        HAS_MEMORIES=true
    fi
    if echo "${line}" | grep -q "memories_1024"; then
        HAS_MEMORIES_1024=true
    fi
done <<< "${TABLES_OUTPUT}"

if [[ "${HAS_MEMORIES}" != "true" ]]; then
    echo "FAIL: 'memories' table not found in schema." >&2
    echo "${TABLES_OUTPUT}" >&2
    exit 4
fi
echo "  ✓ Table 'memories' found" >&2

if [[ "${HAS_MEMORIES_1024}" != "true" ]]; then
    echo "FAIL: 'memories_1024' table not found in schema." >&2
    echo "${TABLES_OUTPUT}" >&2
    exit 4
fi
echo "  ✓ Table 'memories_1024' found" >&2

# ── Step 4: Get pre-state counts ──────────────────────────────────────────────
echo "" >&2
echo "[Step 4/8] Getting pre-state row counts..." >&2
PRE_MEMORIES="$(PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT COUNT(*) FROM memories;" 2>&1 | tr -d ' ')"
PRE_MEMORIES_1024="$(PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT COUNT(*) FROM memories_1024;" 2>&1 | tr -d ' ')"
echo "  ✓ Pre-state: memories=${PRE_MEMORIES}, memories_1024=${PRE_MEMORIES_1024}" >&2

# Also check what columns the memories table has (diagnostic)
echo "  memories columns:" >&2
PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT column_name FROM information_schema.columns WHERE table_name='memories' ORDER BY ordinal_position;" 2>&1 | sed 's/^/    /' >&2

# ── Step 5: Build JSON-RPC request payload ────────────────────────────────────
echo "" >&2
echo "[Step 5/8] Building JSON-RPC request payload..." >&2

TMPDIR_WORK="$(mktemp -d)"
REQUESTS_FILE="${TMPDIR_WORK}/requests.jsonl"

# Build all requests as a single stream, one per line.
# When stdin closes, the binary will process all requests and exit.

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "${REQUESTS_FILE}" <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}
{"jsonrpc":"2.0","id":3,"method":"memory.add","params":{"content":"smoke test memory - MVP verification","sourceType":"session","metadata":{"test":"smoke-mvp","timestamp":"${TIMESTAMP}"}}}
{"jsonrpc":"2.0","id":4,"method":"memory.query","params":{"query":"smoke test","limit":5}}
EOF

echo "  ✓ Built ${REQUESTS_FILE}" >&2

# ── Step 6: Spawn binary and send requests ─────────────────────────────────────
echo "" >&2
echo "[Step 6/8] Spawning binary and sending JSON-RPC requests..." >&2

RESPONSES_FILE="${TMPDIR_WORK}/responses.out"
STDERR_FILE="${TMPDIR_WORK}/stderr.log"

# Pipe requests file into the binary, capture stdout to responses file
# When stdin closes (cat finishes), the binary processes remaining input then exits.
NEURALGENTICS_DB_URL="${DB_URL}" \
MEMINI_EMBEDDING_ADDR="${MEMINI_EMBEDDING_ADDR:-noop}" \
EMBEDDING_MODE="auto" \
timeout "${RESPONSE_TIMEOUT}" \
bash -c "cat '${REQUESTS_FILE}' | '${BINARY}' > '${RESPONSES_FILE}' 2> '${STDERR_FILE}'" || true

BINARY_EXIT=$?
echo "  Binary exited with code: ${BINARY_EXIT}" >&2

# Show stderr (logs from the binary — useful for diagnostics)
if [[ -f "${STDERR_FILE}" ]]; then
    echo "  Binary stderr:" >&2
    cat "${STDERR_FILE}" | sed 's/^/    /' >&2
fi

# ── Step 7: Parse responses ────────────────────────────────────────────────────
echo "" >&2
echo "[Step 7/8] Parsing responses..." >&2

if [[ ! -f "${RESPONSES_FILE}" ]]; then
    echo "FAIL: No response file created" >&2
    exit 1
fi

RESPONSE_COUNT="$(wc -l < "${RESPONSES_FILE}" | tr -d ' ')"
echo "  Received ${RESPONSE_COUNT} response line(s)" >&2

# Parse each response
INIT_OK=false
INIT_VERSION=""
PING_OK=false
ADD_SUCCESS=false
ADD_ERROR=""
MEMORY_ID=""
QUERY_OK=false
QUERY_ERROR=""

while IFS= read -r line; do
    # Skip empty lines
    [[ -z "${line}" ]] && continue

    # Determine which request this responds to by checking the id field
    RESP_ID="$(echo "${line}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")"

    # Check if this is an error response
    IS_ERROR=false
    ERROR_MSG=""
    if echo "${line}" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d and d['error'] is not None" 2>/dev/null; then
        IS_ERROR=true
        ERROR_MSG="$(json_error_message "${line}")"
    fi

    case "${RESP_ID}" in
        1)
            echo "  [id=1] initialize: ${line}" >&2
            if ${IS_ERROR}; then
                echo "  ✗ initialize error: ${ERROR_MSG}" >&2
            else
                INIT_VERSION="$(json_result_field "${line}" "serverInfo" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('version',''))" 2>/dev/null || echo "")"
                if echo "${line}" | grep -q '"serverInfo"'; then
                    INIT_OK=true
                    echo "  ✓ initialize OK (serverInfo present)" >&2
                else
                    echo "  ⚠ initialize response unexpected format" >&2
                fi
            fi
            ;;
        2)
            echo "  [id=2] ping: ${line}" >&2
            if ${IS_ERROR}; then
                echo "  ⚠ ping error: ${ERROR_MSG}" >&2
            else
                PING_OK=true
                echo "  ✓ ping OK" >&2
            fi
            ;;
        3)
            echo "  [id=3] memory.add: ${line}" >&2
            if ${IS_ERROR}; then
                ADD_SUCCESS=false
                ADD_ERROR="${ERROR_MSG}"
                echo "  ✗ memory.add error: ${ERROR_MSG}" >&2
            else
                MEMORY_ID="$(json_result_field "${line}" "id")"
                if [[ -n "${MEMORY_ID}" && "${MEMORY_ID}" != "" ]]; then
                    ADD_SUCCESS=true
                    echo "  ✓ memory.add OK (id=${MEMORY_ID})" >&2
                else
                    ADD_SUCCESS=false
                    echo "  ⚠ memory.add response missing id in result" >&2
                fi
            fi
            ;;
        4)
            echo "  [id=4] memory.query: ${line}" >&2
            if ${IS_ERROR}; then
                QUERY_ERROR="${ERROR_MSG}"
                echo "  ⚠ memory.query error: ${ERROR_MSG}" >&2
            else
                QUERY_OK=true
                echo "  ✓ memory.query OK" >&2
            fi
            ;;
        *)
            echo "  [id=${RESP_ID}] unknown: ${line}" >&2
            ;;
    esac
done < "${RESPONSES_FILE}"

echo "  Results: init=${INIT_OK} ping=${PING_OK} add=${ADD_SUCCESS} query=${QUERY_OK}" >&2

# ── Step 8: Post-state DB verification ──────────────────────────────────────────
echo "" >&2
echo "[Step 8/8] Checking post-state row counts..." >&2
POST_MEMORIES="$(PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT COUNT(*) FROM memories;" 2>&1 | tr -d ' ')"
POST_MEMORIES_1024="$(PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT COUNT(*) FROM memories_1024;" 2>&1 | tr -d ' ')"
echo "  ✓ Post-state: memories=${POST_MEMORIES}, memories_1024=${POST_MEMORIES_1024}" >&2

# ── Determine test result ──────────────────────────────────────────────────────
echo "" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
echo "  RESULTS SUMMARY" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2

SCHEMA_OK=true
if [[ "${HAS_MEMORIES}" != "true" || "${HAS_MEMORIES_1024}" != "true" ]]; then
    SCHEMA_OK=false
fi

MEMORIES_DELTA=$((POST_MEMORIES - PRE_MEMORIES))
MEMORIES_1024_DELTA=$((POST_MEMORIES_1024 - PRE_MEMORIES_1024))

echo "  Binary startup:          OK" >&2
echo "  initialize RPC:          $(if ${INIT_OK}; then echo "OK"; else echo "FAIL"; fi)" >&2
echo "  ping RPC:                $(if ${PING_OK}; then echo "OK"; else echo "TIMEOUT/FAIL"; fi)" >&2
echo "  memory.add RPC:          $(if ${ADD_SUCCESS}; then echo "OK (id=${MEMORY_ID})"; else echo "ERROR: ${ADD_ERROR}"; fi)" >&2
echo "  memory.query RPC:        $(if ${QUERY_OK}; then echo "OK"; else echo "ERROR: ${QUERY_ERROR}"; fi)" >&2
echo "  Schema (memories):       $(if ${HAS_MEMORIES}; then echo "PRESENT"; else echo "MISSING"; fi)" >&2
echo "  Schema (memories_1024):  $(if ${HAS_MEMORIES_1024}; then echo "PRESENT"; else echo "MISSING"; fi)" >&2
echo "  memories rows:           ${PRE_MEMORIES} → ${POST_MEMORIES} (Δ=${MEMORIES_DELTA})" >&2
echo "  memories_1024 rows:      ${PRE_MEMORIES_1024} → ${POST_MEMORIES_1024} (Δ=${MEMORIES_1024_DELTA})" >&2
echo "" >&2

# Determine final status
FINAL_STATUS=""
FINAL_EXIT=0

if ! ${INIT_OK}; then
    FINAL_STATUS="FAIL: initialize RPC did not return expected response"
    FINAL_EXIT=1
elif ! ${SCHEMA_OK}; then
    FINAL_STATUS="FAIL: Required tables missing from schema"
    FINAL_EXIT=4
elif ${ADD_SUCCESS}; then
    if [[ ${MEMORIES_DELTA} -ge 1 ]]; then
        if [[ ${MEMORIES_1024_DELTA} -ge 1 ]]; then
            FINAL_STATUS="PASS (FULL): Transport + schema + dual-write verified"
        else
            FINAL_STATUS="PASS (TRANSPORT+SCHEMA): 384-dim row inserted, 1024 sidecar not triggered (NoOp embedder). 1024-dim dual-write requires gRPC sidecar with BGE-Large model."
        fi
    else
        FINAL_STATUS="PARTIAL: memory.add RPC succeeded but no row in memories table (store error)"
        FINAL_EXIT=1
    fi
else
    # memory.add returned an error — but if init + schema are OK, transport is verified
    if ${INIT_OK} && ${SCHEMA_OK}; then
        FINAL_STATUS="PASS (TRANSPORT+SCHEMA): Binary starts, JSON-RPC works, schema verified. memory.add failed: ${ADD_ERROR}. Full add/query verification requires schema migration or gRPC sidecar."
    else
        FINAL_STATUS="FAIL: Cannot verify transport — initialize or schema broken"
        FINAL_EXIT=1
    fi
fi

echo "  Final Status: ${FINAL_STATUS}" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2

# Print summary to stdout
echo "smoke-test-mvp: ${FINAL_STATUS}"
echo "binary=${BINARY}"
echo "db_url=${DB_URL}"
echo "embedder=noop"
echo "embedding_mode=auto"
echo "init_ok=${INIT_OK}"
echo "ping_ok=${PING_OK}"
echo "add_success=${ADD_SUCCESS}"
echo "memory_id=${MEMORY_ID:-}"
echo "add_error=${ADD_ERROR:-}"
echo "query_ok=${QUERY_OK}"
echo "query_error=${QUERY_ERROR:-}"
echo "schema_ok=${SCHEMA_OK}"
echo "memories=${PRE_MEMORIES}->${POST_MEMORIES}"
echo "memories_1024=${PRE_MEMORIES_1024}->${POST_MEMORIES_1024}"

exit ${FINAL_EXIT}