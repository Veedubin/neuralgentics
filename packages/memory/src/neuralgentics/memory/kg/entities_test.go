package kg

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockKGStore implements core.Store with in-memory entity storage for KG tests.
type mockKGStore struct {
	mu                  sync.Mutex
	entities            map[string]*core.Entity
	entityRelationships []core.EntityRelationship
	counter             int
}

func newMockKGStore() *mockKGStore {
	return &mockKGStore{
		entities: make(map[string]*core.Entity),
	}
}

func (m *mockKGStore) nextID() int {
	m.counter++
	return m.counter
}

// --- Entity operations ---

func (m *mockKGStore) UpsertEntity(ctx context.Context, entity *core.Entity) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entity.ID == "" {
		entity.ID = fmt.Sprintf("ent-%d", m.nextID())
	}
	if entity.Confidence <= 0 {
		entity.Confidence = 0.5
	}
	// Check for existing entity by name+type (upsert semantics)
	for id, existing := range m.entities {
		if existing.Name == entity.Name && existing.EntityType == entity.EntityType {
			// Update: keep higher confidence, increment mention count
			if entity.Confidence > existing.Confidence {
				existing.Confidence = entity.Confidence
			}
			existing.MentionCount++
			existing.LastSeenAt = time.Now()
			if entity.CanonicalName != "" {
				existing.CanonicalName = entity.CanonicalName
			}
			return id, nil
		}
	}
	clone := *entity
	clone.MentionCount = 1
	m.entities[clone.ID] = &clone
	return clone.ID, nil
}

func (m *mockKGStore) GetEntity(ctx context.Context, id string) (*core.Entity, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.entities[id]
	if !ok {
		return nil, fmt.Errorf("entity %s not found", id)
	}
	clone := *e
	return &clone, nil
}

func (m *mockKGStore) GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*core.Entity, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.Entity
	for _, e := range m.entities {
		if e.EntityType == entityType {
			clone := *e
			results = append(results, &clone)
		}
	}
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (m *mockKGStore) SearchEntities(ctx context.Context, name string, limit int) ([]*core.Entity, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.Entity
	for _, e := range m.entities {
		if strings.Contains(strings.ToLower(e.Name), strings.ToLower(name)) {
			clone := *e
			results = append(results, &clone)
		}
	}
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (m *mockKGStore) CreateEntityRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := fmt.Sprintf("rel-%d", m.nextID())
	m.entityRelationships = append(m.entityRelationships, core.EntityRelationship{
		ID:               id,
		SourceEntityID:   sourceID,
		TargetEntityID:   targetID,
		RelationshipType: relType,
		Confidence:       confidence,
		CreatedAt:        time.Now(),
	})
	return id, nil
}

func (m *mockKGStore) GetEntityRelationships(ctx context.Context, entityID string) ([]core.EntityRelationship, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []core.EntityRelationship
	for _, r := range m.entityRelationships {
		if r.SourceEntityID == entityID || r.TargetEntityID == entityID {
			results = append(results, r)
		}
	}
	return results, nil
}

func (m *mockKGStore) ResolveEntityGraph(ctx context.Context, entityID string, depth int) error {
	return nil
}

func (m *mockKGStore) InferenceChain(ctx context.Context, startEntity, endEntity string, maxDepth int) ([]core.EntityRelationship, error) {
	return nil, fmt.Errorf("InferenceChain: not implemented in mock")
}

// --- Stub implementations for remaining core.Store methods ---

