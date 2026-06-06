package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestLogAuditEvent_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.LogAuditEvent(context.Background(), &core.AuditEvent{
		EventType:   "auth_failure",
		Severity:    "warning",
		Description: "test audit event",
	})
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("LogAuditEvent nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetAuditEvents_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetAuditEvents(context.Background(), "", "", 10)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetAuditEvents nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestLogTrustAdjustment_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.LogTrustAdjustment(context.Background(), &core.TrustAdjustment{
		MemoryID:         "mem-123",
		OldScore:         0.5,
		NewScore:         0.55,
		Signal:           "agent_used",
		AdjustmentAmount: 0.05,
	})
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("LogTrustAdjustment nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetTrustAdjustments_NoPool(t *testing.T) {
	// GetTrustAdjustments is a stub that returns "not implemented",
	// so nil pool is not exercised. Test the stub behavior directly.
	s := NewPostgresStore(nil)
	_, err := s.GetTrustAdjustments(context.Background(), "mem-123", 10)
	if err == nil {
		t.Fatal("expected error from GetTrustAdjustments stub, got nil")
	}
	expected := "not implemented: GetTrustAdjustments"
	if err.Error() != expected {
		t.Errorf("GetTrustAdjustments stub error = %q, want %q", err.Error(), expected)
	}
}

func TestUpdateDecayRate_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.UpdateDecayRate(context.Background(), "mem-123", 1.5)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("UpdateDecayRate nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestListFadingMemories_NoPool(t *testing.T) {
	// ListFadingMemories is a stub; test its stub behavior directly.
	s := NewPostgresStore(nil)
	_, err := s.ListFadingMemories(context.Background(), 0.3, 20)
	if err == nil {
		t.Fatal("expected error from ListFadingMemories stub, got nil")
	}
	expected := "not implemented: ListFadingMemories"
	if err.Error() != expected {
		t.Errorf("ListFadingMemories stub error = %q, want %q", err.Error(), expected)
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestLogAuditEvent_Success(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	eventID, err := pgStore.LogAuditEvent(ctx, &core.AuditEvent{
		EventType:   "tool_invocation",
		Severity:    "info",
		AgentName:   "test-agent",
		ToolName:    "query_memories",
		Description: "integration test audit event",
	})
	if err != nil {
		t.Fatalf("LogAuditEvent failed: %v", err)
	}
	if eventID == "" {
		t.Error("expected non-empty event ID from LogAuditEvent")
	}
	t.Logf("LogAuditEvent returned ID: %s", eventID)
}

func TestGetAuditEvents_Success(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	// Log an event first so there's at least one row
	_, err := pgStore.LogAuditEvent(ctx, &core.AuditEvent{
		EventType:   fmt.Sprintf("test_event_%s", time.Now().Format("20060102150405")),
		Severity:    "info",
		AgentName:   "test-agent-audit",
		Description: "audit event for GetAuditEvents test",
	})
	if err != nil {
		t.Fatalf("LogAuditEvent setup failed: %v", err)
	}

	// Now retrieve it
	events, err := pgStore.GetAuditEvents(ctx, "", "", 50)
	if err != nil {
		t.Fatalf("GetAuditEvents failed: %v", err)
	}
	if len(events) == 0 {
		t.Error("GetAuditEvents returned 0 events, expected at least 1")
	}
	t.Logf("GetAuditEvents returned %d events", len(events))
}

func TestLogTrustAdjustment_Success(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	// Add a memory first to get a valid ID
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:    "trust adjustment test memory",
		SourceType: "test",
	})
	if err != nil {
		t.Fatalf("AddMemory setup failed: %v", err)
	}

	adjID, err := pgStore.LogTrustAdjustment(ctx, &core.TrustAdjustment{
		MemoryID:         memID,
		OldScore:         0.5,
		NewScore:         0.55,
		Signal:           "agent_used",
		AdjustmentAmount: 0.05,
		Reason:           "integration test",
	})
	if err != nil {
		t.Fatalf("LogTrustAdjustment failed: %v", err)
	}
	if adjID == "" {
		t.Error("expected non-empty adjustment ID from LogTrustAdjustment")
	}
	t.Logf("LogTrustAdjustment returned ID: %s for memory: %s", adjID, memID)
}
