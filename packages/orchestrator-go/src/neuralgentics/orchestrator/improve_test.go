package orchestrator

import (
	"context"
	"errors"
	"testing"
)

// ============================================================================
// Mock ImproveMemoryProvider
// ============================================================================

// mockImproveMemory implements ImproveMemoryProvider for testing.
type mockImproveMemory struct {
	triggerExtractionErr error
	triggerExtractionN   int
	summaryResult        string
	summaryErr           error
}

func (m *mockImproveMemory) TriggerExtraction(_ context.Context, _ string) (int, error) {
	return m.triggerExtractionN, m.triggerExtractionErr
}

func (m *mockImproveMemory) GetTier1Summary(_ context.Context, _ bool) (string, error) {
	return m.summaryResult, m.summaryErr
}

// ============================================================================
// ImproveHandler Tests
// ============================================================================

func TestImproveHandler_Run_Success(t *testing.T) {
	mock := &mockImproveMemory{
		triggerExtractionN: 3,
		summaryResult:      "Key decision: use PostgreSQL for persistence",
	}
	handler := NewImproveHandler(mock)

	result, err := handler.Run(context.Background(), "task-001", "Agent completed code implementation")
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}

	if result.PatternsExtracted != 3 {
		t.Errorf("PatternsExtracted = %d, want 3", result.PatternsExtracted)
	}
	if !result.SummaryGenerated {
		t.Error("SummaryGenerated = false, want true")
	}
	if len(result.Errors) != 0 {
		t.Errorf("Errors = %v, want empty", result.Errors)
	}
	if result.Duration == "" {
		t.Error("Duration should not be empty")
	}
	if result.StartedAt.IsZero() {
		t.Error("StartedAt should be set")
	}
	if result.CompletedAt.IsZero() {
		t.Error("CompletedAt should be set")
	}
}

func TestImproveHandler_Run_PartialFailure(t *testing.T) {
	mock := &mockImproveMemory{
		triggerExtractionErr: errors.New("extraction service unavailable"),
		triggerExtractionN:   0,
		summaryResult:        "Key decision: use PostgreSQL for persistence",
	}
	handler := NewImproveHandler(mock)

	result, err := handler.Run(context.Background(), "task-002", "Agent completed code implementation")
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}

	if result.PatternsExtracted != 0 {
		t.Errorf("PatternsExtracted = %d, want 0 (extraction failed)", result.PatternsExtracted)
	}
	if !result.SummaryGenerated {
		t.Error("SummaryGenerated = false, want true (summary still succeeded)")
	}
	if len(result.Errors) != 1 {
		t.Fatalf("Errors length = %d, want 1", len(result.Errors))
	}
	expectedErrPrefix := "triggerExtraction:"
	if len(result.Errors) > 0 && result.Errors[0][:len(expectedErrPrefix)] != expectedErrPrefix {
		t.Errorf("Error[0] = %q, want prefix %q", result.Errors[0], expectedErrPrefix)
	}
}

func TestImproveHandler_Run_EmptyConversation(t *testing.T) {
	mock := &mockImproveMemory{
		triggerExtractionN: 0,
		summaryResult:      "No key decisions yet",
	}
	handler := NewImproveHandler(mock)

	result, err := handler.Run(context.Background(), "task-003", "")
	if err != nil {
		t.Fatalf("Run returned unexpected error for empty conversation: %v", err)
	}

	// Empty conversation means extraction is skipped, not failed
	if result.PatternsExtracted != 0 {
		t.Errorf("PatternsExtracted = %d, want 0 (empty conversation)", result.PatternsExtracted)
	}
	if !result.SummaryGenerated {
		t.Error("SummaryGenerated = false, want true")
	}
	if len(result.Errors) != 0 {
		t.Errorf("Errors = %v, want empty (empty conversation should not produce errors)", result.Errors)
	}
}

func TestImproveHandler_Run_BothFail(t *testing.T) {
	mock := &mockImproveMemory{
		triggerExtractionErr: errors.New("extraction failed"),
		triggerExtractionN:   0,
		summaryErr:           errors.New("summary unavailable"),
	}
	handler := NewImproveHandler(mock)

	result, err := handler.Run(context.Background(), "task-004", "some conversation")
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}

	if result.SummaryGenerated {
		t.Error("SummaryGenerated = true, want false (summary failed)")
	}
	if len(result.Errors) != 2 {
		t.Fatalf("Errors length = %d, want 2", len(result.Errors))
	}
}

func TestImproveHandler_Run_SummaryEmpty(t *testing.T) {
	mock := &mockImproveMemory{
		triggerExtractionN: 1,
		summaryResult:      "", // empty summary, no error
	}
	handler := NewImproveHandler(mock)

	result, err := handler.Run(context.Background(), "task-005", "conversation text")
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}

	if result.SummaryGenerated {
		t.Error("SummaryGenerated = true, want false (empty summary string)")
	}
}

// ============================================================================
// NewImproveHandler Tests
// ============================================================================

func TestNewImproveHandler(t *testing.T) {
	mock := &mockImproveMemory{}
	handler := NewImproveHandler(mock)
	if handler == nil {
		t.Fatal("NewImproveHandler returned nil")
	}
	if handler.memory == nil {
		t.Error("handler.memory should not be nil")
	}
}
