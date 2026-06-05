package orchestrator

import (
	"context"
	"strings"
	"testing"
)

// ============================================================================
// Mock MemoryProvider for context_builder unit tests
// ============================================================================

// mockMemoryProvider implements MemoryProvider with controlled data for testing.
type mockMemoryProvider struct {
	memories []*MemoryEntry
	addErr   error
	queryErr error
	getErr   error
}

func (m *mockMemoryProvider) AddMemory(_ context.Context, entry MemoryEntry) (string, error) {
	if m.addErr != nil {
		return "", m.addErr
	}
	return "mem-" + entry.SourceType, nil
}

func (m *mockMemoryProvider) QueryMemories(_ context.Context, _ string, _ *SearchOptions) ([]*MemoryEntry, error) {
	if m.queryErr != nil {
		return nil, m.queryErr
	}
	return m.memories, nil
}

func (m *mockMemoryProvider) GetMemory(_ context.Context, _ string) (*MemoryEntry, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	if len(m.memories) > 0 {
		return m.memories[0], nil
	}
	return nil, nil
}

func (m *mockMemoryProvider) DeleteMemory(_ context.Context, _ string) error {
	return nil
}

func (m *mockMemoryProvider) AdjustTrust(_ context.Context, _ string, _ TrustSignal) (*TrustAdjustment, error) {
	return &TrustAdjustment{}, nil
}

func (m *mockMemoryProvider) Close(_ context.Context) error {
	return nil
}

// ============================================================================
// Tests: BuildContextPackage
// ============================================================================

func TestBuildContextPackage_WithRelevantMemories(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{
		memories: []*MemoryEntry{
			{ID: "mem-1", Content: "Previous decision about project structure", SourceType: "project", TrustScore: 0.9},
			{ID: "mem-2", Content: "User confirmed approval for caching layer", SourceType: "boomerang", TrustScore: 0.8},
			{ID: "mem-3", Content: "Config file contents", SourceType: "file", SourcePath: strPtr("/src/config.go"), TrustScore: 0.7},
			{ID: "mem-4", Content: "func main() { fmt.Println(\"hello\") }", SourceType: "file", SourcePath: strPtr("/src/main.go"), TrustScore: 0.6},
		},
	}

	task := Task{
		ID:          "test-1",
		Type:        TaskTypeCodeImpl,
		Description: "Implement caching layer",
		UserRequest: "Add caching to the data layer",
		Priority:    PriorityHigh,
	}

	pkg, err := BuildContextPackage(ctx, mock, task, AgentCoder)
	if err != nil {
		t.Fatalf("BuildContextPackage failed: %v", err)
	}

	// Verify basic fields
	if pkg.UserRequest != "Add caching to the data layer" {
		t.Errorf("UserRequest = %q, want %q", pkg.UserRequest, "Add caching to the data layer")
	}

	// Verify previous decisions extracted from project/boomerang source types
	if len(pkg.PreviousDecisions) != 2 {
		t.Errorf("expected 2 previous decisions (project + boomerang), got %d", len(pkg.PreviousDecisions))
	} else {
		if pkg.PreviousDecisions[0] != "Previous decision about project structure" {
			t.Errorf("unexpected first decision: %q", pkg.PreviousDecisions[0])
		}
	}

	// Verify relevant files extracted from file-type memories
	if len(pkg.RelevantFiles) != 2 {
		t.Errorf("expected 2 relevant files, got %d: %v", len(pkg.RelevantFiles), pkg.RelevantFiles)
	} else {
		if pkg.RelevantFiles[0] != "/src/config.go" {
			t.Errorf("expected first file /src/config.go, got %q", pkg.RelevantFiles[0])
		}
	}

	// Verify code snippets
	if len(pkg.CodeSnippets) < 1 {
		t.Errorf("expected at least 1 code snippet, got %d", len(pkg.CodeSnippets))
	} else {
		if pkg.CodeSnippets["/src/main.go"] != "func main() { fmt.Println(\"hello\") }" {
			t.Errorf("unexpected snippet content for /src/main.go")
		}
	}

	// Verify trust scores
	if pkg.TrustScores["mem-1"] != 0.9 {
		t.Errorf("expected trust score 0.9 for mem-1, got %f", pkg.TrustScores["mem-1"])
	}
	if pkg.TrustScores["mem-2"] != 0.8 {
		t.Errorf("expected trust score 0.8 for mem-2, got %f", pkg.TrustScores["mem-2"])
	}

	// Verify scope boundaries for code-implementation + coder
	if len(pkg.ScopeIn) == 0 {
		t.Error("expected non-empty ScopeIn")
	}
	if len(pkg.ScopeOut) == 0 {
		t.Error("expected non-empty ScopeOut for code-impl + same-agent")
	}

	// Verify expected output
	if pkg.ExpectedOutput == "" {
		t.Error("expected non-empty ExpectedOutput")
	}

	// Verify error handling
	if pkg.ErrorHandling == "" {
		t.Error("expected non-empty ErrorHandling")
	}

	// Verify task background
	if !strings.Contains(pkg.TaskBackground, "Implement caching layer") {
		t.Errorf("TaskBackground missing task description: %s", pkg.TaskBackground)
	}
	if !strings.Contains(pkg.TaskBackground, "code-implementation") {
		t.Errorf("TaskBackground missing task type: %s", pkg.TaskBackground)
	}
}

