// Package bench provides benchmarks for the Neuralgentics memory module.
//
// These benchmarks use an in-memory mock store (benchMockStore) for fast,
// deterministic results that don't require a live PostgreSQL connection.
// For pgvector-specific benchmarks that require a real database, see pgvector_test.go.
package bench

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── In-Memory Mock Store for Benchmarking ──────────────────────────────────────
//
// benchMockStore implements core.Store with in-memory storage.
// It simulates realistic latencies and provides deterministic results
// for benchmarking without requiring a live PostgreSQL database.

type benchMockStore struct {
	mu        sync.RWMutex
	memories  map[string]*core.MemoryEntry
	entities  map[string]*core.Entity
	peers     map[string]*core.PeerProfile
	chains    map[string]*core.ThoughtChain
	thoughts  map[string]*core.Thought
	rels      map[string]*core.Relationship
	idCounter int64
}

func newBenchMockStore() *benchMockStore {
	return &benchMockStore{
		memories: make(map[string]*core.MemoryEntry),
		entities: make(map[string]*core.Entity),
		peers:    make(map[string]*core.PeerProfile),
		chains:   make(map[string]*core.ThoughtChain),
		thoughts: make(map[string]*core.Thought),
		rels:     make(map[string]*core.Relationship),
	}
}

func (m *benchMockStore) nextID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.idCounter++
	return fmt.Sprintf("bench-%d", m.idCounter)
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

func (m *benchMockStore) Initialize(_ context.Context) error { return nil }
func (m *benchMockStore) Close(_ context.Context) error      { return nil }
func (m *benchMockStore) Ping(_ context.Context) error       { return nil }
func (m *benchMockStore) Stats(_ context.Context) (*core.StatusResult, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return &core.StatusResult{
		MemoryCount: len(m.memories),
		EntityCount: len(m.entities),
		PeerCount:   len(m.peers),
		Initialized: true,
		Ready:       true,
	}, nil
}

// ─── Memory CRUD ────────────────────────────────────────────────────────────────

func (m *benchMockStore) AddMemory(_ context.Context, entry *core.MemoryEntry) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry.ID == "" {
		entry.ID = m.nextID()
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now()
		entry.UpdatedAt = time.Now()
	}
	if entry.ContentHash == "" {
		entry.ContentHash = fmt.Sprintf("%x", sha256.Sum256([]byte(entry.Content)))[:32]
	}
	if entry.TrustScore == 0 {
		entry.TrustScore = 0.5
	}
	if entry.ChangeRatio == 0 {
		entry.ChangeRatio = 1.0
	}
	clone := *entry
	m.memories[clone.ID] = &clone
	return clone.ID, nil
}

func (m *benchMockStore) GetMemory(_ context.Context, id string, _ bool) (*core.MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, ok := m.memories[id]
	if !ok {
		return nil, fmt.Errorf("memory %s not found", id)
	}
	clone := *entry
	return &clone, nil
}

func (m *benchMockStore) UpdateMemory(_ context.Context, entry *core.MemoryEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.memories[entry.ID]
	if !ok {
		return fmt.Errorf("memory %s not found", entry.ID)
	}
	existing.Content = entry.Content
	if entry.Metadata != nil {
		existing.Metadata = entry.Metadata
	}
	existing.UpdatedAt = time.Now()
	return nil
}

func (m *benchMockStore) DeleteMemory(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry, ok := m.memories[id]; ok {
		entry.IsArchived = true
	}
	return nil
}

func (m *benchMockStore) CountMemories(_ context.Context) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var count int64
	for _, e := range m.memories {
		if !e.IsArchived {
			count++
		}
	}
	return count, nil
}

