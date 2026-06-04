package core

import (
	"context"
	"time"
)

// MemoryEntry represents a single semantic memory stored in the system.
// It maps directly to the PostgreSQL memories table schema and preserves
// all fields from the Python memini-ai-dev implementation.
type MemoryEntry struct {
	ID               string         `json:"id,omitempty"`
	Content          string         `json:"content"`
	Vector           []float64      `json:"vector,omitempty"`
	SourceType       string         `json:"sourceType"` // session, file, web, boomerang, project, thought
	SourcePath       *string        `json:"sourcePath,omitempty"`
	ContentHash      string         `json:"contentHash"`
	TrustScore       float64        `json:"trustScore"` // 0.0 - 1.0, default 0.5
	RetrievalCount   int            `json:"retrievalCount"`
	IsArchived       bool           `json:"isArchived"`
	LastAccessedAt   *time.Time     `json:"lastAccessedAt,omitempty"`
	PeerID           string         `json:"peerId,omitempty"`
	Metadata         map[string]any `json:"metadata"`
	Score            *float64       `json:"score,omitempty"` // search relevance score
	SupersedesID     string         `json:"supersedesId,omitempty"`
	StructuredFields map[string]any `json:"structuredFields,omitempty"`
	ChangeRatio      float64        `json:"changeRatio"` // default 1.0
	CreatedAtMs      int64          `json:"createdAtMs"`
	Relationships    []Relationship `json:"relationships,omitempty"`
	CreatedAt        time.Time      `json:"createdAt"`
	UpdatedAt        time.Time      `json:"updatedAt"`
}

// Relationship defines a semantic link between memories.
type Relationship struct {
	ID               string    `json:"id,omitempty"`
	SourceID         string    `json:"sourceId"`
	TargetID         string    `json:"targetId"`
	RelationshipType string    `json:"relationshipType"` // SUPERSEDES, RELATED_TO, CONTRADICTS, DERIVED_FROM, PARTIAL_UPDATE
	Confidence       float64   `json:"confidence"`       // 0.0-1.0, default 1.0
	CreatedAt        time.Time `json:"createdAt"`
	Source           string    `json:"source"` // "manual", "auto", etc.
}

// TrustSignal represents different types of feedback on a memory entry.
type TrustSignal string

const (
	SignalAgentUsed     TrustSignal = "agent_used"     // +0.05
	SignalAgentIgnored  TrustSignal = "agent_ignored"  // -0.05
	SignalUserConfirmed TrustSignal = "user_confirmed" // +0.10
	SignalUserCorrected TrustSignal = "user_corrected" // -0.10
)

// SearchOptions controls how semantic search behaves.
type SearchOptions struct {
	TopK        int     // default 10
	Threshold   float64 // default 0.7
	Strategy    string  // "tiered", "vector_only", "text_only", "parallel", "exact"
	ExactSearch bool    // disable DiskANN for exact results
}

// SearchFilter restricts memory search results.
type SearchFilter struct {
	SourceTypes   []string
	PeerID        string
	IsArchived    *bool // nil = any
	MinTrustScore float64
	Since         *time.Time
}

// Entity represents a knowledge graph entity extracted from memories.
type Entity struct {
	ID            string    `json:"id,omitempty"`
	Name          string    `json:"name"`
	EntityType    string    `json:"entityType"` // PERSON, ORGANIZATION, CONCEPT, CODE, PROJECT, LOCATION, UNKNOWN
	CanonicalName string    `json:"canonicalName,omitempty"`
	Confidence    float64   `json:"confidence"`
	Vector        []float64 `json:"vector,omitempty"`
	PeerID        string    `json:"peerId,omitempty"`
	MentionCount  int       `json:"mentionCount"`
	FirstSeenAt   time.Time `json:"firstSeenAt"`
	LastSeenAt    time.Time `json:"lastSeenAt"`
}

// EntityRelationship links two entities via a semantic relation.
type EntityRelationship struct {
	ID               string  `json:"id,omitempty"`
	SourceEntityID   string  `json:"sourceEntityId"`
	TargetEntityID   string  `json:"targetEntityId"`
	RelationshipType string  `json:"relationshipType"`
	Confidence       float64 `json:"confidence"`
	CreatedAt        time.Time
}

