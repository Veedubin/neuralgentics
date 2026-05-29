package decay

import (
	"context"
	"fmt"
	"math"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// defaultSimilarityThreshold is the cosine similarity above which two memories
// are considered candidates for consolidation.
const defaultSimilarityThreshold = 0.95

// Consolidator merges semantically similar memories, creating SUPERSEDES
// relationships and archiving the lower-trust duplicate.
type Consolidator struct {
	store     core.Store
	embedder  core.Embedder
	threshold float64
}

// NewConsolidator creates a Consolidator with the given store, embedder,
// and default similarity threshold (0.95).
func NewConsolidator(store core.Store, embedder core.Embedder) *Consolidator {
	return &Consolidator{
		store:     store,
		embedder:  embedder,
		threshold: defaultSimilarityThreshold,
	}
}

// ConsolidationStats records the outcome of a consolidation run.
// This mirrors core.ConsolidationStats — returned by Consolidate().
type ConsolidationResult = core.ConsolidationStats

// Consolidate examines all active memories and merges those with cosine
// similarity above the threshold. If force is true, it runs even if
// there are few memories; otherwise it skips if there are fewer than 2.
func (c *Consolidator) Consolidate(ctx context.Context, force bool) (*ConsolidationResult, error) {
	active, err := c.store.ListMemories(ctx, &core.SearchFilter{
		IsArchived: boolPtr(false),
	}, 0)
	if err != nil {
		return nil, fmt.Errorf("consolidate: list memories: %w", err)
	}

	if !force && len(active) < 2 {
		return &ConsolidationResult{
			Examined:  len(active),
			Merged:    0,
			Skipped:   len(active),
			CreatedAt: time.Now(),
		}, nil
	}

	merged := 0
	seen := make(map[string]bool) // track memories already merged in this run

	for i := 0; i < len(active); i++ {
		if seen[active[i].ID] {
			continue
		}
		for j := i + 1; j < len(active); j++ {
			if seen[active[j].ID] {
				continue
			}

			sim, err := c.similarity(active[i], active[j])
			if err != nil || sim < c.threshold {
				continue
			}

			if err := c.merge(ctx, active[i], active[j]); err != nil {
				continue // skip this pair on error
			}
			merged++
			seen[active[j].ID] = true // lower-trust one is archived
		}
	}

	return &ConsolidationResult{
		Examined:  len(active),
		Merged:    merged,
		Skipped:   len(active) - merged,
		CreatedAt: time.Now(),
	}, nil
}

// similarity computes the cosine similarity between two memory vectors.
// If either vector is nil, it attempts to re-embed the content.
func (c *Consolidator) similarity(a, b *core.MemoryEntry) (float64, error) {
	vecA := a.Vector
	vecB := b.Vector

	// Re-embed if vectors are missing.
	if vecA == nil {
		embedded, err := c.embedder.Embed(context.Background(), a.Content)
		if err != nil {
			return 0, fmt.Errorf("embed memory %s: %w", a.ID, err)
		}
		vecA = embedded
	}
	if vecB == nil {
		embedded, err := c.embedder.Embed(context.Background(), b.Content)
		if err != nil {
			return 0, fmt.Errorf("embed memory %s: %w", b.ID, err)
		}
		vecB = embedded
	}

	return cosineSimilarity(vecA, vecB), nil
}

// merge keeps the higher-trust memory, archives the lower-trust one,
// and creates a SUPERSEDES relationship.
func (c *Consolidator) merge(ctx context.Context, higher, lower *core.MemoryEntry) error {
	// Determine which is higher trust (swap if needed).
	if lower.TrustScore > higher.TrustScore {
		higher, lower = lower, higher
	}

	// Archive the lower-trust memory.
	if err := c.store.UpdateTrustFields(ctx, lower.ID, lower.TrustScore, true); err != nil {
		return fmt.Errorf("archive lower-trust memory: %w", err)
	}

	// Create SUPERSEDES relationship from higher to lower.
	if _, err := c.store.CreateRelationship(ctx, higher.ID, lower.ID, "SUPERSEDES", 1.0); err != nil {
		return fmt.Errorf("create supersedes relationship: %w", err)
	}

	return nil
}

// cosineSimilarity computes the cosine similarity between two vectors.
// It safely handles zero vectors by returning 0.
func cosineSimilarity(a, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}

	var dot, normA, normB float64
	for i := range a {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}

	if normA == 0 || normB == 0 {
		return 0
	}

	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}
