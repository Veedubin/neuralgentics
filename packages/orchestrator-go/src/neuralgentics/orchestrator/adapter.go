// Package orchestrator provides the Neuralgentics Orchestrator —
// the central routing and protocol enforcement layer.
//
// This file implements the MemoryProvider adapter that wraps
// *memory.MemorySystem and converts between orchestrator and core types.
package orchestrator

import (
	"context"

	"neuralgentics/src/neuralgentics/memory"
	"neuralgentics/src/neuralgentics/memory/core"
)

// MemorySystemAdapter wraps a *memory.MemorySystem and implements the
// MemoryProvider interface. It converts between orchestrator types and
// core types, acting as a thin bridge layer.
//
// Usage:
//
//	mem, err := memory.New(ctx, &core.Config{DatabaseURL: "..."})
//	if err != nil { ... }
//	adapter := orchestrator.NewMemorySystemAdapter(mem)
//	orch, err := orchestrator.New(&orchestrator.OrchestratorConfig{Memory: adapter})
type MemorySystemAdapter struct {
	mem *memory.MemorySystem
}

// NewMemorySystemAdapter creates a new MemorySystemAdapter that wraps the given
// *memory.MemorySystem and satisfies the MemoryProvider interface.
func NewMemorySystemAdapter(mem *memory.MemorySystem) *MemorySystemAdapter {
	return &MemorySystemAdapter{mem: mem}
}

// AddMemory adds a new memory entry via the underlying MemorySystem.
func (sys *MemorySystemAdapter) AddMemory(ctx context.Context, entry MemoryEntry) (string, error) {
	coreEntry := toCoreEntry(entry)
	return sys.mem.AddMemory(ctx, coreEntry)
}

// QueryMemories performs semantic search via the underlying MemorySystem.
func (sys *MemorySystemAdapter) QueryMemories(ctx context.Context, query string, opts *SearchOptions) ([]*MemoryEntry, error) {
	var coreOpts *core.SearchOptions
	if opts != nil {
		coreOpts = toCoreSearchOptions(opts)
	}

	coreResults, err := sys.mem.QueryMemories(ctx, query, coreOpts)
	if err != nil {
		return nil, err
	}

	results := make([]*MemoryEntry, len(coreResults))
	for i, entry := range coreResults {
		results[i] = fromCoreEntry(entry)
	}
	return results, nil
}

// GetMemory retrieves a memory by ID via the underlying MemorySystem.
func (sys *MemorySystemAdapter) GetMemory(ctx context.Context, id string) (*MemoryEntry, error) {
	coreEntry, err := sys.mem.GetMemory(ctx, id)
	if err != nil {
		return nil, err
	}
	return fromCoreEntry(coreEntry), nil
}

// DeleteMemory soft-deletes a memory via the underlying MemorySystem.
func (sys *MemorySystemAdapter) DeleteMemory(ctx context.Context, id string) error {
	return sys.mem.DeleteMemory(ctx, id)
}

// AdjustTrust modifies a memory's trust score via the underlying MemorySystem.
func (sys *MemorySystemAdapter) AdjustTrust(ctx context.Context, memoryID string, signal TrustSignal) (*TrustAdjustment, error) {
	coreAdj, err := sys.mem.AdjustTrust(ctx, memoryID, core.TrustSignal(signal))
	if err != nil {
		return nil, err
	}
	return fromCoreTrustAdjustment(coreAdj), nil
}

// Close shuts down the underlying MemorySystem.
func (sys *MemorySystemAdapter) Close(ctx context.Context) error {
	return sys.mem.Close(ctx)
}

// Verify MemorySystemAdapter satisfies MemoryProvider at compile time.
var _ MemoryProvider = (*MemorySystemAdapter)(nil)

// ============================================================================
// Type Conversion Functions
// ============================================================================

// toCoreEntry converts an orchestrator.MemoryEntry to a core.MemoryEntry.
// Fields present only in core (CreatedAt, UpdatedAt, etc.) are left as
// zero values and will be set by the store layer.
func toCoreEntry(entry MemoryEntry) core.MemoryEntry {
	return core.MemoryEntry{
		ID:             entry.ID,
		Content:        entry.Content,
		Vector:         entry.Vector,
		SourceType:     entry.SourceType,
		SourcePath:     entry.SourcePath,
		ContentHash:    entry.ContentHash,
		TrustScore:     entry.TrustScore,
		RetrievalCount: entry.RetrievalCount,
		IsArchived:     entry.IsArchived,
		Metadata:       entry.Metadata,
		Score:          entry.Score,
		SupersedesID:   entry.SupersedesID,
	}
}

// fromCoreEntry converts a *core.MemoryEntry to a *orchestrator.MemoryEntry.
// Fields present only in core are dropped — the orchestrator does not use them.
func fromCoreEntry(entry *core.MemoryEntry) *MemoryEntry {
	if entry == nil {
		return nil
	}
	return &MemoryEntry{
		ID:             entry.ID,
		Content:        entry.Content,
		Vector:         entry.Vector,
		SourceType:     entry.SourceType,
		SourcePath:     entry.SourcePath,
		ContentHash:    entry.ContentHash,
		TrustScore:     entry.TrustScore,
		RetrievalCount: entry.RetrievalCount,
		IsArchived:     entry.IsArchived,
		Metadata:       entry.Metadata,
		Score:          entry.Score,
		SupersedesID:   entry.SupersedesID,
	}
}

// toCoreSearchOptions converts an *orchestrator.SearchOptions to a *core.SearchOptions.
// The ExactSearch field defaults to false (not present in orchestrator type).
func toCoreSearchOptions(opts *SearchOptions) *core.SearchOptions {
	if opts == nil {
		return &core.SearchOptions{TopK: 10, Threshold: 0.7}
	}
	return &core.SearchOptions{
		TopK:        opts.TopK,
		Threshold:   opts.Threshold,
		Strategy:    opts.Strategy,
		ExactSearch: false,
	}
}

// fromCoreTrustAdjustment converts a *core.TrustAdjustment to an *orchestrator.TrustAdjustment.
// The CreatedAt field is dropped since the orchestrator type does not include it.
func fromCoreTrustAdjustment(adj *core.TrustAdjustment) *TrustAdjustment {
	if adj == nil {
		return nil
	}
	return &TrustAdjustment{
		ID:               adj.ID,
		MemoryID:         adj.MemoryID,
		OldScore:         adj.OldScore,
		NewScore:         adj.NewScore,
		Signal:           adj.Signal,
		AdjustmentAmount: adj.AdjustmentAmount,
		Reason:           adj.Reason,
	}
}
