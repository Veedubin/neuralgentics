package memory

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // pgx driver for database/sql
)

// ─── JSON-RPC types (mirrors backend) ────────────────────────────────────────

type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonrpcError   `json:"error,omitempty"`
}

type jsonrpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ─── Backend binary helpers ──────────────────────────────────────────────────

// findBackendBinary resolves the path to the neuralgentics-backend binary.
// It checks:
//  1. NEURALGENTICS_BACKEND_PATH env var (if set)
//  2. Relative path from the test file to ../backend-go/neuralgentics-backend
//  3. Relative path from the test file to ../../../.neuralgentics/bin/neuralgentics-backend
//  4. The binary in $PATH
func findBackendBinary(t *testing.T) string {
	t.Helper()

	// Check env var override
	if p := os.Getenv("NEURALGENTICS_BACKEND_PATH"); p != "" {
		if _, statErr := os.Stat(p); statErr == nil {
			return p
		}
		t.Fatalf("NEURALGENTICS_BACKEND_PATH=%s does not exist", p)
	}

	// Resolve relative to test file location
	// The test file is in packages/memory/src/neuralgentics/memory/
	// The binary is in packages/backend-go/neuralgentics-backend
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not determine test file location")
	}
	testDir := filepath.Dir(thisFile)
	// packages/memory/src/neuralgentics/memory -> packages/memory
	memoryPkgDir := filepath.Join(testDir, "..", "..", "..")
	memoryPkgDir, _ = filepath.Abs(memoryPkgDir)
	// packages/memory -> packages/backend-go/neuralgentics-backend
	binPath := filepath.Join(memoryPkgDir, "..", "backend-go", "neuralgentics-backend")
	binPath, _ = filepath.Abs(binPath)

	if _, err := os.Stat(binPath); err == nil {
		return binPath
	}

	// Try relative path from test file to .neuralgentics/bin/
	// packages/memory/src/neuralgentics/memory -> ../../../../../.neuralgentics/bin/neuralgentics-backend
	localBinPath := filepath.Join(testDir, "..", "..", "..", "..", "..", ".neuralgentics", "bin", "neuralgentics-backend")
	localBinPath, _ = filepath.Abs(localBinPath)

	if _, err := os.Stat(localBinPath); err == nil {
		return localBinPath
	}

	// Try PATH lookup
	if p, err := exec.LookPath("neuralgentics-backend"); err == nil {
		return p
	}

	t.Fatalf("neuralgentics-backend binary not found at %s and not in PATH; set NEURALGENTICS_BACKEND_PATH or build the binary", binPath)
	return ""
}

// ─── Shared DB helpers ────────────────────────────────────────────────────────

const backendTestDBURL = "postgresql://neuralgentics:neuralgentics@localhost:6000/neuralgentics_test?sslmode=disable"

