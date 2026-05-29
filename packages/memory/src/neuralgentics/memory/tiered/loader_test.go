package tiered

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockLLMClient implements core.LLMClient for testing.
// It returns predictable responses based on the system prompt content.
type mockLLMClient struct {
	mu           sync.Mutex
	responses    map[string]string // system prompt substring -> response
	chatCalls    int
	embedCalls   int
	lastMessages []core.ConversationMessage
}

func newMockLLMClient() *mockLLMClient {
	return &mockLLMClient{
		responses: make(map[string]string),
	}
}

// setResponse configures a response for any prompt containing the key substring.
func (m *mockLLMClient) setResponse(key, response string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.responses[key] = response
}

// Chat implements core.LLMClient.Chat. It matches the system prompt against
// configured responses and returns the matching response.
func (m *mockLLMClient) Chat(ctx context.Context, messages []core.ConversationMessage, temperature float64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.chatCalls++
	m.lastMessages = messages

	// Check if context is cancelled.
	if ctx.Err() != nil {
		return "", ctx.Err()
	}

	// Find a matching response based on system prompt content.
	for _, msg := range messages {
		for key, response := range m.responses {
			if len(msg.Content) > 0 && containsSubstring(msg.Content, key) {
				return response, nil
			}
		}
	}

	return "LLM mock default response", nil
}

// Embed implements core.LLMClient.Embed (not used by tiered loading).
func (m *mockLLMClient) Embed(ctx context.Context, text string) ([]float64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.embedCalls++
	// Return a 384-dim zero vector.
	vec := make([]float64, 384)
	return vec, nil
}

// Health implements core.LLMClient.Health.
func (m *mockLLMClient) Health(ctx context.Context) error {
	return nil
}

// Close implements core.LLMClient.Close.
func (m *mockLLMClient) Close(ctx context.Context) error {
	return nil
}

func (m *mockLLMClient) getChatCalls() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.chatCalls
}

// containsSubstring checks if s contains sub.
func containsSubstring(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		(len(s) > 0 && len(sub) > 0 && findSubstring(s, sub)))
}

func findSubstring(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// mockStore implements core.Store with in-memory storage for tiered loading tests.
// It supports filtering by trust score and archived status.
type tieredMockStore struct {
	mu       sync.Mutex
	memories map[string]*core.MemoryEntry
	counter  int
}

func newTieredMockStore() *tieredMockStore {
	return &tieredMockStore{
		memories: make(map[string]*core.MemoryEntry),
	}
}

func (m *tieredMockStore) nextID() int {
	m.counter++
	return m.counter
}

// --- core.Store interface ---

func (m *tieredMockStore) Initialize(ctx context.Context) error { return nil }
func (m *tieredMockStore) Close(ctx context.Context) error      { return nil }
func (m *tieredMockStore) Ping(ctx context.Context) error       { return nil }
func (m *tieredMockStore) Stats(ctx context.Context) (*core.StatusResult, error) {
	return &core.StatusResult{}, nil
}

func (m *tieredMockStore) AddMemory(ctx context.Context, entry *core.MemoryEntry) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry.ID == "" {
		entry.ID = fmt.Sprintf("mem-%d", m.nextID())
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now()
		entry.UpdatedAt = time.Now()
	}
	if entry.TrustScore == 0 {
		entry.TrustScore = 0.5 // default trust
	}
	clone := *entry
	m.memories[clone.ID] = &clone
	return clone.ID, nil
}

func (m *tieredMockStore) GetMemory(ctx context.Context, id string, includeArchived bool) (*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.memories[id]
	if !ok {
		return nil, fmt.Errorf("memory %s not found", id)
	}
	clone := *entry
	return &clone, nil
}

func (m *tieredMockStore) UpdateMemory(ctx context.Context, entry *core.MemoryEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	clone := *entry
	m.memories[entry.ID] = &clone
	return nil
}

func (m *tieredMockStore) DeleteMemory(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.memories, id)
	return nil
}

func (m *tieredMockStore) CountMemories(ctx context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var count int64
	for _, e := range m.memories {
		if !e.IsArchived {
			count++
		}
	}
	return count, nil
}