// PeerProfile defines a user/agent peer that can own and share memories.
type PeerProfile struct {
	ID           string         `json:"id,omitempty"`
	Name         string         `json:"name"`
	Role         string         `json:"role"`       // OWNER, COLLABORATOR, READONLY, GUEST
	TrustLevel   float64        `json:"trustLevel"` // 0.0-1.0, default 1.0
	Preferences  map[string]any `json:"preferences"`
	IsActive     bool           `json:"isActive"`
	CreatedAt    time.Time
	LastActiveAt *time.Time
}

// AuditEvent is a structured log entry for security and compliance.
type AuditEvent struct {
	ID          string         `json:"id,omitempty"`
	EventType   string         `json:"eventType"`
	Severity    string         `json:"severity"` // info, warning, critical
	SessionID   string         `json:"sessionId,omitempty"`
	PeerID      string         `json:"peerId,omitempty"`
	AgentName   string         `json:"agentName,omitempty"`
	ToolName    string         `json:"toolName,omitempty"`
	MemoryID    string         `json:"memoryId,omitempty"`
	Description string         `json:"description"`
	Details     map[string]any `json:"details"`
	StateBefore map[string]any `json:"stateBefore"`
	StateAfter  map[string]any `json:"stateAfter"`
	IPAddress   string         `json:"ipAddress,omitempty"`
	OccurredAt  time.Time
	CreatedAt   time.Time
}

// ThoughtChain represents a persistent reasoning log.
type ThoughtChain struct {
	ID            string `json:"id,omitempty"`
	SessionID     string `json:"sessionId,omitempty"`
	ParentChainID string `json:"parentChainId,omitempty"`
	Status        string `json:"status"` // active, paused, completed, abandoned
	CreatedAt     time.Time
	UpdatedAt     time.Time
	Thoughts      []Thought `json:"thoughts,omitempty"`
}

// Thought is a single step in a reasoning chain.
type Thought struct {
	ID                  string    `json:"id,omitempty"`
	ChainID             string    `json:"chainId"`
	ThoughtNumber       int       `json:"thoughtNumber"`
	TotalThoughts       int       `json:"totalThoughts"`
	NextThoughtNeeded   bool      `json:"nextThoughtNeeded"`
	Text                string    `json:"text"`
	IsRevision          bool      `json:"isRevision"`
	RevisesThoughtID    string    `json:"revisesThoughtId,omitempty"`
	BranchFromThoughtID string    `json:"branchFromThoughtId,omitempty"`
	BranchID            string    `json:"branchId,omitempty"`
	Vector              []float64 `json:"vector,omitempty"`
	ContentHash         string    `json:"contentHash,omitempty"`
	MemoryID            string    `json:"memoryId,omitempty"`
	CreatedAt           time.Time
}

// ChunkResult is a single file chunk returned by project search.
type ChunkResult struct {
	FilePath  string  `json:"filePath"`
	Content   string  `json:"content"`
	Score     float64 `json:"score"`
	StartLine int     `json:"startLine"`
	EndLine   int     `json:"endLine"`
}

// FileContentsResult reconstructs indexed file contents from chunks.
type FileContentsResult struct {
	FilePath  string `json:"filePath"`
	Contents  string `json:"contents"`
	IsPartial bool   `json:"isPartial"`
}

// TrustAdjustment captures a single trust score modification.
type TrustAdjustment struct {
	ID               string  `json:"id,omitempty"`
	MemoryID         string  `json:"memoryId"`
	OldScore         float64 `json:"oldScore"`
	NewScore         float64 `json:"newScore"`
	Signal           string  `json:"signal"`
	AdjustmentAmount float64 `json:"adjustmentAmount"`
	Reason           string  `json:"reason,omitempty"`
	CreatedAt        time.Time
}

// TrustResult returns current trust metrics for a memory.
type TrustResult struct {
	MemoryID       string  `json:"memoryId"`
	TrustScore     float64 `json:"trustScore"`
	RetrievalCount int     `json:"retrievalCount"`
	IsArchived     bool    `json:"isArchived"`
	DecayRate      float64 `json:"decayRate"`
}

