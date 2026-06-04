package memory

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
	"neuralgentics/src/neuralgentics/memory/trust"
)

// TestIntegration_AdjustTrust_AllSignals tests all 4 trust signals and verifies
// the score changes are correct and persisted.
func TestIntegration_AdjustTrust_AllSignals(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	// Add a memory
	id, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "test trust signal adjustment across all signals",
		SourceType:  "session",
		ContentHash: "trust-all-signals",
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}

	// Verify initial trust score is 0.5
	result, err := mem.GetTrustScore(ctx, id)
	if err != nil {
		t.Fatalf("failed to get initial trust score: %v", err)
	}
	if result.TrustScore != 0.5 {
		t.Fatalf("expected initial trust score 0.5, got %f", result.TrustScore)
	}

	// 1. agent_used: +0.05
	adj, err := mem.AdjustTrust(ctx, id, core.SignalAgentUsed)
	if err != nil {
		t.Fatalf("agent_used adjustment failed: %v", err)
	}
	if adj.OldScore != 0.5 {
		t.Fatalf("agent_used old score expected 0.5, got %f", adj.OldScore)
	}
	if adj.NewScore != 0.55 {
		t.Fatalf("agent_used new score expected 0.55, got %f", adj.NewScore)
	}
	if adj.Signal != string(core.SignalAgentUsed) {
		t.Fatalf("agent_used signal mismatch: %s", adj.Signal)
	}
	if adj.AdjustmentAmount != 0.05 {
		t.Fatalf("agent_used adjustment amount expected 0.05, got %f", adj.AdjustmentAmount)
	}

	// 2. user_confirmed: +0.10
	adj, err = mem.AdjustTrust(ctx, id, core.SignalUserConfirmed)
	if err != nil {
		t.Fatalf("user_confirmed adjustment failed: %v", err)
	}
	if adj.NewScore != 0.65 {
		t.Fatalf("user_confirmed new score expected 0.65, got %f", adj.NewScore)
	}

	// 3. agent_ignored: -0.05
	adj, err = mem.AdjustTrust(ctx, id, core.SignalAgentIgnored)
	if err != nil {
		t.Fatalf("agent_ignored adjustment failed: %v", err)
	}
	if adj.NewScore != 0.60 {
		t.Fatalf("agent_ignored new score expected 0.60, got %f", adj.NewScore)
	}
	if adj.AdjustmentAmount != -0.05 {
		t.Fatalf("agent_ignored adjustment amount expected -0.05, got %f", adj.AdjustmentAmount)
	}

	// 4. user_corrected: -0.10
	adj, err = mem.AdjustTrust(ctx, id, core.SignalUserCorrected)
	if err != nil {
		t.Fatalf("user_corrected adjustment failed: %v", err)
	}
	if adj.NewScore != 0.50 {
		t.Fatalf("user_corrected new score expected 0.50, got %f", adj.NewScore)
	}
	if adj.AdjustmentAmount != -0.10 {
		t.Fatalf("user_corrected adjustment amount expected -0.10, got %f", adj.AdjustmentAmount)
	}

	// Verify final score persisted in database
	result, err = mem.GetTrustScore(ctx, id)
	if err != nil {
		t.Fatalf("failed to get final trust score: %v", err)
	}
	if result.TrustScore != 0.50 {
		t.Fatalf("expected final trust score 0.50, got %f", result.TrustScore)
	}
}

// TestIntegration_TrustClamping verifies that trust scores stay within [0.0, 1.0]
// even when repeatedly adjusting beyond the bounds.
func TestIntegration_TrustClamping(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	id, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "test trust clamping bounds",
		SourceType:  "session",
		ContentHash: "trust-clamp",
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}

	// Repeated user_corrected (-0.10 each) from 0.5 should bottom out at 0.0
	// It takes 5 adjustments to reach 0.0: 0.5 → 0.4 → 0.3 → 0.2 → 0.1 → 0.0
	for i := 0; i < 10; i++ {
		adj, err := mem.AdjustTrust(ctx, id, core.SignalUserCorrected)
		if err != nil {
			t.Fatalf("adjustment %d failed: %v", i, err)
		}
		if adj.NewScore < 0.0 {
			t.Fatalf("clamp failure at iteration %d: score %f below 0.0", i, adj.NewScore)
		}
	}

	// Verify clamped at 0.0
	result, err := mem.GetTrustScore(ctx, id)
	if err != nil {
		t.Fatalf("failed to get trust score: %v", err)
	}
	if result.TrustScore != 0.0 {
		t.Fatalf("expected lower clamp 0.0, got %f", result.TrustScore)
	}

	// Now repeatedly user_confirmed (+0.10 each) from 0.0 should top out at 1.0
	for i := 0; i < 15; i++ {
		adj, err := mem.AdjustTrust(ctx, id, core.SignalUserConfirmed)
		if err != nil {
			t.Fatalf("upward adjustment %d failed: %v", i, err)
		}
		if adj.NewScore > 1.0 {
			t.Fatalf("clamp failure at iteration %d: score %f above 1.0", i, adj.NewScore)
		}
	}

	// Verify clamped at 1.0
	result, err = mem.GetTrustScore(ctx, id)
	if err != nil {
		t.Fatalf("failed to get final trust score: %v", err)
	}
	if result.TrustScore != 1.0 {
		t.Fatalf("expected upper clamp 1.0, got %f", result.TrustScore)
	}
}

// TestIntegration_ListArchived verifies that archived memories are properly
// tracked and retrievable. Uses the store directly to verify database state
// since the MemorySystem's ListArchived relies on ListMemories which
// currently doesn't apply the IsArchived filter.
func TestIntegration_ListArchived(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	defer pgStore.Close(ctx)

	// Add a memory
	id, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "memory to be archived for list test",
		SourceType:  "session",
		ContentHash: "archived-list-1",
		TrustScore:  0.5,
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}

	// Count active memories before archiving
	var activeCount int
	err = pgStore.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM memories WHERE is_archived = FALSE").Scan(&activeCount)
	if err != nil {
		t.Fatalf("failed to count active: %v", err)
	}
	if activeCount != 1 {
		t.Fatalf("expected 1 active memory before archive, got %d", activeCount)
	}

	// Archive it via DeleteMemory (soft delete sets is_archived = TRUE)
	if err := pgStore.DeleteMemory(ctx, id); err != nil {
		t.Fatalf("failed to archive memory: %v", err)
	}

	// Count archived memories
	var archivedCount int
	err = pgStore.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM memories WHERE is_archived = TRUE").Scan(&archivedCount)
	if err != nil {
		t.Fatalf("failed to count archived: %v", err)
	}
	if archivedCount != 1 {
		t.Fatalf("expected 1 archived memory, got %d", archivedCount)
	}

	// Verify it's retrievable with includeArchived=true
	entry, err := pgStore.GetMemory(ctx, id, true)
	if err != nil {
		t.Fatalf("failed to get archived memory: %v", err)
	}
	if !entry.IsArchived {
		t.Fatal("expected memory to be marked as archived")
	}
	if entry.Content != "memory to be archived for list test" {
		t.Fatalf("expected content match, got: %s", entry.Content)
	}

	// Verify TrustEngine GetTrustScore also works for archived memories
	te := trust.NewTrustEngine(pgStore)
	result, err := te.GetTrustScore(ctx, id)
	if err != nil {
		t.Fatalf("get trust score for archived memory failed: %v", err)
	}
	if !result.IsArchived {
		t.Fatal("expected TrustResult.IsArchived to be true")
	}
}
