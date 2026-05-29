// Package decay implements memory trust decay, archival, and consolidation.
// All business logic operates on the core.Store interface — never on concrete types.
package decay

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// defaultHalfLife is the default time for a memory's trust score to halve.
const defaultHalfLife = 30 * 24 * time.Hour // 30 days

// fadingThreshold is the trust score below which a memory is considered "fading".
const fadingThreshold = 0.3

// archiveThreshold is the trust score below which a memory is archived.
const archiveThreshold = 0.1

// DecayEngine applies exponential trust decay to memories over time.
type DecayEngine struct {
	store    core.Store
	halfLife time.Duration
	mu       sync.RWMutex
}

// NewDecayEngine creates a new DecayEngine with the given store and default half-life.
func NewDecayEngine(store core.Store) *DecayEngine {
	return &DecayEngine{
		store:    store,
		halfLife: defaultHalfLife,
	}
}

// GetDecayStatus returns current decay statistics.
func (e *DecayEngine) GetDecayStatus(ctx context.Context) (*core.DecayStatus, error) {
	// Try the dedicated ListFadingMemories first.
	fading, err := e.store.ListFadingMemories(ctx, fadingThreshold, 0)
	if err != nil || len(fading) == 0 {
		// Fallback: approximate fading count via ListMemories with low trust filter.
		lowTrust, approxErr := e.store.ListMemories(ctx, &core.SearchFilter{
			MinTrustScore: 0.0, // include all
			IsArchived:    boolPtr(false),
		}, 0)
		if approxErr != nil {
			return nil, fmt.Errorf("get fading memories: %w", approxErr)
		}
		// Filter to those with trust < threshold.
		fading = filterByFading(lowTrust, fadingThreshold)
		if err != nil {
			// Non-fatal; we just use the approximation.
		}
	}

	archived, err := e.store.ListMemories(ctx, &core.SearchFilter{
		IsArchived: boolPtr(true),
	}, 0)
	if err != nil {
		return nil, fmt.Errorf("get archived memories: %w", err)
	}

	e.mu.RLock()
	hl := e.halfLife
	e.mu.RUnlock()

	return &core.DecayStatus{
		Enabled:       true,
		HalfLifeDays:  int(hl.Hours() / 24),
		FadingCount:   len(fading),
		ArchivedCount: len(archived),
	}, nil
}

// AdjustDecayRate changes the decay rate for a specific memory, clamped to [0.1, 10.0].
// It also logs an audit event for the configuration change.
func (e *DecayEngine) AdjustDecayRate(ctx context.Context, memoryID string, rate float64) error {
	rate = clamp(rate, 0.1, 10.0)

	if err := e.store.UpdateDecayRate(ctx, memoryID, rate); err != nil {
		return fmt.Errorf("update decay rate: %w", err)
	}

	// Log audit event.
	_, _ = e.store.LogAuditEvent(ctx, &core.AuditEvent{
		EventType:   "config_modification",
		Severity:    "info",
		MemoryID:    memoryID,
		Description: fmt.Sprintf("decay rate adjusted to %.2f", rate),
		Details: map[string]any{
			"new_rate": rate,
		},
	})

	return nil
}

// ApplyDecay applies exponential trust decay to a single memory.
// It is called by the scheduler on each tick.
func (e *DecayEngine) ApplyDecay(ctx context.Context, memoryID string) error {
	entry, err := e.store.GetMemory(ctx, memoryID, true)
	if err != nil {
		return fmt.Errorf("get memory for decay: %w", err)
	}
	if entry == nil {
		return nil
	}
	if entry.IsArchived {
		return nil // skip archived memories
	}

	e.mu.RLock()
	hl := e.halfLife
	e.mu.RUnlock()

	// Determine elapsed time since creation or last access.
	elapsed := time.Since(entry.CreatedAt)
	if entry.LastAccessedAt != nil && entry.LastAccessedAt.After(entry.CreatedAt) {
		elapsed = time.Since(*entry.LastAccessedAt)
	}

	newScore := exponentialDecay(entry.TrustScore, elapsed, hl)

	// Archive if below threshold.
	if newScore < archiveThreshold {
		if err := e.store.UpdateTrustFields(ctx, memoryID, newScore, true); err != nil {
			return fmt.Errorf("archive memory: %w", err)
		}
		return nil
	}

	if err := e.store.UpdateTrustFields(ctx, memoryID, newScore, false); err != nil {
		return fmt.Errorf("update trust fields: %w", err)
	}
	return nil
}

// ListFadingMemories returns memories approaching the archive threshold.
func (e *DecayEngine) ListFadingMemories(ctx context.Context, limit int) ([]*core.MemoryEntry, error) {
	results, err := e.store.ListFadingMemories(ctx, fadingThreshold, limit)
	if err != nil {
		return nil, fmt.Errorf("list fading memories: %w", err)
	}
	return results, nil
}

// exponentialDecay computes the decayed trust score.
// Formula: newScore = currentScore * exp(-ln(2) * elapsed / halfLife)
func exponentialDecay(currentScore float64, elapsed, halfLife time.Duration) float64 {
	if halfLife <= 0 {
		return currentScore
	}
	lambda := math.Ln2 * float64(elapsed) / float64(halfLife)
	return currentScore * math.Exp(-lambda)
}

// filterByFading filters memories to those with trust below the threshold.
func filterByFading(memories []*core.MemoryEntry, threshold float64) []*core.MemoryEntry {
	var result []*core.MemoryEntry
	for _, m := range memories {
		if m.TrustScore < threshold {
			result = append(result, m)
		}
	}
	return result
}

// boolPtr returns a pointer to the given bool value.
func boolPtr(b bool) *bool {
	return &b
}

// clamp restricts value to [min, max].
func clamp(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
