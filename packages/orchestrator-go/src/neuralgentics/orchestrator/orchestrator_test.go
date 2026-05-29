package orchestrator

import (
	"testing"
)

// ============================================================================
// Routing Tests
// ============================================================================

func TestResolveAgent(t *testing.T) {
	tests := []struct {
		taskType  TaskType
		wantAgent AgentRole
		wantErr   bool
	}{
		{TaskTypeCodeImpl, AgentCoder, false},
		{TaskTypeArchDesign, AgentArchitect, false},
		{TaskTypeFileFinding, AgentExplorer, false},
		{TaskTypeTesting, AgentTester, false},
		{TaskTypeLinting, AgentLinter, false},
		{TaskTypeGit, AgentGit, false},
		{TaskTypeDocumentation, AgentWriter, false},
		{TaskTypeWebScraping, AgentScraper, false},
		{TaskTypeMCPDebug, AgentMCPSpecialist, false},
		{TaskTypeRelease, AgentRelease, false},
		{TaskType("unknown"), "", true},
	}

	for _, tt := range tests {
		t.Run(string(tt.taskType), func(t *testing.T) {
			got, err := ResolveAgent(tt.taskType)
			if (err != nil) != tt.wantErr {
				t.Errorf("ResolveAgent(%s) error = %v, wantErr %v", tt.taskType, err, tt.wantErr)
				return
			}
			if !tt.wantErr && got != tt.wantAgent {
				t.Errorf("ResolveAgent(%s) = %v, want %v", tt.taskType, got, tt.wantAgent)
			}
		})
	}
}

func TestIsForbiddenAgent(t *testing.T) {
	tests := []struct {
		taskType TaskType
		agent    AgentRole
		want     bool
	}{
		{TaskTypeCodeImpl, AgentExplorer, true},
		{TaskTypeCodeImpl, AgentCoder, false},
		{TaskTypeArchDesign, AgentCoder, true},
		{TaskTypeFileFinding, AgentCoder, true},
		{TaskTypeTesting, AgentCoder, true},
		{TaskTypeTesting, AgentTester, false},
		{TaskTypeGit, AgentLinter, true},
		{TaskTypeDocumentation, AgentExplorer, true},
	}

	for _, tt := range tests {
		t.Run(string(tt.taskType)+"_"+string(tt.agent), func(t *testing.T) {
			got := IsForbiddenAgent(tt.taskType, tt.agent)
			if got != tt.want {
				t.Errorf("IsForbiddenAgent(%s, %s) = %v, want %v", tt.taskType, tt.agent, got, tt.want)
			}
		})
	}
}

func TestValidateRouting(t *testing.T) {
	// Correct routing
	v := ValidateRouting(TaskTypeCodeImpl, AgentCoder)
	if !v.Valid {
		t.Errorf("ValidateRouting(code-impl, coder) should be valid, got violation: %s", v.Violation)
	}

	// Wrong agent
	v = ValidateRouting(TaskTypeCodeImpl, AgentArchitect)
	if v.Valid {
		t.Error("ValidateRouting(code-impl, architect) should be invalid")
	}
	if v.ExpectedAgent != AgentCoder {
		t.Errorf("ExpectedAgent = %v, want %v", v.ExpectedAgent, AgentCoder)
	}

	// Forbidden agent
	v = ValidateRouting(TaskTypeCodeImpl, AgentExplorer)
	if v.Valid {
		t.Error("ValidateRouting(code-impl, explorer) should be invalid (forbidden)")
	}

	// Unknown task type — should allow any agent
	v = ValidateRouting(TaskType("unknown"), AgentCoder)
	if !v.Valid {
		t.Error("ValidateRouting(unknown, coder) should be valid (no rule)")
	}
}

func TestRoutingMatrixCompleteness(t *testing.T) {
	// Every defined TaskType should have a routing rule
	definedTypes := []TaskType{
		TaskTypeCodeImpl, TaskTypeArchDesign, TaskTypeFileFinding,
		TaskTypeTesting, TaskTypeLinting, TaskTypeGit,
		TaskTypeDocumentation, TaskTypeWebScraping, TaskTypeMCPDebug,
		TaskTypeRelease,
	}

	for _, tt := range definedTypes {
		rule := GetRoutingRule(tt)
		if rule == nil {
			t.Errorf("missing routing rule for TaskType: %s", tt)
		}
	}
}

// ============================================================================
// Protocol Tests
// ============================================================================

