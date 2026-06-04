// Package orchestrator implements the Neuralgentics Orchestrator —
// the central routing and protocol enforcement layer that imports
// the memory module directly (zero HTTP/MCP between orchestrator and memory).
package orchestrator

import (
	"context"
	"time"
)

// ============================================================================
// Agent & Task Types
// ============================================================================

// TaskType enumerates the kinds of tasks the orchestrator can route.
type TaskType string

const (
	TaskTypeCodeImpl      TaskType = "code-implementation"
	TaskTypeArchDesign    TaskType = "architecture-design"
	TaskTypeFileFinding   TaskType = "file-finding"
	TaskTypeTesting       TaskType = "testing"
	TaskTypeLinting       TaskType = "linting"
	TaskTypeGit           TaskType = "git"
	TaskTypeDocumentation TaskType = "documentation"
	TaskTypeWebScraping   TaskType = "web-scraping"
	TaskTypeMCPDebug      TaskType = "mcp-debug"
	TaskTypeRelease       TaskType = "release"
)

// AgentRole enumerates the specialist agents the orchestrator can dispatch to.
type AgentRole string

const (
	AgentOrchestrator  AgentRole = "orchestrator"
	AgentArchitect     AgentRole = "architect"
	AgentCoder         AgentRole = "coder"
	AgentReviewer      AgentRole = "reviewer"
	AgentExplorer      AgentRole = "explorer"
	AgentTester        AgentRole = "tester"
	AgentLinter        AgentRole = "linter"
	AgentGit           AgentRole = "git"
	AgentWriter        AgentRole = "writer"
	AgentScraper       AgentRole = "scraper"
	AgentMCPSpecialist AgentRole = "mcp-specialist"
	AgentRelease       AgentRole = "release"
)

// AgentDefinition describes a specialist agent declaratively.
type AgentDefinition struct {
	Name        AgentRole `json:"name"`
	Description string    `json:"description"`
	Model       string    `json:"model"` // "primary" or "secondary"
	Skills      []string  `json:"skills"`
}

// Priority represents task priority levels.
type Priority string

const (
	PriorityLow    Priority = "low"
	PriorityMedium Priority = "medium"
	PriorityHigh   Priority = "high"
)

// Task represents a single unit of work to be routed and dispatched.
type Task struct {
	ID           string   `json:"id"`
	Type         TaskType `json:"type"`
	Description  string   `json:"description"`
	UserRequest  string   `json:"userRequest"`
	Priority     Priority `json:"priority"`
	Files        []string `json:"files,omitempty"`
	Dependencies []string `json:"dependencies,omitempty"`
}

// ============================================================================
// Routing Types
// ============================================================================

// RoutingRule maps a TaskType to the designated AgentRole
// and lists agents that are FORBIDDEN for that task type.
type RoutingRule struct {
	TaskType        TaskType    `json:"taskType"`
	Agent           AgentRole   `json:"agent"`
	ForbiddenAgents []AgentRole `json:"forbiddenAgents"`
	Description     string      `json:"description"`
}

// RoutingValidation holds the result of validating a task→agent assignment.
type RoutingValidation struct {
	Valid         bool      `json:"valid"`
	ExpectedAgent AgentRole `json:"expectedAgent"`
	Violation     string    `json:"violation,omitempty"`
}

// ============================================================================
// Context Package
// ============================================================================

// ContextPackage is the full context handed to an agent at dispatch time.
// It is assembled by querying the MemorySystem for L0/L1 summaries,
// relevant memories, and trust scores.
type ContextPackage struct {
	UserRequest       string            `json:"userRequest"`
	TaskBackground    string            `json:"taskBackground"`
	RelevantFiles     []string          `json:"relevantFiles"`
	CodeSnippets      map[string]string `json:"codeSnippets"`
	PreviousDecisions []string          `json:"previousDecisions"`
	ExpectedOutput    string            `json:"expectedOutput"`
	ScopeIn           []string          `json:"scopeIn"`
	ScopeOut          []string          `json:"scopeOut"`
	ErrorHandling     string            `json:"errorHandling"`
	ThinkingChainID   string            `json:"thinkingChainId,omitempty"`
	// L0 project summary (~100 tokens, high-trust only)
	L0Summary string `json:"l0Summary,omitempty"`
	// L1 key decisions summary (~2K tokens, trust >= 0.8)
	L1Summary string `json:"l1Summary,omitempty"`
	// Trust scores for relevant memories
	TrustScores map[string]float64 `json:"trustScores,omitempty"`
	// Full skill content for the agent's assigned skill
	SkillContent string `json:"skillContent,omitempty"`
}

