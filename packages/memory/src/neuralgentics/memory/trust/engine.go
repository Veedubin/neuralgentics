// Package trust implements the trust scoring engine for memories.
// It adjusts trust scores based on feedback signals and manages archival.
package trust

import (
	"context"
	"fmt"
	"math"

	"neuralgentics/src/neuralgentics/memory/core"
)

// SignalDeltas maps each TrustSignal to its numeric delta.
var SignalDeltas = map[core.TrustSignal]float64{
	core.SignalAgentUsed:     +0.05,
	core.SignalAgentIgnored:  -0.05,
	core.SignalUserConfirmed: +0.10,
	core.SignalUserCorrected: -0.10,
}

// TrustEngine operates on the core.Store interface to manage trust scores.
// It never references the concrete PostgresStore directly.
type TrustEngine struct {
	store core.Store
}

// NewTrustEngine creates a new TrustEngine backed by the given store.
func NewTrustEngine(store core.Store) *TrustEngine {
	return &TrustEngine{store: store}
}

// GetTrustScore returns the current trust metrics for a memory.
// It fetches the memory (including archived) and builds a TrustResult.
func (e *TrustEngine) GetTrustScore(ctx context.Context, memoryID string) (*core.TrustResult, error) {
	mem, err := e.store.GetMemory(ctx, memoryID, true)
	if err != nil {
		return nil, fmt.Errorf("get trust score: %w", err)
	}
	if mem == nil {
		return nil, fmt.Errorf("get trust score: memory %s not found", memoryID)
	}

	decayRate := 1.0 // default
	if v, ok := mem.Metadata["decay_rate"]; ok {
		if f, ok := v.(float64); ok {
			decayRate = f
		}
	}

	return &core.TrustResult{
		MemoryID:       mem.ID,
		TrustScore:     mem.TrustScore,
		RetrievalCount: mem.RetrievalCount,
		IsArchived:     mem.IsArchived,
		DecayRate:      decayRate,
	}, nil
}

// AdjustTrust modifies a memory's trust score based on a feedback signal.
// It clamps the result to [0.0, 1.0], updates the store, and logs the adjustment.
func (e *TrustEngine) AdjustTrust(ctx context.Context, memoryID string, signal core.TrustSignal) (*core.TrustAdjustment, error) {
	delta, ok := SignalDeltas[signal]
	if !ok {
		return nil, fmt.Errorf("adjust trust: unknown signal %q", signal)
	}

	mem, err := e.store.GetMemory(ctx, memoryID, true)
	if err != nil {
		return nil, fmt.Errorf("adjust trust: fetch memory: %w", err)
	}
	if mem == nil {
		return nil, fmt.Errorf("adjust trust: memory %s not found", memoryID)
	}

	oldScore := mem.TrustScore
	newScore := clamp(oldScore+delta, 0.0, 1.0)

	if err := e.store.UpdateTrustFields(ctx, memoryID, newScore, mem.IsArchived); err != nil {
		return nil, fmt.Errorf("adjust trust: update trust fields: %w", err)
	}

	adj := &core.TrustAdjustment{
		MemoryID:         memoryID,
		OldScore:         oldScore,
		NewScore:         newScore,
		Signal:           string(signal),
		AdjustmentAmount: newScore - oldScore,
	}

	if _, err := e.store.LogTrustAdjustment(ctx, adj); err != nil {
		return nil, fmt.Errorf("adjust trust: log adjustment: %w", err)
	}

	return adj, nil
}

// ListArchived returns archived memories up to the given limit.
func (e *TrustEngine) ListArchived(ctx context.Context, limit int) ([]*core.MemoryEntry, error) {
	archived := true
	return e.store.ListMemories(ctx, &core.SearchFilter{IsArchived: &archived}, limit)
}

// PromoteMemory un-archives a memory by setting is_archived = false.
// The trust score is preserved.
func (e *TrustEngine) PromoteMemory(ctx context.Context, memoryID string) error {
	mem, err := e.store.GetMemory(ctx, memoryID, true)
	if err != nil {
		return fmt.Errorf("promote memory: fetch: %w", err)
	}
	if mem == nil {
		return fmt.Errorf("promote memory: memory %s not found", memoryID)
	}
	if !mem.IsArchived {
		return nil // already active, nothing to do
	}

	if err := e.store.UpdateTrustFields(ctx, memoryID, mem.TrustScore, false); err != nil {
		return fmt.Errorf("promote memory: update: %w", err)
	}
	return nil
}

// clamp restricts v to the range [min, max].
func clamp(v, minVal, maxVal float64) float64 {
	return math.Max(minVal, math.Min(maxVal, v))
}
