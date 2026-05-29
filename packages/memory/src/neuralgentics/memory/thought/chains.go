// Package thought provides the Thought Chains subsystem for Neuralgentics.
// It manages sequential reasoning chains where each thought can be revised,
// branched, and tracked with semantic embeddings for related-chain discovery.
//
// Every thought is dual-stored in both the thoughts table and the memories
// table (sourceType="thought") enabling semantic search, trust scoring, and
// knowledge graph extraction across thoughts.
package thought

import (
	"context"
	"crypto/sha256"
	"fmt"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ChainsManager provides business logic for thought chains on top of
// core.Store. It handles embedding generation, dual storage via MemoryBridge,
// and CONTRADICTS relationship creation during revisions.
type ChainsManager struct {
	store    core.Store
	embedder core.Embedder
	bridge   *MemoryBridge
}

// NewChainsManager creates a new ChainsManager with the given store and
// optional embedder. If embedder is nil, embedding generation is skipped.
func NewChainsManager(store core.Store, embedder core.Embedder) *ChainsManager {
	return &ChainsManager{
		store:    store,
		embedder: embedder,
		bridge:   NewMemoryBridge(store),
	}
}

// StartChain creates a new thought chain and returns its ID.
func (cm *ChainsManager) StartChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	chainID, err := cm.store.StartThoughtChain(ctx, sessionID, parentChainID)
	if err != nil {
		return "", fmt.Errorf("start thought chain: %w", err)
	}
	return chainID, nil
}

// AddThought adds a thought to an existing chain. If the embedder is available,
// it generates an embedding for the thought text. The thought is also
// dual-stored in the memories table via the MemoryBridge.
func (cm *ChainsManager) AddThought(ctx context.Context, chainID, text string, thoughtNumber, totalThoughts int, nextNeeded bool) (string, error) {
	// Generate content hash
	contentHash := contentHash(text)

	// Generate embedding if embedder is available
	var vector []float64
	if cm.embedder != nil {
		emb, err := cm.embedder.Embed(ctx, text)
		if err != nil {
			// Log but don't fail — embedding is optional
			fmt.Printf("thought: embedding generation failed: %v\n", err)
		} else {
			vector = emb
		}
	}

	thought := &core.Thought{
		ChainID:           chainID,
		Text:              text,
		ThoughtNumber:     thoughtNumber,
		TotalThoughts:     totalThoughts,
		NextThoughtNeeded: nextNeeded,
		IsRevision:        false,
		ContentHash:       contentHash,
		Vector:            vector,
	}

	thoughtID, err := cm.store.AddThought(ctx, chainID, thought)
	if err != nil {
		return "", fmt.Errorf("add thought: %w", err)
	}
	thought.ID = thoughtID

	// Dual-store in memories table
	memID, err := cm.bridge.BridgeThought(ctx, thought)
	if err != nil {
		// Non-fatal: thought is stored in the thoughts table even if bridge fails
		fmt.Printf("thought: bridge to memories failed: %v\n", err)
	} else {
		// Update thought with memory_id
		thought.MemoryID = memID
	}

	return thoughtID, nil
}

// GetChain retrieves a thought chain with all its thoughts, ordered by
// thought_number.
func (cm *ChainsManager) GetChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	chain, err := cm.store.GetThoughtChain(ctx, chainID)
	if err != nil {
		return nil, fmt.Errorf("get thought chain: %w", err)
	}
	if chain == nil {
		return nil, fmt.Errorf("thought chain %s not found", chainID)
	}
	return chain, nil
}

// GetRelatedChains performs semantic search over thought chains. It embeds the
// query, searches for similar thoughts via the memories table, and returns
// the parent chains.
func (cm *ChainsManager) GetRelatedChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	if limit <= 0 {
		limit = 10
	}

	// Delegate to the store's GetRelatedChains implementation which uses
	// vector similarity on the thoughts table embedding column.
	chains, err := cm.store.GetRelatedChains(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("get related chains: %w", err)
	}
	return chains, nil
}

// ReviseThought creates a revision of an existing thought. It marks the
// original thought as revised and creates a new thought with is_revision=true
// and revises_thought_id pointing to the original. If the original thought has
// a memory_id, a CONTRADICTS relationship is created between the original and
// revised memories.
func (cm *ChainsManager) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, newText string) (*core.Thought, error) {
	revised, err := cm.store.ReviseThought(ctx, chainID, thoughtNumber, newText)
	if err != nil {
		return nil, fmt.Errorf("revise thought: %w", err)
	}

	// Generate embedding for the revised text
	if cm.embedder != nil {
		emb, err := cm.embedder.Embed(ctx, newText)
		if err == nil {
			revised.Vector = emb
		}
	}

	// Bridge the revised thought to memories
	memID, err := cm.bridge.BridgeThought(ctx, revised)
	if err == nil && memID != "" {
		revised.MemoryID = memID
	}

	return revised, nil
}

// BranchThought creates a branch from an existing thought. The new thought
// records branch_from_thought_id and branch_id for traceability.
func (cm *ChainsManager) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	branch, err := cm.store.BranchThought(ctx, chainID, fromThoughtNumber, branchID, text)
	if err != nil {
		return nil, fmt.Errorf("branch thought: %w", err)
	}

	// Generate embedding for the branch thought
	if cm.embedder != nil {
		emb, err := cm.embedder.Embed(ctx, text)
		if err == nil {
			branch.Vector = emb
		}
	}

	// Bridge the branch thought to memories
	memID, err := cm.bridge.BridgeThought(ctx, branch)
	if err == nil && memID != "" {
		branch.MemoryID = memID
	}

	return branch, nil
}

// PauseChain updates a thought chain's status to "paused".
func (cm *ChainsManager) PauseChain(ctx context.Context, chainID string) error {
	if err := cm.store.PauseThoughtChain(ctx, chainID); err != nil {
		return fmt.Errorf("pause thought chain: %w", err)
	}
	return nil
}

// ResumeChain updates a thought chain's status from "paused" back to "active".
func (cm *ChainsManager) ResumeChain(ctx context.Context, chainID string) error {
	if err := cm.store.ResumeThoughtChain(ctx, chainID); err != nil {
		return fmt.Errorf("resume thought chain: %w", err)
	}
	return nil
}

// AbandonChain updates a thought chain's status to "abandoned".
func (cm *ChainsManager) AbandonChain(ctx context.Context, chainID string) error {
	if err := cm.store.AbandonThoughtChain(ctx, chainID); err != nil {
		return fmt.Errorf("abandon thought chain: %w", err)
	}
	return nil
}

// contentHash computes a SHA-256 hash of the thought text for deduplication.
func contentHash(text string) string {
	h := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%x", h[:16])
}
