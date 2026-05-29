package thought

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// MemoryBridge handles dual storage of thoughts into the memories table.
// Every thought is stored in BOTH the thoughts table AND the memories table
// with sourceType="thought". This enables:
//   - Semantic search across thoughts via QueryMemories
//   - Trust scoring on thoughts
//   - Knowledge graph extraction from thoughts
type MemoryBridge struct {
	store core.Store
}

// NewMemoryBridge creates a new MemoryBridge with the given store.
func NewMemoryBridge(store core.Store) *MemoryBridge {
	return &MemoryBridge{store: store}
}

// BridgeThought stores a thought in the memories table and returns the
// generated memory ID. If the thought already has a MemoryID, it returns
// the existing one without duplicating.
func (mb *MemoryBridge) BridgeThought(ctx context.Context, thought *core.Thought) (string, error) {
	if thought == nil {
		return "", fmt.Errorf("thought cannot be nil")
	}
	if thought.ID == "" {
		return "", fmt.Errorf("thought must have an ID before bridging")
	}

	// If already bridged, return existing memory ID
	if thought.MemoryID != "" {
		return thought.MemoryID, nil
	}

	// Build a deterministic content hash from the thought text
	hash := thoughtContentHash(thought.Text, thought.ChainID, thought.ThoughtNumber)

	// Build metadata with chain context
	metadata := map[string]any{
		"chain_id":       thought.ChainID,
		"thought_number": thought.ThoughtNumber,
		"total_thoughts": thought.TotalThoughts,
		"is_revision":    thought.IsRevision,
	}

	if thought.RevisesThoughtID != "" {
		metadata["revises_thought_id"] = thought.RevisesThoughtID
	}
	if thought.BranchFromThoughtID != "" {
		metadata["branch_from_thought_id"] = thought.BranchFromThoughtID
	}
	if thought.BranchID != "" {
		metadata["branch_id"] = thought.BranchID
	}

	entry := &core.MemoryEntry{
		Content:     thought.Text,
		SourceType:  "thought",
		ContentHash: hash,
		TrustScore:  0.5, // default starting trust
		Vector:      thought.Vector,
		Metadata:    metadata,
		ChangeRatio: 1.0,
		CreatedAtMs: time.Now().UnixMilli(),
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}

	// Check if a memory with this content hash already exists (deduplication)
	exists, err := mb.store.ContentExists(ctx, hash)
	if err != nil {
		return "", fmt.Errorf("check content exists: %w", err)
	}
	if exists {
		// Find the existing memory ID by content hash
		// Use text search to find it
		results, err := mb.store.SearchMemoriesText(ctx, thought.Text, &core.SearchOptions{TopK: 1})
		if err != nil {
			return "", fmt.Errorf("search for existing thought memory: %w", err)
		}
		for _, m := range results {
			if m.ContentHash == hash && m.SourceType == "thought" {
				return m.ID, nil
			}
		}
	}

	memoryID, err := mb.store.AddMemory(ctx, entry)
	if err != nil {
		return "", fmt.Errorf("bridge thought to memories: %w", err)
	}

	return memoryID, nil
}

// CreateContradictsRelationship creates a CONTRADICTS relationship between two
// memories (typically the original thought's memory and the revised thought's memory).
func (mb *MemoryBridge) CreateContradictsRelationship(ctx context.Context, originalMemoryID, revisedMemoryID string) (string, error) {
	if originalMemoryID == "" || revisedMemoryID == "" {
		return "", fmt.Errorf("both memory IDs are required for CONTRADICTS relationship")
	}
	relID, err := mb.store.CreateRelationship(ctx, revisedMemoryID, originalMemoryID, "CONTRADICTS", 1.0)
	if err != nil {
		return "", fmt.Errorf("create CONTRADICTS relationship: %w", err)
	}
	return relID, nil
}

// thoughtContentHash generates a unique content hash for a thought by combining
// its text, chain ID, and thought number.
func thoughtContentHash(text, chainID string, thoughtNumber int) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d", text, chainID, thoughtNumber)))
	return fmt.Sprintf("%x", h[:16])
}
