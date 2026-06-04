package decay

import (
	"context"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Tests ────────────────────────────────────────────────────────────────────

func TestScheduler_StartStop(t *testing.T) {
	store := newMockStore()
	engine := NewDecayEngine(store)
	scheduler := NewScheduler(engine, 50*time.Millisecond)

	// Start and stop should complete cleanly.
	scheduler.Start()

	// Give it a moment to start the goroutine.
	time.Sleep(20 * time.Millisecond)

	scheduler.Stop()
	// If Stop() hangs, the test will timeout.
}

func TestScheduler_Tick(t *testing.T) {
	store := newMockStore()
	engine := NewDecayEngine(store)

	now := time.Now()
	// Add active memories with non-trivial trust scores.
	store.memories["mem-a"] = &core.MemoryEntry{
		ID: "mem-a", Content: "alpha", TrustScore: 0.7, IsArchived: false,
		CreatedAt: now.Add(-72 * time.Hour),
	}
	store.memories["mem-b"] = &core.MemoryEntry{
		ID: "mem-b", Content: "beta", TrustScore: 0.5, IsArchived: false,
		CreatedAt: now.Add(-48 * time.Hour),
	}

	scheduler := NewScheduler(engine, 50*time.Millisecond)

	// We test this by verifying trust fields are updated after a tick.
	scheduler.Start()

	// Wait for at least one tick.
	time.Sleep(120 * time.Millisecond)

	scheduler.Stop()

	// Verify that ApplyDecay was called by checking trust updates.

	// The engine should have updated trust scores.
	updates := store.trustUpdates
	if len(updates) == 0 {
		t.Error("Expected at least one trust update after scheduler tick, got 0")
	}
}

func TestScheduler_DoesNotDecayArchived(t *testing.T) {
	store := newMockStore()
	engine := NewDecayEngine(store)

	now := time.Now()
	// Add an archived memory — should be skipped.
	store.memories["archived-mem"] = &core.MemoryEntry{
		ID: "archived-mem", Content: "archived", TrustScore: 0.01, IsArchived: true,
		CreatedAt: now.Add(-200 * 24 * time.Hour),
	}

	scheduler := NewScheduler(engine, 50*time.Millisecond)
	scheduler.Start()
	time.Sleep(120 * time.Millisecond)
	scheduler.Stop()

	// No trust updates for archived memory.
	for _, u := range store.trustUpdates {
		if u.id == "archived-mem" {
			t.Error("Archived memory should not receive decay updates")
		}
	}
}

func TestConsolidator_Consolidate(t *testing.T) {
	store := newMockStore()
	emb := newMockEmbedder()
	consolidator := NewConsolidator(store, emb)
	ctx := context.Background()

	now := time.Now()

	// Two very similar memories (same vector => cosine similarity = 1.0).
	vec := []float64{0.1, 0.2, 0.3}
	store.memories["high-trust"] = &core.MemoryEntry{
		ID: "high-trust", Content: "dark mode preference", TrustScore: 0.9,
		IsArchived: false, CreatedAt: now, Vector: vec,
	}
	store.memories["low-trust"] = &core.MemoryEntry{
		ID: "low-trust", Content: "dark mode pref", TrustScore: 0.6,
		IsArchived: false, CreatedAt: now, Vector: vec,
	}

	stats, err := consolidator.Consolidate(ctx, true)
	if err != nil {
		t.Fatalf("Consolidate returned error: %v", err)
	}
	if stats.Examined != 2 {
		t.Errorf("Examined = %d, want 2", stats.Examined)
	}
	if stats.Merged != 1 {
		t.Errorf("Merged = %d, want 1", stats.Merged)
	}
	if stats.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1", stats.Skipped)
	}

	// Verify the lower-trust memory was archived.
	lowEntry := store.memories["low-trust"]
	if !lowEntry.IsArchived {
		t.Error("Lower-trust memory should be archived after consolidation")
	}

	// Verify a SUPERSEDES relationship was created.
	var foundRel bool
	for _, r := range store.relationships {
		if r.RelationshipType == "SUPERSEDES" && r.SourceID == "high-trust" && r.TargetID == "low-trust" {
			foundRel = true
		}
	}
	if !foundRel {
		t.Error("Expected SUPERSEDES relationship from high-trust to low-trust")
	}
}

func TestConsolidator_SkipsDissimilar(t *testing.T) {
	store := newMockStore()
	emb := newMockEmbedder()
	consolidator := NewConsolidator(store, emb)
	ctx := context.Background()

	now := time.Now()

	vec1 := []float64{1.0, 0.0, 0.0}
	vec2 := []float64{0.0, 1.0, 0.0} // orthogonal — cosine = 0

	store.memories["mem-x"] = &core.MemoryEntry{
		ID: "mem-x", Content: "alpha", TrustScore: 0.8, IsArchived: false,
		CreatedAt: now, Vector: vec1,
	}
	store.memories["mem-y"] = &core.MemoryEntry{
		ID: "mem-y", Content: "beta", TrustScore: 0.7, IsArchived: false,
		CreatedAt: now, Vector: vec2,
	}

	stats, err := consolidator.Consolidate(ctx, true)
	if err != nil {
		t.Fatalf("Consolidate returned error: %v", err)
	}
	if stats.Merged != 0 {
		t.Errorf("Merged = %d, want 0 for dissimilar memories", stats.Merged)
	}
}

func TestCosineSimilarity(t *testing.T) {
	tests := []struct {
		name string
		a, b []float64
		want float64
	}{
		{"identical", []float64{1, 0, 0}, []float64{1, 0, 0}, 1.0},
		{"orthogonal", []float64{1, 0, 0}, []float64{0, 1, 0}, 0.0},
		{"opposite", []float64{1, 0, 0}, []float64{-1, 0, 0}, -1.0},
		{"zero vector", []float64{0, 0, 0}, []float64{1, 0, 0}, 0.0},
		{"empty", []float64{}, []float64{}, 0.0},
		{"mismatched length", []float64{1, 0}, []float64{1, 0, 0}, 0.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cosineSimilarity(tt.a, tt.b)
			if got < tt.want-0.01 || got > tt.want+0.01 {
				t.Errorf("cosineSimilarity(%v, %v) = %f, want %f", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

// ─── Mock Embedder ───────────────────────────────────────────────────────────

type mockEmbedder struct{}

func newMockEmbedder() *mockEmbedder { return &mockEmbedder{} }

func (m *mockEmbedder) Embed(_ context.Context, _ string) ([]float64, error) {
	return []float64{0.1, 0.2, 0.3}, nil
}

func (m *mockEmbedder) EmbedBatch(_ context.Context, texts []string) ([][]float64, error) {
	result := make([][]float64, len(texts))
	for i := range texts {
		result[i] = []float64{0.1, 0.2, 0.3}
	}
	return result, nil
}

func (m *mockEmbedder) Embed1024(_ context.Context, _ string) ([]float64, error) {
	return make([]float64, 1024), nil
}
func (m *mockEmbedder) Dim() int                       { return 384 }
func (m *mockEmbedder) Health(_ context.Context) error { return nil }

func (m *mockEmbedder) Close(_ context.Context) error { return nil }

// Verify mockEmbedder satisfies core.Embedder.
var _ core.Embedder = (*mockEmbedder)(nil)
