// Package orchestrator provides the Neuralgentics Orchestrator —
// the central routing and protocol enforcement layer.
//
// This file implements the IMPROVE phase (step 7 of 9) of the
// Boomerang Protocol. After quality gates pass, the IMPROVE phase
// extracts patterns from the just-completed work, fetches the L1
// key decisions summary, and reports the result for trust adjustments
// and relationship linking by the orchestrator's normal pathways.
package orchestrator

import (
	"context"
	"fmt"
	"log"
	"time"
)

// ImproveResult tracks what the IMPROVE phase accomplished.
type ImproveResult struct {
	TaskID              string    `json:"task_id"`
	PatternsExtracted   int       `json:"patterns_extracted"`
	TrustAdjustments    int       `json:"trust_adjustments"`
	RelationshipsLinked int       `json:"relationships_linked"`
	SummaryGenerated    bool      `json:"summary_generated"`
	Errors              []string  `json:"errors,omitempty"`
	StartedAt           time.Time `json:"started_at"`
	CompletedAt         time.Time `json:"completed_at"`
	Duration            string    `json:"duration"`
}

// ImproveMemoryProvider is the interface the IMPROVE handler uses to call
// memory tools. The orchestrator's MemoryProvider satisfies this interface.
type ImproveMemoryProvider interface {
	// TriggerExtraction triggers pattern extraction from a conversation buffer.
	TriggerExtraction(ctx context.Context, conversation string) (int, error)
	// GetTier1Summary returns the L1 key decisions summary (~2K tokens, trust >= 0.8).
	GetTier1Summary(ctx context.Context, forceRefresh bool) (string, error)
}

// ImproveHandler runs the IMPROVE phase of the Boomerang Protocol
// (step 7 of 9). After quality gates pass, it extracts patterns from
// the just-completed work, calls memory.triggerExtraction, fetches
// the L1 key decisions summary, and reports the result.
//
// Trust adjustments and relationship linking are handled by the
// orchestrator's normal trust-bump and relationship pathways — the
// IMPROVE handler's job is extraction + summary generation.
type ImproveHandler struct {
	memory ImproveMemoryProvider
}

// NewImproveHandler creates a new IMPROVE handler with the given memory provider.
func NewImproveHandler(memory ImproveMemoryProvider) *ImproveHandler {
	return &ImproveHandler{memory: memory}
}

// Run executes the IMPROVE phase. It is safe to call multiple times
// (idempotent: returns the result of extraction + summary for this call only).
func (h *ImproveHandler) Run(ctx context.Context, taskID string, conversation string) (*ImproveResult, error) {
	result := &ImproveResult{
		TaskID:    taskID,
		StartedAt: time.Now(),
	}
	defer func() {
		result.CompletedAt = time.Now()
		result.Duration = result.CompletedAt.Sub(result.StartedAt).String()
	}()

	// 1. Trigger extraction (catches patterns from the conversation).
	//    If the conversation is empty, skip extraction rather than failing.
	if conversation != "" {
		extracted, err := h.memory.TriggerExtraction(ctx, conversation)
		if err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("triggerExtraction: %v", err))
		} else {
			result.PatternsExtracted = extracted
		}
	}

	// 2. Fetch L1 key decisions summary.
	summary, err := h.memory.GetTier1Summary(ctx, false)
	if err != nil {
		result.Errors = append(result.Errors, fmt.Sprintf("getTier1Summary: %v", err))
	} else {
		result.SummaryGenerated = summary != ""
	}

	// 3. Trust adjustments happen in the orchestrator loop, not here.
	//    This handler reports the result of extraction + summary.
	//    Actual AdjustTrust calls happen via the Orchestrator's normal
	//    trust-bump pathway when memories are queried during work.
	result.TrustAdjustments = 0

	log.Printf("[IMPROVE] complete task_id=%s patterns=%d summary=%t",
		taskID, result.PatternsExtracted, result.SummaryGenerated)

	return result, nil
}
