package peer

import (
	"context"
	"fmt"
	"strings"

	"neuralgentics/src/neuralgentics/memory/core"
)

// Valid permissions for memory sharing.
var validPermissions = map[string]bool{
	"SHARED":    true,
	"INHERITED": true,
}

// SharingManager handles memory sharing operations between peers.
// It validates permissions and delegates storage to core.Store.
type SharingManager struct {
	store core.Store
}

// NewSharingManager creates a new SharingManager backed by the given store.
func NewSharingManager(store core.Store) *SharingManager {
	return &SharingManager{store: store}
}

// ShareMemory shares a memory with a peer using the given permission level.
// It validates that the permission is one of SHARED or INHERITED.
// Returns the share ID.
func (sm *SharingManager) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	if memoryID == "" {
		return "", fmt.Errorf("memory ID is required")
	}
	if peerID == "" {
		return "", fmt.Errorf("peer ID is required")
	}
	permission = strings.ToUpper(permission)
	if !validPermissions[permission] {
		return "", fmt.Errorf("invalid permission %q: must be one of SHARED, INHERITED", permission)
	}
	if grantedBy == "" {
		return "", fmt.Errorf("grantedBy peer ID is required")
	}

	// Verify the memory exists
	if _, err := sm.store.GetMemory(ctx, memoryID, false); err != nil {
		return "", fmt.Errorf("memory %s not found: %w", memoryID, err)
	}

	// Verify the peer exists
	if _, err := sm.store.GetPeer(ctx, peerID); err != nil {
		return "", fmt.Errorf("peer %s not found: %w", peerID, err)
	}

	// Verify the granting peer exists
	if _, err := sm.store.GetPeer(ctx, grantedBy); err != nil {
		return "", fmt.Errorf("granting peer %s not found: %w", grantedBy, err)
	}

	return sm.store.ShareMemory(ctx, memoryID, peerID, permission, grantedBy)
}

// RevokeShareMemory revokes a memory share from a peer.
// The memory will no longer be visible to the peer through shared memories.
func (sm *SharingManager) RevokeShareMemory(ctx context.Context, memoryID, peerID string) error {
	if memoryID == "" {
		return fmt.Errorf("memory ID is required")
	}
	if peerID == "" {
		return fmt.Errorf("peer ID is required")
	}
	return sm.store.RevokeShareMemory(ctx, memoryID, peerID)
}

// GetSharedMemories returns memories shared with a peer.
// If limit <= 0, it defaults to 100.
func (sm *SharingManager) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	if peerID == "" {
		return nil, fmt.Errorf("peer ID is required")
	}
	if limit <= 0 {
		limit = 100
	}
	return sm.store.GetSharedMemories(ctx, peerID, limit)
}
