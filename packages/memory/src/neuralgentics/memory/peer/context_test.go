package peer

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── PeerContext Tests ────────────────────────────────────────────────────────

func TestNewPeerContext_DefaultPeer(t *testing.T) {
	store := newMockStore()
	pc := NewPeerContext(store)

	if pc.GetActivePeerID() != DefaultPeerID {
		t.Errorf("active peer ID = %q, want %q", pc.GetActivePeerID(), DefaultPeerID)
	}
	if !pc.IsDefaultPeer() {
		t.Error("expected IsDefaultPeer() = true for new context")
	}
}

func TestGetActivePeer_DefaultProfile(t *testing.T) {
	store := newMockStore()
	pc := NewPeerContext(store)

	peer := pc.GetActivePeer()
	if peer.ID != DefaultPeerID {
		t.Errorf("default peer ID = %q, want %q", peer.ID, DefaultPeerID)
	}
	if peer.Role != "OWNER" {
		t.Errorf("default peer role = %q, want %q", peer.Role, "OWNER")
	}
	if peer.TrustLevel != 1.0 {
		t.Errorf("default peer trustLevel = %f, want 1.0", peer.TrustLevel)
	}
	if !peer.IsActive {
		t.Error("default peer should be active")
	}
}

func TestSwitchPeer_Success(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)
	pc := NewPeerContext(store)

	// Add a peer
	peerID, _ := pm.AddPeer(context.Background(), "test-collab", "COLLABORATOR", 0.7, nil)

	err := pc.SwitchPeer(context.Background(), peerID)
	if err != nil {
		t.Fatalf("SwitchPeer returned error: %v", err)
	}

	if pc.GetActivePeerID() != peerID {
		t.Errorf("active peer ID = %q, want %q", pc.GetActivePeerID(), peerID)
	}
	if pc.IsDefaultPeer() {
		t.Error("expected IsDefaultPeer() = false after switching")
	}

	peer := pc.GetActivePeer()
	if peer.Name != "test-collab" {
		t.Errorf("peer name = %q, want %q", peer.Name, "test-collab")
	}
	if peer.Role != "COLLABORATOR" {
		t.Errorf("peer role = %q, want %q", peer.Role, "COLLABORATOR")
	}
}

func TestSwitchPeer_NotFound(t *testing.T) {
	store := newMockStore()
	pc := NewPeerContext(store)

	err := pc.SwitchPeer(context.Background(), "nonexistent-peer")
	if err == nil {
		t.Fatal("expected error for nonexistent peer, got nil")
	}
}

func TestSwitchPeer_ResetToDefault(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)
	pc := NewPeerContext(store)

	// Switch to a peer
	peerID, _ := pm.AddPeer(context.Background(), "collab", "COLLABORATOR", 0.7, nil)
	pc.SwitchPeer(context.Background(), peerID)

	if pc.IsDefaultPeer() {
		t.Error("expected non-default peer after switch")
	}

	// Reset to default
	err := pc.SwitchPeer(context.Background(), "")
	if err != nil {
		t.Fatalf("SwitchPeer('') returned error: %v", err)
	}
	if !pc.IsDefaultPeer() {
		t.Error("expected default peer after reset")
	}
	if pc.GetActivePeerID() != DefaultPeerID {
		t.Errorf("active peer ID = %q, want %q", pc.GetActivePeerID(), DefaultPeerID)
	}
}

func TestGetVisibleMemories_DefaultPeer(t *testing.T) {
	store := newMockStore()
	pc := NewPeerContext(store)

	// Add some memories
	store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "memory 1", SourceType: "session",
	})
	store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "memory 2", SourceType: "session",
	})

	memories, err := pc.GetVisibleMemories(context.Background(), 10)
	if err != nil {
		t.Fatalf("GetVisibleMemories returned error: %v", err)
	}
	if len(memories) != 2 {
		t.Errorf("expected 2 visible memories for default peer, got %d", len(memories))
	}
}

func TestGetVisibleMemories_NonDefaultPeer(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)
	pc := NewPeerContext(store)

	// Add owner and collaborator
	ownerID, _ := pm.AddPeer(context.Background(), "owner", "OWNER", 1.0, nil)
	collabID, _ := pm.AddPeer(context.Background(), "collab", "COLLABORATOR", 0.7, nil)

	// Add owned memory and shared memory
	_, _ = store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "owned memory", SourceType: "session", PeerID: collabID,
	})
	sharedID, _ := store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "shared memory", SourceType: "session",
	})
	// Extra memory not visible to collab
	store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "other memory", SourceType: "session",
	})

	// Share memory with collaborator
	store.ShareMemory(context.Background(), sharedID, collabID, "SHARED", ownerID)

	// Switch to collaborator context
	err := pc.SwitchPeer(context.Background(), collabID)
	if err != nil {
		t.Fatalf("SwitchPeer returned error: %v", err)
	}

	memories, err := pc.GetVisibleMemories(context.Background(), 10)
	if err != nil {
		t.Fatalf("GetVisibleMemories returned error: %v", err)
	}
	// Should see owned (1) + shared (1) = 2
	if len(memories) != 2 {
		t.Errorf("expected 2 visible memories for collaborator, got %d", len(memories))
	}
}

func TestGetVisibleMemories_DefaultLimit(t *testing.T) {
	store := newMockStore()
	pc := NewPeerContext(store)

	// Call with limit 0 — should default to 100
	memories, err := pc.GetVisibleMemories(context.Background(), 0)
	if err != nil {
		t.Fatalf("GetVisibleMemories with limit 0 returned error: %v", err)
	}
	// No memories, so should be empty
	if len(memories) != 0 {
		t.Errorf("expected 0 memories, got %d", len(memories))
	}
}

func TestIsDefaultPeer(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)
	pc := NewPeerContext(store)

	if !pc.IsDefaultPeer() {
		t.Error("expected IsDefaultPeer() = true initially")
	}

	peerID, _ := pm.AddPeer(context.Background(), "collab", "COLLABORATOR", 0.7, nil)
	pc.SwitchPeer(context.Background(), peerID)

	if pc.IsDefaultPeer() {
		t.Error("expected IsDefaultPeer() = false after switching")
	}

	// Reset
	pc.SwitchPeer(context.Background(), "")
	if !pc.IsDefaultPeer() {
		t.Error("expected IsDefaultPeer() = true after reset")
	}
}

func TestPeerContext_ConcurrentSwitch(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)
	pc := NewPeerContext(store)

	// Add multiple peers
	peer1, _ := pm.AddPeer(context.Background(), "peer-1", "COLLABORATOR", 0.5, nil)
	peer2, _ := pm.AddPeer(context.Background(), "peer-2", "GUEST", 0.1, nil)

	// Switch concurrently (no race detector assertions here, but the test
	// ensures the mutex works without panics)
	done := make(chan bool, 2)
	go func() {
		pc.SwitchPeer(context.Background(), peer1)
		done <- true
	}()
	go func() {
		pc.SwitchPeer(context.Background(), peer2)
		done <- true
	}()

	// Wait for both goroutines
	<-done
	<-done

	// One of the peer IDs should be active
	activeID := pc.GetActivePeerID()
	if activeID != peer1 && activeID != peer2 {
		t.Errorf("active peer ID = %q, want one of %q or %q", activeID, peer1, peer2)
	}
}
