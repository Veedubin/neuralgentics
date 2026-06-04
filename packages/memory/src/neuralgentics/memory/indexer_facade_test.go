package memory

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockIndexerFacadeStore implements core.Store with only indexer-related methods
// functional. All other methods are stubbed.
type mockIndexerFacadeStore struct {
	chunks   map[string]*core.ChunkResult // chunkID → chunk
	byPath   map[string][]string          // filePath → []chunkID
	fileData map[string]*core.FileContentsResult
	nextID   int
}

func newMockIndexerFacadeStore() *mockIndexerFacadeStore {
	return &mockIndexerFacadeStore{
		chunks:   make(map[string]*core.ChunkResult),
		byPath:   make(map[string][]string),
		fileData: make(map[string]*core.FileContentsResult),
	}
}

func (m *mockIndexerFacadeStore) AddProjectChunk(_ context.Context, chunk *core.ChunkResult) (string, error) {
	m.nextID++
	id := fmt.Sprintf("chunk-%d", m.nextID)
	clone := *chunk
	m.chunks[id] = &clone
	m.byPath[chunk.FilePath] = append(m.byPath[chunk.FilePath], id)
	return id, nil
}

func (m *mockIndexerFacadeStore) DeleteChunksByPath(_ context.Context, path string) error {
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

func (m *mockIndexerFacadeStore) SearchChunks(_ context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	var results []*core.ChunkResult
	for _, chunk := range m.chunks {
		clone := *chunk
		clone.Score = 0.95
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

func (m *mockIndexerFacadeStore) GetFileChunksByPath(_ context.Context, filePath string) (*core.FileContentsResult, error) {
	result, ok := m.fileData[filePath]
	if !ok {
		return nil, nil
	}
	return result, nil
}

// --- Stub implementations for remaining core.Store methods ---

func (m *mockIndexerFacadeStore) Initialize(_ context.Context) error { return nil }
func (m *mockIndexerFacadeStore) Close(_ context.Context) error      { return nil }
func (m *mockIndexerFacadeStore) Ping(_ context.Context) error       { return nil }
func (m *mockIndexerFacadeStore) Stats(_ context.Context) (*core.StatusResult, error) {
	return &core.StatusResult{}, nil
}
func (m *mockIndexerFacadeStore) AddMemory(_ context.Context, _ *core.MemoryEntry) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) GetMemory(_ context.Context, _ string, _ bool) (*core.MemoryEntry, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockIndexerFacadeStore) UpdateMemory(_ context.Context, _ *core.MemoryEntry) error {
	return nil
}
func (m *mockIndexerFacadeStore) DeleteMemory(_ context.Context, _ string) error { return nil }
func (m *mockIndexerFacadeStore) CountMemories(_ context.Context) (int64, error) { return 0, nil }
func (m *mockIndexerFacadeStore) ListMemories(_ context.Context, _ *core.SearchFilter, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) ContentExists(_ context.Context, _ string) (bool, error) {
	return false, nil
}
func (m *mockIndexerFacadeStore) QueryMemoriesByVector(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) SearchMemoriesText(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetSimilar(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) UpdateTrustFields(_ context.Context, _ string, _ float64, _ bool) error {
	return nil
}
func (m *mockIndexerFacadeStore) IncrementRetrievalCount(_ context.Context, _ string) error {
	return nil
}
func (m *mockIndexerFacadeStore) CreateRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) DeleteRelationship(_ context.Context, _ string) error { return nil }
func (m *mockIndexerFacadeStore) GetRelationships(_ context.Context, _ string) ([]core.Relationship, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetRelationshipSummary(_ context.Context, _ string) (*core.RelationshipSummary, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetSuperseded(_ context.Context, _ string) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) UpsertEntity(_ context.Context, _ *core.Entity) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) GetEntity(_ context.Context, _ string) (*core.Entity, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetEntitiesByType(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) SearchEntities(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error {
	return nil
}
func (m *mockIndexerFacadeStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) AddPeer(_ context.Context, _ *core.PeerProfile) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) GetPeer(_ context.Context, _ string) (*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) ListPeers(_ context.Context, _ int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) UpdatePeerLastActive(_ context.Context, _ string) error { return nil }
func (m *mockIndexerFacadeStore) ShareMemory(_ context.Context, _, _, _, _ string) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) RevokeShareMemory(_ context.Context, _, _ string) error { return nil }
func (m *mockIndexerFacadeStore) GetSharedMemories(_ context.Context, _ string, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetPeerMemories(_ context.Context, _, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) AddThought(_ context.Context, _ string, _ *core.Thought) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) PauseThoughtChain(_ context.Context, _ string) error   { return nil }
func (m *mockIndexerFacadeStore) ResumeThoughtChain(_ context.Context, _ string) error  { return nil }
func (m *mockIndexerFacadeStore) AbandonThoughtChain(_ context.Context, _ string) error { return nil }
func (m *mockIndexerFacadeStore) LogAuditEvent(_ context.Context, _ *core.AuditEvent) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) GetAuditEvents(_ context.Context, _, _ string, _ int) ([]*core.AuditEvent, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) LogTrustAdjustment(_ context.Context, _ *core.TrustAdjustment) (string, error) {
	return "", nil
}
func (m *mockIndexerFacadeStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error {
	return nil
}
func (m *mockIndexerFacadeStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetUserProfile(_ context.Context, _ string) (*core.UserProfile, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) UpsertUserProfile(_ context.Context, _ *core.UserProfile) error {
	return nil
}
func (m *mockIndexerFacadeStore) GetSecuritySummary(_ context.Context, _ int) (*core.SecuritySummary, error) {
	return &core.SecuritySummary{}, nil
}

// v0.7.0 1024-dim methods
func (m *mockIndexerFacadeStore) Has1024Support(_ context.Context) bool { return false }
func (m *mockIndexerFacadeStore) AddMemory1024(_ context.Context, _ string, _ []float64) (string, error) {
	return "", fmt.Errorf("not implemented")
}
func (m *mockIndexerFacadeStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockIndexerFacadeStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	return nil, fmt.Errorf("not found")
}
func (m *mockIndexerFacadeStore) CountMemories1024(_ context.Context) (int64, error) { return 0, nil }
func (m *mockIndexerFacadeStore) DeleteMemory1024(_ context.Context, _ string) error { return nil }

func (m *mockIndexerFacadeStore) GetChunkCount() int { return len(m.chunks) }
func (m *mockIndexerFacadeStore) GetPathCount() int  { return len(m.byPath) }
func (m *mockIndexerFacadeStore) SetFileData(path, contents string, isPartial bool) {
	m.fileData[path] = &core.FileContentsResult{
		FilePath:  path,
		Contents:  contents,
		IsPartial: isPartial,
	}
}

// --- Facade tests ---

func TestSearchProject(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	// Add a chunk manually for searching
	chunk := &core.ChunkResult{
		FilePath:  "main.go",
		Content:   "package main\nfunc main() {}",
		Score:     0.95,
		StartLine: 1,
		EndLine:   2,
	}
	store.AddProjectChunk(context.Background(), chunk)

	results, err := memSys.SearchProject(context.Background(), "main function", 10, nil, nil)
	if err != nil {
		t.Fatalf("SearchProject returned error: %v", err)
	}
	if len(results) == 0 {
		t.Error("expected at least one search result")
	}
}

func TestSearchProject_EmptyQuery(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	_, err := memSys.SearchProject(context.Background(), "", 10, nil, nil)
	if err == nil {
		t.Error("expected error for empty query, got nil")
	}
}

func TestSearchProject_DefaultTopK(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	// Add 25 chunks — should only get topK=20 back by default
	for i := 0; i < 25; i++ {
		chunk := &core.ChunkResult{
			FilePath:  fmt.Sprintf("file%d.go", i),
			Content:   fmt.Sprintf("content %d", i),
			Score:     0.9,
			StartLine: 1,
			EndLine:   1,
		}
		store.AddProjectChunk(context.Background(), chunk)
	}

	results, err := memSys.SearchProject(context.Background(), "content", 0, nil, nil)
	if err != nil {
		t.Fatalf("SearchProject returned error: %v", err)
	}
	if len(results) != 20 {
		t.Errorf("expected 20 results with default topK, got %d", len(results))
	}
}

func TestIndexProject_Synchronous(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	// Create a temp directory with a small file
	tmpDir := t.TempDir()
	content := []byte("package main\n\nfunc main() {}\n")
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	jobID, status, err := memSys.IndexProject(context.Background(), tmpDir, true, false)
	if err != nil {
		t.Fatalf("IndexProject returned error: %v", err)
	}
	if jobID != "" {
		t.Errorf("expected empty jobID for synchronous indexing, got %q", jobID)
	}
	if status != "completed" {
		t.Errorf("expected status 'completed', got %q", status)
	}
}

func TestIndexProject_Background(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	// Create a temp directory with a small file
	tmpDir := t.TempDir()
	content := []byte("package main\n\nfunc main() {}\n")
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	jobID, status, err := memSys.IndexProject(context.Background(), tmpDir, true, true)
	if err != nil {
		t.Fatalf("IndexProject background returned error: %v", err)
	}
	if jobID == "" {
		t.Error("expected non-empty jobID for background indexing")
	}
	if status != "running" {
		t.Errorf("expected status 'running', got %q", status)
	}

	// Check job status
	job, err := memSys.GetIndexerJobStatus(jobID)
	if err != nil {
		t.Fatalf("GetIndexerJobStatus returned error: %v", err)
	}
	// Job should be either "running" or "completed" by now (race condition)
	if job.Status != "running" && job.Status != "completed" && job.Status != "failed" {
		t.Errorf("unexpected job status: %q", job.Status)
	}
}

func TestIndexProject_NonexistentPath(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	_, _, err := memSys.IndexProject(context.Background(), "/nonexistent/path/that/does/not/exist", false, false)
	if err == nil {
		t.Error("expected error for nonexistent path, got nil")
	}
}

func TestGetFileContents(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	// Pre-populate file data
	store.SetFileData("main.go", "package main\n\nfunc main() {}\n", false)

	result, err := memSys.GetFileContents(context.Background(), "main.go", false)
	if err != nil {
		t.Fatalf("GetFileContents returned error: %v", err)
	}
	if result == nil {
		t.Fatal("expected result, got nil")
	}
	if result.Contents != "package main\n\nfunc main() {}\n" {
		t.Errorf("unexpected contents: %q", result.Contents)
	}
	if result.FilePath != "main.go" {
		t.Errorf("unexpected filePath: %q", result.FilePath)
	}
}

func TestGetFileContents_NotFound(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	result, err := memSys.GetFileContents(context.Background(), "nonexistent.go", false)
	if err != nil {
		t.Fatalf("GetFileContents returned error: %v", err)
	}
	if result != nil {
		t.Errorf("expected nil result for nonexistent file, got %+v", result)
	}
}

func TestGetFileContents_EmptyPath(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	_, err := memSys.GetFileContents(context.Background(), "", false)
	if err == nil {
		t.Error("expected error for empty filePath, got nil")
	}
}

func TestGetIndexerJobStatus_NotFound(t *testing.T) {
	store := newMockIndexerFacadeStore()
	emb := newIndexerFacadeMockEmbedder()
	cfg := &core.Config{DatabaseURL: "noop"}
	memSys := NewWithComponents(store, emb, nil, cfg)

	_, err := memSys.GetIndexerJobStatus("nonexistent-job")
	if err == nil {
		t.Error("expected error for nonexistent job, got nil")
	}
}

// newIndexerFacadeMockEmbedder creates a mock embedder for indexer facade tests.
// It implements core.Embedder with deterministic 384-dim vectors.
func newIndexerFacadeMockEmbedder() core.Embedder {
	return &indexerFacadeMockEmbedder{dim: 384}
}

type indexerFacadeMockEmbedder struct {
	dim int
}

func (e *indexerFacadeMockEmbedder) Embed(_ context.Context, _ string) ([]float64, error) {
	vec := make([]float64, e.dim)
	vec[0] = 1.0
	return vec, nil
}

func (e *indexerFacadeMockEmbedder) Embed1024(_ context.Context, _ string) ([]float64, error) {
	return make([]float64, 1024), nil
}

func (e *indexerFacadeMockEmbedder) EmbedBatch(_ context.Context, texts []string) ([][]float64, error) {
	vecs := make([][]float64, len(texts))
	for i := range texts {
		vecs[i] = make([]float64, e.dim)
		vecs[i][0] = float64(i + 1)
	}
	return vecs, nil
}

func (e *indexerFacadeMockEmbedder) Dim() int                       { return e.dim }
func (e *indexerFacadeMockEmbedder) Health(_ context.Context) error { return nil }
func (e *indexerFacadeMockEmbedder) Close(_ context.Context) error  { return nil }

// Phase 3 stubs for agent_tools interface methods
func (m *mockIndexerFacadeStore) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	return nil
}
func (m *mockIndexerFacadeStore) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	return false, nil
}
func (m *mockIndexerFacadeStore) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	return nil, nil
}