// ScopeBoundaries defines what is IN and OUT of scope for a task.
type ScopeBoundaries struct {
	InScope  []string `json:"inScope"`
	OutScope []string `json:"outScope"`
}

// ============================================================================
// Task Plan & Dependency Graph
// ============================================================================

// TaskPlan represents a set of tasks with dependency ordering.
type TaskPlan struct {
	Tasks        []Task              `json:"tasks"`
	Dependencies map[string][]string `json:"dependencies"` // taskID → prerequisite taskIDs
}

// ExecutionStep is a single step in an execution plan.
type ExecutionStep struct {
	Agent     AgentRole `json:"agent"`
	Task      string    `json:"task"`
	DependsOn []string  `json:"dependsOn"`
	Priority  Priority  `json:"priority"`
}

// ExecutionPlan describes the ordered steps for task dispatch.
type ExecutionPlan struct {
	Steps               []ExecutionStep `json:"steps"`
	CanParallelize      bool            `json:"canParallelize"`
	EstimatedComplexity string          `json:"estimatedComplexity"` // "low", "medium", "high"
}

// OrchestrationResult is the result of handling a task (inline context mode).
type OrchestrationResult struct {
	Agent          AgentRole      `json:"agent"`
	ContextPackage ContextPackage `json:"contextPackage"`
	ExecutionPlan  ExecutionPlan  `json:"executionPlan"`
}

// ============================================================================
// Stateless Protocol Types
// ============================================================================

// SeedPrompt is the minimal prompt given to an agent in stateless mode.
// The agent fetches the full ContextPackage from memory using MemoryID.
type SeedPrompt struct {
	Task     string `json:"task"`
	MemoryID string `json:"memoryId"`
	Prompt   string `json:"prompt"`
}

// StatelessOrchestrationResult is the result of handling a task in stateless mode.
type StatelessOrchestrationResult struct {
	Agent           AgentRole     `json:"agent"`
	ContextMemoryID string        `json:"contextMemoryId"`
	SeedPrompt      SeedPrompt    `json:"seedPrompt"`
	ExecutionPlan   ExecutionPlan `json:"executionPlan"`
}

// StatelessTaskResult is what an agent returns after completing work.
type StatelessTaskResult struct {
	MemoryID    string `json:"memory_id"`
	Description string `json:"description"`
}

// AgentWrapUp is the content stored in memory when an agent completes a task.
type AgentWrapUp struct {
	Summary         string                `json:"summary"`
	FilesModified   []string              `json:"filesModified"`
	FilesCreated    []string              `json:"filesCreated"`
	FollowUpTasks   []string              `json:"followUpTasks"`
	TrustSignals    []TrustSignalEntry    `json:"trustSignals"`
	Errors          []string              `json:"errors"`
	Warnings        []string              `json:"warnings"`
	SubAgentResults []StatelessTaskResult `json:"subAgentResults"`
}

// TrustSignalEntry associates a trust signal with a context memory.
type TrustSignalEntry struct {
	ContextMemoryID string `json:"contextMemoryId"`
	Signal          string `json:"signal"`
}

// ContextPackageMetadata is stored alongside a ContextPackage in memory.
type ContextPackageMetadata struct {
	TaskType        TaskType  `json:"taskType"`
	AgentRole       AgentRole `json:"agentRole"`
	TaskID          string    `json:"taskId"`
	ContextMemoryID string    `json:"contextMemoryId,omitempty"`
	ParentMemoryID  *string   `json:"parentMemoryId,omitempty"`
	CreatedAt       string    `json:"createdAt"`
	Project         string    `json:"project"`
	Version         string    `json:"version"`
}