func (m *tieredMockStore) ListMemories(ctx context.Context, filter *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.MemoryEntry
	for _, e := range m.memories {
		if filter != nil {
			if filter.IsArchived != nil && e.IsArchived != *filter.IsArchived {
				continue
			}
			if e.TrustScore < filter.MinTrustScore {
				continue
			}
		}
		clone := *e
		results = append(results, &clone)
	}
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (m *tieredMockStore) ContentExists(ctx context.Context, contentHash string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.memories {
		if e.ContentHash == contentHash {
			return true, nil
		}
	}
	return false, nil
}

func (m *tieredMockStore) QueryMemoriesByVector(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *tieredMockStore) SearchMemoriesText(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *tieredMockStore) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *tieredMockStore) UpdateTrustFields(ctx context.Context, id string, trustScore float64, archived bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.memories[id]; ok {
		e.TrustScore = trustScore
		e.IsArchived = archived
	}
	return nil
}
func (m *tieredMockStore) IncrementRetrievalCount(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.memories[id]; ok {
		e.RetrievalCount++
	}
	return nil
}

// Stub implementations for unused core.Store methods.
func (m *tieredMockStore) CreateRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return "", nil
}
func (m *tieredMockStore) DeleteRelationship(ctx context.Context, id string) error { return nil }
func (m *tieredMockStore) GetRelationships(ctx context.Context, memoryID string) ([]core.Relationship, error) {
	return nil, nil
}
func (m *tieredMockStore) GetRelationshipSummary(ctx context.Context, memoryID string) (*core.RelationshipSummary, error) {
	return nil, nil
}
func (m *tieredMockStore) GetSupersessionChain(ctx context.Context, memoryID string, maxDepth int) ([]string, error) {
	return nil, nil
}
func (m *tieredMockStore) GetSuperseded(ctx context.Context, memoryID string) (string, error) {
	return "", nil
}
func (m *tieredMockStore) UpsertEntity(ctx context.Context, entity *core.Entity) (string, error) {
	return "", nil
}
func (m *tieredMockStore) GetEntity(ctx context.Context, id string) (*core.Entity, error) {
	return nil, nil
}
func (m *tieredMockStore) GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *tieredMockStore) SearchEntities(ctx context.Context, name string, limit int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *tieredMockStore) CreateEntityRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return "", nil
}
func (m *tieredMockStore) GetEntityRelationships(ctx context.Context, entityID string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *tieredMockStore) ResolveEntityGraph(ctx context.Context, entityID string, depth int) error {
	return nil
}
func (m *tieredMockStore) InferenceChain(ctx context.Context, startEntity, endEntity string, maxDepth int) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *tieredMockStore) AddPeer(ctx context.Context, peer *core.PeerProfile) (string, error) {
	return "", nil
}
func (m *tieredMockStore) GetPeer(ctx context.Context, id string) (*core.PeerProfile, error) {
	return nil, nil
}
func (m *tieredMockStore) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (m *tieredMockStore) UpdatePeerLastActive(ctx context.Context, id string) error { return nil }
func (m *tieredMockStore) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	return "", nil
}
func (m *tieredMockStore) RevokeShareMemory(ctx context.Context, memoryID, peerID string) error {
	return nil
}
func (m *tieredMockStore) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *tieredMockStore) GetPeerMemories(ctx context.Context, peerID, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *tieredMockStore) StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	return "", nil
}
func (m *tieredMockStore) AddThought(ctx context.Context, chainID string, thought *core.Thought) (string, error) {
	return "", nil
}
func (m *tieredMockStore) GetThoughtChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	return nil, nil
}
func (m *tieredMockStore) GetRelatedChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (m *tieredMockStore) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, revisedText string) (*core.Thought, error) {
	return nil, nil
}
func (m *tieredMockStore) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	return nil, nil
}
func (m *tieredMockStore) PauseThoughtChain(ctx context.Context, chainID string) error   { return nil }
func (m *tieredMockStore) ResumeThoughtChain(ctx context.Context, chainID string) error  { return nil }
func (m *tieredMockStore) AbandonThoughtChain(ctx context.Context, chainID string) error { return nil }
func (m *tieredMockStore) LogAuditEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	return "", nil
}
func (m *tieredMockStore) GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	return nil, nil
}
func (m *tieredMockStore) LogTrustAdjustment(ctx context.Context, adj *core.TrustAdjustment) (string, error) {
	return "", nil
}
func (m *tieredMockStore) GetTrustAdjustments(ctx context.Context, memoryID string, limit int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}
func (m *tieredMockStore) UpdateDecayRate(ctx context.Context, memoryID string, rate float64) error {
	return nil
}
func (m *tieredMockStore) ListFadingMemories(ctx context.Context, threshold float64, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *tieredMockStore) AddProjectChunk(ctx context.Context, chunk *core.ChunkResult) (string, error) {
	return "", nil
}
func (m *tieredMockStore) DeleteChunksByPath(ctx context.Context, path string) error { return nil }
func (m *tieredMockStore) SearchChunks(ctx context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	return nil, nil
}
func (m *tieredMockStore) GetFileChunksByPath(ctx context.Context, filePath string) (*core.FileContentsResult, error) {
	return nil, nil
}

