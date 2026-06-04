package memory

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// TestIntegration_AddPeer tests creating a peer profile and verifying
// it persists correctly in the database.
func TestIntegration_AddPeer(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	defer pgStore.Close(ctx)

	// Add multiple peers with different roles
	peers := []core.PeerProfile{
		{
			Name:       "owner-agent",
			Role:       "OWNER",
			TrustLevel: 1.0,
			IsActive:   true,
		},
		{
			Name:       "collaborator-user",
			Role:       "COLLABORATOR",
			TrustLevel: 0.8,
			IsActive:   true,
		},
		{
			Name:       "readonly-guest",
			Role:       "GUEST",
			TrustLevel: 0.3,
			IsActive:   true,
		},
	}

	peerIDs := make([]string, len(peers))
	for i, p := range peers {
		id, err := pgStore.AddPeer(ctx, &p)
		if err != nil {
			t.Fatalf("failed to add peer %d (%s): %v", i, p.Name, err)
		}
		if id == "" {
			t.Fatalf("expected non-empty peer ID for peer %d", i)
		}
		peerIDs[i] = id
		t.Logf("created peer %s with ID: %s", p.Name, id)
	}

	// Verify each peer by retrieving
	for i, p := range peers {
		retrieved, err := pgStore.GetPeer(ctx, peerIDs[i])
		if err != nil {
			t.Fatalf("failed to get peer %d: %v", i, err)
		}
		if retrieved.Name != p.Name {
			t.Fatalf("peer %d name mismatch: expected %s, got %s", i, p.Name, retrieved.Name)
		}
		if retrieved.Role != p.Role {
			t.Fatalf("peer %d role mismatch: expected %s, got %s", i, p.Role, retrieved.Role)
		}
		if retrieved.TrustLevel != p.TrustLevel {
			t.Fatalf("peer %d trust_level mismatch: expected %f, got %f", i, p.TrustLevel, retrieved.TrustLevel)
		}
		if !retrieved.IsActive {
			t.Fatalf("peer %d expected isActive=true", i)
		}
	}

	// List all peers
	allPeers, err := pgStore.ListPeers(ctx, 10)
	if err != nil {
		t.Fatalf("failed to list peers: %v", err)
	}
	if len(allPeers) != 3 {
		t.Fatalf("expected 3 peers, got %d", len(allPeers))
	}
}

// TestIntegration_ShareMemory tests sharing a memory with a peer and
// verifying it appears in the shared memory list.
func TestIntegration_ShareMemory(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	defer pgStore.Close(ctx)

	// Create owner and recipient peers
	ownerID, err := pgStore.AddPeer(ctx, &core.PeerProfile{
		Name: "owner", Role: "OWNER", TrustLevel: 1.0, IsActive: true,
	})
	if err != nil {
		t.Fatalf("failed to add owner peer: %v", err)
	}

	recipientID, err := pgStore.AddPeer(ctx, &core.PeerProfile{
		Name: "recipient", Role: "COLLABORATOR", TrustLevel: 0.8, IsActive: true,
	})
	if err != nil {
		t.Fatalf("failed to add recipient peer: %v", err)
	}

	// Add a memory
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "shared memory content",
		SourceType:  "session",
		ContentHash: "shared-mem-1",
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}

	// Share the memory with recipient
	shareID, err := pgStore.ShareMemory(ctx, memID, recipientID, "SHARED", ownerID)
	if err != nil {
		t.Fatalf("failed to share memory: %v", err)
	}
	if shareID == "" {
		t.Fatal("expected non-empty share ID")
	}

	// Verify recipient can see shared memories
	shared, err := pgStore.GetSharedMemories(ctx, recipientID, 10)
	if err != nil {
		t.Fatalf("failed to get shared memories: %v", err)
	}
	if len(shared) == 0 {
		t.Fatal("expected at least 1 shared memory")
	}
	if shared[0].Content != "shared memory content" {
		t.Fatalf("expected content 'shared memory content', got: %s", shared[0].Content)
	}
}

// TestIntegration_RevokeShareMemory tests revoking a memory share and
// verifying the peer can no longer see it.
func TestIntegration_RevokeShareMemory(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	defer pgStore.Close(ctx)

	// Create peers
	ownerID, err := pgStore.AddPeer(ctx, &core.PeerProfile{
		Name: "owner2", Role: "OWNER", TrustLevel: 1.0, IsActive: true,
	})
	if err != nil {
		t.Fatalf("failed to add owner: %v", err)
	}

	recipientID, err := pgStore.AddPeer(ctx, &core.PeerProfile{
		Name: "recipient2", Role: "COLLABORATOR", TrustLevel: 0.8, IsActive: true,
	})
	if err != nil {
		t.Fatalf("failed to add recipient: %v", err)
	}

	// Add memory and share it
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "memory to be shared and revoked",
		SourceType:  "session",
		ContentHash: "revoke-test",
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}

	_, err = pgStore.ShareMemory(ctx, memID, recipientID, "SHARED", ownerID)
	if err != nil {
		t.Fatalf("failed to share memory: %v", err)
	}

	// Verify shared
	shared, err := pgStore.GetSharedMemories(ctx, recipientID, 10)
	if err != nil {
		t.Fatalf("failed to get shared memories: %v", err)
	}
	if len(shared) != 1 {
		t.Fatalf("expected 1 shared memory before revoke, got %d", len(shared))
	}

	// Revoke
	err = pgStore.RevokeShareMemory(ctx, memID, recipientID)
	if err != nil {
		t.Fatalf("failed to revoke share: %v", err)
	}

	// Verify no longer shared
	shared, err = pgStore.GetSharedMemories(ctx, recipientID, 10)
	if err != nil {
		t.Fatalf("failed to get shared memories after revoke: %v", err)
	}
	if len(shared) != 0 {
		t.Fatalf("expected 0 shared memories after revoke, got %d", len(shared))
	}
}