// AgentWrapUpMetadata is stored alongside an agent wrap-up in memory.
type AgentWrapUpMetadata struct {
	TaskType        TaskType  `json:"taskType"`
	AgentRole       AgentRole `json:"agentRole"`
	TaskID          string    `json:"taskId"`
	ContextMemoryID string    `json:"contextMemoryId"`
	ParentWrapUpID  *string   `json:"parentWrapUpId,omitempty"`
	CreatedAt       string    `json:"createdAt"`
	Project         string    `json:"project"`
	DurationMs      int64     `json:"durationMs,omitempty"`
	Success         bool      `json:"success"`
}

// ============================================================================
// Fine-Grained Task Scoping Types
// ============================================================================

// TaskStatus represents the execution state of a fine-grained task.
type TaskStatus string

const (
	StatusPending            TaskStatus = "PENDING"
	StatusReady              TaskStatus = "READY"
	StatusActive             TaskStatus = "ACTIVE"
	StatusBlocked            TaskStatus = "BLOCKED"
	StatusResolving          TaskStatus = "RESOLVING"
	StatusDependencyBuilding TaskStatus = "DEPENDENCY_BUILDING"
	StatusResumed            TaskStatus = "RESUMED"
	StatusComplete           TaskStatus = "COMPLETE"
	StatusFailed             TaskStatus = "FAILED"
	StatusCancelled          TaskStatus = "CANCELLED"
)

// TerminalStatuses are the statuses from which no further transitions are possible.
var TerminalStatuses = map[TaskStatus]bool{
	StatusComplete:  true,
	StatusFailed:    true,
	StatusCancelled: true,
}

// FineGrainedTaskEntry is a single scoped task in the architect's decomposition plan.
type FineGrainedTaskEntry struct {
	ID                string          `json:"id"`
	TargetFile        string          `json:"targetFile"`
	EntryType         string          `json:"type"` // "new_file" or "modify_file"
	Agent             AgentRole       `json:"agent"`
	Scope             ScopeBoundaries `json:"scope"`
	DependsOn         []string        `json:"dependsOn"`
	Status            TaskStatus      `json:"status"`
	Priority          Priority        `json:"priority"`
	EstimatedTokens   int             `json:"estimatedTokens"`
	DispatchCount     int             `json:"dispatchCount"`
	MaxDispatches     int             `json:"maxDispatches"`
	IsDeltaTask       bool            `json:"isDeltaTask"`
	ParentTaskID      string          `json:"parentTaskId,omitempty"`
	ResolvedBlockerID string          `json:"resolvedBlockerId,omitempty"`
	DesignDocID       string          `json:"designDocId,omitempty"`
	ResultMemoryID    string          `json:"resultMemoryId,omitempty"`
}

// FileLock tracks file ownership for conflict prevention.
type FileLock struct {
	TaskID     string     `json:"taskId"`
	Status     TaskStatus `json:"status"`
	AcquiredAt int64      `json:"acquiredAt"`
}

// BlockerReport is a structured report from a coder agent when it hits a missing dependency.
type BlockerReport struct {
	OriginalTaskID    string `json:"originalTaskId"`
	BlockerTaskID     string `json:"blockerTaskId"`
	MissingDependency string `json:"missingDependency"`
	Description       string `json:"description"`
	Severity          string `json:"severity"` // "low", "medium", "high"
}

// DesignDelta captures the architect's resolution for a blocker.
type DesignDelta struct {
	ParentDesignID string                 `json:"parentDesignId"`
	NewTasks       []FineGrainedTaskEntry `json:"newTasks"`
	Reasoning      string                 `json:"reasoning"`
}

// FineGrainedTaskList is the full decomposition from the architect.
type FineGrainedTaskList struct {
	FeatureID            string                 `json:"featureId"`
	FeatureDescription   string                 `json:"featureDescription"`
	Tasks                []FineGrainedTaskEntry `json:"tasks"`
	CreatedAt            string                 `json:"createdAt"`
	TotalEstimatedTokens int                    `json:"totalEstimatedTokens"`
	MaxTopologicalDepth  int                    `json:"maxTopologicalDepth"`
}

