package index

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// --- Mock implementations ---

// mockIndexerStore implements core.Store with functional project chunk methods.
type mockIndexerStore struct {
	mu       sync.Mutex
	chunks   map[string]*core.ChunkResult // chunkID → chunk
	byPath   map[string][]string          // filePath → []chunkID
	nextID   int
	embedErr error // optional: inject embed error

	// blockAddChunk and unblockAddChunk are used by concurrent-indexing tests
	// to signal when AddProjectChunk is entered and to unblock it.
	// When blockAddChunk is non-nil, AddProjectChunk sends a value on it
	// (signaling it has been called) then waits on unblockAddChunk before returning.
	blockAddChunk   chan struct{}
	unblockAddChunk chan struct{}
}

func newMockIndexerStore() *mockIndexerStore {
	return &mockIndexerStore{
		chunks: make(map[string]*core.ChunkResult),
		byPath: make(map[string][]string),
	}
}

func (m *mockIndexerStore) AddProjectChunk(_ context.Context, chunk *core.ChunkResult) (string, error) {
	// Signal entry and wait for unblock if configured (for concurrent test synchronization).
	if m.blockAddChunk != nil {
		m.blockAddChunk <- struct{}{}
		<-m.unblockAddChunk
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	id := fmt.Sprintf("chunk-%d", m.nextID)
	clone := *chunk
	clone.Score = 0
	m.chunks[id] = &clone
	m.byPath[chunk.FilePath] = append(m.byPath[chunk.FilePath], id)
	return id, nil
}

func (m *mockIndexerStore) DeleteChunksByPath(_ context.Context, path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids, ok := m.byPath[path]
	if !ok {
		return nil
	}
	for _, id := range ids {
		delete(m.chunks, id)
	}
	delete(m.byPath, path)
	return nil
}

func (m *mockIndexerStore) SearchChunks(_ context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.ChunkResult
	for _, chunk := range m.chunks {
		clone := *chunk
		clone.Score = 0.95 // mock score
		results = append(results, &clone)
	}
	limit := 10
	if opts != nil && opts.TopK > 0 {
		limit = opts.TopK
	}
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (m *mockIndexerStore) GetChunkCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.chunks)
}

func (m *mockIndexerStore) GetPathCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.byPath)
}

// --- Stub implementations for remaining core.Store methods ---

