package peer

import (
	"context"
	"fmt"
	"sync"

	"neuralgentics/src/neuralgentics/memory/core"
)

// DefaultPeerID is the peer ID used when no peer context is set.
const DefaultPeerID = "default"

// PeerContext manages the active peer for memory operations.
// It provides thread-safe context switching and filters memory queries
// based on the active peer and shared memory visibility.
//
// The default context (no peer set) uses the "default" peer with OWNER role,
// which can see all memories without filtering.
type PeerContext struct {
	mu         sync.RWMutex
	activePeer string
	store      core.Store
}

// NewPeerContext creates a new PeerContext with the default peer active.
func NewPeerContext(store core.Store) *PeerContext {
	return &PeerContext{
		activePeer: DefaultPeerID,
		store:      store,
	}
}

// SwitchPeer switches the active peer context to the given peer ID.
// Pass an empty string to reset to the default peer.
// Returns an error if the peer ID is provided but not found in the store.
func (pc *PeerContext) SwitchPeer(ctx context.Context, peerID string) error {
	if peerID == "" {
		pc.mu.Lock()
		pc.activePeer = DefaultPeerID
		pc.mu.Unlock()
		return nil
	}

	// Validate the peer exists
	peer, err := pc.store.GetPeer(ctx, peerID)
	if err != nil {
		return fmt.Errorf("peer %s not found: %w", peerID, err)
	}
	if !peer.IsActive {
		return fmt.Errorf("peer %s is not active", peerID)
	}

	pc.mu.Lock()
	pc.activePeer = peerID
	pc.mu.Unlock()

	// Update last active timestamp in the background
	_ = pc.store.UpdatePeerLastActive(ctx, peerID)

	return nil
}

// GetActivePeer returns the currently active peer profile.
// Returns the default OWNER peer if no explicit peer is set.
func (pc *PeerContext) GetActivePeer() *core.PeerProfile {
	pc.mu.RLock()
	activePeer := pc.activePeer
	pc.mu.RUnlock()

	ctx := context.Background()
	peer, err := pc.store.GetPeer(ctx, activePeer)
	if err != nil {
		// Return default peer profile for the built-in default
		if activePeer == DefaultPeerID {
			return &core.PeerProfile{
				ID:         DefaultPeerID,
				Name:       "Default Owner",
				Role:       "OWNER",
				TrustLevel: 1.0,
				IsActive:   true,
			}
		}
		// Return a minimal fallback
		return &core.PeerProfile{
			ID:   activePeer,
			Name: activePeer,
			Role: "GUEST",
		}
	}
	return peer
}

// GetActivePeerID returns the currently active peer ID.
func (pc *PeerContext) GetActivePeerID() string {
	pc.mu.RLock()
	defer pc.mu.RUnlock()
	return pc.activePeer
}

// GetVisibleMemories returns memories visible to the active peer.
// For the default (OWNER) peer, this returns all memories using a standard list.
// For other peers, this returns the union of owned + shared memories.
func (pc *PeerContext) GetVisibleMemories(ctx context.Context, limit int) ([]*core.MemoryEntry, error) {
	if limit <= 0 {
		limit = 100
	}

	pc.mu.RLock()
	activePeer := pc.activePeer
	pc.mu.RUnlock()

	// Default peer can see all memories
	if activePeer == DefaultPeerID {
		return pc.store.ListMemories(ctx, nil, limit)
	}

	// For non-default peers, return shared memories
	// In a full implementation, this would union owned + shared memories,
	// but owned memories are tracked via PeerID on MemoryEntry.
	// The store's GetSharedMemories handles the JOIN query.
	shared, err := pc.store.GetSharedMemories(ctx, activePeer, limit)
	if err != nil {
		return nil, fmt.Errorf("get shared memories for peer %s: %w", activePeer, err)
	}

	// Also get the peer's own memories
	peerMemories, err := pc.store.GetPeerMemories(ctx, activePeer, "", &core.SearchOptions{TopK: limit})
	if err != nil {
		return nil, fmt.Errorf("get peer memories for peer %s: %w", activePeer, err)
	}

	// Deduplicate by ID
	seen := make(map[string]bool)
	var results []*core.MemoryEntry
	for _, m := range shared {
		if !seen[m.ID] {
			seen[m.ID] = true
			results = append(results, m)
		}
	}
	for _, m := range peerMemories {
		if !seen[m.ID] {
			seen[m.ID] = true
			results = append(results, m)
		}
	}

	if len(results) > limit {
		results = results[:limit]
	}

	return results, nil
}

// IsDefaultPeer reports whether the active peer is the default (OWNER) peer.
func (pc *PeerContext) IsDefaultPeer() bool {
	pc.mu.RLock()
	defer pc.mu.RUnlock()
	return pc.activePeer == DefaultPeerID
}