func TestBuildContextPackage_EmptyMemories(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{
		memories: []*MemoryEntry{},
	}

	task := Task{
		ID:          "test-empty",
		Type:        TaskTypeCodeImpl,
		Description: "A simple task with no context",
		UserRequest: "Add a small feature",
		Priority:    PriorityLow,
	}

	pkg, err := BuildContextPackage(ctx, mock, task, AgentCoder)
	if err != nil {
		t.Fatalf("BuildContextPackage with empty memories failed: %v", err)
	}

	// Should have empty slices, not nil
	if pkg.PreviousDecisions == nil {
		t.Error("PreviousDecisions should be empty slice, not nil")
	}
	if pkg.RelevantFiles == nil {
		t.Error("RelevantFiles should be empty slice, not nil")
	}
	if pkg.RelevantFiles != nil && len(pkg.RelevantFiles) != 0 {
		t.Errorf("expected 0 relevant files with empty memories, got %d", len(pkg.RelevantFiles))
	}

	// Code snippets should be empty map
	if pkg.CodeSnippets == nil {
		t.Error("CodeSnippets should be empty map, not nil")
	}
	if len(pkg.CodeSnippets) != 0 {
		t.Errorf("expected 0 code snippets, got %d", len(pkg.CodeSnippets))
	}

	// Trust scores should be empty
	if len(pkg.TrustScores) != 0 {
		t.Errorf("expected 0 trust scores with empty memories, got %d", len(pkg.TrustScores))
	}
}

func TestBuildContextPackage_MemoryQueryError(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{
		queryErr: errTest("memory error"),
	}

	task := Task{
		ID:          "test-err",
		Type:        TaskTypeCodeImpl,
		Description: "Task that triggers memory error",
		UserRequest: "Test error handling",
		Priority:    PriorityLow,
	}

	_, err := BuildContextPackage(ctx, mock, task, AgentCoder)
	if err == nil {
		t.Fatal("expected error when QueryMemories fails, got nil")
	}
	if !strings.Contains(err.Error(), "memory error") {
		t.Errorf("expected error to contain 'memory error', got: %v", err)
	}
}

func TestBuildContextPackage_DifferentTaskTypes(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{
		memories: []*MemoryEntry{
			{ID: "mem-1", Content: "Some context", SourceType: "session", TrustScore: 0.5},
		},
	}

	tests := []struct {
		taskType TaskType
		agent    AgentRole
		name     string
	}{
		{TaskTypeArchDesign, AgentArchitect, "architecture"},
		{TaskTypeTesting, AgentTester, "testing"},
		{TaskTypeFileFinding, AgentExplorer, "file-finding"},
		{TaskTypeDocumentation, AgentWriter, "documentation"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			task := Task{
				ID:          "test-" + tt.name,
				Type:        tt.taskType,
				Description: "A " + tt.name + " task",
				UserRequest: "Do the " + tt.name + " task",
				Priority:    PriorityMedium,
			}

			pkg, err := BuildContextPackage(ctx, mock, task, tt.agent)
			if err != nil {
				t.Fatalf("BuildContextPackage for %s failed: %v", tt.name, err)
			}

			// Each task type should have appropriate scope boundaries
			if len(pkg.ScopeIn) == 0 {
				t.Errorf("%s: expected non-empty ScopeIn", tt.name)
			}

			// Expected output should be non-empty
			if pkg.ExpectedOutput == "" {
				t.Errorf("%s: expected non-empty ExpectedOutput", tt.name)
			}

			// Error handling should be non-empty
			if pkg.ErrorHandling == "" {
				t.Errorf("%s: expected non-empty ErrorHandling", tt.name)
			}

			// Task background should include task description
			if !strings.Contains(pkg.TaskBackground, task.Description) {
				t.Errorf("%s: TaskBackground missing description", tt.name)
			}
		})
	}
}

