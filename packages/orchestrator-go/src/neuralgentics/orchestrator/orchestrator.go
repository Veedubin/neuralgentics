// Package orchestrator implements the Neuralgentics Orchestrator —
// the central routing and protocol enforcement layer that imports
// the memory module directly (zero HTTP/MCP between orchestrator and memory).
package orchestrator

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

// OrchestratorConfig holds configuration for creating an Orchestrator.
type OrchestratorConfig struct {
	// MemoryProvider is the memory system interface (direct Go calls, no HTTP).
	Memory MemoryProvider
	// ProtocolStrictness controls how strictly the protocol is enforced.
	// "lenient", "standard", or "strict".
	ProtocolStrictness StrictnessLevel
	// MaxConcurrent sets the maximum number of parallel sub-agent dispatches.
	MaxConcurrent int
	// UseStatelessAgents enables stateless mode where context is stored in memory
	// and agents receive a seed prompt with a memory ID.
	UseStatelessAgents bool
	// ImproveMemoryProvider supplies the memory interface used by the IMPROVE
	// handler (step 7 of 9). If nil, the IMPROVE phase is skipped.
	ImproveMemory ImproveMemoryProvider
	// RepoRoot is the path to the repository root, used for config fingerprinting.
	// If empty, fingerprinting is skipped (returns empty ConfigFingerprint).
	RepoRoot string
}

// Orchestrator is the central routing and protocol enforcement layer.
// It uses a MemoryProvider interface for memory operations — the concrete
// *memory.MemorySystem satisfies this interface.
//
// All methods are thread-safe. The orchestrator manages protocol state per task,
// enforces the 9-step Boomerang Protocol, and routes tasks to specialist agents.
type Orchestrator struct {
	mu             sync.Mutex
	memory         MemoryProvider
	config         *OrchestratorConfig
	protocol       *ProtocolMachine
	fileLock       *FileOwnershipRegistry
	improveHandler *ImproveHandler
}

// New creates a new Orchestrator with the given configuration.
// It initializes the protocol machine and file ownership registry.
func New(cfg *OrchestratorConfig) (*Orchestrator, error) {
	if cfg.Memory == nil {
		return nil, fmt.Errorf("MemoryProvider is required (direct import, no HTTP)")
	}

	if cfg.ProtocolStrictness == "" {
		cfg.ProtocolStrictness = StrictnessStandard
	}
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = 5
	}

	orch := &Orchestrator{
		memory:   cfg.Memory,
		config:   cfg,
		protocol: NewProtocolMachine(cfg.ProtocolStrictness),
		fileLock: NewFileOwnershipRegistry(),
	}

	// Wire IMPROVE handler if the improve memory provider is configured.
	if cfg.ImproveMemory != nil {
		orch.improveHandler = NewImproveHandler(cfg.ImproveMemory, cfg.RepoRoot)
	}

	return orch, nil
}

// HandleTask is the main entry point. It routes a task to the correct agent,
// builds context, and enforces protocol compliance.
//
// In stateless mode, it stores the context package in memory and returns a
// SeedPrompt. In inline mode, it returns the full ContextPackage.
func (o *Orchestrator) HandleTask(ctx context.Context, task Task) (OrchestrationResult, error) {
	if o.config.UseStatelessAgents {
		result, err := o.HandleTaskStateless(ctx, task)
		if err != nil {
			return OrchestrationResult{}, err
		}
		// Convert stateless result to inline result for API compatibility
		return OrchestrationResult{
			Agent:          result.Agent,
			ContextPackage: ContextPackage{}, // In stateless mode, context is in memory
			ExecutionPlan:  result.ExecutionPlan,
		}, nil
	}
	return o.handleTaskInline(ctx, task)
}