// isSharedDBAvailable checks if the shared test DB is reachable.
func isSharedDBAvailable() bool {
	db, err := sql.Open("pgx", backendTestDBURL)
	if err != nil {
		return false
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return db.PingContext(ctx) == nil
}

// cleanupMemoryByID deletes a memory from both tables by ID (for test cleanup).
// The CASCADE on memories_1024 FK handles the sidecar row automatically.
func cleanupMemoryByID(db *sql.DB, memoryID string) error {
	// Delete from memories_1024 first (explicit, though CASCADE should handle it)
	_, _ = db.Exec("DELETE FROM memories_1024 WHERE memory_id = $1", memoryID)
	_, err := db.Exec("DELETE FROM memories WHERE id = $1", memoryID)
	return err
}

// contentHash computes the same SHA256 hash the backend uses for content dedup.
func contentHash(content string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
}

// ─── Backend subprocess test ─────────────────────────────────────────────────

// TestIntegration_BackendJSONRPC spawns the neuralgentics-backend binary as a
// subprocess and drives it via JSON-RPC 2.0 over stdio, verifying the full
// lifecycle: initialize → ping → memory.add → memory.query → DB verification.
//
// This is the Go-ified, CI-runnable equivalent of tests/smoke-test-mvp.sh.
func TestIntegration_BackendJSONRPC(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	// ── Pre-conditions ───────────────────────────────────────────────────
	binPath := findBackendBinary(t)
	t.Logf("backend binary: %s", binPath)

	if !isSharedDBAvailable() {
		t.Skip("shared test database not available on port 6000; start neuralgentics-test-pg container first")
	}

	// ── Connect to DB for post-test verification ──────────────────────────
	db, err := sql.Open("pgx", backendTestDBURL)
	if err != nil {
		t.Fatalf("failed to connect to test DB: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	// ── Spawn subprocess ──────────────────────────────────────────────────
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath)
	cmd.Env = append(os.Environ(),
		"NEURALGENTICS_DB_URL="+backendTestDBURL,
		"MEMINI_EMBEDDING_ADDR=noop",
		"EMBEDDING_MODE=auto",
	)

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("failed to create stdin pipe: %v", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("failed to create stdout pipe: %v", err)
	}

	// Capture stderr for diagnostics
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start backend binary: %v", err)
	}
	t.Logf("backend process started with PID %d", cmd.Process.Pid)

	// Kill process on cleanup if still running (safety net)
	t.Cleanup(func() {
		if cmd.Process != nil && cmd.ProcessState == nil {
			cmd.Process.Kill()
		}
	})

	// ── Send JSON-RPC requests ──────────────────────────────────────────
	// Content string with unique suffix to avoid collisions
	testContent := "jsonrpc dual-write test"
	testHash := contentHash(testContent)

	requests := []jsonrpcRequest{
		{JSONRPC: "2.0", ID: rawInt(1), Method: "initialize", Params: json.RawMessage(`{}`)},
		{JSONRPC: "2.0", ID: rawInt(2), Method: "ping", Params: json.RawMessage(`{}`)},
		{JSONRPC: "2.0", ID: rawInt(3), Method: "memory.add", Params: json.RawMessage(
			fmt.Sprintf(`{"content":"%s","sourceType":"session"}`, testContent),
		)},
		{JSONRPC: "2.0", ID: rawInt(4), Method: "memory.query", Params: json.RawMessage(
			`{"query":"jsonrpc dual-write test","limit":5}`,
		)},
	}

	// Write all requests then close stdin to signal the binary to finish
	requestsJSON := make([]string, len(requests))
	for i, req := range requests {
		data, _ := json.Marshal(req)
		requestsJSON[i] = string(data)
	}
	allRequests := strings.Join(requestsJSON, "\n") + "\n"

	_, err = io.WriteString(stdinPipe, allRequests)
	if err != nil {
		t.Fatalf("failed to write requests to stdin: %v", err)
	}
	stdinPipe.Close()

	// ── Read responses ───────────────────────────────────────────────────
	scanner := bufio.NewScanner(stdoutPipe)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	type parsedResponse struct {
		ID     int
		Result json.RawMessage
		Error  *jsonrpcError
	}
	var responses []parsedResponse

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var resp jsonrpcResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			t.Logf("warning: could not parse response line: %q", string(line))
			continue
		}

		var id int
		if len(resp.ID) > 0 {
			_ = json.Unmarshal(resp.ID, &id)
		}

		responses = append(responses, parsedResponse{
			ID:     id,
			Result: resp.Result,
			Error:  resp.Error,
		})
	}

	// ── Wait for process to exit ─────────────────────────────────────────
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Logf("backend process exited with error: %v", err)
		} else {
			t.Log("backend process exited cleanly")
		}
	case <-ctx.Done():
		cmd.Process.Kill()
		t.Fatal("backend process did not exit within timeout")
	}

	// Log stderr for diagnostics
	if stderrBuf.Len() > 0 {
		t.Logf("backend stderr:\n%s", stderrBuf.String())
	}

	// ── Verify responses ─────────────────────────────────────────────────
	responseMap := make(map[int]parsedResponse)
	for _, r := range responses {
		responseMap[r.ID] = r
	}

	// 1. Initialize
	initResp, ok := responseMap[1]
	if !ok {
		t.Fatal("no response for initialize (id=1)")
	}
	if initResp.Error != nil {
		t.Fatalf("initialize returned error: code=%d message=%s", initResp.Error.Code, initResp.Error.Message)
	}
	// Check serverInfo.name
	var initResult struct {
		ServerInfo struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
	}
	if err := json.Unmarshal(initResp.Result, &initResult); err != nil {
		t.Fatalf("failed to parse initialize result: %v", err)
	}
	if initResult.ServerInfo.Name != "neuralgentics-backend" {
		t.Fatalf("expected serverInfo.name 'neuralgentics-backend', got %q", initResult.ServerInfo.Name)
	}
	t.Logf("✓ initialize: serverInfo.name=%s version=%s", initResult.ServerInfo.Name, initResult.ServerInfo.Version)

	// 2. Ping
	pingResp, ok := responseMap[2]
	if !ok {
		t.Fatal("no response for ping (id=2)")
	}
	if pingResp.Error != nil {
		t.Fatalf("ping returned error: code=%d message=%s", pingResp.Error.Code, pingResp.Error.Message)
	}
	t.Logf("✓ ping: %s", string(pingResp.Result))

	// 3. memory.add
	addResp, ok := responseMap[3]
	if !ok {
		t.Fatal("no response for memory.add (id=3)")
	}
	if addResp.Error != nil {
		t.Fatalf("memory.add returned error: code=%d message=%s", addResp.Error.Code, addResp.Error.Message)
	}
	var addResult struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(addResp.Result, &addResult); err != nil {
		t.Fatalf("failed to parse memory.add result: %v", err)
	}
	if addResult.ID == "" {
		t.Fatal("memory.add returned empty id")
	}
	memoryID := addResult.ID
	t.Logf("✓ memory.add: id=%s", memoryID)

	// Schedule cleanup of the created memory
	t.Cleanup(func() {
		if err := cleanupMemoryByID(db, memoryID); err != nil {
			t.Logf("warning: failed to cleanup memory %s: %v", memoryID, err)
		}
	})

	// 4. memory.query
	queryResp, ok := responseMap[4]
	if !ok {
		t.Fatal("no response for memory.query (id=4)")
	}
	if queryResp.Error != nil {
		t.Fatalf("memory.query returned error: code=%d message=%s", queryResp.Error.Code, queryResp.Error.Message)
	}
	// Verify query results are a non-empty array
	var queryResults []interface{}
	if err := json.Unmarshal(queryResp.Result, &queryResults); err != nil {
		t.Fatalf("failed to parse memory.query result as array: %v", err)
	}
	if len(queryResults) == 0 {
		t.Fatal("memory.query returned empty results, expected at least one match")
	}
	t.Logf("✓ memory.query: returned %d results", len(queryResults))

	// ── Verify database state (using the returned memory ID) ──────────────
	// Check memories table by ID
	var memContent string
	err = db.QueryRow("SELECT text FROM memories WHERE id = $1", memoryID).Scan(&memContent)
	if err != nil {
		t.Fatalf("failed to query memories table for id %s: %v", memoryID, err)
	}
	if memContent != testContent {
		t.Fatalf("expected content %q in memories, got %q", testContent, memContent)
	}
	t.Logf("✓ memories table: row verified (id=%s, content=%q)", memoryID, memContent)

	// Check that content_hash matches what the backend computed (SHA256 of content)
	var memHash string
	err = db.QueryRow("SELECT content_hash FROM memories WHERE id = $1", memoryID).Scan(&memHash)
	if err != nil {
		t.Fatalf("failed to query content_hash: %v", err)
	}
	if memHash != testHash {
		t.Fatalf("expected content_hash %s, got %s", testHash, memHash)
	}
	t.Logf("✓ content_hash verified: %s", memHash)

	// Check memories_1024 sidecar table — this is the DUAL-WRITE verification
	var sidecarCount int
	err = db.QueryRow("SELECT COUNT(*) FROM memories_1024 WHERE memory_id = $1", memoryID).Scan(&sidecarCount)
	if err != nil {
		t.Fatalf("failed to count memories_1024 for memory_id %s: %v", memoryID, err)
	}
	if sidecarCount < 1 {
		t.Fatalf("expected at least 1 row in memories_1024 for memory_id %s, got %d — DUAL-WRITE DID NOT WORK", memoryID, sidecarCount)
	}
	t.Logf("✓ memories_1024 table: %d row(s) for memory_id %s — DUAL-WRITE VERIFIED", sidecarCount, memoryID)

	// Verify 1024-dim vector dimension
	var vecDim int
	err = db.QueryRow("SELECT array_length(embedding::real[], 1) FROM memories_1024 WHERE memory_id = $1", memoryID).Scan(&vecDim)
	if err != nil {
		t.Fatalf("failed to query 1024-dim vector dimension: %v", err)
	}
	if vecDim != 1024 {
		t.Fatalf("expected 1024-dim vector in memories_1024, got %d-dim", vecDim)
	}
	t.Logf("✓ 1024-dim vector dimension verified: %d", vecDim)

	t.Log("✓ backend JSON-RPC integration test passed: transport, dual-write, queries all verified")
}

// rawInt creates a json.RawMessage from an integer for use as JSON-RPC ID.
func rawInt(n int) json.RawMessage {
	data, _ := json.Marshal(n)
	return data
}