// ============================================================================
// Tests: StoreContextPackage / FetchContextPackage
// ============================================================================

func TestStoreAndFetchContextPackage_RoundTrip(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{
		memories: []*MemoryEntry{
			{ID: "fetch-mem-1", Content: "Context data", SourceType: "session", TrustScore: 0.7},
		},
	}

	task := Task{
		ID:          "rt-1",
		Type:        TaskTypeCodeImpl,
		Description: "Round-trip test task",
		UserRequest: "Test store and fetch",
		Priority:    PriorityLow,
	}

	pkg, err := BuildContextPackage(ctx, mock, task, AgentCoder)
	if err != nil {
		t.Fatalf("BuildContextPackage failed: %v", err)
	}

	// Store the context package
	memoryID, err := StoreContextPackage(ctx, mock, pkg, task, AgentCoder)
	if err != nil {
		t.Fatalf("StoreContextPackage failed: %v", err)
	}
	if memoryID == "" {
		t.Fatal("StoreContextPackage returned empty memoryID")
	}

	// Fetch it back by using mock.GetMemory which returns the first memory
	// Override the mock to return our stored content
	mock.getErr = nil
	mock.memories = []*MemoryEntry{
		{
			ID:         memoryID,
			Content:    `{"userRequest":"Test store and fetch","taskBackground":"Task: Round-trip test task\nType: code-implementation\nPriority: low","previousDecisions":[],"expectedOutput":"Modified files with implementation, 100-300 word summary"}`,
			SourceType: "context_package",
		},
	}

	fetched, err := FetchContextPackage(ctx, mock, memoryID)
	if err != nil {
		t.Fatalf("FetchContextPackage failed: %v", err)
	}

	if fetched.UserRequest != "Test store and fetch" {
		t.Errorf("UserRequest = %q, want %q", fetched.UserRequest, "Test store and fetch")
	}
	if !strings.Contains(fetched.TaskBackground, "Round-trip test task") {
		t.Errorf("TaskBackground missing task description: %s", fetched.TaskBackground)
	}
	if fetched.ExpectedOutput != "Modified files with implementation, 100-300 word summary" {
		t.Errorf("ExpectedOutput = %q, want %q", fetched.ExpectedOutput, "Modified files with implementation, 100-300 word summary")
	}
}

func TestStoreContextPackage_ErrorPath(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{
		addErr: errTest("storage full"),
	}

	task := Task{
		ID:          "err-store",
		Type:        TaskTypeCodeImpl,
		Description: "Task that triggers storage error",
		UserRequest: "Test storage error",
		Priority:    PriorityLow,
	}

	pkg := ContextPackage{
		UserRequest: task.UserRequest,
		ScopeIn:     []string{"test"},
	}

	_, err := StoreContextPackage(ctx, mock, pkg, task, AgentCoder)
	if err == nil {
		t.Fatal("expected error when AddMemory fails, got nil")
	}
	if !strings.Contains(err.Error(), "storage full") {
		t.Errorf("expected error to contain 'storage full', got: %v", err)
	}
}

func TestFetchContextPackage_ErrorPath(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{
		getErr: errTest("memory not found"),
	}

	_, err := FetchContextPackage(ctx, mock, "nonexistent-id")
	if err == nil {
		t.Fatal("expected error when GetMemory fails, got nil")
	}
	if !strings.Contains(err.Error(), "memory not found") {
		t.Errorf("expected error to contain 'memory not found', got: %v", err)
	}
}