// HandleTaskStateless handles a task in stateless mode, storing context in memory
// and returning a SeedPrompt with a memory ID.
func (o *Orchestrator) HandleTaskStateless(ctx context.Context, task Task) (StatelessOrchestrationResult, error) {
	// Initialize protocol tracking
	o.protocol.InitState(task.ID)

	// Step 1: MEMORY_QUERY (mandatory)
	if err := o.protocol.Advance(task.ID, StepMemoryQuery); err != nil {
		log.Printf("[Orchestrator] protocol advance warning: %v", err)
	}

	// Step 2: THOUGHT_CHAIN — mark complete (actual thinking is done by the agent)
	if err := o.protocol.Advance(task.ID, StepThoughtChain); err != nil {
		log.Printf("[Orchestrator] protocol advance warning: %v", err)
	}

	// Step 3: PLAN — mark complete
	if err := o.protocol.Advance(task.ID, StepPlan); err != nil {
		log.Printf("[Orchestrator] protocol advance warning: %v", err)
	}

	// Step 4: DELEGATE — resolve agent
	agent, err := o.resolveTaskAgent(task.Type)
	if err != nil {
		return StatelessOrchestrationResult{}, fmt.Errorf("resolve task agent: %w", err)
	}

	// Validate routing
	routeCheck := ValidateRouting(task.Type, agent)
	if !routeCheck.Valid && routeCheck.Violation != "" {
		violation := ProtocolViolation{
			Step:     StepDelegate,
			Message:  routeCheck.Violation,
			Severity: "high",
		}
		state := o.protocol.GetState(task.ID)
		if state != nil {
			state.Violations = append(state.Violations, violation)
		}

		if o.config.ProtocolStrictness == StrictnessStrict {
			return StatelessOrchestrationResult{}, fmt.Errorf("ROUTING BLOCKED: %s", routeCheck.Violation)
		}
		log.Printf("[Orchestrator] %s", routeCheck.Violation)
	}

	if err := o.protocol.Advance(task.ID, StepDelegate); err != nil {
		log.Printf("[Orchestrator] protocol advance warning: %v", err)
	}

	// Build context package
	contextPkg, err := BuildContextPackage(ctx, o.memory, task, agent)
	if err != nil {
		return StatelessOrchestrationResult{}, fmt.Errorf("build context package: %w", err)
	}

	// Store context in memory and get seed prompt
	seedPrompt, contextMemoryID, err := BuildSeedPrompt(ctx, o.memory, task, contextPkg, agent)
	if err != nil {
		return StatelessOrchestrationResult{}, fmt.Errorf("build seed prompt: %w", err)
	}

	// Build execution plan
	executionPlan := o.buildExecutionPlan(task, agent)

	return StatelessOrchestrationResult{
		Agent:           agent,
		ContextMemoryID: contextMemoryID,
		SeedPrompt:      seedPrompt,
		ExecutionPlan:   executionPlan,
	}, nil
}

// handleTaskInline handles a task with inline context (not stateless).
func (o *Orchestrator) handleTaskInline(ctx context.Context, task Task) (OrchestrationResult, error) {
	// Initialize protocol tracking
	o.protocol.InitState(task.ID)

	// Step 1: MEMORY_QUERY (mandatory)
	if err := o.protocol.Advance(task.ID, StepMemoryQuery); err != nil {
		log.Printf("[Orchestrator] protocol advance warning: %v", err)
	}

	// Step 2: THOUGHT_CHAIN
	if err := o.protocol.Advance(task.ID, StepThoughtChain); err != nil {
		log.Printf("[Orchestrator] protocol advance warning: %v", err)
	}

	// Step 3: PLAN
	if err := o.protocol.Advance(task.ID, StepPlan); err != nil {
		log.Printf("[Orchestrator] protocol advance warning: %v", err)
	}

	// Step 4: DELEGATE — resolve agent
	agent, err := o.resolveTaskAgent(task.Type)
	if err != nil {
		return OrchestrationResult{}, fmt.Errorf("resolve task agent: %w", err)
	}

	// Validate routing
	routeCheck := ValidateRouting(task.Type, agent)
	if !routeCheck.Valid && routeCheck.Violation != "" {
		violation := ProtocolViolation{
			Step:     StepDelegate,
			Message:  routeCheck.Violation,
			Severity: "high",
		}
		state := o.protocol.GetState(task.ID)
		if state != nil {
			state.Violations = append(state.Violations, violation)
		}

		if o.config.ProtocolStrictness == StrictnessStrict {
			return OrchestrationResult{}, fmt.Errorf("ROUTING BLOCKED: %s", routeCheck.Violation)
		}
		log.Printf("[Orchestrator] %s", routeCheck.Violation)
	}

	if err := o.protocol.Advance(task.ID, StepDelegate); err != nil {
		log.Printf("[Orchestrator] protocol advance warning: %v", err)
	}

	// Build context package (direct memory call — no HTTP)
	contextPkg, err := BuildContextPackage(ctx, o.memory, task, agent)
	if err != nil {
		return OrchestrationResult{}, fmt.Errorf("build context package: %w", err)
	}

	// Build execution plan
	executionPlan := o.buildExecutionPlan(task, agent)

	return OrchestrationResult{
		Agent:          agent,
		ContextPackage: contextPkg,
		ExecutionPlan:  executionPlan,
	}, nil
}

// CompleteTaskCycle completes the task cycle after an agent returns.
// It fetches the wrap-up from memory, adjusts trust, runs the IMPROVE
// phase (if configured), and completes the protocol.
func (o *Orchestrator) CompleteTaskCycle(
	ctx context.Context,
	taskID string,
	result StatelessTaskResult,
	contextMemoryID string,
) (AgentWrapUp, error) {
	// Step 1: Fetch the wrap-up from memory
	wrapUp, err := FetchAgentWrapUp(ctx, o.memory, result.MemoryID)
	if err != nil {
		return AgentWrapUp{}, fmt.Errorf("fetch agent wrap-up: %w", err)
	}

	// Step 2: Adjust trust on the context memory (agent_used signal = +0.05)
	if _, err := o.memory.AdjustTrust(ctx, contextMemoryID, SignalAgentUsed); err != nil {
		log.Printf("[Orchestrator] failed to adjust trust on context memory %s: %v", contextMemoryID, err)
	}

	// Step 2b: Run IMPROVE phase (step 7 of 9) if the improve handler is configured.
	// This extracts patterns from the completed work and fetches L1 summary.
	if o.improveHandler != nil {
		improveResult, improveErr := o.improveHandler.Run(ctx, taskID, wrapUp.Summary)
		if improveErr != nil {
			log.Printf("[Orchestrator] IMPROVE phase failed for task %s: %v", taskID, improveErr)
		} else if len(improveResult.Errors) > 0 {
			log.Printf("[Orchestrator] IMPROVE phase completed with %d error(s) for task %s: %v",
				len(improveResult.Errors), taskID, improveResult.Errors)
		}
	}

	// Step 3: Complete remaining protocol steps
	o.protocol.CompleteProtocol(taskID)

	return wrapUp, nil
}

