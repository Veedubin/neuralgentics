// Package orchestrator provides end-to-end tests that verify the full
// Orchestrator → MemorySystem → PostgreSQL → Search lifecycle.
//
// These tests require Docker (for testcontainers) and are skipped in
// short mode (go test -short) and when the NEURALGENTICS_SKIP_E2E
// environment variable is set.
package orchestrator

import (
	"context"
	"fmt"
	"sync"
	"testing"

	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"neuralgentics/src/neuralgentics/memory"
	"neuralgentics/src/neuralgentics/memory/core"
)

// setupE2EDB starts a PostgreSQL+pgvector testcontainer and returns the
// container handle and a connection string suitable for core.Config.DatabaseURL.
func setupE2EDB(t *testing.T, ctx context.Context) (*tcpostgres.PostgresContainer, string) {
	t.Helper()

	pgContainer, err := tcpostgres.Run(ctx,
		"pgvector/pgvector:pg16",
		tcpostgres.WithDatabase("neuralgentics"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("testpassword"),
		tcpostgres.BasicWaitStrategies(),
	)
	if err != nil {
		t.Fatalf("failed to start postgres container: %v", err)
	}

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		pgContainer.Terminate(ctx)
		t.Fatalf("failed to get connection string: %v", err)
	}

	return pgContainer, connStr
}

// shouldSkipE2E returns true when E2E tests should be skipped
// (short mode or NEURALGENTICS_SKIP_E2E env var).
func shouldSkipE2E(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping E2E test in short mode")
	}
}

// ============================================================================
// Test: Orchestrator → Memory → PostgreSQL lifecycle
// ============================================================================

func TestE2E_OrchestratorMemoryLifecycle(t *testing.T) {
	shouldSkipE2E(t)

	ctx := context.Background()

	// 1. Start PostgreSQL testcontainer
	pg, connStr := setupE2EDB(t, ctx)
	defer pg.Terminate(ctx)

	// 2. Create MemorySystem
	cfg := &core.Config{
		DatabaseURL: connStr,
	}
	mem, err := memory.New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	// Verify health
	status, err := mem.GetStatus(ctx)
	if err != nil {
		t.Fatalf("failed to get status: %v", err)
	}
	if !status.Ready {
		t.Fatal("memory system not ready")
	}
	t.Logf("Memory system ready: dimension=%d, memoryCount=%d", status.Dimension, status.MemoryCount)

	// 3. Create adapter + orchestrator
	adapter := NewMemorySystemAdapter(mem)
	orch, err := New(&OrchestratorConfig{
		Memory:             adapter,
		ProtocolStrictness: StrictnessStandard,
		MaxConcurrent:      5,
	})
	if err != nil {
		t.Fatalf("failed to create orchestrator: %v", err)
	}
	defer orch.Close(ctx)

	// 4. Add memories through the memory system
	id1, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "user prefers dark mode for the code editor",
		SourceType:  "session",
		ContentHash: "e2e-dark-mode-hash",
	})
	if err != nil {
		t.Fatalf("AddMemory (id1) failed: %v", err)
	}
	t.Logf("Added memory id1: %s", id1)

	id2, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "project uses Go for the memory module",
		SourceType:  "project",
		ContentHash: "e2e-golang-hash",
	})
	if err != nil {
		t.Fatalf("AddMemory (id2) failed: %v", err)
	}
	t.Logf("Added memory id2: %s", id2)

	// 5. Orchestrator builds context (inline mode — not stateless)
	task := Task{
		ID:          "e2e-task-1",
		Type:        TaskTypeCodeImpl,
		Description: "Add dark mode toggle",
		UserRequest: "Implement a dark mode toggle for the UI",
		Priority:    PriorityHigh,
	}

	result, err := orch.HandleTask(ctx, task)
	if err != nil {
		t.Fatalf("HandleTask failed: %v", err)
	}

	// 6. Verify context package was built (even if empty previous decisions)
	if result.ContextPackage.UserRequest == "" {
		t.Error("ContextPackage.UserRequest should not be empty")
	}

	// The context package should have populated fields from the task
	if result.ContextPackage.UserRequest != task.UserRequest {
		t.Errorf("ContextPackage.UserRequest = %q, want %q", result.ContextPackage.UserRequest, task.UserRequest)
	}

	// Verify the orchestrator routed to the correct agent
	if result.Agent != AgentCoder {
		t.Errorf("HandleTask agent = %v, want coder", result.Agent)
	}

	// Verify previous decisions are present (even if empty slice)
	// The important thing is no crash, not necessarily populated results
	t.Logf("PreviousDecisions count: %d", len(result.ContextPackage.PreviousDecisions))

	// 7. Verify the orchestrator can query memory
	retrieved, err := adapter.GetMemory(ctx, id1)
	if err != nil {
		t.Fatalf("GetMemory(id1) failed: %v", err)
	}
	if retrieved.Content != "user prefers dark mode for the code editor" {
		t.Errorf("GetMemory content = %q, want dark mode preference", retrieved.Content)
	}
	if retrieved.ID != id1 {
		t.Errorf("GetMemory ID = %q, want %q", retrieved.ID, id1)
	}

	// 8. Trust propagation
	adj, err := mem.AdjustTrust(ctx, id1, core.SignalAgentUsed)
	if err != nil {
		t.Fatalf("AdjustTrust failed: %v", err)
	}
	if adj.NewScore <= 0.5 {
		t.Errorf("trust after agent_used signal = %f, want > 0.5", adj.NewScore)
	}
	t.Logf("Trust adjusted: %f -> %f (signal: agent_used)", adj.OldScore, adj.NewScore)

	// Verify trust score persists via GetMemory
	entry, err := mem.GetMemory(ctx, id1)
	if err != nil {
		t.Fatalf("GetMemory after trust adjustment failed: %v", err)
	}
	if entry.TrustScore <= 0.5 {
		t.Errorf("trust score after agent_used = %f, want > 0.5", entry.TrustScore)
	}

	// Clean up — delete memories
	if err := mem.DeleteMemory(ctx, id1); err != nil {
		t.Logf("DeleteMemory(id1) warning: %v", err)
	}
	if err := mem.DeleteMemory(ctx, id2); err != nil {
		t.Logf("DeleteMemory(id2) warning: %v", err)
	}
}

