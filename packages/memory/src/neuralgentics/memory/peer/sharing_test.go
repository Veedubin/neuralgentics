package peer

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── SharingManager Tests ─────────────────────────────────────────────────────

func TestShareMemory_ValidPermissions(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)
	pm := NewPeerManager(store)

	// Create memory and peer
	memID, _ := store.AddMemory(context.Background(), &core.MemoryEntry{
		Content:    "test memory",
		SourceType: "session",
	})
	peerID, _ := pm.AddPeer(context.Background(), "collaborator", "COLLABORATOR", 0.5, nil)
	ownerID, _ := pm.AddPeer(context.Background(), "owner", "OWNER", 1.0, nil)

	perms := []string{"SHARED", "INHERITED"}
	for _, perm := range perms {
		shareID, err := sm.ShareMemory(context.Background(), memID, peerID, perm, ownerID)
		if err != nil {
			t.Errorf("ShareMemory(%q) returned error: %v", perm, err)
		}
		if shareID == "" {
			t.Errorf("ShareMemory(%q) returned empty share ID", perm)
		}
	}
}

func TestShareMemory_CaseInsensitivePermission(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)
	pm := NewPeerManager(store)

	memID, _ := store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "test memory", SourceType: "session",
	})
	peerID, _ := pm.AddPeer(context.Background(), "peer-1", "GUEST", 0.1, nil)
	ownerID, _ := pm.AddPeer(context.Background(), "owner", "OWNER", 1.0, nil)

	lowerPerms := []string{"shared", "inherited"}
	for _, perm := range lowerPerms {
		_, err := sm.ShareMemory(context.Background(), memID, peerID, perm, ownerID)
		if err != nil {
			t.Errorf("ShareMemory(%q) returned error for lowercase permission: %v", perm, err)
		}
	}
}

func TestShareMemory_InvalidPermission(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)
	pm := NewPeerManager(store)

	memID, _ := store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "test memory", SourceType: "session",
	})
	peerID, _ := pm.AddPeer(context.Background(), "peer-1", "GUEST", 0.1, nil)
	ownerID, _ := pm.AddPeer(context.Background(), "owner", "OWNER", 1.0, nil)

	_, err := sm.ShareMemory(context.Background(), memID, peerID, "READ", ownerID)
	if err == nil {
		t.Fatal("expected error for invalid permission, got nil")
	}
}

func TestShareMemory_EmptyMemoryID(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)

	_, err := sm.ShareMemory(context.Background(), "", "peer-1", "SHARED", "owner-1")
	if err == nil {
		t.Fatal("expected error for empty memory ID, got nil")
	}
}

func TestShareMemory_EmptyPeerID(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)

	_, err := sm.ShareMemory(context.Background(), "mem-1", "", "SHARED", "owner-1")
	if err == nil {
		t.Fatal("expected error for empty peer ID, got nil")
	}
}

func TestShareMemory_EmptyGrantedBy(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)

	_, err := sm.ShareMemory(context.Background(), "mem-1", "peer-1", "SHARED", "")
	if err == nil {
		t.Fatal("expected error for empty grantedBy, got nil")
	}
}

func TestShareMemory_MemoryNotFound(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)
	pm := NewPeerManager(store)

	peerID, _ := pm.AddPeer(context.Background(), "peer-1", "GUEST", 0.1, nil)
	ownerID, _ := pm.AddPeer(context.Background(), "owner", "OWNER", 1.0, nil)

	_, err := sm.ShareMemory(context.Background(), "nonexistent-mem", peerID, "SHARED", ownerID)
	if err == nil {
		t.Fatal("expected error for nonexistent memory, got nil")
	}
}

func TestShareMemory_PeerNotFound(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)
	pm := NewPeerManager(store)

	memID, _ := store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "test memory", SourceType: "session",
	})
	ownerID, _ := pm.AddPeer(context.Background(), "owner", "OWNER", 1.0, nil)

	_, err := sm.ShareMemory(context.Background(), memID, "nonexistent-peer", "SHARED", ownerID)
	if err == nil {
		t.Fatal("expected error for nonexistent peer, got nil")
	}
}

func TestRevokeShareMemory(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)
	pm := NewPeerManager(store)

	memID, _ := store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "test memory", SourceType: "session",
	})
	peerID, _ := pm.AddPeer(context.Background(), "collab-1", "COLLABORATOR", 0.7, nil)
	ownerID, _ := pm.AddPeer(context.Background(), "owner", "OWNER", 1.0, nil)

	// Share first
	_, err := sm.ShareMemory(context.Background(), memID, peerID, "SHARED", ownerID)
	if err != nil {
		t.Fatalf("ShareMemory returned error: %v", err)
	}

	// Then revoke
	err = sm.RevokeShareMemory(context.Background(), memID, peerID)
	if err != nil {
		t.Fatalf("RevokeShareMemory returned error: %v", err)
	}

	// Verify shared memories are empty
	shared, err := sm.GetSharedMemories(context.Background(), peerID, 10)
	if err != nil {
		t.Fatalf("GetSharedMemories returned error: %v", err)
	}
	if len(shared) != 0 {
		t.Errorf("expected 0 shared memories after revoke, got %d", len(shared))
	}
}

func TestRevokeShareMemory_EmptyIDs(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)

	err := sm.RevokeShareMemory(context.Background(), "", "peer-1")
	if err == nil {
		t.Fatal("expected error for empty memory ID, got nil")
	}

	err = sm.RevokeShareMemory(context.Background(), "mem-1", "")
	if err == nil {
		t.Fatal("expected error for empty peer ID, got nil")
	}
}

func TestGetSharedMemories(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)
	pm := NewPeerManager(store)

	mem1ID, _ := store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "memory 1", SourceType: "session",
	})
	mem2ID, _ := store.AddMemory(context.Background(), &core.MemoryEntry{
		Content: "memory 2", SourceType: "session",
	})
	peerID, _ := pm.AddPeer(context.Background(), "collab-1", "COLLABORATOR", 0.7, nil)
	ownerID, _ := pm.AddPeer(context.Background(), "owner", "OWNER", 1.0, nil)

	// Share both memories
	sm.ShareMemory(context.Background(), mem1ID, peerID, "SHARED", ownerID)
	sm.ShareMemory(context.Background(), mem2ID, peerID, "INHERITED", ownerID)

	shared, err := sm.GetSharedMemories(context.Background(), peerID, 10)
	if err != nil {
		t.Fatalf("GetSharedMemories returned error: %v", err)
	}
	if len(shared) != 2 {
		t.Errorf("expected 2 shared memories, got %d", len(shared))
	}
}

func TestGetSharedMemories_EmptyPeerID(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)

	_, err := sm.GetSharedMemories(context.Background(), "", 10)
	if err == nil {
		t.Fatal("expected error for empty peer ID, got nil")
	}
}

func TestGetSharedMemories_DefaultLimit(t *testing.T) {
	store := newMockStore()
	sm := NewSharingManager(store)
	pm := NewPeerManager(store)

	peerID, _ := pm.AddPeer(context.Background(), "peer-1", "GUEST", 0.1, nil)

	// Call with limit 0 — should default to 100
	shared, err := sm.GetSharedMemories(context.Background(), peerID, 0)
	if err != nil {
		t.Fatalf("GetSharedMemories with limit 0 returned error: %v", err)
	}
	// No shares, so should be empty
	if len(shared) != 0 {
		t.Errorf("expected 0 shared memories, got %d", len(shared))
	}
}
