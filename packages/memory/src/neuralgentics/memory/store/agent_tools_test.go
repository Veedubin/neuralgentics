package store

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestRecordToolRequest_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.RecordToolRequest(context.Background(), "peer-1", "memini-ai", "memory.query")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("RecordToolRequest nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestIncrementToolUse_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	bypass, err := s.IncrementToolUse(context.Background(), "peer-1", "memini-ai", "memory.query")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("IncrementToolUse nil-pool error = %q, want %q", err.Error(), expected)
	}
	if bypass {
		t.Error("IncrementToolUse should return false bypass with nil pool")
	}
}

func TestGetAgentTools_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetAgentTools(context.Background(), "peer-1")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetAgentTools nil-pool error = %q, want %q", err.Error(), expected)
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestRecordAndRetrieveToolRequest_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	// Record a tool request
	err := pgStore.RecordToolRequest(ctx, "peer-test-at", "memini-ai", "memory.add")
	if err != nil {
		t.Fatalf("RecordToolRequest failed: %v", err)
	}

	// Verify it appears in GetAgentTools
	tools, err := pgStore.GetAgentTools(ctx, "peer-test-at")
	if err != nil {
		t.Fatalf("GetAgentTools failed: %v", err)
	}
	if len(tools) == 0 {
		t.Fatal("GetAgentTools returned 0 tools, expected at least 1")
	}

	found := false
	for _, tool := range tools {
		if tool.ToolServer == "memini-ai" && tool.ToolName == "memory.add" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected to find memini-ai/memory.add in agent tools")
	}
}

func TestIncrementToolUse_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	// First record the tool so it exists
	err := pgStore.RecordToolRequest(ctx, "peer-incr-test", "broker", "tool.run")
	if err != nil {
		t.Fatalf("RecordToolRequest failed: %v", err)
	}

	// Increment once — should not yet bypass
	bypass, err := pgStore.IncrementToolUse(ctx, "peer-incr-test", "broker", "tool.run")
	if err != nil {
		t.Fatalf("IncrementToolUse (1st) failed: %v", err)
	}
	if bypass {
		t.Error("IncrementToolUse should return bypass=false after 1st increment (bypass at 5)")
	}

	// Verify use count updated in GetAgentTools
	tools, err := pgStore.GetAgentTools(ctx, "peer-incr-test")
	if err != nil {
		t.Fatalf("GetAgentTools failed: %v", err)
	}
	found := false
	for _, tool := range tools {
		if tool.ToolServer == "broker" && tool.ToolName == "tool.run" {
			found = true
			if tool.UseCount < 1 {
				t.Errorf("expected UseCount >= 1, got %d", tool.UseCount)
			}
		}
	}
	if !found {
		t.Error("expected to find broker/tool.run in agent tools after IncrementToolUse")
	}
}
