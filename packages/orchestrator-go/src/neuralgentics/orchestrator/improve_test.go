package orchestrator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
	handler := NewImproveHandler(mock, "")

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
	handler := NewImproveHandler(mock, "")

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
	handler := NewImproveHandler(mock, "")

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
	handler := NewImproveHandler(mock, "")

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
	handler := NewImproveHandler(mock, "")

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
	handler := NewImproveHandler(mock, "")
	if handler == nil {
		t.Fatal("NewImproveHandler returned nil")
	}
	if handler.memory == nil {
		t.Error("handler.memory should not be nil")
	}
}

// ============================================================================
// ConfigFingerprint Tests
// ============================================================================

// TestComputeConfigFingerprint_AGENTSmd verifies that fingerprinting reads
// AGENTS.md, opencode.json, and SKILL.md files correctly.
func TestComputeConfigFingerprint_AGENTSmd(t *testing.T) {
	// Set up temp directory with config files.
	tmpDir := t.TempDir()

	// Write AGENTS.md
	agentsContent := []byte("# Agents\nOrchestrator runs everything.\n")
	if err := os.WriteFile(filepath.Join(tmpDir, "AGENTS.md"), agentsContent, 0644); err != nil {
		t.Fatalf("WriteFile AGENTS.md: %v", err)
	}

	// Write .opencode/opencode.json
	opencodeDir := filepath.Join(tmpDir, ".opencode")
	if err := os.MkdirAll(opencodeDir, 0755); err != nil {
		t.Fatalf("MkdirAll .opencode: %v", err)
	}
	configContent := []byte(`{"provider": "ollama"}`)
	if err := os.WriteFile(filepath.Join(opencodeDir, "opencode.json"), configContent, 0644); err != nil {
		t.Fatalf("WriteFile opencode.json: %v", err)
	}

	// Write .opencode/skills/boomerang-orchestrator/SKILL.md
	skillsDir := filepath.Join(opencodeDir, "skills", "boomerang-orchestrator")
	if err := os.MkdirAll(skillsDir, 0755); err != nil {
		t.Fatalf("MkdirAll skills: %v", err)
	}
	skillContent := []byte("# Orchestrator Skill\nCoordinates all agents.\n")
	if err := os.WriteFile(filepath.Join(skillsDir, "SKILL.md"), skillContent, 0644); err != nil {
		t.Fatalf("WriteFile SKILL.md: %v", err)
	}

	fp := ComputeConfigFingerprint(tmpDir)

	// Verify AgentsMD is a 64-char hex string (SHA-256)
	if fp.AgentsMD == "" {
		t.Error("AgentsMD should not be empty")
	}
	if len(fp.AgentsMD) != 64 {
		t.Errorf("AgentsMD length = %d, want 64 (SHA-256 hex)", len(fp.AgentsMD))
	}

	// Verify OpenCodeConfig is populated
	if fp.OpenCodeConfig == "" {
		t.Error("OpenCodeConfig should not be empty")
	}
	if len(fp.OpenCodeConfig) != 64 {
		t.Errorf("OpenCodeConfig length = %d, want 64", len(fp.OpenCodeConfig))
	}

	// Verify SkillFiles has 1 entry
	if len(fp.SkillFiles) != 1 {
		t.Errorf("SkillFiles length = %d, want 1", len(fp.SkillFiles))
	}
	if fp.SkillFiles[0].SHA256 == "" {
		t.Error("SkillFiles[0].SHA256 should not be empty")
	}
	if fp.SkillFiles[0].Size != len(skillContent) {
		t.Errorf("SkillFiles[0].Size = %d, want %d", fp.SkillFiles[0].Size, len(skillContent))
	}

	// Verify CapturedAt is set
	if fp.CapturedAt.IsZero() {
		t.Error("CapturedAt should not be zero")
	}
}

