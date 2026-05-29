package orchestrator

import (
	"context"
	"fmt"
	"sync"
)

// ============================================================================
// Dependency Graph (Kahn's Algorithm)
// ============================================================================

// TopologicalSort sorts tasks in dependency order using Kahn's algorithm.
// Returns an error if a cycle is detected.
func TopologicalSort(tasks []FineGrainedTaskEntry) ([]FineGrainedTaskEntry, error) {
	if len(tasks) == 0 {
		return nil, nil
	}

	taskMap := make(map[string]*FineGrainedTaskEntry, len(tasks))
	for i := range tasks {
		taskMap[tasks[i].ID] = &tasks[i]
	}

	// Build in-degree map and adjacency list
	inDegree := make(map[string]int)
	graph := make(map[string][]string) // depID → task IDs that depend on it

	for _, task := range tasks {
		if _, ok := inDegree[task.ID]; !ok {
			inDegree[task.ID] = 0
		}
		for _, depID := range task.DependsOn {
			inDegree[task.ID]++
			graph[depID] = append(graph[depID], task.ID)
		}
	}

	// Collect all tasks with in-degree 0
	var queue []string
	for id, degree := range inDegree {
		if degree == 0 {
			queue = append(queue, id)
		}
	}

	var sorted []FineGrainedTaskEntry

	for len(queue) > 0 {
		currentID := queue[0]
		queue = queue[1:]

		if task, ok := taskMap[currentID]; ok {
			sorted = append(sorted, *task)
		}

		for _, depID := range graph[currentID] {
			inDegree[depID]--
			if inDegree[depID] == 0 {
				queue = append(queue, depID)
			}
		}
	}

	if len(sorted) != len(tasks) {
		return nil, fmt.Errorf("dependency cycle detected: %d of %d tasks sorted", len(sorted), len(tasks))
	}

	return sorted, nil
}

// GetParallelGroups groups tasks by topological depth. Tasks at the same depth
// with no inter-dependencies can run in parallel.
func GetParallelGroups(tasks []FineGrainedTaskEntry) ([][]FineGrainedTaskEntry, error) {
	if len(tasks) == 0 {
		return nil, nil
	}

	taskMap := make(map[string]*FineGrainedTaskEntry, len(tasks))
	for i := range tasks {
		taskMap[tasks[i].ID] = &tasks[i]
	}

	// Compute depth for each task
	depths := make(map[string]int)
	computing := make(map[string]bool)

	var computeDepth func(id string) (int, error)
	computeDepth = func(id string) (int, error) {
		if d, ok := depths[id]; ok {
			return d, nil
		}
		if computing[id] {
			return 0, fmt.Errorf("dependency cycle detected involving task: %s", id)
		}
		computing[id] = true

		task := taskMap[id]
		if task == nil || len(task.DependsOn) == 0 {
			computing[id] = false
			depths[id] = 0
			return 0, nil
		}

		maxDepDepth := 0
		for _, depID := range task.DependsOn {
			d, err := computeDepth(depID)
			if err != nil {
				return 0, err
			}
			if d > maxDepDepth {
				maxDepDepth = d
			}
		}

		computing[id] = false
		depths[id] = maxDepDepth + 1
		return maxDepDepth + 1, nil
	}

	for _, task := range tasks {
		if _, err := computeDepth(task.ID); err != nil {
			return nil, err
		}
	}

	// Find maximum depth
	maxDepth := 0
	for _, d := range depths {
		if d > maxDepth {
			maxDepth = d
		}
	}

	// Group by depth
	var groups [][]FineGrainedTaskEntry
	for d := 0; d <= maxDepth; d++ {
		var group []FineGrainedTaskEntry
		for _, task := range tasks {
			if depths[task.ID] == d {
				group = append(group, task)
			}
		}
		if len(group) > 0 {
			groups = append(groups, group)
		}
	}

	return groups, nil
}

// FindReadyTasks returns tasks where all dependencies are COMPLETE.
func FindReadyTasks(tasks []FineGrainedTaskEntry) []FineGrainedTaskEntry {
	statusMap := make(map[string]TaskStatus, len(tasks))
	for _, t := range tasks {
		statusMap[t.ID] = t.Status
	}

	var ready []FineGrainedTaskEntry
	for _, task := range tasks {
		if task.Status != StatusPending {
			continue
		}
		if len(task.DependsOn) == 0 {
			ready = append(ready, task)
			continue
		}
		allComplete := true
		for _, depID := range task.DependsOn {
			if statusMap[depID] != StatusComplete {
				allComplete = false
				break
			}
		}
		if allComplete {
			ready = append(ready, task)
		}
	}
	return ready
}

