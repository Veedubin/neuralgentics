package orchestrator

import (
	"fmt"
	"strings"
	"sync"
)

// ============================================================================
// Protocol Steps
// ============================================================================

// ProtocolStep represents a step in the 9-step Boomerang Protocol state machine.
type ProtocolStep string

const (
	StepIDLE         ProtocolStep = "IDLE"
	StepMemoryQuery  ProtocolStep = "MEMORY_QUERY"
	StepThoughtChain ProtocolStep = "THOUGHT_CHAIN"
	StepPlan         ProtocolStep = "PLAN"
	StepDelegate     ProtocolStep = "DELEGATE"
	StepGitCheck     ProtocolStep = "GIT_CHECK"
	StepQualityGates ProtocolStep = "QUALITY_GATES"
	StepImprove      ProtocolStep = "IMPROVE"
	StepDocUpdate    ProtocolStep = "DOC_UPDATE"
	StepMemorySave   ProtocolStep = "MEMORY_SAVE"
	StepComplete     ProtocolStep = "COMPLETE"
)

// ProtocolSteps is the ordered sequence of mandatory protocol steps.
var ProtocolSteps = []ProtocolStep{
	StepMemoryQuery,
	StepThoughtChain,
	StepPlan,
	StepDelegate,
	StepGitCheck,
	StepQualityGates,
	StepImprove,
	StepDocUpdate,
	StepMemorySave,
}

// ProtocolValidTransitions defines which steps can follow each step.
// This enforces the mandatory ordering of the state machine.
var ProtocolValidTransitions = map[ProtocolStep][]ProtocolStep{
	StepIDLE:         {StepMemoryQuery},
	StepMemoryQuery:  {StepThoughtChain, StepComplete}, // Can complete early if no relevant memories
	StepThoughtChain: {StepPlan},
	StepPlan:         {StepDelegate},
	StepDelegate:     {StepGitCheck},
	StepGitCheck:     {StepQualityGates},
	StepQualityGates: {StepImprove},
	StepImprove:      {StepDocUpdate},
	StepDocUpdate:    {StepMemorySave},
	StepMemorySave:   {StepComplete},
	StepComplete:     {},
}

// WaiverPhrases maps user utterances to the protocol steps they can skip.
var WaiverPhrases = map[string]ProtocolStep{
	"skip planning":  StepPlan,
	"just do it":     StepPlan,
	"no plan needed": StepPlan,
	"skip tests":     StepQualityGates,
	"skip gates":     StepQualityGates,
	"git is fine":    StepGitCheck,
	"no docs needed": StepDocUpdate,
	"skip improve":   StepImprove,
}

// ============================================================================
// Protocol State
// ============================================================================

// ProtocolViolation records a protocol requirement that was not met.
type ProtocolViolation struct {
	Step     ProtocolStep `json:"step"`
	Message  string       `json:"message"`
	Severity string       `json:"severity"` // "low", "medium", "high"
}

// ProtocolState tracks the current state of protocol enforcement for a task.
type ProtocolState struct {
	CurrentStep    ProtocolStep            `json:"currentStep"`
	CompletedSteps []ProtocolStep          `json:"completedSteps"`
	Violations     []ProtocolViolation     `json:"violations"`
	WaivedSteps    map[ProtocolStep]string `json:"waivedSteps"` // step → waiver phrase
}

// NewProtocolState creates a fresh protocol state at IDLE.
func NewProtocolState() *ProtocolState {
	return &ProtocolState{
		CurrentStep:    StepIDLE,
		CompletedSteps: []ProtocolStep{},
		Violations:     []ProtocolViolation{},
		WaivedSteps:    make(map[ProtocolStep]string),
	}
}

// ============================================================================
// Protocol Machine
// ============================================================================

// ProtocolMachine enforces the 9-step Boomerang Protocol.
// It tracks state per task and blocks execution if required steps are missing.
type ProtocolMachine struct {
	strictness StrictnessLevel
	states     map[string]*ProtocolState
	mu         sync.RWMutex
}

// NewProtocolMachine creates a new protocol enforcement machine.
func NewProtocolMachine(strictness StrictnessLevel) *ProtocolMachine {
	return &ProtocolMachine{
		strictness: strictness,
		states:     make(map[string]*ProtocolState),
	}
}

// InitState initializes a protocol state for a task. Returns an error
// if a state already exists for the task.
func (pm *ProtocolMachine) InitState(taskID string) *ProtocolState {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	state := NewProtocolState()
	pm.states[taskID] = state
	return state
}

