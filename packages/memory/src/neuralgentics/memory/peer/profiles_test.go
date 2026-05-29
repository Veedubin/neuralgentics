package peer

import (
	"context"
	"testing"
)

// ─── PeerManager Tests ────────────────────────────────────────────────────────

func TestAddPeer_ValidRoles(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	roles := []struct {
		role       string
		trustLevel float64
	}{
		{"OWNER", 1.0},
		{"COLLABORATOR", 0.5},
		{"READONLY", 0.3},
		{"GUEST", 0.1},
	}

	for _, tc := range roles {
		id, err := pm.AddPeer(context.Background(), "peer-"+tc.role, tc.role, tc.trustLevel, nil)
		if err != nil {
			t.Errorf("AddPeer(%q) returned error: %v", tc.role, err)
		}
		if id == "" {
			t.Errorf("AddPeer(%q) returned empty ID", tc.role)
		}
	}
}

func TestAddPeer_CaseInsensitiveRole(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	lowerRoles := []string{"owner", "collaborator", "readonly", "guest"}
	for _, role := range lowerRoles {
		_, err := pm.AddPeer(context.Background(), "peer-"+role, role, 0.5, nil)
		if err != nil {
			t.Errorf("AddPeer(%q) returned error for lowercase role: %v", role, err)
		}
	}
}

func TestAddPeer_InvalidRole(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	_, err := pm.AddPeer(context.Background(), "peer-invalid", "ADMIN", 0.5, nil)
	if err == nil {
		t.Fatal("expected error for invalid role, got nil")
	}
}

func TestAddPeer_EmptyName(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	_, err := pm.AddPeer(context.Background(), "", "OWNER", 1.0, nil)
	if err == nil {
		t.Fatal("expected error for empty name, got nil")
	}
}

func TestAddPeer_TrustLevelValidation(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	tests := []struct {
		name       string
		trustLevel float64
		wantErr    bool
	}{
		{"negative", -0.1, true},
		{"zero", 0.0, false},
		{"valid", 0.5, false},
		{"one", 1.0, false},
		{"over_one", 1.5, true},
	}

	for _, tc := range tests {
		_, err := pm.AddPeer(context.Background(), "peer-"+tc.name, "GUEST", tc.trustLevel, nil)
		if (err != nil) != tc.wantErr {
			t.Errorf("AddPeer(trustLevel=%f) error = %v, wantErr %v", tc.trustLevel, err, tc.wantErr)
		}
	}
}

func TestAddPeer_OwnerDefaultTrustLevel(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	// OWNER with trustLevel 0 should get bumped to 1.0
	id, err := pm.AddPeer(context.Background(), "owner-peer", "OWNER", 0, nil)
	if err != nil {
		t.Fatalf("AddPeer returned error: %v", err)
	}

	peer, err := pm.GetPeer(context.Background(), id)
	if err != nil {
		t.Fatalf("GetPeer returned error: %v", err)
	}
	if peer.TrustLevel != 1.0 {
		t.Errorf("OWNER trustLevel = %f, want 1.0", peer.TrustLevel)
	}
}

func TestAddPeer_NilPreferences(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	id, err := pm.AddPeer(context.Background(), "peer-nil-prefs", "GUEST", 0.5, nil)
	if err != nil {
		t.Fatalf("AddPeer returned error with nil preferences: %v", err)
	}
	if id == "" {
		t.Fatal("AddPeer returned empty ID")
	}
}

func TestAddPeer_WithPreferences(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	prefs := map[string]any{"theme": "dark", "language": "en"}
	_, err := pm.AddPeer(context.Background(), "peer-prefs", "COLLABORATOR", 0.7, prefs)
	if err != nil {
		t.Fatalf("AddPeer returned error with preferences: %v", err)
	}
}

func TestGetPeer_ExistingPeer(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	id, _ := pm.AddPeer(context.Background(), "test-peer", "COLLABORATOR", 0.7, nil)
	peer, err := pm.GetPeer(context.Background(), id)
	if err != nil {
		t.Fatalf("GetPeer returned error: %v", err)
	}
	if peer.Name != "test-peer" {
		t.Errorf("Name = %q, want %q", peer.Name, "test-peer")
	}
	if peer.Role != "COLLABORATOR" {
		t.Errorf("Role = %q, want %q", peer.Role, "COLLABORATOR")
	}
	if peer.TrustLevel != 0.7 {
		t.Errorf("TrustLevel = %f, want 0.7", peer.TrustLevel)
	}
}

func TestGetPeer_NotFound(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	_, err := pm.GetPeer(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent peer, got nil")
	}
}

func TestGetPeer_EmptyID(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	_, err := pm.GetPeer(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty peer ID, got nil")
	}
}

func TestListPeers(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	// Add multiple peers
	for i := 0; i < 5; i++ {
		pm.AddPeer(context.Background(), "peer-"+string(rune('A'+i)), "GUEST", 0.3, nil)
	}

	peers, err := pm.ListPeers(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListPeers returned error: %v", err)
	}
	if len(peers) != 5 {
		t.Errorf("ListPeers returned %d peers, want 5", len(peers))
	}
}

func TestListPeers_DefaultLimit(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	// Add a peer so we get results
	pm.AddPeer(context.Background(), "peer-1", "GUEST", 0.3, nil)

	peers, err := pm.ListPeers(context.Background(), 0) // should default to 100
	if err != nil {
		t.Fatalf("ListPeers returned error: %v", err)
	}
	if len(peers) != 1 {
		t.Errorf("ListPeers returned %d peers, want 1", len(peers))
	}
}

func TestUpdatePeerLastActive(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	id, _ := pm.AddPeer(context.Background(), "active-peer", "OWNER", 1.0, nil)

	err := pm.UpdatePeerLastActive(context.Background(), id)
	if err != nil {
		t.Fatalf("UpdatePeerLastActive returned error: %v", err)
	}

	peer, _ := pm.GetPeer(context.Background(), id)
	if peer.LastActiveAt == nil {
		t.Error("expected LastActiveAt to be set, got nil")
	}
}

func TestUpdatePeerLastActive_EmptyID(t *testing.T) {
	store := newMockStore()
	pm := NewPeerManager(store)

	err := pm.UpdatePeerLastActive(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty peer ID, got nil")
	}
}