// addMemory is a test helper that adds a memory with the specified trust score.
func addMemory(s *tieredMockStore, content string, sourceType string, trustScore float64, archived bool) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := fmt.Sprintf("mem-%d", s.nextID())
	entry := &core.MemoryEntry{
		ID:          id,
		Content:     content,
		SourceType:  sourceType,
		ContentHash: "hash-" + id,
		TrustScore:  trustScore,
		IsArchived:  archived,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	s.memories[id] = entry
	return id
}

// --- Unit Tests ---

func TestGetTier0Summary_CacheMiss(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	llm.setResponse("100 tokens", "L0 summary: Project uses Go with PostgreSQL.")
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	// Add high-trust memories.
	addMemory(store, "Uses Go for backend", "session", 0.6, false)
	addMemory(store, "PostgreSQL with pgvector", "session", 0.7, false)

	summary, err := loader.GetTier0Summary(context.Background(), false)
	if err != nil {
		t.Fatalf("GetTier0Summary returned error: %v", err)
	}
	if summary.Tier != "L0" {
		t.Errorf("Tier = %q, want %q", summary.Tier, "L0")
	}
	if summary.Content == "" {
		t.Error("Content should not be empty")
	}
	if llm.getChatCalls() != 1 {
		t.Errorf("expected 1 LLM call, got %d", llm.getChatCalls())
	}
}

func TestGetTier0Summary_CacheHit(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	llm.setResponse("100 tokens", "L0 cached summary")
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	addMemory(store, "Test memory", "session", 0.6, false)

	// First call: cache miss -> LLM called.
	_, err := loader.GetTier0Summary(context.Background(), false)
	if err != nil {
		t.Fatalf("First call returned error: %v", err)
	}
	if llm.getChatCalls() != 1 {
		t.Errorf("expected 1 LLM call after first, got %d", llm.getChatCalls())
	}

	// Second call: cache hit -> LLM NOT called.
	summary, err := loader.GetTier0Summary(context.Background(), false)
	if err != nil {
		t.Fatalf("Second call returned error: %v", err)
	}
	if llm.getChatCalls() != 1 {
		t.Errorf("expected 1 LLM call after second (cached), got %d", llm.getChatCalls())
	}
	if summary.Content != "L0 cached summary" {
		t.Errorf("Content = %q, want %q", summary.Content, "L0 cached summary")
	}
}

func TestGetTier0Summary_ForceRefresh(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	llm.setResponse("100 tokens", "L0 fresh summary")
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	addMemory(store, "Test memory", "session", 0.6, false)

	// First call to populate cache.
	_, _ = loader.GetTier0Summary(context.Background(), false)

	// Force refresh should bypass cache and call LLM again.
	summary, err := loader.GetTier0Summary(context.Background(), true)
	if err != nil {
		t.Fatalf("ForceRefresh returned error: %v", err)
	}
	if llm.getChatCalls() != 2 {
		t.Errorf("expected 2 LLM calls after force refresh, got %d", llm.getChatCalls())
	}
	if summary.Content != "L0 fresh summary" {
		t.Errorf("Content = %q, want %q", summary.Content, "L0 fresh summary")
	}
}

func TestGetTier0Summary_NoMemories(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	// Empty store should return a default message without calling LLM.
	summary, err := loader.GetTier0Summary(context.Background(), false)
	if err != nil {
		t.Fatalf("GetTier0Summary with no memories returned error: %v", err)
	}
	if summary.Content != "No high-trust memories available." {
		t.Errorf("Content = %q, want default message", summary.Content)
	}
	if llm.getChatCalls() != 0 {
		t.Errorf("expected 0 LLM calls for empty store, got %d", llm.getChatCalls())
	}
}