// FindBlockedTasks returns tasks with BLOCKED status.
func FindBlockedTasks(tasks []FineGrainedTaskEntry) []FineGrainedTaskEntry {
	var blocked []FineGrainedTaskEntry
	for _, t := range tasks {
		if t.Status == StatusBlocked {
			blocked = append(blocked, t)
		}
	}
	return blocked
}

// ValidationResult holds the result of dependency graph validation.
type ValidationResult struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors"`
	Warnings []string `json:"warnings"`
}

const maxDependencyDepth = 5

// ValidateDependencyGraph validates a task dependency graph for cycles,
// dangling references, self-references, and depth warnings.
func ValidateDependencyGraph(tasks []FineGrainedTaskEntry) ValidationResult {
	var errors []string
	var warnings []string

	taskIDs := make(map[string]bool, len(tasks))
	for _, t := range tasks {
		taskIDs[t.ID] = true
	}

	for _, task := range tasks {
		// Self-reference check
		for _, dep := range task.DependsOn {
			if dep == task.ID {
				errors = append(errors, fmt.Sprintf("task %s depends on itself", task.ID))
			}
			// Dangling reference check
			if !taskIDs[dep] {
				errors = append(errors, fmt.Sprintf("task %s depends on non-existent task %s", task.ID, dep))
			}
		}

		// Duplicate target file check
		for _, other := range tasks {
			if other.ID != task.ID && other.TargetFile == task.TargetFile && task.TargetFile != "" {
				errors = append(errors, fmt.Sprintf("tasks %s and %s target the same file: %s",
					task.ID, other.ID, task.TargetFile))
			}
		}
	}

	// Depth check (warnings only)
	groups, err := GetParallelGroups(tasks)
	if err != nil {
		errors = append(errors, fmt.Sprintf("cycle detected: %v", err))
	} else if len(groups) > maxDependencyDepth {
		warnings = append(warnings, fmt.Sprintf("dependency depth %d exceeds recommended max of %d",
			len(groups), maxDependencyDepth))
	}

	return ValidationResult{
		Valid:    len(errors) == 0,
		Errors:   errors,
		Warnings: warnings,
	}
}

// ============================================================================
// File Ownership Registry
// ============================================================================

// FileOwnershipRegistry prevents two agents from owning the same file simultaneously.
// Locks are acquired at dispatch and released on COMPLETE, FAILED, or CANCELLED.
type FileOwnershipRegistry struct {
	mu    sync.RWMutex
	locks map[string]FileLock
}

// NewFileOwnershipRegistry creates a new FileOwnershipRegistry.
func NewFileOwnershipRegistry() *FileOwnershipRegistry {
	return &FileOwnershipRegistry{
		locks: make(map[string]FileLock),
	}
}

// AcquireLock tries to acquire a file lock for a task.
// Returns true if the lock was acquired, false if another task owns the file.
// A lock can be re-acquired by the same taskID (idempotent).
// A lock can be acquired if the previous owner is in a terminal state.
func (r *FileOwnershipRegistry) AcquireLock(filePath, taskID string, status TaskStatus) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	existing, ok := r.locks[filePath]
	if ok {
		// Same task re-acquiring is idempotent
		if existing.TaskID == taskID {
			return true
		}
		// Previous owner in terminal state — allow takeover
		if TerminalStatuses[existing.Status] {
			r.locks[filePath] = FileLock{
				TaskID:     taskID,
				Status:     status,
				AcquiredAt: nowMillis(),
			}
			return true
		}
		// Another active task owns this file
		return false
	}

	r.locks[filePath] = FileLock{
		TaskID:     taskID,
		Status:     status,
		AcquiredAt: nowMillis(),
	}
	return true
}

// ReleaseLock releases a file lock. Only the owning task can release.
func (r *FileOwnershipRegistry) ReleaseLock(filePath, taskID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	existing, ok := r.locks[filePath]
	if !ok {
		return false
	}
	if existing.TaskID != taskID {
		return false
	}
	delete(r.locks, filePath)
	return true
}

// GetOwner returns the task ID that owns a file, or empty string if unowned.
func (r *FileOwnershipRegistry) GetOwner(filePath string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	lock, ok := r.locks[filePath]
	if !ok || TerminalStatuses[lock.Status] {
		return ""
	}
	return lock.TaskID
}