func (m *mockKGStore) Initialize(ctx context.Context) error { return nil }
func (m *mockKGStore) Close(ctx context.Context) error      { return nil }
func (m *mockKGStore) Ping(ctx context.Context) error       { return nil }
func (m *mockKGStore) Stats(ctx context.Context) (*core.StatusResult, error) {
	return &core.StatusResult{}, nil
}
func (m *mockKGStore) AddMemory(ctx context.Context, entry *core.MemoryEntry) (string, error) {
	return "", nil
}
func (m *mockKGStore) GetMemory(ctx context.Context, id string, includeArchived bool) (*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockKGStore) UpdateMemory(ctx context.Context, entry *core.MemoryEntry) error { return nil }
func (m *mockKGStore) DeleteMemory(ctx context.Context, id string) error               { return nil }
func (m *mockKGStore) CountMemories(ctx context.Context) (int64, error)                { return 0, nil }
func (m *mockKGStore) ListMemories(ctx context.Context, filter *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockKGStore) ContentExists(ctx context.Context, contentHash string) (bool, error) {
	return false, nil
}
func (m *mockKGStore) QueryMemoriesByVector(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockKGStore) SearchMemoriesText(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockKGStore) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockKGStore) UpdateTrustFields(ctx context.Context, id string, trustScore float64, archived bool) error {
	return nil
}
func (m *mockKGStore) IncrementRetrievalCount(ctx context.Context, id string) error { return nil }
func (m *mockKGStore) CreateRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return "", nil
}
func (m *mockKGStore) DeleteRelationship(ctx context.Context, id string) error { return nil }
func (m *mockKGStore) GetRelationships(ctx context.Context, memoryID string) ([]core.Relationship, error) {
	return nil, nil
}
func (m *mockKGStore) GetRelationshipSummary(ctx context.Context, memoryID string) (*core.RelationshipSummary, error) {
	return nil, nil
}
func (m *mockKGStore) GetSupersessionChain(ctx context.Context, memoryID string, maxDepth int) ([]string, error) {
	return nil, nil
}
func (m *mockKGStore) GetSuperseded(ctx context.Context, memoryID string) (string, error) {
	return "", nil
}
func (m *mockKGStore) AddPeer(ctx context.Context, peer *core.PeerProfile) (string, error) {
	return "", nil
}
func (m *mockKGStore) GetPeer(ctx context.Context, id string) (*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockKGStore) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockKGStore) UpdatePeerLastActive(ctx context.Context, id string) error { return nil }
func (m *mockKGStore) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	return "", nil
}
func (m *mockKGStore) RevokeShareMemory(ctx context.Context, memoryID, peerID string) error {
	return nil
}
func (m *mockKGStore) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockKGStore) GetPeerMemories(ctx context.Context, peerID, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockKGStore) StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	return "", nil
}
func (m *mockKGStore) AddThought(ctx context.Context, chainID string, thought *core.Thought) (string, error) {
	return "", nil
}
func (m *mockKGStore) GetThoughtChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockKGStore) GetRelatedChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockKGStore) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, revisedText string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockKGStore) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockKGStore) PauseThoughtChain(ctx context.Context, chainID string) error   { return nil }
func (m *mockKGStore) ResumeThoughtChain(ctx context.Context, chainID string) error  { return nil }
func (m *mockKGStore) AbandonThoughtChain(ctx context.Context, chainID string) error { return nil }
func (m *mockKGStore) LogAuditEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	return "", nil
}
func (m *mockKGStore) GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	return nil, nil
}
func (m *mockKGStore) LogTrustAdjustment(ctx context.Context, adj *core.TrustAdjustment) (string, error) {
	return "", nil
}
func (m *mockKGStore) GetTrustAdjustments(ctx context.Context, memoryID string, limit int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}
func (m *mockKGStore) UpdateDecayRate(ctx context.Context, memoryID string, rate float64) error {
	return nil
}
func (m *mockKGStore) ListFadingMemories(ctx context.Context, threshold float64, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockKGStore) AddProjectChunk(ctx context.Context, chunk *core.ChunkResult) (string, error) {
	return "", nil
}
func (m *mockKGStore) DeleteChunksByPath(ctx context.Context, path string) error { return nil }
func (m *mockKGStore) SearchChunks(ctx context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	return nil, nil
}
func (m *mockKGStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	return nil, nil
}

// mockLLMClient implements core.LLMClient for testing entity extraction.
type mockLLMClient struct {
	response  string
	err       error
	callCount int
}

func (m *mockLLMClient) Chat(ctx context.Context, messages []core.ConversationMessage, temperature float64) (string, error) {
	m.callCount++
	if m.err != nil {
		return "", m.err
	}
	return m.response, nil
}

func (m *mockLLMClient) Embed(ctx context.Context, text string) ([]float64, error) {
	return make([]float64, 384), nil
}

func (m *mockLLMClient) Health(ctx context.Context) error { return nil }

func (m *mockLLMClient) Close(ctx context.Context) error { return nil }

// --- EntityExtractor Tests ---

func TestExtractEntities_EmptyText(t *testing.T) {
	store := newMockKGStore()
	llm := &mockLLMClient{}
	extractor := NewEntityExtractor(store, llm)

	_, err := extractor.ExtractEntities(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty text, got nil")
	}
}

func TestExtractEntities_LLMError(t *testing.T) {
	store := newMockKGStore()
	llm := &mockLLMClient{err: fmt.Errorf("LLM unavailable")}
	extractor := NewEntityExtractor(store, llm)

	_, err := extractor.ExtractEntities(context.Background(), "some text")
	if err == nil {
		t.Fatal("expected error when LLM fails, got nil")
	}
}

func TestExtractEntities_Success(t *testing.T) {
	store := newMockKGStore()
	llm := &mockLLMClient{
		response: `{"entities": [{"name": "Alice", "entity_type": "PERSON", "canonical_name": "alice", "confidence": 0.9}, {"name": "Acme Corp", "entity_type": "ORGANIZATION", "canonical_name": "acme corp", "confidence": 0.8}]}`,
	}
	extractor := NewEntityExtractor(store, llm)

	ids, err := extractor.ExtractEntities(context.Background(), "Alice works at Acme Corp")
	if err != nil {
		t.Fatalf("ExtractEntities returned error: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 entity IDs, got %d", len(ids))
	}
	if llm.callCount != 1 {
		t.Errorf("expected 1 LLM call, got %d", llm.callCount)
	}

	// Verify entities were stored
	if len(store.entities) != 2 {
		t.Errorf("expected 2 entities in store, got %d", len(store.entities))
	}
}