func (m *mockIndexerStore) Initialize(_ context.Context) error { return nil }
func (m *mockIndexerStore) Close(_ context.Context) error      { return nil }
func (m *mockIndexerStore) Ping(_ context.Context) error       { return nil }
func (m *mockIndexerStore) Stats(_ context.Context) (*core.StatusResult, error) {
	return &core.StatusResult{}, nil
}
func (m *mockIndexerStore) AddMemory(_ context.Context, _ *core.MemoryEntry) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) GetMemory(_ context.Context, _ string, _ bool) (*core.MemoryEntry, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockIndexerStore) UpdateMemory(_ context.Context, _ *core.MemoryEntry) error { return nil }
func (m *mockIndexerStore) DeleteMemory(_ context.Context, _ string) error            { return nil }
func (m *mockIndexerStore) CountMemories(_ context.Context) (int64, error)            { return 0, nil }
func (m *mockIndexerStore) ListMemories(_ context.Context, _ *core.SearchFilter, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerStore) ContentExists(_ context.Context, _ string) (bool, error) {
	return false, nil
}
func (m *mockIndexerStore) QueryMemoriesByVector(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerStore) SearchMemoriesText(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetSimilar(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerStore) UpdateTrustFields(_ context.Context, _ string, _ float64, _ bool) error {
	return nil
}
func (m *mockIndexerStore) IncrementRetrievalCount(_ context.Context, _ string) error { return nil }
func (m *mockIndexerStore) CreateRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) DeleteRelationship(_ context.Context, _ string) error { return nil }
func (m *mockIndexerStore) GetRelationships(_ context.Context, _ string) ([]core.Relationship, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetRelationshipSummary(_ context.Context, _ string) (*core.RelationshipSummary, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetSuperseded(_ context.Context, _ string) (string, error) { return "", nil }
func (m *mockIndexerStore) UpsertEntity(_ context.Context, _ *core.Entity) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) GetEntity(_ context.Context, _ string) (*core.Entity, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetEntitiesByType(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockIndexerStore) SearchEntities(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockIndexerStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockIndexerStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error { return nil }
func (m *mockIndexerStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockIndexerStore) AddPeer(_ context.Context, _ *core.PeerProfile) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) GetPeer(_ context.Context, _ string) (*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockIndexerStore) ListPeers(_ context.Context, _ int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockIndexerStore) UpdatePeerLastActive(_ context.Context, _ string) error { return nil }
func (m *mockIndexerStore) ShareMemory(_ context.Context, _, _, _, _ string) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) RevokeShareMemory(_ context.Context, _, _ string) error { return nil }
func (m *mockIndexerStore) GetSharedMemories(_ context.Context, _ string, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetPeerMemories(_ context.Context, _, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) AddThought(_ context.Context, _ string, _ *core.Thought) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockIndexerStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockIndexerStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockIndexerStore) PauseThoughtChain(_ context.Context, _ string) error   { return nil }
func (m *mockIndexerStore) ResumeThoughtChain(_ context.Context, _ string) error  { return nil }
func (m *mockIndexerStore) AbandonThoughtChain(_ context.Context, _ string) error { return nil }
func (m *mockIndexerStore) LogAuditEvent(_ context.Context, _ *core.AuditEvent) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) GetAuditEvents(_ context.Context, _, _ string, _ int) ([]*core.AuditEvent, error) {
	return nil, nil
}
func (m *mockIndexerStore) LogTrustAdjustment(_ context.Context, _ *core.TrustAdjustment) (string, error) {
	return "", nil
}
func (m *mockIndexerStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}
func (m *mockIndexerStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error { return nil }
func (m *mockIndexerStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	return nil, fmt.Errorf("not implemented")
}

// v0.7.0 1024-dim methods
func (m *mockIndexerStore) Has1024Support(_ context.Context) bool { return false }
func (m *mockIndexerStore) AddMemory1024(_ context.Context, _ string, _ []float64) (string, error) {
	return "", fmt.Errorf("not implemented")
}
func (m *mockIndexerStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	return nil, fmt.Errorf("not found")
}
func (m *mockIndexerStore) CountMemories1024(_ context.Context) (int64, error) { return 0, nil }
func (m *mockIndexerStore) DeleteMemory1024(_ context.Context, _ string) error { return nil }

// mockEmbedder implements core.Embedder for testing.
type mockEmbedder struct {
	mu             sync.Mutex
	calls          int
	dim            int
	embedFn        func(texts []string) ([][]float64, error)
	embedSingleErr error // if set, Embed returns this error
}

func newMockEmbedder() *mockEmbedder {
	return &mockEmbedder{
		dim: 384,
		embedFn: func(texts []string) ([][]float64, error) {
			vecs := make([][]float64, len(texts))
			for i := range texts {
				vecs[i] = make([]float64, 384)
				vecs[i][0] = float64(i + 1) // distinguish vectors
			}
			return vecs, nil
		},
	}
}

func (m *mockEmbedder) Embed(_ context.Context, _ string) ([]float64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if m.embedSingleErr != nil {
		return nil, m.embedSingleErr
	}
	vec := make([]float64, m.dim)
	vec[0] = float64(m.calls)
	return vec, nil
}

func (m *mockEmbedder) Embed1024(_ context.Context, _ string) ([]float64, error) {
	return make([]float64, 1024), nil
}

func (m *mockEmbedder) Dim() int { return m.dim }

func (m *mockEmbedder) EmbedBatch(_ context.Context, texts []string) ([][]float64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if m.embedFn != nil {
		return m.embedFn(texts)
	}
	vecs := make([][]float64, len(texts))
	for i := range texts {
		vecs[i] = make([]float64, m.dim)
		vecs[i][0] = float64(i + 1)
	}
	return vecs, nil
}

func (m *mockEmbedder) Health(_ context.Context) error { return nil }
func (m *mockEmbedder) Close(_ context.Context) error  { return nil }

func (m *mockEmbedder) getCalls() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

// --- ProjectIndexer tests ---

func TestNewProjectIndexer(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	if pi == nil {
		t.Fatal("NewProjectIndexer returned nil")
	}
	if pi.tracker == nil {
		t.Error("tracker should not be nil")
	}
	if pi.chunker == nil {
		t.Error("chunker should not be nil")
	}
}

func TestProjectIndexer_IsIndexing_InitiallyFalse(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	if pi.IsIndexing(context.Background()) {
		t.Error("IsIndexing should be false initially")
	}
}

func TestProjectIndexer_Index_NonexistentPath(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	err := pi.Index(context.Background(), "/nonexistent/path/that/does/not/exist", nil)
	if err == nil {
		t.Error("expected error for nonexistent path, got nil")
	}
}

func TestProjectIndexer_Index_NotADirectory(t *testing.T) {
	tmpDir := t.TempDir()
	tmpFile := filepath.Join(tmpDir, "notadir.txt")
	if err := os.WriteFile(tmpFile, []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	err := pi.Index(context.Background(), tmpFile, nil)
	if err == nil {
		t.Error("expected error for file path (not directory), got nil")
	}
}

func TestProjectIndexer_Index_EmptyDirectory(t *testing.T) {
	tmpDir := t.TempDir()

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	err := pi.Index(context.Background(), tmpDir, nil)
	if err != nil {
		t.Fatalf("Index on empty dir returned error: %v", err)
	}
	if pi.IsIndexing(context.Background()) {
		t.Error("IsIndexing should be false after indexing completes")
	}
}

func TestProjectIndexer_Index_SingleFile(t *testing.T) {
	tmpDir := t.TempDir()
	content := []byte("package main\n\nfunc main() {\n\tfmt.Println(\"hello\")\n}\n")
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	err := pi.Index(context.Background(), tmpDir, &core.IndexOptions{Force: true})
	if err != nil {
		t.Fatalf("Index returned error: %v", err)
	}

	// Should have stored chunks
	if store.GetChunkCount() == 0 {
		t.Error("expected at least one chunk to be stored")
	}
}

func TestProjectIndexer_Index_SkipsIgnoredDirs(t *testing.T) {
	tmpDir := t.TempDir()
	// Create a real Go file and a file in node_modules
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	nodeDir := filepath.Join(tmpDir, "node_modules")
	if err := os.MkdirAll(nodeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nodeDir, "pkg.js"), []byte("var x = 1"), 0o644); err != nil {
		t.Fatal(err)
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	err := pi.Index(context.Background(), tmpDir, &core.IndexOptions{Force: true})
	if err != nil {
		t.Fatalf("Index returned error: %v", err)
	}

	// Only main.go should be indexed, node_modules/pkg.js should be skipped
	if store.GetPathCount() != 1 {
		t.Errorf("expected 1 path indexed, got %d", store.GetPathCount())
	}
}

func TestProjectIndexer_Index_SkipsUnchangedFiles(t *testing.T) {
	tmpDir := t.TempDir()
	content := []byte("package main\n\nfunc main() {}\n")
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	// First index
	err := pi.Index(context.Background(), tmpDir, &core.IndexOptions{Force: false})
	if err != nil {
		t.Fatalf("first Index returned error: %v", err)
	}
	firstChunkCount := store.GetChunkCount()

	// Second index without force — should skip unchanged files
	err = pi.Index(context.Background(), tmpDir, &core.IndexOptions{Force: false})
	if err != nil {
		t.Fatalf("second Index returned error: %v", err)
	}
	// Chunk count should be the same (old chunks not deleted since file was skipped)
	if store.GetChunkCount() != firstChunkCount {
		t.Errorf("second index: chunk count changed from %d to %d (should skip unchanged)", firstChunkCount, store.GetChunkCount())
	}
}

func TestProjectIndexer_Index_ForceReindex(t *testing.T) {
	tmpDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	// First index
	_ = pi.Index(context.Background(), tmpDir, &core.IndexOptions{Force: true})
	firstCount := store.GetChunkCount()

	// Force reindex
	_ = pi.Index(context.Background(), tmpDir, &core.IndexOptions{Force: true})
	secondCount := store.GetChunkCount()

	if firstCount == 0 {
		t.Error("expected chunks from first index")
	}
	if secondCount == 0 {
		t.Error("expected chunks from force reindex")
	}
	// Force reindex should produce the same number of chunks (deletes old then re-adds)
	if firstCount != secondCount {
		t.Errorf("force reindex chunk count: first=%d, second=%d (should be equal)", firstCount, secondCount)
	}
}

func TestProjectIndexer_Index_CancelledContext(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping context cancellation test in short mode")
	}

	tmpDir := t.TempDir()
	// Create multiple files so indexing takes some time
	for i := 0; i < 20; i++ {
		name := filepath.Join(tmpDir, fmt.Sprintf("file%d.go", i))
		if err := os.WriteFile(name, []byte("package main\nfunc main() {}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	err := pi.Index(ctx, tmpDir, &core.IndexOptions{Force: true})
	if err == nil {
		t.Error("expected error from cancelled context, got nil")
	}
}

func TestProjectIndexer_Index_ConcurrentIndexing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping concurrent test in short mode")
	}

	tmpDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	// Block the mock store's AddProjectChunk so the first Index() call
	// stays in progress long enough for the second call to detect it.
	store.blockAddChunk = make(chan struct{})
	store.unblockAddChunk = make(chan struct{})

	// Start first indexing in a goroutine.
	firstDone := make(chan error, 1)
	go func() {
		err := pi.Index(context.Background(), tmpDir, &core.IndexOptions{Force: true})
		firstDone <- err
	}()

	// Wait until the first Index() call is inside AddProjectChunk.
	// Signal that we're ready for the concurrent call.
	select {
	case <-store.blockAddChunk:
		// First call is now inside AddProjectChunk and blocked.
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for first Index() to start")
	}

	// Try to start second indexing — should fail with "indexing already in progress".
	err := pi.Index(context.Background(), tmpDir, &core.IndexOptions{Force: true})
	if err == nil {
		t.Error("expected error for concurrent indexing, got nil")
	} else if err.Error() != "indexing already in progress" {
		t.Errorf("expected 'indexing already in progress' error, got: %v", err)
	}

	// Unblock the first Index() call so it can complete.
	close(store.unblockAddChunk)

	// Wait for first indexing to complete.
	if err := <-firstDone; err != nil {
		t.Fatalf("first Index() returned error: %v", err)
	}
}

func TestProjectIndexer_Search(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	// Add a chunk manually for searching
	chunk := &core.ChunkResult{
		FilePath:  "main.go",
		Content:   "package main\nfunc main() {}",
		Score:     0,
		StartLine: 1,
		EndLine:   2,
	}
	store.AddProjectChunk(context.Background(), chunk)

	results, err := pi.Search(context.Background(), "main function", &core.SearchProjectOptions{TopK: 10, Threshold: 0.5})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(results) == 0 {
		t.Error("expected at least one search result")
	}
}

func TestProjectIndexer_Search_DefaultOptions(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	// Add a chunk manually
	chunk := &core.ChunkResult{
		FilePath:  "app.go",
		Content:   "test content",
		Score:     0,
		StartLine: 1,
		EndLine:   1,
	}
	store.AddProjectChunk(context.Background(), chunk)

	// Search with nil options — should use defaults
	results, err := pi.Search(context.Background(), "test", nil)
	if err != nil {
		t.Fatalf("Search with nil opts returned error: %v", err)
	}
	if len(results) == 0 {
		t.Error("expected at least one search result")
	}
}

func TestProjectIndexer_Search_EmbedError(t *testing.T) {
	store := newMockIndexerStore()
	embedder := &mockEmbedder{
		dim:            384,
		embedSingleErr: fmt.Errorf("embed error"),
	}

	pi := NewProjectIndexer(store, embedder)

	_, err := pi.Search(context.Background(), "test", nil)
	if err == nil {
		t.Error("expected error from embed failure, got nil")
	}
}

func TestProjectIndexer_GetTracker(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	pi := NewProjectIndexer(store, embedder)

	tracker := pi.GetTracker()
	if tracker == nil {
		t.Error("GetTracker returned nil")
	}
}

// Phase 2 part 1 stubs for new core.Store interface methods

func (m *mockIndexerStore) GetUserProfile(ctx context.Context, peerID string) (*core.UserProfile, error) {
	return nil, nil
}

func (m *mockIndexerStore) UpsertUserProfile(ctx context.Context, profile *core.UserProfile) error {
	return nil
}

func (m *mockIndexerStore) GetSecuritySummary(ctx context.Context, hours int) (*core.SecuritySummary, error) {
	return &core.SecuritySummary{}, nil
}

// Phase 3 stubs for agent_tools interface methods
func (m *mockIndexerStore) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	return nil
}

func (m *mockIndexerStore) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	return false, nil
}

func (m *mockIndexerStore) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	return nil, nil
}