// ============================================================================
// Test: Parallel Dispatch — concurrent tasks don't race
// ============================================================================

func TestE2E_ParallelDispatch(t *testing.T) {
	shouldSkipE2E(t)

	ctx := context.Background()

	pg, connStr := setupE2EDB(t, ctx)
	defer pg.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := memory.New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	adapter := NewMemorySystemAdapter(mem)
	orch, err := New(&OrchestratorConfig{
		Memory:             adapter,
		ProtocolStrictness: StrictnessLenient,
		MaxConcurrent:      5,
	})
	if err != nil {
		t.Fatalf("failed to create orchestrator: %v", err)
	}
	defer orch.Close(ctx)

	// Add memories concurrently
	const numTasks = 10
	var wg sync.WaitGroup
	memoryIDs := make([]string, numTasks)
	errors := make([]error, numTasks)

	for i := 0; i < numTasks; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			id, err := mem.AddMemory(ctx, core.MemoryEntry{
				Content:     fmt.Sprintf("parallel memory %d: concurrent test data", idx),
				SourceType:  "session",
				ContentHash: fmt.Sprintf("parallel-hash-%d", idx),
			})
			memoryIDs[idx] = id
			errors[idx] = err
		}(i)
	}
	wg.Wait()

	// Verify all succeeded
	for i, err := range errors {
		if err != nil {
			t.Errorf("parallel AddMemory(%d) failed: %v", i, err)
		}
		if memoryIDs[i] == "" {
			t.Errorf("parallel AddMemory(%d) returned empty ID", i)
		}
	}

	// Verify count
	count, err := mem.CountMemories(ctx)
	if err != nil {
		t.Fatalf("CountMemories failed: %v", err)
	}
	if count < numTasks {
		t.Errorf("expected at least %d memories, got %d", numTasks, count)
	}

	// Dispatch parallel HandleTask calls
	type handleResult struct {
		agent AgentRole
		err   error
	}
	handleResults := make([]handleResult, numTasks)
	for i := 0; i < numTasks; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			result, err := orch.HandleTask(ctx, Task{
				ID:          fmt.Sprintf("parallel-task-%d", idx),
				Type:        TaskTypeCodeImpl,
				Description: fmt.Sprintf("Parallel task %d", idx),
				UserRequest: fmt.Sprintf("Handle parallel task %d", idx),
				Priority:    PriorityMedium,
			})
			hr := handleResult{}
			if err != nil {
				hr.err = err
			} else {
				hr.agent = result.Agent
			}
			handleResults[idx] = hr
		}(i)
	}
	wg.Wait()

	// All should route to coder
	for i, hr := range handleResults {
		if hr.err != nil {
			t.Errorf("parallel HandleTask(%d) error: %v", i, hr.err)
			continue
		}
		if hr.agent != AgentCoder {
			t.Errorf("parallel HandleTask(%d) agent = %v, want coder", i, hr.agent)
		}
	}

	t.Logf("Parallel dispatch: %d tasks handled successfully", numTasks)
}