// RelationshipSummary groups relationships by type for a memory.
type RelationshipSummary struct {
	MemoryID           string         `json:"memoryId"`
	TotalRelationships int            `json:"totalRelationships"`
	ByType             map[string]int `json:"byType"`
}

// IndexOptions are used to trigger project file indexing jobs.
type IndexOptions struct {
	Path      string
	Force     bool
	BatchSize int
}

// SearchProjectOptions are used for project chunk semantic search.
type SearchProjectOptions struct {
	TopK      int
	Threshold float64
	Paths     []string
	FileTypes []string
}

// StatusResult reports overall memory system health.
type StatusResult struct {
	MemoryCount int    `json:"memoryCount"`
	EntityCount int    `json:"entityCount"`
	PeerCount   int    `json:"peerCount"`
	ChainCount  int    `json:"chainCount"`
	Dimension   int    `json:"dimension"`
	Initialized bool   `json:"initialized"`
	Ready       bool   `json:"ready"`
	VectorStyle string `json:"vectorStyle"` // "pgvector" or "pgvectorScale"
}

// DecayStatus reports memory decay statistics.
type DecayStatus struct {
	Enabled         bool `json:"enabled"`
	HalfLifeDays    int  `json:"halfLifeDays"`
	FadingCount     int  `json:"fadingCount"`
	ArchivedCount   int  `json:"archivedCount"`
	ConsolidateRuns int  `json:"consolidateRuns"`
}

// ConsolidationStats records the result of a consolidation run.
type ConsolidationStats struct {
	Examined  int       `json:"examined"`
	Merged    int       `json:"merged"`
	Skipped   int       `json:"skipped"`
	CreatedAt time.Time `json:"createdAt"`
}

// ConversationMessage is a simple chat message structure for LLM calls.
type ConversationMessage struct {
	Role    string `json:"role"` // system, user, assistant
	Content string `json:"content"`
}

// LLMClient handles external LLM calls.
type LLMClient interface {
	Chat(ctx context.Context, messages []ConversationMessage, temperature float64) (string, error)
	Embed(ctx context.Context, text string) ([]float64, error)
	Health(ctx context.Context) error
	Close(ctx context.Context) error
}

// ─── Dialectic Types (Phase 4 Track B) ──────────────────────────────────────────

// Contradiction represents a pair of memories flagged as conflicting.
type Contradiction struct {
	ID          string     `json:"id,omitempty"`
	MemoryA     string     `json:"memoryA"`
	MemoryB     string     `json:"memoryB"`
	Description string     `json:"description"`
	Severity    string     `json:"severity"` // "low", "medium", "high"
	Status      string     `json:"status"`   // "open", "resolved", "superseded"
	CreatedAt   time.Time  `json:"createdAt"`
	ResolvedAt  *time.Time `json:"resolvedAt,omitempty"`
}

// Argument is a single pro or con for a memory in a contradiction.
type Argument struct {
	MemoryID   string   `json:"memoryId"`
	Text       string   `json:"text"`
	Confidence float64  `json:"confidence"` // 0.0-1.0
	Evidence   []string `json:"evidence,omitempty"`
}

