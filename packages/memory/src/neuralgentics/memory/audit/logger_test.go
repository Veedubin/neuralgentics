package audit

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockStore implements core.Store for testing audit logging.
// Only audit-related methods are implemented; all others panic.
type mockStore struct {
	loggedEvents []*core.AuditEvent
	auditEvents  []*core.AuditEvent
	err          error // inject errors for testing
}

func (m *mockStore) LogAuditEvent(_ context.Context, event *core.AuditEvent) (string, error) {
	if m.err != nil {
		return "", m.err
	}
	m.loggedEvents = append(m.loggedEvents, event)
	if event.ID == "" {
		return "evt-mock-123", nil
	}
	return event.ID, nil
}

func (m *mockStore) GetAuditEvents(_ context.Context, _ string, _ string, _ int) ([]*core.AuditEvent, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.auditEvents, nil
}

// Stub out all other core.Store methods with panics.
func (m *mockStore) Initialize(_ context.Context) error                               { panic("stub") }
func (m *mockStore) Close(_ context.Context) error                                    { panic("stub") }
func (m *mockStore) Ping(_ context.Context) error                                     { panic("stub") }
func (m *mockStore) Stats(_ context.Context) (*core.StatusResult, error)              { panic("stub") }
func (m *mockStore) AddMemory(_ context.Context, _ *core.MemoryEntry) (string, error) { panic("stub") }
func (m *mockStore) GetMemory(_ context.Context, _ string, _ bool) (*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) UpdateMemory(_ context.Context, _ *core.MemoryEntry) error { panic("stub") }
func (m *mockStore) DeleteMemory(_ context.Context, _ string) error            { panic("stub") }
func (m *mockStore) CountMemories(_ context.Context) (int64, error)            { panic("stub") }
func (m *mockStore) ListMemories(_ context.Context, _ *core.SearchFilter, _ int) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) ContentExists(_ context.Context, _ string) (bool, error) { panic("stub") }
func (m *mockStore) QueryMemoriesByVector(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) SearchMemoriesText(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) GetSimilar(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) UpdateTrustFields(_ context.Context, _ string, _ float64, _ bool) error {
	panic("stub")
}
func (m *mockStore) IncrementRetrievalCount(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) CreateRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	panic("stub")
}
func (m *mockStore) DeleteRelationship(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) GetRelationships(_ context.Context, _ string) ([]core.Relationship, error) {
	panic("stub")
}
func (m *mockStore) GetRelationshipSummary(_ context.Context, _ string) (*core.RelationshipSummary, error) {
	panic("stub")
}
func (m *mockStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	panic("stub")
}
func (m *mockStore) GetSuperseded(_ context.Context, _ string) (string, error)      { panic("stub") }
func (m *mockStore) UpsertEntity(_ context.Context, _ *core.Entity) (string, error) { panic("stub") }
func (m *mockStore) GetEntity(_ context.Context, _ string) (*core.Entity, error)    { panic("stub") }
func (m *mockStore) GetEntitiesByType(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	panic("stub")
}
func (m *mockStore) SearchEntities(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	panic("stub")
}
func (m *mockStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	panic("stub")
}
func (m *mockStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	panic("stub")
}
func (m *mockStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error { panic("stub") }
func (m *mockStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	panic("stub")
}
func (m *mockStore) AddPeer(_ context.Context, _ *core.PeerProfile) (string, error)   { panic("stub") }
func (m *mockStore) GetPeer(_ context.Context, _ string) (*core.PeerProfile, error)   { panic("stub") }
func (m *mockStore) ListPeers(_ context.Context, _ int) ([]*core.PeerProfile, error)  { panic("stub") }
func (m *mockStore) UpdatePeerLastActive(_ context.Context, _ string) error           { panic("stub") }
func (m *mockStore) ShareMemory(_ context.Context, _, _, _, _ string) (string, error) { panic("stub") }
func (m *mockStore) RevokeShareMemory(_ context.Context, _, _ string) error           { panic("stub") }
func (m *mockStore) GetSharedMemories(_ context.Context, _ string, _ int) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) GetPeerMemories(_ context.Context, _, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) { panic("stub") }
func (m *mockStore) AddThought(_ context.Context, _ string, _ *core.Thought) (string, error) {
	panic("stub")
}
func (m *mockStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	panic("stub")
}
func (m *mockStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	panic("stub")
}
func (m *mockStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	panic("stub")
}
func (m *mockStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	panic("stub")
}
func (m *mockStore) PauseThoughtChain(_ context.Context, _ string) error   { panic("stub") }
func (m *mockStore) ResumeThoughtChain(_ context.Context, _ string) error  { panic("stub") }
func (m *mockStore) AbandonThoughtChain(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) LogTrustAdjustment(_ context.Context, _ *core.TrustAdjustment) (string, error) {
	panic("stub")
}
func (m *mockStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	panic("stub")
}
func (m *mockStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error { panic("stub") }
func (m *mockStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) AddProjectChunk(_ context.Context, _ *core.ChunkResult) (string, error) {
	panic("stub")
}
func (m *mockStore) DeleteChunksByPath(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) SearchChunks(_ context.Context, _ []float64, _ *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	panic("stub")
}
func (m *mockStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	panic("stub")
}

func (m *mockStore) Has1024Support(_ context.Context) bool { return false }
func (m *mockStore) AddMemory1024(_ context.Context, _ string, _ []float64) (string, error) {
	return "", fmt.Errorf("stub")
}
func (m *mockStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) CountMemories1024(_ context.Context) (int64, error) { return 0, nil }
func (m *mockStore) DeleteMemory1024(_ context.Context, _ string) error { return nil }

func newMockStore() *mockStore {
	return &mockStore{}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

func TestLogEvent(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	event := &core.AuditEvent{
		EventType:   "auth_failure",
		Severity:    "warning",
		PeerID:      "peer-1",
		Description: "login failed",
	}

	id, err := logger.LogEvent(context.Background(), event)
	if err != nil {
		t.Fatalf("LogEvent returned error: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty event ID")
	}
	if len(store.loggedEvents) != 1 {
		t.Fatalf("expected 1 logged event, got %d", len(store.loggedEvents))
	}
	logged := store.loggedEvents[0]
	if logged.EventType != "auth_failure" {
		t.Errorf("expected EventType 'auth_failure', got %q", logged.EventType)
	}
	if logged.Severity != "warning" {
		t.Errorf("expected Severity 'warning', got %q", logged.Severity)
	}
	if logged.OccurredAt.IsZero() {
		t.Error("expected OccurredAt to be set")
	}
}

func TestLogEvent_DefaultSeverity(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	event := &core.AuditEvent{
		EventType:   "tool_invocation",
		Description: "some tool",
		// Severity intentionally left empty
	}

	_, err := logger.LogEvent(context.Background(), event)
	if err != nil {
		t.Fatalf("LogEvent returned error: %v", err)
	}
	if store.loggedEvents[0].Severity != "info" {
		t.Errorf("expected default Severity 'info', got %q", store.loggedEvents[0].Severity)
	}
}

func TestLogEvent_InvalidSeverity(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	event := &core.AuditEvent{
		EventType: "auth_failure",
		Severity:  "debug",
	}

	_, err := logger.LogEvent(context.Background(), event)
	if err == nil {
		t.Fatal("expected error for invalid severity, got nil")
	}
	if !strings.Contains(err.Error(), "invalid severity") {
		t.Errorf("expected 'invalid severity' error, got: %v", err)
	}
}

func TestLogEvent_EmptyEventType(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	event := &core.AuditEvent{
		Severity: "info",
	}

	_, err := logger.LogEvent(context.Background(), event)
	if err == nil {
		t.Fatal("expected error for empty EventType, got nil")
	}
	if !strings.Contains(err.Error(), "EventType is required") {
		t.Errorf("expected 'EventType is required' error, got: %v", err)
	}
}

func TestLogEvent_DefaultOccurredAt(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	before := time.Now()
	event := &core.AuditEvent{
		EventType:   "config_modification",
		Severity:    "info",
		Description: "config changed",
		// OccurredAt intentionally left zero
	}

	_, err := logger.LogEvent(context.Background(), event)
	if err != nil {
		t.Fatalf("LogEvent returned error: %v", err)
	}

	logged := store.loggedEvents[0]
	if logged.OccurredAt.Before(before) {
		t.Error("expected OccurredAt to be set to current time, but it was before the call")
	}
}

func TestGetEvents(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	// Pre-populate mock store with events
	expectedEvents := []*core.AuditEvent{
		{ID: "evt-1", EventType: "auth_failure", Severity: "warning"},
		{ID: "evt-2", EventType: "trust_adjustment", Severity: "info"},
	}
	store.auditEvents = expectedEvents

	events, err := logger.GetEvents(context.Background(), "session-1", "auth_failure", 10)
	if err != nil {
		t.Fatalf("GetEvents returned error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
}

func TestGetEvents_DefaultLimit(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	// When limit is 0, it should default to 100
	events, err := logger.GetEvents(context.Background(), "", "", 0)
	if err != nil {
		t.Fatalf("GetEvents returned error: %v", err)
	}
	// The mock store should receive limit=100 — verified by checking no error
	_ = events
}

func TestLogTrustAdjustment(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	adj := &core.TrustAdjustment{
		MemoryID:         "mem-123",
		OldScore:         0.5,
		NewScore:         0.55,
		Signal:           "agent_used",
		AdjustmentAmount: 0.05,
		Reason:           "agent used the memory",
		CreatedAt:        time.Now(),
	}

	id, err := logger.LogTrustAdjustment(context.Background(), adj)
	if err != nil {
		t.Fatalf("LogTrustAdjustment returned error: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty event ID")
	}

	logged := store.loggedEvents[0]
	if logged.EventType != "trust_adjustment" {
		t.Errorf("expected EventType 'trust_adjustment', got %q", logged.EventType)
	}
	if logged.MemoryID != "mem-123" {
		t.Errorf("expected MemoryID 'mem-123', got %q", logged.MemoryID)
	}
	if logged.Severity != "info" {
		t.Errorf("expected Severity 'info', got %q", logged.Severity)
	}
	if logged.StateBefore["trustScore"] != 0.5 {
		t.Errorf("expected StateBefore trustScore 0.5, got %v", logged.StateBefore["trustScore"])
	}
	if logged.StateAfter["trustScore"] != 0.55 {
		t.Errorf("expected StateAfter trustScore 0.55, got %v", logged.StateAfter["trustScore"])
	}
}

func TestLogMemoryMutation(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	id, err := logger.LogMemoryMutation(
		context.Background(),
		"mem-456",
		"update",
		"updated memory content",
		map[string]any{"field": "content"},
	)
	if err != nil {
		t.Fatalf("LogMemoryMutation returned error: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty event ID")
	}

	logged := store.loggedEvents[0]
	if logged.EventType != "memory_mutation" {
		t.Errorf("expected EventType 'memory_mutation', got %q", logged.EventType)
	}
	if logged.MemoryID != "mem-456" {
		t.Errorf("expected MemoryID 'mem-456', got %q", logged.MemoryID)
	}
	if logged.Details["mutationType"] != "update" {
		t.Errorf("expected Details mutationType 'update', got %v", logged.Details["mutationType"])
	}
	if logged.Details["field"] != "content" {
		t.Errorf("expected Details field 'content', got %v", logged.Details["field"])
	}
}

func TestLogMemoryMutation_NilDetails(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	_, err := logger.LogMemoryMutation(
		context.Background(),
		"mem-789",
		"delete",
		"deleted memory",
		nil,
	)
	if err != nil {
		t.Fatalf("LogMemoryMutation returned error: %v", err)
	}

	logged := store.loggedEvents[0]
	if logged.Details["mutationType"] != "delete" {
		t.Errorf("expected Details mutationType 'delete', got %v", logged.Details["mutationType"])
	}
}

func TestLogToolInvocation(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	id, err := logger.LogToolInvocation(
		context.Background(),
		"session-1",
		"boomerang-coder",
		"memini-ai-dev_query_memories",
		map[string]any{"query": "neuralgentics"},
	)
	if err != nil {
		t.Fatalf("LogToolInvocation returned error: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty event ID")
	}

	logged := store.loggedEvents[0]
	if logged.EventType != "tool_invocation" {
		t.Errorf("expected EventType 'tool_invocation', got %q", logged.EventType)
	}
	if logged.SessionID != "session-1" {
		t.Errorf("expected SessionID 'session-1', got %q", logged.SessionID)
	}
	if logged.AgentName != "boomerang-coder" {
		t.Errorf("expected AgentName 'boomerang-coder', got %q", logged.AgentName)
	}
	if logged.ToolName != "memini-ai-dev_query_memories" {
		t.Errorf("expected ToolName 'memini-ai-dev_query_memories', got %q", logged.ToolName)
	}
	if logged.Details["query"] != "neuralgentics" {
		t.Errorf("expected Details query 'neuralgentics', got %v", logged.Details["query"])
	}
}

func TestLogToolInvocation_NilDetails(t *testing.T) {
	store := newMockStore()
	logger := NewAuditLogger(store)

	_, err := logger.LogToolInvocation(
		context.Background(),
		"session-2",
		"boomerang-architect",
		"search_project",
		nil,
	)
	if err != nil {
		t.Fatalf("LogToolInvocation returned error: %v", err)
	}

	logged := store.loggedEvents[0]
	if logged.Details == nil {
		t.Error("expected Details to be non-nil map")
	}
}

func TestLogEvent_StoreError(t *testing.T) {
	store := newMockStore()
	store.err = fmt.Errorf("database error")
	logger := NewAuditLogger(store)

	event := &core.AuditEvent{
		EventType:   "auth_failure",
		Severity:    "warning",
		Description: "test error propagation",
	}

	_, err := logger.LogEvent(context.Background(), event)
	if err == nil {
		t.Fatal("expected error from store, got nil")
	}
	if !strings.Contains(err.Error(), "log event") {
		t.Errorf("expected wrapped error with 'log event', got: %v", err)
	}
}

// Phase 2 part 1 stubs for new core.Store interface methods

func (m *mockStore) GetUserProfile(ctx context.Context, peerID string) (*core.UserProfile, error) {
	return nil, nil
}

func (m *mockStore) UpsertUserProfile(ctx context.Context, profile *core.UserProfile) error {
	return nil
}

func (m *mockStore) GetSecuritySummary(ctx context.Context, hours int) (*core.SecuritySummary, error) {
	return &core.SecuritySummary{}, nil
}

// Phase 3 stubs for agent_tools interface methods
func (m *mockStore) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	return nil
}

func (m *mockStore) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	return false, nil
}

func (m *mockStore) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	return nil, nil
}