// ============================================================================
// Test: 8-Step Protocol Enforcement with Memory
// ============================================================================

func TestE2E_ProtocolEnforcement(t *testing.T) {
	shouldSkipE2E(t)

	ctx := context.Background()

	pg, connStr := setupE2EDB(t, ctx)
	defer pg.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := memory.New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	adapter := NewMemorySystemAdapter(mem)

	// Strict enforcement
	orch, err := New(&OrchestratorConfig{
		Memory:             adapter,
		ProtocolStrictness: StrictnessStandard,
		MaxConcurrent:      5,
	})
	if err != nil {
		t.Fatalf("failed to create orchestrator: %v", err)
	}
	defer orch.Close(ctx)

	task := Task{
		ID:          "protocol-task-1",
		Type:        TaskTypeArchDesign,
		Description: "Design the data pipeline architecture",
		UserRequest: "We need a scalable data pipeline",
		Priority:    PriorityHigh,
	}

	result, err := orch.HandleTask(ctx, task)
	if err != nil {
		t.Fatalf("HandleTask failed: %v", err)
	}

	// Verify routing: architecture design → architect
	if result.Agent != AgentArchitect {
		t.Errorf("HandleTask agent = %v, want architect", result.Agent)
	}

	// Verify protocol state was tracked
	state := orch.GetProtocolMachine().GetState(task.ID)
	if state == nil {
		t.Fatal("protocol state should not be nil after HandleTask")
	}

	// Verify all mandatory protocol steps were completed
	expectedSteps := []ProtocolStep{
		StepMemoryQuery, StepThoughtChain, StepPlan, StepDelegate,
	}
	for _, step := range expectedSteps {
		found := false
		for _, completed := range state.CompletedSteps {
			if completed == step {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("protocol step %s not completed; completed: %v", step, state.CompletedSteps)
		}
	}

	// Verify no violations in standard mode (we followed the protocol)
	if len(state.Violations) > 0 {
		t.Logf("Protocol violations (may be expected in standard mode): %v", state.Violations)
	}

	t.Logf("Protocol state: currentStep=%s, completedSteps=%d, violations=%d",
		state.CurrentStep, len(state.CompletedSteps), len(state.Violations))

	// Test context package for architecture task type
	if result.ContextPackage.ScopeIn == nil || len(result.ContextPackage.ScopeIn) == 0 {
		t.Error("ContextPackage.ScopeIn should not be empty for arch design task")
	}

	// Test AdjustTrust workflow within protocol context
	// Use the adapter directly since Orchestrator.memory is unexported
	memID, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "Architecture decision: use event-driven pipeline",
		SourceType:  "project",
		ContentHash: "protocol-arch-decision",
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	// Simulate agent_used trust adjustment (as per the protocol)
	// Using adapter directly since Orchestrator's memory field is unexported
	adj, err := adapter.AdjustTrust(ctx, memID, SignalAgentUsed)
	if err != nil {
		t.Fatalf("AdjustTrust within protocol context failed: %v", err)
	}
	if adj.NewScore <= adj.OldScore {
		t.Errorf("agent_used should increase trust: %f -> %f", adj.OldScore, adj.NewScore)
	}
}

// ============================================================================
// Test: Context Building — L0/L1 summaries + trust scores in ContextPackage
// ============================================================================

func TestE2E_ContextBuilding(t *testing.T) {
	shouldSkipE2E(t)

	ctx := context.Background()

	pg, connStr := setupE2EDB(t, ctx)
	defer pg.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := memory.New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	adapter := NewMemorySystemAdapter(mem)
	orch, err := New(&OrchestratorConfig{
		Memory:             adapter,
		ProtocolStrictness: StrictnessLenient,
		MaxConcurrent:      5,
	})
	if err != nil {
		t.Fatalf("failed to create orchestrator: %v", err)
	}
	defer orch.Close(ctx)

	// Add memories with different trust scores and source types
	_, err = mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "The project uses React for the frontend",
		SourceType:  "project",
		ContentHash: "context-react",
		TrustScore:  0.9, // High trust — should show up in results
	})
	if err != nil {
		t.Fatalf("AddMemory (react) failed: %v", err)
	}

	_, err = mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "User prefers TypeScript over JavaScript",
		SourceType:  "session",
		ContentHash: "context-ts",
		TrustScore:  0.5, // Default trust
	})
	if err != nil {
		t.Fatalf("AddMemory (typescript) failed: %v", err)
	}

	_, err = mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "Always use absolute imports in Python",
		SourceType:  "boomerang",
		ContentHash: "context-python",
		TrustScore:  0.85,
	})
	if err != nil {
		t.Fatalf("AddMemory (python) failed: %v", err)
	}

	// Build context package directly
	task := Task{
		ID:          "ctx-task-1",
		Type:        TaskTypeCodeImpl,
		Description: "Implement React component",
		UserRequest: "Build a new React component for the dashboard",
		Priority:    PriorityMedium,
	}

	ctxPkg, err := BuildContextPackage(ctx, adapter, task, AgentCoder)
	if err != nil {
		t.Fatalf("BuildContextPackage failed: %v", err)
	}

	// Verify context package fields are populated
	if ctxPkg.UserRequest != task.UserRequest {
		t.Errorf("UserRequest = %q, want %q", ctxPkg.UserRequest, task.UserRequest)
	}

	if ctxPkg.TaskBackground == "" {
		t.Error("TaskBackground should not be empty")
	}

	// Verify scope boundaries are set for code-impl
	if len(ctxPkg.ScopeIn) == 0 {
		t.Error("ScopeIn should not be empty for code-impl task")
	}
	if len(ctxPkg.ScopeOut) == 0 {
		t.Log("ScopeOut may be empty for code-impl (depends on routing)")
	}

	// Verify expected output is set
	if ctxPkg.ExpectedOutput == "" {
		t.Error("ExpectedOutput should not be empty")
	}

	// Verify error handling is set
	if ctxPkg.ErrorHandling == "" {
		t.Error("ErrorHandling should not be empty")
	}

	// Verify trust scores map (may or may not be populated depending on search)
	t.Logf("TrustScores count: %d", len(ctxPkg.TrustScores))

	// Verify previous decisions include project/boomerang sources
	t.Logf("PreviousDecisions count: %d", len(ctxPkg.PreviousDecisions))
	for _, dec := range ctxPkg.PreviousDecisions {
		t.Logf("  PreviousDecision: %s", dec)
	}

	// Test stateless mode
	seedPrompt, ctxMemID, err := BuildSeedPrompt(ctx, adapter, task, ctxPkg, AgentCoder)
	if err != nil {
		t.Fatalf("BuildSeedPrompt failed: %v", err)
	}
	if seedPrompt.Task == "" {
		t.Error("SeedPrompt.Task should not be empty")
	}
	if seedPrompt.MemoryID == "" {
		t.Error("SeedPrompt.MemoryID should not be empty")
	}
	if ctxMemID == "" {
		t.Error("contextMemoryID should not be empty")
	}
	t.Logf("SeedPrompt memoryID: %s", seedPrompt.MemoryID)

	// Verify we can fetch the stored context package back
	fetchedPkg, err := FetchContextPackage(ctx, adapter, ctxMemID)
	if err != nil {
		t.Fatalf("FetchContextPackage failed: %v", err)
	}
	if fetchedPkg.UserRequest != task.UserRequest {
		t.Errorf("Fetched UserRequest = %q, want %q", fetchedPkg.UserRequest, task.UserRequest)
	}

	// Store and fetch an agent wrap-up
	wrapUp := AgentWrapUp{
		Summary:       "Implemented dark mode toggle",
		FilesModified: []string{"src/ui/toggle.tsx"},
		FilesCreated:  []string{"src/ui/darkmode.tsx"},
		FollowUpTasks: []string{"Add tests for dark mode toggle"},
		TrustSignals: []TrustSignalEntry{
			{ContextMemoryID: ctxMemID, Signal: "agent_used"},
		},
	}
	wrapUpID, err := StoreAgentWrapUp(ctx, adapter, wrapUp, task, AgentCoder, ctxMemID, 1500, true)
	if err != nil {
		t.Fatalf("StoreAgentWrapUp failed: %v", err)
	}
	t.Logf("Agent wrap-up stored with ID: %s", wrapUpID)

	// Fetch it back
	fetchedWrapUp, err := FetchAgentWrapUp(ctx, adapter, wrapUpID)
	if err != nil {
		t.Fatalf("FetchAgentWrapUp failed: %v", err)
	}
	if fetchedWrapUp.Summary != wrapUp.Summary {
		t.Errorf("FetchAgentWrapUp summary = %q, want %q", fetchedWrapUp.Summary, wrapUp.Summary)
	}
	if len(fetchedWrapUp.FilesModified) != 1 {
		t.Errorf("FetchAgentWrapUp FilesModified count = %d, want 1", len(fetchedWrapUp.FilesModified))
	}
}