// TestComputeConfigFingerprint_MissingFiles verifies that missing files
// produce empty/zero fields without panicking.
func TestComputeConfigFingerprint_MissingFiles(t *testing.T) {
	tmpDir := t.TempDir() // empty dir, no config files

	fp := ComputeConfigFingerprint(tmpDir)

	if fp.AgentsMD != "" {
		t.Error("AgentsMD should be empty for missing file")
	}
	if fp.OpenCodeConfig != "" {
		t.Error("OpenCodeConfig should be empty for missing file")
	}
	if len(fp.SkillFiles) != 0 {
		t.Errorf("SkillFiles length = %d, want 0", len(fp.SkillFiles))
	}
	if len(fp.AgentPersonas) != 0 {
		t.Errorf("AgentPersonas length = %d, want 0", len(fp.AgentPersonas))
	}
	if fp.HashMismatch {
		t.Error("HashMismatch should be false (set by orchestrator, not here)")
	}
}

// TestComputeConfigFingerprint_Deterministic verifies that calling
// ComputeConfigFingerprint twice on the same dir produces identical output.
func TestComputeConfigFingerprint_Deterministic(t *testing.T) {
	tmpDir := t.TempDir()

	// Write AGENTS.md
	if err := os.WriteFile(filepath.Join(tmpDir, "AGENTS.md"), []byte("deterministic test content"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	fp1 := ComputeConfigFingerprint(tmpDir)
	fp2 := ComputeConfigFingerprint(tmpDir)

	if fp1.AgentsMD != fp2.AgentsMD {
		t.Errorf("AgentsMD mismatch: %s != %s", fp1.AgentsMD, fp2.AgentsMD)
	}
	if fp1.OpenCodeConfig != fp2.OpenCodeConfig {
		t.Errorf("OpenCodeConfig mismatch: %s != %s", fp1.OpenCodeConfig, fp2.OpenCodeConfig)
	}
}

// TestComputeConfigFingerprint_DetectsChange verifies that modifying a file
// changes its SHA-256 hash.
func TestComputeConfigFingerprint_DetectsChange(t *testing.T) {
	tmpDir := t.TempDir()

	// Write initial AGENTS.md
	path := filepath.Join(tmpDir, "AGENTS.md")
	if err := os.WriteFile(path, []byte("original content"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	fp1 := ComputeConfigFingerprint(tmpDir)

	// Modify AGENTS.md (add 1 byte)
	if err := os.WriteFile(path, []byte("original content!"), 0644); err != nil {
		t.Fatalf("WriteFile modified: %v", err)
	}

	fp2 := ComputeConfigFingerprint(tmpDir)

	if fp1.AgentsMD == fp2.AgentsMD {
		t.Error("AgentsMD should differ after file modification")
	}
}

// TestImproveHandler_IncludesFingerprint verifies that Run() populates
// ConfigFingerprint and sets RestartRecommended=false.
func TestImproveHandler_IncludesFingerprint(t *testing.T) {
	tmpDir := t.TempDir()

	// Write AGENTS.md so fingerprint is non-empty
	if err := os.WriteFile(filepath.Join(tmpDir, "AGENTS.md"), []byte("test agents content"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	mock := &mockImproveMemory{
		triggerExtractionN: 1,
		summaryResult:      "summary",
	}
	handler := NewImproveHandler(mock, tmpDir)

	result, err := handler.Run(context.Background(), "task-fp-001", "conversation")
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}

	if result.ConfigFingerprint == nil {
		t.Fatal("ConfigFingerprint should not be nil")
	}
	if result.ConfigFingerprint.AgentsMD == "" {
		t.Error("ConfigFingerprint.AgentsMD should be populated")
	}
	if result.RestartRecommended {
		t.Error("RestartRecommended should be false (set by orchestrator)")
	}
	if result.ConfigFingerprint.HashMismatch {
		t.Error("HashMismatch should be false (set by orchestrator)")
	}
}

// TestHashFile_NotFound verifies that hashFile returns ("", 0, false) for
// a nonexistent file.
func TestHashFile_NotFound(t *testing.T) {
	tmpDir := t.TempDir()

	hash, size, ok := hashFile(tmpDir, "nonexistent.md")
	if ok {
		t.Error("hashFile should return false for nonexistent file")
	}
	if hash != "" {
		t.Errorf("hash = %q, want empty string", hash)
	}
	if size != 0 {
		t.Errorf("size = %d, want 0", size)
	}
}

// ============================================================================
// Token Estimation Tests
// ============================================================================

func TestEstimateTokens_Empty(t *testing.T) {
	got := EstimateTokens("")
	if got != 0 {
		t.Errorf("EstimateTokens(\"\") = %d, want 0", got)
	}
}

func TestEstimateTokens_Short(t *testing.T) {
	// "hello world" = 11 chars → (11+3)/4 = 3
	got := EstimateTokens("hello world")
	if got != 3 {
		t.Errorf("EstimateTokens(\"hello world\") = %d, want 3", got)
	}
}

func TestEstimateTokens_Long(t *testing.T) {
	// 400 chars → (400+3)/4 = 100
	got := EstimateTokens(strings.Repeat("a", 400))
	if got != 100 {
		t.Errorf("EstimateTokens(400 chars) = %d, want 100", got)
	}
}

func TestEstimateTaskOutputTokens_NoSummary(t *testing.T) {
	got := EstimateTaskOutputTokens(0, false)
	if got != 0 {
		t.Errorf("EstimateTaskOutputTokens(0, false) = %d, want 0", got)
	}
}

func TestEstimateTaskOutputTokens_SummaryOnly(t *testing.T) {
	got := EstimateTaskOutputTokens(0, true)
	if got != 2000 {
		t.Errorf("EstimateTaskOutputTokens(0, true) = %d, want 2000", got)
	}
}

func TestEstimateTaskOutputTokens_PatternsAndSummary(t *testing.T) {
	// 5 patterns * 100 + 2000 summary = 2500
	got := EstimateTaskOutputTokens(5, true)
	if got != 2500 {
		t.Errorf("EstimateTaskOutputTokens(5, true) = %d, want 2500", got)
	}
}

// ============================================================================
// ContextBudget Tests
// ============================================================================

func TestImproveHandler_IncludesContextBudget(t *testing.T) {
	mock := &mockImproveMemory{
		triggerExtractionN: 2,
		summaryResult:      "some summary",
	}
	handler := NewImproveHandler(mock, "")

	result, err := handler.Run(context.Background(), "task-001", "some conversation text")
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}

	if result.ContextBudget == nil {
		t.Fatal("ContextBudget should not be nil")
	}
	if result.ContextBudget.TaskInputTokens <= 0 {
		t.Errorf("TaskInputTokens = %d, want > 0", result.ContextBudget.TaskInputTokens)
	}
	if result.ContextBudget.ContextWindowTokens != DefaultContextWindowTokens {
		t.Errorf("ContextWindowTokens = %d, want %d", result.ContextBudget.ContextWindowTokens, DefaultContextWindowTokens)
	}
	if result.ContextBudget.CapturedAt.IsZero() {
		t.Error("CapturedAt should not be zero")
	}
	// RecommendPrecompress is false by default (orchestrator sets it based on session totals)
	if result.ContextBudget.RecommendPrecompress {
		t.Error("RecommendPrecompress should be false (set by orchestrator)")
	}
}

func TestImproveHandler_CustomContextWindow(t *testing.T) {
	mock := &mockImproveMemory{
		triggerExtractionN: 0,
		summaryResult:      "",
	}
	handler := NewImproveHandlerWithContext(mock, "", 32000)

	result, err := handler.Run(context.Background(), "task-001", "")
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}

	if result.ContextBudget == nil {
		t.Fatal("ContextBudget should not be nil")
	}
	if result.ContextBudget.ContextWindowTokens != 32000 {
		t.Errorf("ContextWindowTokens = %d, want 32000", result.ContextBudget.ContextWindowTokens)
	}
}

func TestSetContextWindow(t *testing.T) {
	mock := &mockImproveMemory{
		triggerExtractionN: 1,
		summaryResult:      "summary",
	}
	handler := NewImproveHandler(mock, "")
	handler.SetContextWindow(128000)

	result, err := handler.Run(context.Background(), "task-001", "conversation")
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}

	if result.ContextBudget == nil {
		t.Fatal("ContextBudget should not be nil")
	}
	if result.ContextBudget.ContextWindowTokens != 128000 {
		t.Errorf("ContextWindowTokens = %d, want 128000", result.ContextBudget.ContextWindowTokens)
	}
}