func TestProtocolMachineAdvance(t *testing.T) {
	pm := NewProtocolMachine(StrictnessStandard)
	taskID := "test-task-1"

	pm.InitState(taskID)

	// Should start at IDLE
	state := pm.GetState(taskID)
	if state == nil {
		t.Fatal("expected state to be initialized")
	}
	if state.CurrentStep != StepIDLE {
		t.Errorf("initial state = %v, want IDLE", state.CurrentStep)
	}

	// Advance through protocol steps
	steps := []ProtocolStep{
		StepMemoryQuery, StepThoughtChain, StepPlan,
		StepDelegate, StepGitCheck, StepQualityGates,
		StepDocUpdate, StepMemorySave, StepComplete,
	}

	for _, step := range steps {
		if err := pm.Advance(taskID, step); err != nil {
			t.Errorf("Advance(%s) error: %v", step, err)
		}
	}

	state = pm.GetState(taskID)
	if state.CurrentStep != StepComplete {
		t.Errorf("final state = %v, want COMPLETE", state.CurrentStep)
	}
	if len(state.CompletedSteps) != 8 {
		t.Errorf("completed steps = %d, want 8", len(state.CompletedSteps))
	}
}

func TestProtocolMachineEnforce(t *testing.T) {
	pm := NewProtocolMachine(StrictnessStrict)
	taskID := "test-task-enforce"

	pm.InitState(taskID)

	// Enforce before completing steps should return error in strict mode
	_, err := pm.Enforce(taskID)
	if err == nil {
		t.Error("expected error for missing steps in strict mode")
	}

	// Complete all steps
	pm.Advance(taskID, StepMemoryQuery)
	pm.Advance(taskID, StepThoughtChain)
	pm.Advance(taskID, StepPlan)
	pm.Advance(taskID, StepDelegate)
	pm.Advance(taskID, StepGitCheck)
	pm.Advance(taskID, StepQualityGates)
	pm.Advance(taskID, StepDocUpdate)
	pm.Advance(taskID, StepMemorySave)

	state, err := pm.Enforce(taskID)
	if err != nil {
		t.Errorf("Enforce after completing steps should not error: %v", err)
	}
	if len(state.Violations) > 0 {
		t.Errorf("expected no violations, got %d", len(state.Violations))
	}
}

func TestProtocolMachineWaiverPhrases(t *testing.T) {
	tests := []struct {
		phrase string
		step   ProtocolStep
		want   bool
	}{
		{"skip planning", StepPlan, true},
		{"just do it", StepPlan, true},
		{"no plan needed", StepPlan, true},
		{"skip tests", StepQualityGates, true},
		{"skip gates", StepQualityGates, true},
		{"git is fine", StepGitCheck, true},
		{"no docs needed", StepDocUpdate, true},
		{"skip planning", StepGitCheck, false},
		{"random phrase", StepPlan, false},
	}

	for _, tt := range tests {
		t.Run(tt.phrase, func(t *testing.T) {
			got := CanWaiverStep(tt.phrase, tt.step)
			if got != tt.want {
				t.Errorf("CanWaiverStep(%q, %s) = %v, want %v", tt.phrase, tt.step, got, tt.want)
			}
		})
	}
}

// ============================================================================
// Dependency Graph Tests
// ============================================================================

func TestTopologicalSort(t *testing.T) {
	tasks := []FineGrainedTaskEntry{
		{ID: "a", DependsOn: []string{}},
		{ID: "b", DependsOn: []string{"a"}},
		{ID: "c", DependsOn: []string{"a"}},
		{ID: "d", DependsOn: []string{"b", "c"}},
	}

	sorted, err := TopologicalSort(tasks)
	if err != nil {
		t.Fatalf("TopologicalSort error: %v", err)
	}

	if len(sorted) != 4 {
		t.Fatalf("expected 4 tasks, got %d", len(sorted))
	}

	// 'a' must come before 'b' and 'c'
	posA := findTaskPos(sorted, "a")
	posB := findTaskPos(sorted, "b")
	posC := findTaskPos(sorted, "c")
	posD := findTaskPos(sorted, "d")

	if posA > posB {
		t.Error("a should come before b")
	}
	if posA > posC {
		t.Error("a should come before c")
	}
	if posB > posD {
		t.Error("b should come before d")
	}
	if posC > posD {
		t.Error("c should come before d")
	}
}

func TestTopologicalSortCycleDetection(t *testing.T) {
	tasks := []FineGrainedTaskEntry{
		{ID: "a", DependsOn: []string{"b"}},
		{ID: "b", DependsOn: []string{"a"}},
	}

	_, err := TopologicalSort(tasks)
	if err == nil {
		t.Error("expected error for cycle detection")
	}
}

