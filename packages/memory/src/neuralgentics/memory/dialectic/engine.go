// Package dialectic provides contradiction resolution via pro/con argumentation
// and LLM-driven synthesis. It builds on top of the memory_relationships
// subsystem (CONTRADICTS type) and the core LLMClient interface.
package dialectic

import (
	"context"
	"fmt"
	"math"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// Engine provides dialectic contradiction resolution capabilities.
type Engine struct {
	store core.Store
	llm   core.LLMClient
}

// NewEngine creates a dialectic Engine backed by the given store and LLM client.
func NewEngine(store core.Store, llm core.LLMClient) *Engine {
	return &Engine{
		store: store,
		llm:   llm,
	}
}

// FindContradictions discovers pairs of memories that contradict each other.
// It first collects explicit CONTRADICTS relationships from the store. If a
// non-empty query is provided, it also performs a text similarity search to
// find implicit contradictions (memories with high cosine similarity that may
// hold conflicting information).
//
// The query parameter is optional — pass an empty string to rely solely on
// explicit CONTRADICTS relationships.
func (e *Engine) FindContradictions(ctx context.Context, query string, limit int) ([]*core.Contradiction, error) {
	if limit <= 0 {
		limit = 10
	}

	var contradictions []*core.Contradiction
	seen := make(map[string]bool) // dedup by "A|B" key

	// Step 1: Collect explicit CONTRADICTS relationships.
	// List all memories and check each for CONTRADICTS relationships.
	memories, err := e.store.ListMemories(ctx, nil, limit*3)
	if err != nil {
		return nil, fmt.Errorf("list memories: %w", err)
	}

	for _, mem := range memories {
		rels, err := e.store.GetRelationships(ctx, mem.ID)
		if err != nil {
			continue
		}
		for _, rel := range rels {
			if rel.RelationshipType != "CONTRADICTS" {
				continue
			}

			memA, memB := normalisePair(rel.SourceID, rel.TargetID)
			pairKey := memA + "|" + memB
			if seen[pairKey] {
				continue
			}
			seen[pairKey] = true

			// Build a description from available information.
			desc := fmt.Sprintf("Memory %s contradicts memory %s (confidence %.2f)", memA, memB, rel.Confidence)
			severity := severityFromConfidence(rel.Confidence)

			contradictions = append(contradictions, &core.Contradiction{
				MemoryA:     memA,
				MemoryB:     memB,
				Description: desc,
				Severity:    severity,
				Status:      "open",
				CreatedAt:   time.Now(),
			})

			if len(contradictions) >= limit {
				return contradictions, nil
			}
		}
	}

	// Step 2: Implications via text similarity (only when query provided).
	if query != "" {
		impl, err := e.findImplicitContradictions(ctx, query, limit-len(contradictions))
		if err != nil {
			// Implicit search is best-effort — log but don't fail.
			return contradictions, nil
		}
		for _, c := range impl {
			pairKey := c.MemoryA + "|" + c.MemoryB
			if seen[pairKey] {
				continue
			}
			seen[pairKey] = true
			contradictions = append(contradictions, c)
			if len(contradictions) >= limit {
				break
			}
		}
	}

	return contradictions, nil
}

// ResolveContradiction resolves a contradiction by generating pro/con arguments
// for each side, then synthesising a Resolution via LLM.
//
// contradictionID is the ID of the contradiction record; for now it must be
// identifiable via the store's relationship data. If neither memory exists, an
// error is returned.
func (e *Engine) ResolveContradiction(ctx context.Context, contradictionID string) (*core.Resolution, error) {
	if contradictionID == "" {
		return nil, fmt.Errorf("contradiction ID must not be empty")
	}

	// Look up the contradiction. The ID may be in the form "A|B" used by
	// FindContradictions, or it may be a memory relationship ID.
	memAID, memBID, err := e.parseContradictionID(ctx, contradictionID)
	if err != nil {
		return nil, fmt.Errorf("parse contradiction ID: %w", err)
	}

	return e.resolveContradictionByIDs(ctx, memAID, memBID)
}

// ResolveContradictionByIDs resolves a contradiction between two memories
// identified by their IDs directly. This aligns with the memini-ai Python
// source-of-truth which takes memory_id_a and memory_id_b parameters.
func (e *Engine) ResolveContradictionByIDs(ctx context.Context, memoryIDA, memoryIDB string) (*core.Resolution, error) {
	if memoryIDA == "" {
		return nil, fmt.Errorf("memory ID A must not be empty")
	}
	if memoryIDB == "" {
		return nil, fmt.Errorf("memory ID B must not be empty")
	}
	return e.resolveContradictionByIDs(ctx, memoryIDA, memoryIDB)
}

// resolveContradictionByIDs is the shared implementation that fetches both memories,
// generates arguments, and synthesizes a resolution.
func (e *Engine) resolveContradictionByIDs(ctx context.Context, memAID, memBID string) (*core.Resolution, error) {
	memA, err := e.store.GetMemory(ctx, memAID, true)
	if err != nil {
		return nil, fmt.Errorf("get memory A (%s): %w", memAID, err)
	}
	memB, err := e.store.GetMemory(ctx, memBID, true)
	if err != nil {
		return nil, fmt.Errorf("get memory B (%s): %w", memBID, err)
	}

	// Generate arguments for each side.
	args, err := GenerateArguments(ctx, e.llm, memA, memB)
	if err != nil {
		return nil, fmt.Errorf("generate arguments: %w", err)
	}

	contradictionID := memAID + "|" + memBID
	contradiction := &core.Contradiction{
		ID:      contradictionID,
		MemoryA: memAID,
		MemoryB: memBID,
		Status:  "open",
	}

	// Synthesise a resolution.
	resolution, err := SynthesizeResolution(ctx, e.llm, contradiction, args)
	if err != nil {
		return nil, fmt.Errorf("synthesize resolution: %w", err)
	}

	return resolution, nil
}

// ChallengeMemory accepts a challenge against a memory and generates a response
// via the LLM. If the challenge is compelling (response supports it), the
// memory's trust score is adjusted downward.
func (e *Engine) ChallengeMemory(ctx context.Context, memoryID, challengerID, challengeText string) (*core.ChallengeEvent, error) {
	if memoryID == "" {
		return nil, fmt.Errorf("memory ID must not be empty")
	}
	if challengeText == "" {
		return nil, fmt.Errorf("challenge text must not be empty")
	}
	if e.llm == nil {
		return nil, fmt.Errorf("LLM client not configured")
	}

	memory, err := e.store.GetMemory(ctx, memoryID, true)
	if err != nil {
		return nil, fmt.Errorf("get memory %s: %w", memoryID, err)
	}

	// Retrieve challenge history for context (stub — no dedicated table yet).
	history := e.getChallengeHistory()

	// Process the challenge via the LLM.
	event, err := ProcessChallenge(ctx, e.llm, memory, challengeText, history)
	if err != nil {
		return nil, fmt.Errorf("process challenge: %w", err)
	}

	event.MemoryID = memoryID
	event.ChallengerID = challengerID

	// Adjust trust if the challenge is persuasive.
	if event.Status == "accepted" && event.ConfidenceChange < 0 {
		newScore := math.Max(0, memory.TrustScore+event.ConfidenceChange)
		if err := e.store.UpdateTrustFields(ctx, memoryID, newScore, memory.IsArchived); err != nil {
			// Trust update is best-effort — don't fail the whole operation.
			_ = err
		}
	}

	return event, nil
}

// GetDialecticHistory returns a history of contradiction events for a memory.
// Currently returns an empty slice since there is no dedicated dialectic_events
// table — this is a placeholder for future implementation.
func (e *Engine) GetDialecticHistory(ctx context.Context, memoryID string, limit int) ([]*core.DialecticEvent, error) {
	if memoryID == "" {
		return nil, fmt.Errorf("memory ID must not be empty")
	}
	if limit <= 0 {
		limit = 10
	}

	// No dedicated table exists yet. Return events derived from CONTRADICTS
	// relationships for this memory.
	rels, err := e.store.GetRelationships(ctx, memoryID)
	if err != nil {
		return nil, fmt.Errorf("get relationships: %w", err)
	}

	var events []*core.DialecticEvent
	for _, rel := range rels {
		if rel.RelationshipType != "CONTRADICTS" {
			continue
		}
		events = append(events, &core.DialecticEvent{
			ContradictionID: rel.SourceID + "|" + rel.TargetID,
			EventType:       "contradiction_found",
			Description:     fmt.Sprintf("Memory %s contradicts memory %s", rel.SourceID, rel.TargetID),
			CreatedAt:       time.Now(),
		})
		if len(events) >= limit {
			break
		}
	}

	if len(events) == 0 {
		return nil, nil
	}
	return events, nil
}

// findImplicitContradictions performs a text similarity search to find potentially
// conflicting memories. This is a best-effort search that uses the store's text
// search capability.
func (e *Engine) findImplicitContradictions(ctx context.Context, query string, limit int) ([]*core.Contradiction, error) {
	if limit <= 0 {
		return nil, nil
	}

	results, err := e.store.SearchMemoriesText(ctx, query, &core.SearchOptions{
		TopK:      limit * 2, // get extra for dedup
		Threshold: 0.85,
		Strategy:  "text_only",
	})
	if err != nil {
		return nil, fmt.Errorf("text search: %w", err)
	}

	// Pairwise comparisons for potential contradictions. For simplicity,
	// compare adjacent pairs from the search results.
	var contradictions []*core.Contradiction
	for i := 0; i+1 < len(results) && len(contradictions) < limit; i++ {
		memA := results[i]
		memB := results[i+1]

		// Check if there's already an explicit CONTRADICTS relationship.
		rels, err := e.store.GetRelationships(ctx, memA.ID)
		if err != nil {
			continue
		}
		alreadyKnown := false
		for _, rel := range rels {
			if rel.RelationshipType == "CONTRADICTS" &&
				(rel.TargetID == memB.ID || rel.TargetID == memA.ID) {
				alreadyKnown = true
				break
			}
		}
		if alreadyKnown {
			continue
		}

		aID, bID := normalisePair(memA.ID, memB.ID)
		contradictions = append(contradictions, &core.Contradiction{
			MemoryA:     aID,
			MemoryB:     bID,
			Description: fmt.Sprintf("Potentially contradictory memories on topic: %s", query),
			Severity:    "low",
			Status:      "open",
			CreatedAt:   time.Now(),
		})
	}

	return contradictions, nil
}

// parseContradictionID extracts memory A and memory B IDs from a
// contradiction ID. The ID may be in "A|B" format, or it may be a single
// memory ID that we look up via relationships.
func (e *Engine) parseContradictionID(ctx context.Context, id string) (string, string, error) {
	// Try "A|B" format first.
	for _, sep := range []string{"|", ":"} {
		for i := 0; i < len(id); i++ {
			if string(id[i]) == sep {
				return id[:i], id[i+1:], nil
			}
		}
	}

	// Fall back: assume id is memory A; find first CONTRADICTS relationship.
	rels, err := e.store.GetRelationships(ctx, id)
	if err != nil {
		return "", "", fmt.Errorf("no CONTRADICTS relationship found for %s: %w", id, err)
	}
	for _, rel := range rels {
		if rel.RelationshipType == "CONTRADICTS" {
			a, b := normalisePair(rel.SourceID, rel.TargetID)
			return a, b, nil
		}
	}
	return "", "", fmt.Errorf("no CONTRADICTS relationship found for memory %s", id)
}

// getChallengeHistory retrieves past challenge events for a memory.
// Currently a stub since there's no dedicated table.
func (e *Engine) getChallengeHistory() []core.ChallengeEvent {
	// Placeholder: no dedicated challenge_events table yet.
	return nil
}

// normalisePair sorts two IDs so that "A|B" and "B|A" produce the same result.
func normalisePair(a, b string) (string, string) {
	if a > b {
		return b, a
	}
	return a, b
}

// severityFromConfidence maps a relationship confidence to a severity level.
func severityFromConfidence(confidence float64) string {
	switch {
	case confidence >= 0.8:
		return "high"
	case confidence >= 0.5:
		return "medium"
	default:
		return "low"
	}
}