// EnforceProtocol enforces the 8-step protocol compliance for a task.
// Returns the current protocol state with any violations.
func (o *Orchestrator) EnforceProtocol(taskID string) (*ProtocolState, error) {
	return o.protocol.Enforce(taskID)
}

// Route returns the agent name for a given task type based on the routing matrix.
func (o *Orchestrator) Route(taskType TaskType) (AgentRole, error) {
	return ResolveAgent(taskType)
}

// BuildContextPackageDirect builds a context package by querying memory directly.
// This is the public API for external callers who need to build context
// without going through the full HandleTask flow.
func (o *Orchestrator) BuildContextPackageDirect(ctx context.Context, task Task, agent AgentRole) (ContextPackage, error) {
	return BuildContextPackage(ctx, o.memory, task, agent)
}

// Dispatch dispatches a TaskPlan with dependency ordering and parallel execution.
func (o *Orchestrator) Dispatch(ctx context.Context, plan TaskPlan) ([]DispatchResult, error) {
	runner := NewTaskRunner(o, o.config.MaxConcurrent, o.defaultDispatch)
	return runner.Dispatch(ctx, plan)
}

// defaultDispatch is the default dispatch function that creates a successful result.
// In production, this would be replaced with actual agent dispatch.
func (o *Orchestrator) defaultDispatch(ctx context.Context, task Task, agent AgentRole, contextPkg ContextPackage) (DispatchResult, error) {
	start := time.Now()
	// This is a placeholder — actual agent execution would happen here
	// via the sub-agent system. For now, we return a successful result.
	return DispatchResult{
		TaskID:   task.ID,
		Agent:    agent,
		Success:  true,
		Duration: time.Since(start),
	}, nil
}

// SetImproveHandler sets the IMPROVE handler. Use this when the improve
// memory provider is not available at construction time.
func (o *Orchestrator) SetImproveHandler(handler *ImproveHandler) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.improveHandler = handler
}

// GetImproveHandler returns the current IMPROVE handler, or nil if not set.
func (o *Orchestrator) GetImproveHandler() *ImproveHandler {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.improveHandler
}

// Close shuts down the orchestrator and releases resources.
func (o *Orchestrator) Close(ctx context.Context) error {
	return o.memory.Close(ctx)
}

// GetFileLockRegistry returns the file ownership registry for external use.
func (o *Orchestrator) GetFileLockRegistry() *FileOwnershipRegistry {
	return o.fileLock
}

// GetProtocolMachine returns the protocol enforcement machine.
func (o *Orchestrator) GetProtocolMachine() *ProtocolMachine {
	return o.protocol
}

// ============================================================================
// Private Methods
// ============================================================================

func (o *Orchestrator) resolveTaskAgent(taskType TaskType) (AgentRole, error) {
	agent, err := ResolveAgent(taskType)
	if err != nil {
		log.Printf("[Orchestrator] no routing rule for task type: %s, defaulting to architect", taskType)
		return AgentArchitect, nil
	}
	return agent, nil
}

func (o *Orchestrator) buildExecutionPlan(task Task, agent AgentRole) ExecutionPlan {
	var steps []ExecutionStep

	// Main step for the resolved agent
	steps = append(steps, ExecutionStep{
		Agent:     agent,
		Task:      task.Description,
		DependsOn: []string{},
		Priority:  task.Priority,
	})

	// If the task has dependencies, add prerequisites
	if len(task.Dependencies) > 0 {
		for _, dep := range task.Dependencies {
			steps = append(steps, ExecutionStep{
				Agent:     AgentOrchestrator,
				Task:      fmt.Sprintf("Resolve dependency: %s", dep),
				DependsOn: []string{},
				Priority:  PriorityHigh,
			})
		}
	}

	canParallelize := len(steps) <= 1
	if len(steps) > 1 {
		canParallelize = false
		for _, s := range steps {
			if len(s.DependsOn) > 0 {
				canParallelize = false
				break
			}
		}
	}

	estimatedComplexity := estimateComplexity(task)

	return ExecutionPlan{
		Steps:               steps,
		CanParallelize:      canParallelize,
		EstimatedComplexity: estimatedComplexity,
	}
}

func estimateComplexity(task Task) string {
	if task.Priority == PriorityHigh {
		return "high"
	}
	if len(task.Files) > 3 {
		return "high"
	}
	if len(task.Dependencies) > 0 {
		return "medium"
	}
	if task.Priority == PriorityMedium {
		return "medium"
	}
	return "low"
}