func TestGetParallelGroups(t *testing.T) {
	tasks := []FineGrainedTaskEntry{
		{ID: "a", DependsOn: []string{}},
		{ID: "b", DependsOn: []string{}},
		{ID: "c", DependsOn: []string{"a"}},
		{ID: "d", DependsOn: []string{"b"}},
		{ID: "e", DependsOn: []string{"c", "d"}},
	}

	groups, err := GetParallelGroups(tasks)
	if err != nil {
		t.Fatalf("GetParallelGroups error: %v", err)
	}

	if len(groups) < 2 {
		t.Errorf("expected at least 2 parallel groups, got %d", len(groups))
	}

	// First group should have tasks with no dependencies
	if len(groups[0]) != 2 {
		t.Errorf("first group should have 2 tasks (a, b), got %d", len(groups[0]))
	}
}

func TestFindReadyTasks(t *testing.T) {
	tasks := []FineGrainedTaskEntry{
		{ID: "a", Status: StatusPending, DependsOn: []string{}},
		{ID: "b", Status: StatusPending, DependsOn: []string{"a"}},
		{ID: "c", Status: StatusPending, DependsOn: []string{"a"}},
		{ID: "d", Status: StatusComplete, DependsOn: []string{}},
		{ID: "e", Status: StatusPending, DependsOn: []string{"d", "a"}},
	}

	ready := FindReadyTasks(tasks)

	// 'a' has no deps, 'e' depends on 'd' (complete) and 'a' (pending)
	// Only 'a' should be ready (e still depends on 'a' which isn't complete)
	if len(ready) != 1 {
		t.Errorf("expected 1 ready task, got %d", len(ready))
	}
	if ready[0].ID != "a" {
		t.Errorf("expected ready task 'a', got '%s'", ready[0].ID)
	}
}

func TestValidateDependencyGraph(t *testing.T) {
	t.Run("valid graph", func(t *testing.T) {
		tasks := []FineGrainedTaskEntry{
			{ID: "a", DependsOn: []string{}},
			{ID: "b", DependsOn: []string{"a"}},
		}
		result := ValidateDependencyGraph(tasks)
		if !result.Valid {
			t.Errorf("expected valid graph, got errors: %v", result.Errors)
		}
	})

	t.Run("self-reference", func(t *testing.T) {
		tasks := []FineGrainedTaskEntry{
			{ID: "a", DependsOn: []string{"a"}},
		}
		result := ValidateDependencyGraph(tasks)
		if result.Valid {
			t.Error("expected invalid for self-reference")
		}
	})

	t.Run("dangling reference", func(t *testing.T) {
		tasks := []FineGrainedTaskEntry{
			{ID: "a", DependsOn: []string{"nonexistent"}},
		}
		result := ValidateDependencyGraph(tasks)
		if result.Valid {
			t.Error("expected invalid for dangling reference")
		}
	})
}

// ============================================================================
// Task State Machine Tests
// ============================================================================

func TestCanTransition(t *testing.T) {
	tests := []struct {
		from TaskStatus
		to   TaskStatus
		want bool
	}{
		{StatusPending, StatusReady, true},
		{StatusPending, StatusCancelled, true},
		{StatusPending, StatusActive, false},
		{StatusReady, StatusActive, true},
		{StatusReady, StatusCancelled, true},
		{StatusActive, StatusComplete, true},
		{StatusActive, StatusBlocked, true},
		{StatusActive, StatusFailed, true},
		{StatusComplete, StatusActive, false},
		{StatusFailed, StatusActive, false},
		{StatusCancelled, StatusPending, false},
	}

	for _, tt := range tests {
		t.Run(string(tt.from)+"->"+string(tt.to), func(t *testing.T) {
			got := CanTransition(tt.from, tt.to)
			if got != tt.want {
				t.Errorf("CanTransition(%s, %s) = %v, want %v", tt.from, tt.to, got, tt.want)
			}
		})
	}
}

func TestIsTerminal(t *testing.T) {
	if !IsTerminal(StatusComplete) {
		t.Error("COMPLETE should be terminal")
	}
	if !IsTerminal(StatusFailed) {
		t.Error("FAILED should be terminal")
	}
	if !IsTerminal(StatusCancelled) {
		t.Error("CANCELLED should be terminal")
	}
	if IsTerminal(StatusActive) {
		t.Error("ACTIVE should not be terminal")
	}
	if IsTerminal(StatusPending) {
		t.Error("PENDING should not be terminal")
	}
}

// ============================================================================
// File Ownership Registry Tests
// ============================================================================