func (m *benchMockStore) ListMemories(_ context.Context, filter *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if limit <= 0 {
		limit = 100
	}
	var results []*core.MemoryEntry
	for _, e := range m.memories {
		if e.IsArchived {
			continue
		}
		if filter != nil && len(filter.SourceTypes) > 0 {
			found := false
			for _, st := range filter.SourceTypes {
				if e.SourceType == st {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		clone := *e
		results = append(results, &clone)
		if len(results) >= limit {
			break
		}
	}
	return results, nil
}

func (m *benchMockStore) ContentExists(_ context.Context, contentHash string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, e := range m.memories {
		if e.ContentHash == contentHash && !e.IsArchived {
			return true, nil
		}
	}
	return false, nil
}

// ─── Vector Search (mock: linear scan with cosine similarity) ──────────────────

func (m *benchMockStore) QueryMemoriesByVector(_ context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if opts == nil {
		opts = &core.SearchOptions{TopK: 10, Threshold: 0.7}
	}
	if opts.TopK <= 0 {
		opts.TopK = 10
	}

	type scored struct {
		entry      *core.MemoryEntry
		similarity float64
	}
	var candidates []scored
	for _, e := range m.memories {
		if e.IsArchived || e.Vector == nil {
			continue
		}
		sim := cosineSimilarity(vector, e.Vector)
		if sim >= opts.Threshold {
			clone := *e
			clone.Score = &sim
			candidates = append(candidates, scored{entry: &clone, similarity: sim})
		}
	}

	// Sort by similarity descending (simple insertion sort for benchmark)
	for i := 1; i < len(candidates); i++ {
		for j := i; j > 0 && candidates[j].similarity > candidates[j-1].similarity; j-- {
			candidates[j], candidates[j-1] = candidates[j-1], candidates[j]
		}
	}

	if len(candidates) > opts.TopK {
		candidates = candidates[:opts.TopK]
	}

	results := make([]*core.MemoryEntry, len(candidates))
	for i, c := range candidates {
		results[i] = c.entry
	}
	return results, nil
}

func (m *benchMockStore) SearchMemoriesText(_ context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if opts == nil {
		opts = &core.SearchOptions{TopK: 10}
	}
	if opts.TopK <= 0 {
		opts.TopK = 10
	}

	var results []*core.MemoryEntry
	for _, e := range m.memories {
		if e.IsArchived {
			continue
		}
		// Simple contains match for benchmark
		clone := *e
		results = append(results, &clone)
		if len(results) >= opts.TopK {
			break
		}
	}
	return results, nil
}

func (m *benchMockStore) GetSimilar(_ context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	m.mu.RLock()
	entry, ok := m.memories[memoryID]
	m.mu.RUnlock()
	if !ok || entry.Vector == nil {
		return nil, nil
	}
	return m.QueryMemoriesByVector(context.Background(), entry.Vector, opts)
}

// ─── Trust Fields ───────────────────────────────────────────────────────────────

func (m *benchMockStore) UpdateTrustFields(_ context.Context, id string, trustScore float64, archived bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.memories[id]; ok {
		e.TrustScore = trustScore
		if archived {
			e.IsArchived = true
		}
	}
	return nil
}

func (m *benchMockStore) IncrementRetrievalCount(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.memories[id]; ok {
		e.RetrievalCount++
	}
	return nil
}

// ─── Relationships (stubs) ──────────────────────────────────────────────────────

func (m *benchMockStore) CreateRelationship(_ context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	id := m.nextID()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rels[id] = &core.Relationship{
		SourceID:         sourceID,
		TargetID:         targetID,
		RelationshipType: relType,
		Confidence:       confidence,
	}
	return id, nil
}

func (m *benchMockStore) DeleteRelationship(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rels, id)
	return nil
}

func (m *benchMockStore) GetRelationships(_ context.Context, memoryID string) ([]core.Relationship, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var results []core.Relationship
	for _, r := range m.rels {
		if r.SourceID == memoryID || r.TargetID == memoryID {
			results = append(results, *r)
		}
	}
	return results, nil
}

func (m *benchMockStore) GetRelationshipSummary(_ context.Context, memoryID string) (*core.RelationshipSummary, error) {
	rels, err := m.GetRelationships(context.Background(), memoryID)
	if err != nil {
		return nil, err
	}
	byType := make(map[string]int)
	for _, r := range rels {
		byType[r.RelationshipType]++
	}
	return &core.RelationshipSummary{
		MemoryID:           memoryID,
		TotalRelationships: len(rels),
		ByType:             byType,
	}, nil
}

func (m *benchMockStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	return nil, nil
}
func (m *benchMockStore) GetSuperseded(_ context.Context, _ string) (string, error) {
	return "", nil
}

// ─── Entity Operations (stubs) ──────────────────────────────────────────────────

func (m *benchMockStore) UpsertEntity(_ context.Context, entity *core.Entity) (string, error) {
	if entity.ID == "" {
		entity.ID = m.nextID()
	}
	clone := *entity
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entities[clone.ID] = &clone
	return clone.ID, nil
}
func (m *benchMockStore) GetEntity(_ context.Context, id string) (*core.Entity, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.entities[id]
	if !ok {
		return nil, fmt.Errorf("entity %s not found", id)
	}
	clone := *e
	return &clone, nil
}
func (m *benchMockStore) GetEntitiesByType(_ context.Context, entityType string, limit int) ([]*core.Entity, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var results []*core.Entity
	for _, e := range m.entities {
		if e.EntityType == entityType {
			clone := *e
			results = append(results, &clone)
			if len(results) >= limit {
				break
			}
		}
	}
	return results, nil
}
func (m *benchMockStore) SearchEntities(_ context.Context, name string, limit int) ([]*core.Entity, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var results []*core.Entity
	for _, e := range m.entities {
		clone := *e
		results = append(results, &clone)
		if len(results) >= limit {
			break
		}
	}
	return results, nil
}
func (m *benchMockStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	return m.nextID(), nil
}
func (m *benchMockStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *benchMockStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error { return nil }
func (m *benchMockStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	return nil, nil
}

// ─── Peer Operations (stubs) ───────────────────────────────────────────────────

func (m *benchMockStore) AddPeer(_ context.Context, peer *core.PeerProfile) (string, error) {
	if peer.ID == "" {
		peer.ID = m.nextID()
	}
	clone := *peer
	m.mu.Lock()
	defer m.mu.Unlock()
	m.peers[clone.ID] = &clone
	return clone.ID, nil
}
func (m *benchMockStore) GetPeer(_ context.Context, id string) (*core.PeerProfile, error) {
	return nil, fmt.Errorf("stub")
}
func (m *benchMockStore) ListPeers(_ context.Context, limit int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (m *benchMockStore) UpdatePeerLastActive(_ context.Context, _ string) error { return nil }

// ─── Memory Sharing (stubs) ────────────────────────────────────────────────────

func (m *benchMockStore) ShareMemory(_ context.Context, _, _, _, _ string) (string, error) {
	return m.nextID(), nil
}
func (m *benchMockStore) RevokeShareMemory(_ context.Context, _, _ string) error { return nil }
func (m *benchMockStore) GetSharedMemories(_ context.Context, _ string, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *benchMockStore) GetPeerMemories(_ context.Context, _, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// ─── Thought Chain Operations (stubs) ──────────────────────────────────────────

func (m *benchMockStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) {
	return m.nextID(), nil
}
func (m *benchMockStore) AddThought(_ context.Context, _ string, thought *core.Thought) (string, error) {
	return m.nextID(), nil
}
func (m *benchMockStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	return nil, nil
}
func (m *benchMockStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (m *benchMockStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	return nil, nil
}
func (m *benchMockStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	return nil, nil
}
func (m *benchMockStore) PauseThoughtChain(_ context.Context, _ string) error   { return nil }
func (m *benchMockStore) ResumeThoughtChain(_ context.Context, _ string) error  { return nil }
func (m *benchMockStore) AbandonThoughtChain(_ context.Context, _ string) error { return nil }

// ─── Audit (stubs) ────────────────────────────────────────────────────────────

func (m *benchMockStore) LogAuditEvent(_ context.Context, _ *core.AuditEvent) (string, error) {
	return m.nextID(), nil
}
func (m *benchMockStore) GetAuditEvents(_ context.Context, _, _ string, _ int) ([]*core.AuditEvent, error) {
	return nil, nil
}

// ─── Trust Adjustments (stubs) ──────────────────────────────────────────────────

func (m *benchMockStore) LogTrustAdjustment(_ context.Context, _ *core.TrustAdjustment) (string, error) {
	return m.nextID(), nil
}
func (m *benchMockStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}

// ─── Decay (stubs) ─────────────────────────────────────────────────────────────

func (m *benchMockStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error { return nil }
func (m *benchMockStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// ─── Project Indexer (stubs) ─────────────────────────────────────────────────────

func (m *benchMockStore) AddProjectChunk(_ context.Context, _ *core.ChunkResult) (string, error) {
	return m.nextID(), nil
}
func (m *benchMockStore) DeleteChunksByPath(_ context.Context, _ string) error { return nil }
func (m *benchMockStore) SearchChunks(_ context.Context, _ []float64, _ *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	return nil, nil
}
func (m *benchMockStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	return nil, nil
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

// cosineSimilarity computes cosine similarity between two vectors.
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
	return dot / (sqrt(normA) * sqrt(normB))
}

// sqrt returns the square root of x.
func sqrt(x float64) float64 {
	if x <= 0 {
		return 0
	}
	// Newton's method for sqrt
	z := x
	for i := 0; i < 20; i++ {
		z = (z + x/z) / 2
	}
	return z
}

// randomVector generates a random normalized vector of the given dimension.
func randomVector(dim int, rng *rand.Rand) []float64 {
	vec := make([]float64, dim)
	var norm float64
	for i := range vec {
		vec[i] = rng.NormFloat64()
		norm += vec[i] * vec[i]
	}
	norm = sqrt(norm)
	for i := range vec {
		vec[i] /= norm
	}
	return vec
}

// ─── Benchmarks ─────────────────────────────────────────────────────────────────

// benchDimension is the embedding vector dimension for benchmarks.
const benchDimension = 384

// BenchmarkAddMemory benchmarks memory insertion performance.
func BenchmarkAddMemory(b *testing.B) {
	store := newBenchMockStore()
	ctx := context.Background()
	rng := rand.New(rand.NewSource(42))

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		entry := &core.MemoryEntry{
			Content:     fmt.Sprintf("benchmark memory content %d", i),
			SourceType:  "session",
			ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("content-%d", i))))[:32],
			TrustScore:  0.5,
			Vector:      randomVector(benchDimension, rng),
		}
		_, err := store.AddMemory(ctx, entry)
		if err != nil {
			b.Fatalf("AddMemory failed: %v", err)
		}
	}
}

// BenchmarkQueryMemories benchmarks vector similarity search (top-10).
func BenchmarkQueryMemories(b *testing.B) {
	store := newBenchMockStore()
	ctx := context.Background()
	rng := rand.New(rand.NewSource(42))

	// Pre-populate with 1000 memories
	const numMemories = 1000
	for i := 0; i < numMemories; i++ {
		entry := &core.MemoryEntry{
			Content:     fmt.Sprintf("pre-populated memory %d", i),
			SourceType:  "session",
			ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("pre-%d", i))))[:32],
			TrustScore:  0.5 + float64(i%5)*0.1,
			Vector:      randomVector(benchDimension, rng),
		}
		if _, err := store.AddMemory(ctx, entry); err != nil {
			b.Fatalf("pre-populate failed: %v", err)
		}
	}

	// Generate a query vector
	queryVec := randomVector(benchDimension, rng)

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, err := store.QueryMemoriesByVector(ctx, queryVec, &core.SearchOptions{TopK: 10, Threshold: 0.5})
		if err != nil {
			b.Fatalf("QueryMemoriesByVector failed: %v", err)
		}
	}
}