// UpdateLockStatus updates the status of a file lock.
func (r *FileOwnershipRegistry) UpdateLockStatus(filePath, taskID string, status TaskStatus) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	existing, ok := r.locks[filePath]
	if !ok || existing.TaskID != taskID {
		return false
	}
	existing.Status = status
	r.locks[filePath] = existing
	return true
}

// GetActiveLocks returns all active (non-terminal) locks.
func (r *FileOwnershipRegistry) GetActiveLocks() map[string]FileLock {
	r.mu.RLock()
	defer r.mu.RUnlock()

	active := make(map[string]FileLock)
	for path, lock := range r.locks {
		if !TerminalStatuses[lock.Status] {
			active[path] = lock
		}
	}
	return active
}

// Clear removes all locks. Used for testing or hard reset.
func (r *FileOwnershipRegistry) Clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.locks = make(map[string]FileLock)
}

// ============================================================================
// Task Runner
// ============================================================================

// TaskDispatchFunc is the callback for executing a single task.
// The orchestrator provides this to allow different execution backends.
type TaskDispatchFunc func(ctx context.Context, task Task, agent AgentRole, contextPkg ContextPackage) (DispatchResult, error)

// TaskRunner handles parallel task execution with dependency ordering.
type TaskRunner struct {
	orchestrator  *Orchestrator
	maxConcurrent int
	dispatch      TaskDispatchFunc
}

// NewTaskRunner creates a new TaskRunner with the given orchestrator and concurrency limit.
func NewTaskRunner(orch *Orchestrator, maxConcurrent int, dispatch TaskDispatchFunc) *TaskRunner {
	if maxConcurrent <= 0 {
		maxConcurrent = 5
	}
	return &TaskRunner{
		orchestrator:  orch,
		maxConcurrent: maxConcurrent,
		dispatch:      dispatch,
	}
}

// Dispatch executes a TaskPlan with dependency ordering and parallel execution
// where possible. It uses a worker pool pattern with channels.
func (tr *TaskRunner) Dispatch(ctx context.Context, plan TaskPlan) ([]DispatchResult, error) {
	if len(plan.Tasks) == 0 {
		return nil, nil
	}

	// Convert Task slice to FineGrainedTaskEntry slice for dependency graph
	entries := tasksToEntries(plan.Tasks, plan.Dependencies)

	// Get parallel groups
	groups, err := GetParallelGroups(entries)
	if err != nil {
		return nil, fmt.Errorf("compute parallel groups: %w", err)
	}

	var allResults []DispatchResult
	var mu sync.Mutex

	for _, group := range groups {
		// Execute each group in parallel (tasks within a group have no deps on each other)
		results, err := tr.dispatchGroup(ctx, group)
		if err != nil {
			return allResults, fmt.Errorf("dispatch group: %w", err)
		}

		mu.Lock()
		allResults = append(allResults, results...)
		mu.Unlock()

		// Check for context cancellation
		if ctx.Err() != nil {
			return allResults, ctx.Err()
		}
	}

	return allResults, nil
}

// dispatchGroup executes a group of tasks in parallel using a worker pool.
func (tr *TaskRunner) dispatchGroup(ctx context.Context, group []FineGrainedTaskEntry) ([]DispatchResult, error) {
	if len(group) == 0 {
		return nil, nil
	}

	// If only 1 task, no need for parallel execution
	if len(group) == 1 {
		task := entryToTask(group[0])
		agent, err := ResolveAgent(task.Type)
		if err != nil {
			agent = AgentArchitect
		}

		// Build context
		contextPkg, err := BuildContextPackage(ctx, tr.orchestrator.memory, task, agent)
		if err != nil {
			return []DispatchResult{{
				TaskID: task.ID,
				Agent:  agent,
				Error:  err.Error(),
			}}, nil
		}

		result, err := tr.dispatch(ctx, task, agent, contextPkg)
		if err != nil {
			result = DispatchResult{
				TaskID: task.ID,
				Agent:  agent,
				Error:  err.Error(),
			}
		}
		return []DispatchResult{result}, nil
	}

	// Worker pool for parallel execution
	type indexedResult struct {
		index  int
		result DispatchResult
	}

	jobs := make(chan int, len(group))
	results := make(chan indexedResult, len(group))

	// Start workers
	var wg sync.WaitGroup
	workers := min(len(group), tr.maxConcurrent)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				entry := group[idx]
				task := entryToTask(entry)
				agent, err := ResolveAgent(task.Type)
				if err != nil {
					agent = AgentArchitect
				}

				contextPkg, ctxErr := BuildContextPackage(ctx, tr.orchestrator.memory, task, agent)
				if ctxErr != nil {
					results <- indexedResult{
						index: idx,
						result: DispatchResult{
							TaskID: task.ID,
							Agent:  agent,
							Error:  ctxErr.Error(),
						},
					}
					continue
				}

				result, dispatchErr := tr.dispatch(ctx, task, agent, contextPkg)
				if dispatchErr != nil {
					result = DispatchResult{
						TaskID: task.ID,
						Agent:  agent,
						Error:  dispatchErr.Error(),
					}
				}
				results <- indexedResult{index: idx, result: result}
			}
		}()
	}

	// Send jobs
	for i := range group {
		jobs <- i
	}
	close(jobs)

	// Wait for workers and close results
	go func() {
		wg.Wait()
		close(results)
	}()

	// Collect results
	finalResults := make([]DispatchResult, len(group))
	for ir := range results {
		finalResults[ir.index] = ir.result
	}

	return finalResults, nil
}