// ============================================================================
// Tests: StoreAgentWrapUp / FetchAgentWrapUp
// ============================================================================

func TestStoreAndFetchAgentWrapUp_RoundTrip(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{}

	task := Task{
		ID:          "wrap-1",
		Type:        TaskTypeCodeImpl,
		Description: "Wrap-up test task",
		Priority:    PriorityLow,
	}

	wrapUp := AgentWrapUp{
		Summary:       "Successfully implemented caching layer",
		FilesModified: []string{"/src/cache.go", "/src/main.go"},
		FilesCreated:  []string{"/src/cache_test.go"},
		FollowUpTasks: []string{"Add integration test"},
		TrustSignals: []TrustSignalEntry{
			{ContextMemoryID: "ctx-mem-1", Signal: string(SignalAgentUsed)},
		},
	}

	wrapUpID, err := StoreAgentWrapUp(ctx, mock, wrapUp, task, AgentCoder, "ctx-mem-1", 1500, true)
	if err != nil {
		t.Fatalf("StoreAgentWrapUp failed: %v", err)
	}
	if wrapUpID == "" {
		t.Fatal("StoreAgentWrapUp returned empty ID")
	}

	// Fetch back
	mock.memories = []*MemoryEntry{
		{
			ID:         wrapUpID,
			Content:    `{"summary":"Successfully implemented caching layer","filesModified":["/src/cache.go","/src/main.go"],"filesCreated":["/src/cache_test.go"],"followUpTasks":["Add integration test"],"trustSignals":[{"contextMemoryId":"ctx-mem-1","signal":"agent_used"}]}`,
			SourceType: "agent_wrap_up",
		},
	}

	fetched, err := FetchAgentWrapUp(ctx, mock, wrapUpID)
	if err != nil {
		t.Fatalf("FetchAgentWrapUp failed: %v", err)
	}

	if fetched.Summary != "Successfully implemented caching layer" {
		t.Errorf("Summary = %q, want %q", fetched.Summary, "Successfully implemented caching layer")
	}
	if len(fetched.FilesModified) != 2 {
		t.Errorf("expected 2 modified files, got %d", len(fetched.FilesModified))
	}
	if len(fetched.FollowUpTasks) != 1 {
		t.Errorf("expected 1 follow-up task, got %d", len(fetched.FollowUpTasks))
	}
}

func TestStoreAgentWrapUp_ErrorPath(t *testing.T) {
	ctx := context.Background()
	mock := &mockMemoryProvider{
		addErr: errTest("wrap-up storage failed"),
	}

	wrapUp := AgentWrapUp{Summary: "test"}
	_, err := StoreAgentWrapUp(ctx, mock, wrapUp, Task{}, AgentCoder, "", 0, false)
	if err == nil {
		t.Fatal("expected error when AddMemory fails, got nil")
	}
}

// ============================================================================
// Tests: FormatSeedPrompt
// ============================================================================

func TestFormatSeedPrompt_ContainsExpectedContent(t *testing.T) {
	prompt := FormatSeedPrompt("Implement feature X", "mem-12345-abcde")

	if !strings.Contains(prompt, "Implement feature X") {
		t.Error("seed prompt should contain task description")
	}
	if !strings.Contains(prompt, "mem-12345-abcde") {
		t.Error("seed prompt should contain memory ID")
	}
	if !strings.Contains(prompt, "## Task") {
		t.Error("seed prompt should have ## Task header")
	}
	if !strings.Contains(prompt, "## Memory Context") {
		t.Error("seed prompt should have ## Memory Context header")
	}
	if !strings.Contains(prompt, "## Protocol (MANDATORY") {
		t.Error("seed prompt should have protocol section")
	}
	if !strings.Contains(prompt, "Wrap-Up Storage") {
		t.Error("seed prompt should mention wrap-up storage")
	}
	if !strings.Contains(prompt, "Trust Signal") {
		t.Error("seed prompt should mention trust signal")
	}
	if !strings.Contains(prompt, "Return Format") {
		t.Error("seed prompt should mention return format")
	}
}

// ============================================================================
// Helpers
// ============================================================================

func strPtr(s string) *string {
	return &s
}

// errTest returns a simple error value for testing error paths.
type errTest string

func (e errTest) Error() string {
	return string(e)
}