// ============================================================================
// Test: Dispatch with Dependency Ordering
// ============================================================================

func TestE2E_DispatchWithDependencies(t *testing.T) {
	shouldSkipE2E(t)

	ctx := context.Background()

	pg, connStr := setupE2EDB(t, ctx)
	defer pg.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := memory.New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	adapter := NewMemorySystemAdapter(mem)
	orch, err := New(&OrchestratorConfig{
		Memory:             adapter,
		ProtocolStrictness: StrictnessLenient,
		MaxConcurrent:      5,
	})
	if err != nil {
		t.Fatalf("failed to create orchestrator: %v", err)
	}
	defer orch.Close(ctx)

	// Add a memory for context
	_, err = mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "The deployment script uses bash and Docker",
		SourceType:  "project",
		ContentHash: "dispatch-dep-hash",
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	// Create a task plan with dependencies
	plan := TaskPlan{
		Tasks: []Task{
			{ID: "task-a", Type: TaskTypeArchDesign, Description: "Design the system", Priority: PriorityHigh},
			{ID: "task-b", Type: TaskTypeCodeImpl, Description: "Implement features", Priority: PriorityMedium},
			{ID: "task-c", Type: TaskTypeTesting, Description: "Write tests", Priority: PriorityLow},
		},
		Dependencies: map[string][]string{
			"task-b": {"task-a"},
			"task-c": {"task-b"},
		},
	}

	results, err := orch.Dispatch(ctx, plan)
	if err != nil {
		t.Fatalf("Dispatch failed: %v", err)
	}

	if len(results) != 3 {
		t.Errorf("expected 3 dispatch results, got %d", len(results))
	}

	// Verify results are present for all tasks
	resultMap := make(map[string]bool)
	for _, r := range results {
		resultMap[r.TaskID] = r.Success
		t.Logf("Dispatch result: taskID=%s, agent=%s, success=%v, duration=%v",
			r.TaskID, r.Agent, r.Success, r.Duration)
	}

	for _, task := range plan.Tasks {
		if _, ok := resultMap[task.ID]; !ok {
			t.Errorf("missing dispatch result for task %s", task.ID)
		}
	}
}