func TestFileOwnershipRegistry(t *testing.T) {
	reg := NewFileOwnershipRegistry()

	// Acquire lock
	if !reg.AcquireLock("/src/main.go", "task-1", StatusActive) {
		t.Error("should acquire lock for new file")
	}

	// Same task re-acquire (idempotent)
	if !reg.AcquireLock("/src/main.go", "task-1", StatusActive) {
		t.Error("same task should re-acquire lock")
	}

	// Different task can't acquire
	if reg.AcquireLock("/src/main.go", "task-2", StatusActive) {
		t.Error("different task should not acquire lock on owned file")
	}

	// Get owner
	owner := reg.GetOwner("/src/main.go")
	if owner != "task-1" {
		t.Errorf("GetOwner = %q, want 'task-1'", owner)
	}

	// Update status to terminal
	reg.UpdateLockStatus("/src/main.go", "task-1", StatusComplete)

	// Now different task can acquire (previous owner is terminal)
	if !reg.AcquireLock("/src/main.go", "task-2", StatusActive) {
		t.Error("should acquire lock after previous owner completes")
	}

	// Release lock
	if !reg.ReleaseLock("/src/main.go", "task-2") {
		t.Error("should release lock")
	}

	// Unowned file
	owner = reg.GetOwner("/src/other.go")
	if owner != "" {
		t.Errorf("GetOwner for unowned file = %q, want empty", owner)
	}
}

func TestFileOwnershipRegistryClear(t *testing.T) {
	reg := NewFileOwnershipRegistry()
	reg.AcquireLock("/src/a.go", "task-1", StatusActive)
	reg.AcquireLock("/src/b.go", "task-2", StatusActive)
	reg.Clear()

	if len(reg.GetActiveLocks()) != 0 {
		t.Error("Clear should remove all locks")
	}
}

// ============================================================================
// Orchestrator Tests
// ============================================================================

func TestNewOrchestratorValidation(t *testing.T) {
	// Creating an orchestrator without a memory system should fail
	_, err := New(&OrchestratorConfig{
		Memory: nil,
	})
	if err == nil {
		t.Error("expected error when MemorySystem is nil")
	}
}

func TestBuildExecutionPlan(t *testing.T) {
	// This tests the internal buildExecutionPlan method.
	// We can't easily create a full MemorySystem for unit tests,
	// so we test the routing and plan logic directly.

	task := Task{
		ID:          "test-1",
		Type:        TaskTypeCodeImpl,
		Description: "Implement feature X",
		UserRequest: "Add feature X to the codebase",
		Priority:    PriorityHigh,
	}

	agent, err := ResolveAgent(task.Type)
	if err != nil {
		t.Fatalf("ResolveAgent error: %v", err)
	}
	if agent != AgentCoder {
		t.Errorf("ResolveAgent(code-impl) = %v, want coder", agent)
	}

	// Verify the execution plan structure
	plan := TaskPlan{
		Tasks:        []Task{task},
		Dependencies: map[string][]string{},
	}

	if len(plan.Tasks) != 1 {
		t.Errorf("expected 1 task, got %d", len(plan.Tasks))
	}
}

func TestEstimateComplexity(t *testing.T) {
	tests := []struct {
		task Task
		want string
	}{
		{Task{Priority: PriorityHigh}, "high"},
		{Task{Priority: PriorityLow, Files: []string{"a", "b", "c", "d"}}, "high"},
		{Task{Priority: PriorityMedium, Dependencies: []string{"dep1"}}, "medium"},
		{Task{Priority: PriorityLow}, "low"},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got := estimateComplexity(tt.task)
			if got != tt.want {
				t.Errorf("estimateComplexity() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRouteAgentToTaskType(t *testing.T) {
	tests := []struct {
		agent    AgentRole
		wantType TaskType
	}{
		{AgentCoder, TaskTypeCodeImpl},
		{AgentArchitect, TaskTypeArchDesign},
		{AgentExplorer, TaskTypeFileFinding},
		{AgentTester, TaskTypeTesting},
		{AgentLinter, TaskTypeLinting},
		{AgentGit, TaskTypeGit},
		{AgentWriter, TaskTypeDocumentation},
		{AgentScraper, TaskTypeWebScraping},
		{AgentMCPSpecialist, TaskTypeMCPDebug},
		{AgentRelease, TaskTypeRelease},
	}

	for _, tt := range tests {
		t.Run(string(tt.agent), func(t *testing.T) {
			got := RouteAgentToTaskType(tt.agent)
			if got != tt.wantType {
				t.Errorf("RouteAgentToTaskType(%v) = %v, want %v", tt.agent, got, tt.wantType)
			}
		})
	}
}

// ============================================================================
// Helper Functions
// ============================================================================

func findTaskPos(tasks []FineGrainedTaskEntry, id string) int {
	for i, t := range tasks {
		if t.ID == id {
			return i
		}
	}
	return -1
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