func TestGetTier0Summary_FiltersLowTrust(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	llm.setResponse("100 tokens", "L0 summary result")
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	// Add memory below L0 threshold (trust 0.3).
	addMemory(store, "Low trust memory", "session", 0.3, false)
	// Add memory above L0 threshold (trust 0.7).
	addMemory(store, "High trust memory", "session", 0.7, false)
	// Add archived memory (trust 0.9 but archived).
	addMemory(store, "Archived memory", "session", 0.9, true)

	summary, err := loader.GetTier0Summary(context.Background(), false)
	if err != nil {
		t.Fatalf("GetTier0Summary returned error: %v", err)
	}
	if summary.Tier != "L0" {
		t.Errorf("Tier = %q, want %q", summary.Tier, "L0")
	}
	// LLM should have been called (there are memories >= 0.5).
	if llm.getChatCalls() != 1 {
		t.Errorf("expected 1 LLM call, got %d", llm.getChatCalls())
	}
}

func TestGetTier1Summary_CacheMiss(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	llm.setResponse("key decisions", "L1 summary: Decision 1 - Use Go. Decision 2 - Use PostgreSQL.")
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	// Add high-trust memories (trust >= 0.8).
	addMemory(store, "Decided to use Go", "session", 0.85, false)
	addMemory(store, "Decided to use PostgreSQL", "session", 0.95, false)

	summary, err := loader.GetTier1Summary(context.Background(), false)
	if err != nil {
		t.Fatalf("GetTier1Summary returned error: %v", err)
	}
	if summary.Tier != "L1" {
		t.Errorf("Tier = %q, want %q", summary.Tier, "L1")
	}
	if summary.Content == "" {
		t.Error("Content should not be empty")
	}
	if llm.getChatCalls() != 1 {
		t.Errorf("expected 1 LLM call, got %d", llm.getChatCalls())
	}
}

func TestGetTier1Summary_FiltersBelow08(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	llm.setResponse("key decisions", "L1 empty result")
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	// Add memory below L1 threshold (trust 0.5 — above L0 but below L1).
	addMemory(store, "Medium trust memory", "session", 0.5, false)

	summary, err := loader.GetTier1Summary(context.Background(), false)
	if err != nil {
		t.Fatalf("GetTier1Summary returned error: %v", err)
	}
	// With no memories at trust >= 0.8, should return default message.
	if summary.Content != "No key decisions available." {
		t.Errorf("Content = %q, want default L1 message", summary.Content)
	}
	if llm.getChatCalls() != 0 {
		t.Errorf("expected 0 LLM calls for no qualifying memories, got %d", llm.getChatCalls())
	}
}

func TestTriggerExtraction(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	llm.setResponse("extract", "- First extracted fact\n- Second extracted fact\n- Third insight")
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	result, err := loader.TriggerExtraction(context.Background(), "User discussed the project architecture and chose Go.")
	if err != nil {
		t.Fatalf("TriggerExtraction returned error: %v", err)
	}
	if result.Count != 3 {
		t.Errorf("Count = %d, want 3", result.Count)
	}
	if len(result.MemoryIDs) != 3 {
		t.Errorf("MemoryIDs length = %d, want 3", len(result.MemoryIDs))
	}
}

func TestTriggerExtraction_EmptyConversation(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	result, err := loader.TriggerExtraction(context.Background(), "")
	if err != nil {
		t.Fatalf("TriggerExtraction returned error: %v", err)
	}
	if result.Count != 0 {
		t.Errorf("Count = %d, want 0 for empty conversation", result.Count)
	}
	if llm.getChatCalls() != 0 {
		t.Errorf("expected 0 LLM calls for empty conversation, got %d", llm.getChatCalls())
	}
}

func TestPrecompressExtraction(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	llm.setResponse("context", "- Important decision made\n- Key insight discovered")
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	result, err := loader.PrecompressExtraction(context.Background(), "Long conversation about project setup...")
	if err != nil {
		t.Fatalf("PrecompressExtraction returned error: %v", err)
	}
	if result.MemoriesExtracted != 2 {
		t.Errorf("MemoriesExtracted = %d, want 2", result.MemoriesExtracted)
	}
	if result.Context != "Long conversation about project setup..." {
		t.Errorf("Context = %q, want original content", result.Context)
	}
}

func TestPrecompressExtraction_EmptyContent(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	cache := NewSummaryCache()
	loader := NewTieredLoader(store, llm, cache)

	result, err := loader.PrecompressExtraction(context.Background(), "")
	if err != nil {
		t.Fatalf("PrecompressExtraction returned error: %v", err)
	}
	if result.MemoriesExtracted != 0 {
		t.Errorf("MemoriesExtracted = %d, want 0 for empty content", result.MemoriesExtracted)
	}
	if llm.getChatCalls() != 0 {
		t.Errorf("expected 0 LLM calls for empty content, got %d", llm.getChatCalls())
	}
}

