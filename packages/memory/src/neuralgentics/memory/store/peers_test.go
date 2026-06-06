package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestAddPeer_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.AddPeer(context.Background(), &core.PeerProfile{
		Name:       "test-peer",
		Role:       "guest",
		TrustLevel: 0.5,
	})
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("AddPeer nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetPeer_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetPeer(context.Background(), "peer-123")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetPeer nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestListPeers_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.ListPeers(context.Background(), 10)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("ListPeers nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestShareMemory_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.ShareMemory(context.Background(), "mem-123", "peer-456", "shared", "owner")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("ShareMemory nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestRevokeShareMemory_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.RevokeShareMemory(context.Background(), "mem-123", "peer-456")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("RevokeShareMemory nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetSharedMemories_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetSharedMemories(context.Background(), "peer-123", 10)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetSharedMemories nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetPeerMemories_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetPeerMemories(context.Background(), "peer-123", "", nil)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetPeerMemories nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestUpdatePeerLastActive_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.UpdatePeerLastActive(context.Background(), "peer-123")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("UpdatePeerLastActive nil-pool error = %q, want %q", err.Error(), expected)
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestAddPeer_Success(t *testing.T) {
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

	peerID, err := pgStore.AddPeer(ctx, &core.PeerProfile{
		Name:       fmt.Sprintf("test-peer-%s", time.Now().Format("20060102150405")),
		Role:       "guest",
		TrustLevel: 0.5,
	})
	if err != nil {
		t.Fatalf("AddPeer failed: %v", err)
	}
	if peerID == "" {
		t.Error("expected non-empty peer ID from AddPeer")
	}
	t.Logf("AddPeer returned ID: %s", peerID)
}

func TestListPeers_Success(t *testing.T) {
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

	peers, err := pgStore.ListPeers(ctx, 50)
	if err != nil {
		t.Fatalf("ListPeers failed: %v", err)
	}
	t.Logf("ListPeers returned %d peers", len(peers))
}

func TestShareMemory_Success(t *testing.T) {
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

	// Add a peer first
	peerID, err := pgStore.AddPeer(ctx, &core.PeerProfile{
		Name:       fmt.Sprintf("share-test-peer-%s", time.Now().Format("20060102150405")),
		Role:       "collaborator",
		TrustLevel: 0.7,
	})
	if err != nil {
		t.Fatalf("AddPeer setup failed: %v", err)
	}

	// Add a memory to share
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:    "test memory for sharing",
		SourceType: "test",
	})
	if err != nil {
		t.Fatalf("AddMemory setup failed: %v", err)
	}

	// Share the memory
	shareID, err := pgStore.ShareMemory(ctx, memID, peerID, "shared", "owner")
	if err != nil {
		t.Fatalf("ShareMemory failed: %v", err)
	}
	if shareID == "" {
		t.Error("expected non-empty share ID from ShareMemory")
	}
	t.Logf("ShareMemory returned ID: %s for memory: %s shared with peer: %s", shareID, memID, peerID)
}