// BenchmarkGetMemory benchmarks ID-based memory lookup.
func BenchmarkGetMemory(b *testing.B) {
	store := newBenchMockStore()
	ctx := context.Background()

	// Pre-populate
	const numMemories = 1000
	ids := make([]string, numMemories)
	for i := 0; i < numMemories; i++ {
		entry := &core.MemoryEntry{
			Content:     fmt.Sprintf("lookup memory %d", i),
			SourceType:  "session",
			ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("lookup-%d", i))))[:32],
			TrustScore:  0.5,
		}
		id, err := store.AddMemory(ctx, entry)
		if err != nil {
			b.Fatalf("pre-populate failed: %v", err)
		}
		ids[i] = id
	}

	rng := rand.New(rand.NewSource(42))

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		idx := rng.Intn(numMemories)
		_, err := store.GetMemory(ctx, ids[idx], false)
		if err != nil {
			b.Fatalf("GetMemory failed: %v", err)
		}
	}
}

// BenchmarkHybridSearch benchmarks hybrid search (text + vector combined).
func BenchmarkHybridSearch(b *testing.B) {
	store := newBenchMockStore()
	ctx := context.Background()
	rng := rand.New(rand.NewSource(42))

	// Pre-populate with 500 memories
	const numMemories = 500
	for i := 0; i < numMemories; i++ {
		entry := &core.MemoryEntry{
			Content:     fmt.Sprintf("hybrid search test content about topic %d with keywords algorithm data", i),
			SourceType:  "session",
			ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("hybrid-%d", i))))[:32],
			TrustScore:  0.5 + float64(i%3)*0.15,
			Vector:      randomVector(benchDimension, rng),
		}
		if _, err := store.AddMemory(ctx, entry); err != nil {
			b.Fatalf("pre-populate failed: %v", err)
		}
	}

	queries := []string{
		"algorithm optimization",
		"data processing technique",
		"memory retrieval system",
		"neural network training",
		"vector similarity search",
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		query := queries[i%len(queries)]
		_, err := store.SearchMemoriesText(ctx, query, &core.SearchOptions{TopK: 10})
		if err != nil {
			b.Fatalf("SearchMemoriesText failed: %v", err)
		}
	}
}