func TestInvalidateCache(t *testing.T) {
	cache := NewSummaryCache()
	cache.Set(CacheKeyL0, "l0 value", DefaultL0TTL)
	cache.Set(CacheKeyL1, "l1 value", DefaultL1TTL)

	store := newTieredMockStore()
	llm := newMockLLMClient()
	loader := NewTieredLoader(store, llm, cache)

	// Invalidate L0 only.
	loader.InvalidateCache("L0")
	if _, ok := cache.Get(CacheKeyL0); ok {
		t.Error("L0 cache should be invalidated")
	}
	if _, ok := cache.Get(CacheKeyL1); !ok {
		t.Error("L1 cache should still be present")
	}

	// Reset and invalidate L1.
	cache.Set(CacheKeyL0, "l0 value", DefaultL0TTL)
	cache.Set(CacheKeyL1, "l1 value", DefaultL1TTL)
	loader.InvalidateCache("L1")
	if _, ok := cache.Get(CacheKeyL0); !ok {
		t.Error("L0 cache should still be present")
	}
	if _, ok := cache.Get(CacheKeyL1); ok {
		t.Error("L1 cache should be invalidated")
	}

	// Reset and invalidate all.
	cache.Set(CacheKeyL0, "l0 value", DefaultL0TTL)
	cache.Set(CacheKeyL1, "l1 value", DefaultL1TTL)
	loader.InvalidateCache("")
	if _, ok := cache.Get(CacheKeyL0); ok {
		t.Error("L0 cache should be invalidated")
	}
	if _, ok := cache.Get(CacheKeyL1); ok {
		t.Error("L1 cache should be invalidated")
	}
}

func TestEstimateTokens(t *testing.T) {
	tests := []struct {
		text string
		want int
	}{
		{"", 0},
		{"ab", 0},               // 2 chars / 4 = 0
		{"four", 1},             // 4 chars / 4 = 1
		{"hello world test", 4}, // 17 chars / 4 = 4
		{"a longer sentence with many words in it", 9}, // 39 chars / 4 = 9
	}
	for _, tt := range tests {
		got := estimateTokens(tt.text)
		if got != tt.want {
			t.Errorf("estimateTokens(%q) = %d, want %d", tt.text, got, tt.want)
		}
	}
}

func TestParseExtractedMemories(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []string
	}{
		{
			name:  "standard bullet points",
			input: "- First fact\n- Second fact\n- Third fact\nSome commentary without bullet",
			want:  []string{"First fact", "Second fact", "Third fact"},
		},
		{
			name:  "empty input",
			input: "",
			want:  nil,
		},
		{
			name:  "no bullet points",
			input: "Just plain text\nwithout any bullets",
			want:  nil,
		},
		{
			name:  "bullet with empty content",
			input: "- \n- Has content",
			want:  []string{"Has content"},
		},
		{
			name:  "mixed content",
			input: "Here are the facts:\n- Fact one\n- Fact two\n\nSome notes\n- Fact three",
			want:  []string{"Fact one", "Fact two", "Fact three"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseExtractedMemories(tt.input)
			if len(got) != len(tt.want) {
				t.Errorf("parseExtractedMemories(%q) = %v, want %v", tt.input, got, tt.want)
				return
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("parseExtractedMemories[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestFormatMemories(t *testing.T) {
	memories := []*core.MemoryEntry{
		{Content: "Uses Go", SourceType: "session", TrustScore: 0.8},
		{Content: "Uses PostgreSQL", SourceType: "file", TrustScore: 0.9},
	}
	result := formatMemories(memories)
	if len(result) == 0 {
		t.Error("formatMemories should not return empty string")
	}
	// Check that both memories are present.
	if !containsSubstring(result, "Uses Go") {
		t.Error("formatMemories should contain 'Uses Go'")
	}
	if !containsSubstring(result, "Uses PostgreSQL") {
		t.Error("formatMemories should contain 'Uses PostgreSQL'")
	}
	// Check trust scores are formatted.
	if !containsSubstring(result, "0.80") {
		t.Error("formatMemories should contain trust score 0.80")
	}
}

func TestNewTieredLoader_NilCache(t *testing.T) {
	store := newTieredMockStore()
	llm := newMockLLMClient()
	loader := NewTieredLoader(store, llm, nil)
	if loader.cache == nil {
		t.Error("Expected non-nil cache when nil is passed")
	}
}
