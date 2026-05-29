// Package peer provides multi-peer support for the memory system.
// It handles peer profile management, memory sharing, and peer context switching.
package peer

import (
	"context"
	"fmt"
	"strings"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// Valid roles for peer profiles.
var validRoles = map[string]bool{
	"OWNER":        true,
	"COLLABORATOR": true,
	"READONLY":     true,
	"GUEST":        true,
}

// PeerManager handles CRUD operations for peer profiles.
// It validates role strings and delegates storage to core.Store.
type PeerManager struct {
	store core.Store
}

// NewPeerManager creates a new PeerManager backed by the given store.
func NewPeerManager(store core.Store) *PeerManager {
	return &PeerManager{store: store}
}

// AddPeer creates a new peer profile with the given name, role, and optional trust level.
// It validates the role and normalizes defaults before delegating to the store.
// Returns the newly created peer ID.
func (pm *PeerManager) AddPeer(ctx context.Context, name, role string, trustLevel float64, preferences map[string]any) (string, error) {
	if name == "" {
		return "", fmt.Errorf("peer name is required")
	}
	role = strings.ToUpper(role)
	if !validRoles[role] {
		return "", fmt.Errorf("invalid role %q: must be one of OWNER, COLLABORATOR, READONLY, GUEST", role)
	}
	if trustLevel < 0 || trustLevel > 1 {
		return "", fmt.Errorf("trust level %f must be between 0.0 and 1.0", trustLevel)
	}
	if trustLevel == 0 && role == "OWNER" {
		trustLevel = 1.0
	}
	if preferences == nil {
		preferences = map[string]any{}
	}

	peer := &core.PeerProfile{
		Name:        name,
		Role:        role,
		TrustLevel:  trustLevel,
		Preferences: preferences,
		IsActive:    true,
		CreatedAt:   time.Now(),
	}

	return pm.store.AddPeer(ctx, peer)
}

// GetPeer retrieves a peer profile by ID.
func (pm *PeerManager) GetPeer(ctx context.Context, id string) (*core.PeerProfile, error) {
	if id == "" {
		return nil, fmt.Errorf("peer ID is required")
	}
	return pm.store.GetPeer(ctx, id)
}

// ListPeers returns a list of peer profiles up to the given limit.
// If limit <= 0, it defaults to 100.
func (pm *PeerManager) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	if limit <= 0 {
		limit = 100
	}
	return pm.store.ListPeers(ctx, limit)
}

// UpdatePeerLastActive updates the last_active_at timestamp for a peer.
func (pm *PeerManager) UpdatePeerLastActive(ctx context.Context, id string) error {
	if id == "" {
		return fmt.Errorf("peer ID is required")
	}
	return pm.store.UpdatePeerLastActive(ctx, id)
}