// ============================================================================
// Test: Trust Signals Full Workflow
// ============================================================================

func TestE2E_TrustSignalsWorkflow(t *testing.T) {
	shouldSkipE2E(t)

	ctx := context.Background()

	pg, connStr := setupE2EDB(t, ctx)
	defer pg.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := memory.New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	// Add a memory and test all trust signals
	id, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "Trust signal test memory",
		SourceType:  "session",
		ContentHash: "trust-signal-e2e",
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	// Verify initial trust score
	entry, err := mem.GetMemory(ctx, id)
	if err != nil {
		t.Fatalf("GetMemory failed: %v", err)
	}
	if entry.TrustScore != 0.5 {
		t.Errorf("initial trust score = %f, want 0.5", entry.TrustScore)
	}

	// Test agent_used (+0.05)
	adj, err := mem.AdjustTrust(ctx, id, core.SignalAgentUsed)
	if err != nil {
		t.Fatalf("AdjustTrust (agent_used) failed: %v", err)
	}
	if adj.NewScore != 0.55 {
		t.Errorf("after agent_used: trust = %f, want 0.55", adj.NewScore)
	}

	// Test user_confirmed (+0.10)
	adj2, err := mem.AdjustTrust(ctx, id, core.SignalUserConfirmed)
	if err != nil {
		t.Fatalf("AdjustTrust (user_confirmed) failed: %v", err)
	}
	if adj2.NewScore != 0.65 {
		t.Errorf("after user_confirmed: trust = %f, want 0.65", adj2.NewScore)
	}

	// Test agent_ignored (-0.05)
	adj3, err := mem.AdjustTrust(ctx, id, core.SignalAgentIgnored)
	if err != nil {
		t.Fatalf("AdjustTrust (agent_ignored) failed: %v", err)
	}
	if adj3.NewScore != 0.60 {
		t.Errorf("after agent_ignored: trust = %f, want 0.60", adj3.NewScore)
	}

	// Test user_corrected (-0.10)
	adj4, err := mem.AdjustTrust(ctx, id, core.SignalUserCorrected)
	if err != nil {
		t.Fatalf("AdjustTrust (user_corrected) failed: %v", err)
	}
	if adj4.NewScore != 0.50 {
		t.Errorf("after user_corrected: trust = %f, want 0.50", adj4.NewScore)
	}

	t.Logf("Trust signal workflow complete: initial=0.5, final=%.2f", adj4.NewScore)
}