// BenchmarkBatchInsert benchmarks batch insertion of 100 memories.
func BenchmarkBatchInsert(b *testing.B) {
	rng := rand.New(rand.NewSource(42))

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		store := newBenchMockStore()
		ctx := context.Background()
		for j := 0; j < 100; j++ {
			entry := &core.MemoryEntry{
				Content:     fmt.Sprintf("batch memory %d-%d", i, j),
				SourceType:  "session",
				ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("batch-%d-%d", i, j))))[:32],
				TrustScore:  0.5,
				Vector:      randomVector(benchDimension, rng),
			}
			if _, err := store.AddMemory(ctx, entry); err != nil {
				b.Fatalf("AddMemory failed: %v", err)
			}
		}
	}
}

// BenchmarkAddMemoryParallel benchmarks concurrent memory insertion.
func BenchmarkAddMemoryParallel(b *testing.B) {
	store := newBenchMockStore()
	ctx := context.Background()

	b.ResetTimer()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		rng := rand.New(rand.NewSource(42))
		i := 0
		for pb.Next() {
			entry := &core.MemoryEntry{
				Content:     fmt.Sprintf("parallel memory %d", i),
				SourceType:  "session",
				ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("par-%d", i))))[:32],
				TrustScore:  0.5,
				Vector:      randomVector(benchDimension, rng),
			}
			_, _ = store.AddMemory(ctx, entry)
			i++
		}
	})
}

// BenchmarkQueryMemoriesParallel benchmarks concurrent vector search.
func BenchmarkQueryMemoriesParallel(b *testing.B) {
	store := newBenchMockStore()
	ctx := context.Background()
	rng := rand.New(rand.NewSource(42))

	// Pre-populate with 500 memories
	for i := 0; i < 500; i++ {
		entry := &core.MemoryEntry{
			Content:     fmt.Sprintf("parallel query memory %d", i),
			SourceType:  "session",
			ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("pq-%d", i))))[:32],
			TrustScore:  0.5,
			Vector:      randomVector(benchDimension, rng),
		}
		if _, err := store.AddMemory(ctx, entry); err != nil {
			b.Fatalf("pre-populate failed: %v", err)
		}
	}

	b.ResetTimer()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		rng := rand.New(rand.NewSource(42))
		for pb.Next() {
			queryVec := randomVector(benchDimension, rng)
			_, _ = store.QueryMemoriesByVector(ctx, queryVec, &core.SearchOptions{TopK: 10, Threshold: 0.5})
		}
	})
}