// ============================================================================
// Task State Machine
// ============================================================================

// TaskStateTransitions defines valid state transitions for TaskStatus.
var TaskStateTransitions = map[TaskStatus][]TaskStatus{
	StatusPending:            {StatusReady, StatusCancelled},
	StatusReady:              {StatusActive, StatusCancelled},
	StatusActive:             {StatusComplete, StatusBlocked, StatusFailed, StatusCancelled},
	StatusBlocked:            {StatusResolving, StatusFailed, StatusCancelled},
	StatusResolving:          {StatusDependencyBuilding, StatusFailed, StatusCancelled},
	StatusDependencyBuilding: {StatusResumed, StatusFailed, StatusCancelled},
	StatusResumed:            {StatusComplete, StatusBlocked, StatusFailed, StatusCancelled},
	StatusComplete:           {},
	StatusFailed:             {},
	StatusCancelled:          {},
}

// CanTransition checks whether a transition from one TaskStatus to another is valid.
func CanTransition(from, to TaskStatus) bool {
	allowed, ok := TaskStateTransitions[from]
	if !ok {
		return false
	}
	for _, s := range allowed {
		if s == to {
			return true
		}
	}
	return false
}

// IsTerminal checks whether a status is terminal (no further transitions).
func IsTerminal(status TaskStatus) bool {
	allowed, ok := TaskStateTransitions[status]
	if !ok {
		return false
	}
	return len(allowed) == 0
}

// ============================================================================
// Helpers
// ============================================================================

func nowMillis() int64 {
	return 0 // timestamp handled by caller; placeholder for cross-platform compat
}

func tasksToEntries(tasks []Task, deps map[string][]string) []FineGrainedTaskEntry {
	entries := make([]FineGrainedTaskEntry, len(tasks))
	for i, t := range tasks {
		entries[i] = FineGrainedTaskEntry{
			ID:            t.ID,
			Agent:         AgentCoder, // will be resolved by routing
			DependsOn:     deps[t.ID],
			Status:        StatusPending,
			Priority:      t.Priority,
			MaxDispatches: 3,
		}
	}
	return entries
}

func entryToTask(entry FineGrainedTaskEntry) Task {
	return Task{
		ID:          entry.ID,
		Type:        RouteAgentToTaskType(entry.Agent),
		Description: fmt.Sprintf("Task %s for %s", entry.ID, entry.Agent),
		UserRequest: fmt.Sprintf("Task %s for %s", entry.ID, entry.Agent),
		Priority:    entry.Priority,
	}
}

// RouteAgentToTaskType maps an AgentRole back to the default TaskType.
func RouteAgentToTaskType(agent AgentRole) TaskType {
	switch agent {
	case AgentCoder:
		return TaskTypeCodeImpl
	case AgentArchitect:
		return TaskTypeArchDesign
	case AgentExplorer:
		return TaskTypeFileFinding
	case AgentTester:
		return TaskTypeTesting
	case AgentLinter:
		return TaskTypeLinting
	case AgentGit:
		return TaskTypeGit
	case AgentWriter:
		return TaskTypeDocumentation
	case AgentScraper:
		return TaskTypeWebScraping
	case AgentMCPSpecialist:
		return TaskTypeMCPDebug
	case AgentRelease:
		return TaskTypeRelease
	default:
		return TaskTypeArchDesign
	}
}