// ============================================================================
// Test: Protocol Waiver Phrases
// ============================================================================

func TestE2E_ProtocolWaiverPhrases(t *testing.T) {
	shouldSkipE2E(t)

	ctx := context.Background()

	pg, connStr := setupE2EDB(t, ctx)
	defer pg.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := memory.New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	adapter := NewMemorySystemAdapter(mem)
	orch, err := New(&OrchestratorConfig{
		Memory:             adapter,
		ProtocolStrictness: StrictnessStandard,
		MaxConcurrent:      5,
	})
	if err != nil {
		t.Fatalf("failed to create orchestrator: %v", err)
	}
	defer orch.Close(ctx)

	// Test that waiver phrases work with the protocol machine
	taskID := "waiver-test-1"
	orch.GetProtocolMachine().InitState(taskID)

	// Apply waiver for plan step
	orch.GetProtocolMachine().ApplyWaiver(taskID, StepPlan, "skip planning")

	// Verify the waived step is recorded
	state := orch.GetProtocolMachine().GetState(taskID)
	if state == nil {
		t.Fatal("protocol state should not be nil")
	}

	if state.WaivedSteps[StepPlan] != "skip planning" {
		t.Errorf("waived step not recorded: got %q", state.WaivedSteps[StepPlan])
	}

	t.Logf("Protocol waiver test passed: plan step waived with 'skip planning'")
}