func TestExtractEntities_Deduplication(t *testing.T) {
	store := newMockKGStore()
	llm := &mockLLMClient{
		response: `{"entities": [{"name": "Alice", "entity_type": "PERSON", "canonical_name": "alice", "confidence": 0.7}, {"name": "Alice Johnson", "entity_type": "PERSON", "canonical_name": "alice", "confidence": 0.9}]}`,
	}
	extractor := NewEntityExtractor(store, llm)

	ids, err := extractor.ExtractEntities(context.Background(), "Alice and Alice Johnson")
	if err != nil {
		t.Fatalf("ExtractEntities returned error: %v", err)
	}
	// Should be deduplicated to 1 entity (same canonical name "alice")
	if len(ids) != 1 {
		t.Errorf("expected 1 deduplicated entity ID, got %d", len(ids))
	}
}

func TestExtractEntities_InvalidEntityType(t *testing.T) {
	store := newMockKGStore()
	llm := &mockLLMClient{
		response: `{"entities": [{"name": "Widget", "entity_type": "PRODUCT", "canonical_name": "widget", "confidence": 0.8}]}`,
	}
	extractor := NewEntityExtractor(store, llm)

	ids, err := extractor.ExtractEntities(context.Background(), "The Widget is great")
	if err != nil {
		t.Fatalf("ExtractEntities returned error: %v", err)
	}
	if len(ids) != 1 {
		t.Fatalf("expected 1 entity ID, got %d", len(ids))
	}

	// The entity type should be normalized to UNKNOWN
	for _, e := range store.entities {
		if e.EntityType != "UNKNOWN" {
			t.Errorf("expected entity type UNKNOWN, got %s", e.EntityType)
		}
	}
}

func TestExtractEntities_MarkdownFence(t *testing.T) {
	store := newMockKGStore()
	llm := &mockLLMClient{
		response: "```json\n{\"entities\": [{\"name\": \"Bob\", \"entity_type\": \"PERSON\", \"canonical_name\": \"bob\", \"confidence\": 0.85}]}\n```",
	}
	extractor := NewEntityExtractor(store, llm)

	ids, err := extractor.ExtractEntities(context.Background(), "Bob was here")
	if err != nil {
		t.Fatalf("ExtractEntities returned error: %v", err)
	}
	if len(ids) != 1 {
		t.Fatalf("expected 1 entity ID, got %d", len(ids))
	}
}

func TestExtractEntities_NoEntities(t *testing.T) {
	store := newMockKGStore()
	llm := &mockLLMClient{
		response: `{"entities": []}`,
	}
	extractor := NewEntityExtractor(store, llm)

	ids, err := extractor.ExtractEntities(context.Background(), "nothing here")
	if err != nil {
		t.Fatalf("ExtractEntities returned error: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected 0 entity IDs for empty extraction, got %d", len(ids))
	}
}

func TestGetEntityGraph(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	// Create entities
	alice := &core.Entity{Name: "Alice", EntityType: "PERSON", CanonicalName: "alice", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	bob := &core.Entity{Name: "Bob", EntityType: "PERSON", CanonicalName: "bob", Confidence: 0.8, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	acme := &core.Entity{Name: "Acme", EntityType: "ORGANIZATION", CanonicalName: "acme", Confidence: 0.95, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	aliceID, _ := store.UpsertEntity(ctx, alice)
	bobID, _ := store.UpsertEntity(ctx, bob)
	acmeID, _ := store.UpsertEntity(ctx, acme)

	// Create relationships
	store.CreateEntityRelationship(ctx, aliceID, acmeID, "WORKS_AT", 0.9)
	store.CreateEntityRelationship(ctx, aliceID, bobID, "KNOWS", 0.7)

	// Test GetEntityGraph
	entities, rels, err := GetEntityGraph(ctx, store, aliceID, 3)
	if err != nil {
		t.Fatalf("GetEntityGraph returned error: %v", err)
	}
	if len(entities) != 3 {
		t.Errorf("expected 3 entities, got %d", len(entities))
	}
	if len(rels) != 2 {
		t.Errorf("expected 2 relationships, got %d", len(rels))
	}
}

func TestGetEntityGraph_NotFound(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	_, _, err := GetEntityGraph(ctx, store, "nonexistent", 3)
	if err == nil {
		t.Fatal("expected error for nonexistent entity, got nil")
	}
}

func TestEntityColor(t *testing.T) {
	tests := []struct {
		entityType string
		expected   string
	}{
		{"PERSON", "#4CAF50"},
		{"ORGANIZATION", "#2196F3"},
		{"CONCEPT", "#FF9800"},
		{"CODE", "#9C27B0"},
		{"PROJECT", "#F44336"},
		{"LOCATION", "#00BCD4"},
		{"UNKNOWN", "#607D8B"},
		{"OTHER", "#607D8B"},
	}

	for _, tt := range tests {
		got := EntityColor(tt.entityType)
		if got != tt.expected {
			t.Errorf("EntityColor(%q) = %q, want %q", tt.entityType, got, tt.expected)
		}
	}
}