// Resolution synthesizes a conclusion from dialectic arguments.
type Resolution struct {
	ID              string    `json:"id,omitempty"`
	ContradictionID string    `json:"contradictionId"`
	WinnerMemory    string    `json:"winnerMemory,omitempty"` // "", "A", "B", or "inconclusive"
	Explanation     string    `json:"explanation"`
	Confidence      float64   `json:"confidence"`
	Recommendations []string  `json:"recommendations,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
}

// ChallengeEvent records a challenge to a memory.
type ChallengeEvent struct {
	ID               string     `json:"id,omitempty"`
	MemoryID         string     `json:"memoryId"`
	ChallengerID     string     `json:"challengerId"`
	ChallengeText    string     `json:"challengeText"`
	ResponseText     string     `json:"responseText,omitempty"`
	Status           string     `json:"status"` // "open", "accepted", "rejected", "superseded"
	ConfidenceChange float64    `json:"confidenceChange"`
	CreatedAt        time.Time  `json:"createdAt"`
	ResolvedAt       *time.Time `json:"resolvedAt,omitempty"`
}

// DialecticEvent represents a step in contradiction resolution history.
type DialecticEvent struct {
	ID              string    `json:"id,omitempty"`
	ContradictionID string    `json:"contradictionId"`
	EventType       string    `json:"eventType"` // "contradiction_found", "argument_added", "resolution_created", "challenge_made"
	Description     string    `json:"description"`
	CreatedAt       time.Time `json:"createdAt"`
}

// ─── User Profile Types (Phase 2 Part 1) ────────────────────────────────────────

// UserProfile represents a user's persistent profile stored in user_profiles.
// It tracks communication style, expertise, and preferences across sessions.
type UserProfile struct {
	ID                 string         `json:"id,omitempty"`
	PeerID             string         `json:"peerId,omitempty"`
	Preferences        map[string]any `json:"preferences"`
	CommunicationStyle string         `json:"communicationStyle"`
	ExpertiseLevel     string         `json:"expertiseLevel"`
	DialecticNotes     []any          `json:"dialecticNotes"`
	WarmedUp           bool           `json:"warmedUp"`
	SessionCount       int            `json:"sessionCount"`
	CreatedAt          time.Time      `json:"createdAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
}

// UserProfileUpdate contains the fields that can be partially updated.
// Only non-nil/non-empty fields will be applied.
type UserProfileUpdate struct {
	Preferences        map[string]any `json:"preferences,omitempty"`
	CommunicationStyle string         `json:"communicationStyle,omitempty"`
	ExpertiseLevel     string         `json:"expertiseLevel,omitempty"`
	DialecticNotes     []any          `json:"dialecticNotes,omitempty"`
	WarmedUp           *bool          `json:"warmedUp,omitempty"`
	SessionCount       *int           `json:"sessionCount,omitempty"`
}

// SecuritySummary aggregates audit_log data for a time window.
type SecuritySummary struct {
	TotalEvents    int            `json:"totalEvents"`
	CriticalCount  int            `json:"criticalCount"`
	EventsPerType  map[string]int `json:"eventsPerType"`
	EventsPerAgent map[string]int `json:"eventsPerAgent"`
	SeverityCounts map[string]int `json:"severityCounts"`
}

// ─── Agent Tools (Lazy Tool Exposure) ──────────────────────────────────────────

// ToolRecord tracks which tools an agent/peer has been exposed to via
// demand-driven expansion. The broker uses this to build personalized
// tool catalogs for each agent.
type ToolRecord struct {
	ID               int64      `json:"id"`
	PeerID           string     `json:"peerId"`
	ToolServer       string     `json:"toolServer"`
	ToolName         string     `json:"toolName"`
	FirstRequestedAt time.Time  `json:"firstRequestedAt"`
	LastUsedAt       *time.Time `json:"lastUsedAt,omitempty"`
	UseCount         int        `json:"useCount"`
	BypassBroker     bool       `json:"bypassBroker"`
}

// DefaultInitialTools returns the core tool set that every agent starts with.
// These 5 tools are always available via the memoryManager server without
// requiring an explicit tool request.
func DefaultInitialTools() []string {
	return []string{
		"memory.add",
		"memory.query",
		"memory.get",
		"memory.adjustTrust",
		"memory.getStatus",
	}
}

// RoleExtraTools returns role-specific default tools on top of the core set.
// These are included in buildCatalog output for the role but are NOT tracked
// in agent_tools until the agent explicitly requests them.
func RoleExtraTools(role string) []string {
	switch role {
	case "architect":
		return []string{
			"memory.extractEntities",
			"memory.queryKG",
			"memory.getTier1Summary",
			"memory.searchEntities",
			"memory.getEntityGraph",
		}
	case "orchestrator":
		return []string{
			"memory.logAuditEvent",
			"memory.getAuditLog",
			"memory.getDecayStatus",
			"memory.addPeer",
			"memory.listPeers",
		}
	case "tester":
		return []string{
			"memory.findContradictions",
			"memory.getRelatedThoughtChains",
		}
	default:
		return nil
	}
}