// MandatorySequences defines agents that MUST complete before others for the same feature.
// Architect designs before coder builds; reviewer gates merge before tester.
var MandatorySequences = map[AgentRole][]AgentRole{
	AgentOrchestrator:  {},
	AgentArchitect:     {AgentCoder, AgentTester},
	AgentReviewer:      {AgentTester},
	AgentCoder:         {},
	AgentExplorer:      {},
	AgentTester:        {},
	AgentLinter:        {},
	AgentGit:           {},
	AgentWriter:        {},
	AgentScraper:       {},
	AgentMCPSpecialist: {},
	AgentRelease:       {},
}

// ============================================================================
// Dispatch Result
// ============================================================================

// DispatchResult holds the outcome of a single task dispatch.
type DispatchResult struct {
	TaskID   string        `json:"taskId"`
	Agent    AgentRole     `json:"agent"`
	Success  bool          `json:"success"`
	Error    string        `json:"error,omitempty"`
	Duration time.Duration `json:"duration"`
	// In stateless mode:
	MemoryID    string `json:"memoryId,omitempty"`
	Description string `json:"description,omitempty"`
}

// StrictnessLevel controls how strictly the protocol is enforced.
type StrictnessLevel string

const (
	StrictnessLenient  StrictnessLevel = "lenient"
	StrictnessStandard StrictnessLevel = "standard"
	StrictnessStrict   StrictnessLevel = "strict"
)

// ============================================================================
// Memory Provider Interface
// ============================================================================

// MemoryProvider defines the interface for memory operations.
// The orchestrator uses this interface instead of importing the memory
// module directly, allowing it to compile independently and making
// testing easy with mock implementations.
//
// The concrete *memory.MemorySystem satisfies this interface.
type MemoryProvider interface {
	// AddMemory adds a new memory entry and returns its ID.
	AddMemory(ctx context.Context, entry MemoryEntry) (string, error)
	// QueryMemories performs semantic search.
	QueryMemories(ctx context.Context, query string, opts *SearchOptions) ([]*MemoryEntry, error)
	// GetMemory retrieves a memory by ID.
	GetMemory(ctx context.Context, id string) (*MemoryEntry, error)
	// DeleteMemory soft-deletes a memory.
	DeleteMemory(ctx context.Context, id string) error
	// AdjustTrust modifies a memory's trust score based on a feedback signal.
	AdjustTrust(ctx context.Context, memoryID string, signal TrustSignal) (*TrustAdjustment, error)
	// Close shuts down the memory system.
	Close(ctx context.Context) error
}

// MemoryEntry represents a single semantic memory.
type MemoryEntry struct {
	ID             string         `json:"id,omitempty"`
	Content        string         `json:"content"`
	Vector         []float64      `json:"vector,omitempty"`
	SourceType     string         `json:"sourceType"`
	SourcePath     *string        `json:"sourcePath,omitempty"`
	ContentHash    string         `json:"contentHash"`
	TrustScore     float64        `json:"trustScore"`
	RetrievalCount int            `json:"retrievalCount"`
	IsArchived     bool           `json:"isArchived"`
	Metadata       map[string]any `json:"metadata"`
	Score          *float64       `json:"score,omitempty"`
	SupersedesID   string         `json:"supersedesId,omitempty"`
}

// MemoryEntry is what QueryMemories returns.
// This shadows the memory package type but is self-contained.

// SearchOptions controls how semantic search behaves.
type SearchOptions struct {
	TopK      int
	Threshold float64
	Strategy  string // "tiered", "vector_only", "text_only", "parallel", "exact"
}

// TrustSignal represents different types of trust feedback.
type TrustSignal string

const (
	SignalAgentUsed     TrustSignal = "agent_used"
	SignalAgentIgnored  TrustSignal = "agent_ignored"
	SignalUserConfirmed TrustSignal = "user_confirmed"
	SignalUserCorrected TrustSignal = "user_corrected"
)

// TrustAdjustment captures a single trust score modification.
type TrustAdjustment struct {
	ID               string  `json:"id,omitempty"`
	MemoryID         string  `json:"memoryId"`
	OldScore         float64 `json:"oldScore"`
	NewScore         float64 `json:"newScore"`
	Signal           string  `json:"signal"`
	AdjustmentAmount float64 `json:"adjustmentAmount"`
	Reason           string  `json:"reason,omitempty"`
}