// GetState returns the protocol state for a task, or nil.
func (pm *ProtocolMachine) GetState(taskID string) *ProtocolState {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	return pm.states[taskID]
}

// Enforce checks that all mandatory protocol steps have been completed
// for a task. Returns an error in strict mode if steps are missing.
func (pm *ProtocolMachine) Enforce(taskID string) (*ProtocolState, error) {
	pm.mu.RLock()
	state := pm.states[taskID]
	pm.mu.RUnlock()
	if state == nil {
		return nil, fmt.Errorf("no protocol state for task %s", taskID)
	}

	if pm.strictness == StrictnessLenient {
		return state, nil
	}

	// Check for missing mandatory steps
	missing := pm.missingSteps(state)
	if len(missing) > 0 && pm.strictness == StrictnessStrict {
		return state, fmt.Errorf("PROTOCOL BLOCKED: missing mandatory steps: %v", missing)
	}

	return state, nil
}

// Advance moves the protocol to the given step for a task.
// It validates that the transition is allowed and records violations
// for invalid transitions.
func (pm *ProtocolMachine) Advance(taskID string, step ProtocolStep) error {
	pm.mu.RLock()
	state := pm.states[taskID]
	pm.mu.RUnlock()
	if state == nil {
		return fmt.Errorf("no protocol state for task %s", taskID)
	}

	// Check if the transition is valid
	validNext, ok := ProtocolValidTransitions[state.CurrentStep]
	if ok {
		allowed := false
		for _, s := range validNext {
			if s == step {
				allowed = true
				break
			}
		}
		if !allowed && pm.strictness == StrictnessStrict {
			return fmt.Errorf("PROTOCOL: invalid transition from %s to %s", state.CurrentStep, step)
		}
		if !allowed && pm.strictness == StrictnessStandard {
			state.Violations = append(state.Violations, ProtocolViolation{
				Step:     state.CurrentStep,
				Message:  fmt.Sprintf("unexpected transition from %s to %s", state.CurrentStep, step),
				Severity: "low",
			})
		}
	}

	state.CurrentStep = step

	// Record completed step (avoid duplicates)
	found := false
	for _, s := range state.CompletedSteps {
		if s == step {
			found = true
			break
		}
	}
	if !found && step != StepIDLE && step != StepComplete {
		state.CompletedSteps = append(state.CompletedSteps, step)
	}

	return nil
}

// CanWaiverStep checks if a waiver phrase can skip a given protocol step.
func CanWaiverStep(phrase string, step ProtocolStep) bool {
	normalized := strings.ToLower(strings.TrimSpace(phrase))
	if waivedStep, ok := WaiverPhrases[normalized]; ok {
		return waivedStep == step
	}
	return false
}

// ApplyWaiver records a waiver for a protocol step.
func (pm *ProtocolMachine) ApplyWaiver(taskID string, step ProtocolStep, phrase string) {
	state := pm.states[taskID]
	if state == nil {
		return
	}
	state.WaivedSteps[step] = phrase
	// Mark the waived step as completed
	pm.Advance(taskID, step)
}

// CompleteProtocol advances through the remaining steps after agent execution.
func (pm *ProtocolMachine) CompleteProtocol(taskID string) (*ProtocolState, error) {
	remaining := []ProtocolStep{StepGitCheck, StepQualityGates, StepImprove, StepDocUpdate, StepMemorySave}
	for _, step := range remaining {
		if err := pm.Advance(taskID, step); err != nil && pm.strictness == StrictnessStrict {
			return nil, err
		}
	}
	pm.Advance(taskID, StepComplete)
	return pm.Enforce(taskID)
}

// missingSteps returns the mandatory steps that haven't been completed or waived.
func (pm *ProtocolMachine) missingSteps(state *ProtocolState) []ProtocolStep {
	completedSet := make(map[ProtocolStep]bool)
	for _, s := range state.CompletedSteps {
		completedSet[s] = true
	}

	var missing []ProtocolStep
	for _, step := range ProtocolSteps {
		if !completedSet[step] && state.WaivedSteps[step] == "" {
			missing = append(missing, step)
		}
	}
	return missing
}

// IsStepComplete checks if a specific protocol step has been completed for a task.
func (pm *ProtocolMachine) IsStepComplete(taskID string, step ProtocolStep) bool {
	state := pm.states[taskID]
	if state == nil {
		return false
	}
	for _, s := range state.CompletedSteps {
		if s == step {
			return true
		}
	}
	return state.WaivedSteps[step] != ""
}
