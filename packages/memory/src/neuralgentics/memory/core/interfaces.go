package core

import "context"

// Store is the abstract interface behind the PostgreSQL-backed storage layer.
// Every subsystem depends on this interface, never on the concrete PostgresStore.
type Store interface {
	// ─── Lifecycle ────────────────────────────────────────────────────────────────
	Initialize(ctx context.Context) error
	Close(ctx context.Context) error
	Ping(ctx context.Context) error
	Stats(ctx context.Context) (*StatusResult, error)

	// ─── Memory CRUD ──────────────────────────────────────────────────────────────
	AddMemory(ctx context.Context, entry *MemoryEntry) (string, error)
	GetMemory(ctx context.Context, id string, includeArchived bool) (*MemoryEntry, error)
	UpdateMemory(ctx context.Context, entry *MemoryEntry) error
	DeleteMemory(ctx context.Context, id string) error
	CountMemories(ctx context.Context) (int64, error)
	ListMemories(ctx context.Context, filter *SearchFilter, limit int) ([]*MemoryEntry, error)
	ContentExists(ctx context.Context, contentHash string) (bool, error)

	// ─── Vector search ────────────────────────────────────────────────────────────
	QueryMemoriesByVector(ctx context.Context, vector []float64, opts *SearchOptions) ([]*MemoryEntry, error)
	SearchMemoriesText(ctx context.Context, query string, opts *SearchOptions) ([]*MemoryEntry, error)
	GetSimilar(ctx context.Context, memoryID string, opts *SearchOptions) ([]*MemoryEntry, error)

	// ─── Trust fields ─────────────────────────────────────────────────────────────
	UpdateTrustFields(ctx context.Context, id string, trustScore float64, archived bool) error
	IncrementRetrievalCount(ctx context.Context, id string) error

	// ─── Relationships ───────────────────────────────────────────────────────────
	CreateRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error)
	DeleteRelationship(ctx context.Context, id string) error
	GetRelationships(ctx context.Context, memoryID string) ([]Relationship, error)
	GetRelationshipSummary(ctx context.Context, memoryID string) (*RelationshipSummary, error)
	GetSupersessionChain(ctx context.Context, memoryID string, maxDepth int) ([]string, error)
	GetSuperseded(ctx context.Context, memoryID string) (string, error)

	// ─── Entity CRUD (Knowledge Graph) ────────────────────────────────────────────
	UpsertEntity(ctx context.Context, entity *Entity) (string, error)
	GetEntity(ctx context.Context, id string) (*Entity, error)
	GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*Entity, error)
	SearchEntities(ctx context.Context, name string, limit int) ([]*Entity, error)
	CreateEntityRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error)
	GetEntityRelationships(ctx context.Context, entityID string) ([]EntityRelationship, error)
	ResolveEntityGraph(ctx context.Context, entityID string, depth int) error
	InferenceChain(ctx context.Context, startEntity, endEntity string, maxDepth int) ([]EntityRelationship, error)

	// ─── Peer CRUD (Multi-Peer) ────────────────────────────────────────────────────
	AddPeer(ctx context.Context, peer *PeerProfile) (string, error)
	GetPeer(ctx context.Context, id string) (*PeerProfile, error)
	ListPeers(ctx context.Context, limit int) ([]*PeerProfile, error)
	UpdatePeerLastActive(ctx context.Context, id string) error

	// ─── Memory Sharing ──────────────────────────────────────────────────────────
	ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error)
	RevokeShareMemory(ctx context.Context, memoryID, peerID string) error
	GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*MemoryEntry, error)
	GetPeerMemories(ctx context.Context, peerID string, query string, opts *SearchOptions) ([]*MemoryEntry, error)

	// ─── Thought Chains ──────────────────────────────────────────────────────────
	StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error)
	AddThought(ctx context.Context, chainID string, thought *Thought) (string, error)
	GetThoughtChain(ctx context.Context, chainID string) (*ThoughtChain, error)
	GetRelatedChains(ctx context.Context, query string, limit int) ([]*ThoughtChain, error)
	ReviseThought(ctx context.Context, chainID string, thoughtNumber int, revisedText string) (*Thought, error)
	BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*Thought, error)
	PauseThoughtChain(ctx context.Context, chainID string) error
	ResumeThoughtChain(ctx context.Context, chainID string) error
	AbandonThoughtChain(ctx context.Context, chainID string) error

	// ─── Audit logging ───────────────────────────────────────────────────────────
	LogAuditEvent(ctx context.Context, event *AuditEvent) (string, error)
	GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*AuditEvent, error)

	// ─── Trust Adjustments ──────────────────────────────────────────────────────
	LogTrustAdjustment(ctx context.Context, adj *TrustAdjustment) (string, error)
	GetTrustAdjustments(ctx context.Context, memoryID string, limit int) ([]*TrustAdjustment, error)

	// ─── Decay metadata ──────────────────────────────────────────────────────────
	UpdateDecayRate(ctx context.Context, memoryID string, rate float64) error
	ListFadingMemories(ctx context.Context, threshold float64, limit int) ([]*MemoryEntry, error)

	// ─── Project indexer ────────────────────────────────────────────────────────
	AddProjectChunk(ctx context.Context, chunk *ChunkResult) (string, error)
	DeleteChunksByPath(ctx context.Context, path string) error
	SearchChunks(ctx context.Context, vector []float64, opts *SearchProjectOptions) ([]*ChunkResult, error)
	GetFileChunksByPath(ctx context.Context, filePath string) (*FileContentsResult, error)
}

// Embedder is the abstract interface for generating text embeddings.
// The default implementation is a gRPC client to the Python embedding sidecar.
type Embedder interface {
	Embed(ctx context.Context, text string) ([]float64, error)
	EmbedBatch(ctx context.Context, texts []string) ([][]float64, error)
	Health(ctx context.Context) error
	Close(ctx context.Context) error
}

// Searcher is the abstract interface for hybrid semantic + text search.
// Implementations are in package search/vector.go and search/hybrid.go.
type Searcher interface {
	Query(ctx context.Context, query string, opts *SearchOptions) ([]*MemoryEntry, error)
	VectorSearch(ctx context.Context, vector []float64, opts *SearchOptions) ([]*MemoryEntry, error)
	TextSearch(ctx context.Context, query string, opts *SearchOptions) ([]*MemoryEntry, error)
	HybridSearch(ctx context.Context, query string, vector []float64, opts *SearchOptions) ([]*MemoryEntry, error)
	GetSimilar(ctx context.Context, memoryID string, opts *SearchOptions) ([]*MemoryEntry, error)
}

// Indexer is the abstract interface for project file indexing.
type Indexer interface {
	Index(ctx context.Context, path string, opts *IndexOptions) error
	Search(ctx context.Context, query string, opts *SearchProjectOptions) ([]*ChunkResult, error)
	Watch(ctx context.Context, path string) error
	IsIndexing(ctx context.Context) bool
}
