package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestGetUserProfile_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetUserProfile(context.Background(), "test-peer-id")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetUserProfile nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestUpsertUserProfile_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.UpsertUserProfile(context.Background(), &core.UserProfile{
		PeerID:             "test-peer-id",
		Preferences:        map[string]any{"key": "value"},
		CommunicationStyle: "concise",
		ExpertiseLevel:     "expert",
		DialecticNotes:     []any{"note1"},
		WarmedUp:           true,
		SessionCount:       5,
	})
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("UpsertUserProfile nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetSecuritySummary_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetSecuritySummary(context.Background(), 24)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetSecuritySummary nil-pool error = %q, want %q", err.Error(), expected)
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestGetUserProfile_NotFound(t *testing.T) {
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

	// GetUserProfile on a non-existent peer should return nil, nil
	profile, err := pgStore.GetUserProfile(ctx, "nonexistent-peer-id-12345")
	if err != nil {
		t.Fatalf("GetUserProfile for nonexistent peer returned error: %v", err)
	}
	if profile != nil {
		t.Errorf("expected nil profile for nonexistent peer, got %+v", profile)
	}
}

func TestUpsertUserProfile_Success(t *testing.T) {
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

	peerID := fmt.Sprintf("test-peer-upsert-%s", time.Now().Format("20060102150405.000000000"))

	// Upsert a new profile
	err := pgStore.UpsertUserProfile(ctx, &core.UserProfile{
		PeerID:             peerID,
		Preferences:        map[string]any{"theme": "dark"},
		CommunicationStyle: "concise",
		ExpertiseLevel:     "expert",
		DialecticNotes:     []any{"note1", "note2"},
		WarmedUp:           true,
		SessionCount:       1,
	})
	if err != nil {
		t.Fatalf("UpsertUserProfile failed: %v", err)
	}

	// Verify the profile was saved by reading it back
	profile, err := pgStore.GetUserProfile(ctx, peerID)
	if err != nil {
		t.Fatalf("GetUserProfile after upsert returned error: %v", err)
	}
	if profile == nil {
		t.Fatal("GetUserProfile after upsert returned nil profile")
	}
	if profile.PeerID != peerID {
		t.Errorf("profile.PeerID = %q, want %q", profile.PeerID, peerID)
	}
	if profile.CommunicationStyle != "concise" {
		t.Errorf("profile.CommunicationStyle = %q, want %q", profile.CommunicationStyle, "concise")
	}
	if profile.ExpertiseLevel != "expert" {
		t.Errorf("profile.ExpertiseLevel = %q, want %q", profile.ExpertiseLevel, "expert")
	}
	if !profile.WarmedUp {
		t.Error("profile.WarmedUp = false, want true")
	}
	if profile.SessionCount != 1 {
		t.Errorf("profile.SessionCount = %d, want 1", profile.SessionCount)
	}
	t.Logf("UpsertUserProfile + GetUserProfile roundtrip OK: peerID=%s", profile.PeerID)
}

func TestGetSecuritySummary_Success(t *testing.T) {
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

	summary, err := pgStore.GetSecuritySummary(ctx, 24)
	if err != nil {
		t.Fatalf("GetSecuritySummary failed: %v", err)
	}
	if summary == nil {
		t.Fatal("GetSecuritySummary returned nil summary")
	}
	// On an empty-ish DB, total events may be 0 but maps should be initialized
	if summary.EventsPerType == nil {
		t.Error("summary.EventsPerType is nil, expected empty map")
	}
	if summary.EventsPerAgent == nil {
		t.Error("summary.EventsPerAgent is nil, expected empty map")
	}
	if summary.SeverityCounts == nil {
		t.Error("summary.SeverityCounts is nil, expected empty map")
	}
	t.Logf("GetSecuritySummary OK: totalEvents=%d, criticalCount=%d", summary.TotalEvents, summary.CriticalCount)
}
