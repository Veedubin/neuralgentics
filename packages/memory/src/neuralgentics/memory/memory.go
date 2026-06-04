package memory

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"neuralgentics/src/neuralgentics/memory/audit"
	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/decay"
	"neuralgentics/src/neuralgentics/memory/dialectic"
	"neuralgentics/src/neuralgentics/memory/embed"
	"neuralgentics/src/neuralgentics/memory/index"
	"neuralgentics/src/neuralgentics/memory/kg"
	"neuralgentics/src/neuralgentics/memory/llm"
	"neuralgentics/src/neuralgentics/memory/search"
	"neuralgentics/src/neuralgentics/memory/store"
	"neuralgentics/src/neuralgentics/memory/thought"
	"neuralgentics/src/neuralgentics/memory/trust"
	"neuralgentics/src/neuralgentics/memory/user"
)

// IndexerJob tracks a background indexing job.
type IndexerJob struct {
	ID        string
	Status    string // "running", "completed", "failed"
	Message   string
	StartedAt time.Time
}

// MemorySystem is the top-level facade for the neuralgentics memory module.
// The Go orchestrator imports this directly — no HTTP, no MCP between them.
//
// Usage:
//
//	mem, err := memory.New(ctx, &core.Config{DatabaseURL: "postgresql://..."})
//	id, err := mem.AddMemory(ctx, core.MemoryEntry{Content: "dark mode", SourceType: "session"})
//	results, err := mem.QueryMemories(ctx, "search query", nil)
type MemorySystem struct {
	store           core.Store
	embedder        core.Embedder
	searcher        core.Searcher
	trustEngine     *trust.TrustEngine
	auditLogger     *audit.AuditLogger
	decayEngine     *decay.DecayEngine
	scheduler       *decay.Scheduler
	consolidator    *decay.Consolidator
	entityExtractor *kg.EntityExtractor
	kgQuery         *kg.KGQuery
	graphVisualizer *kg.GraphVisualizer
	dialecticEngine *dialectic.Engine
	chainsManager   *thought.ChainsManager
	profileManager  *user.ProfileManager
	config          *core.Config
	indexer         *index.ProjectIndexer
	backgroundJobs  map[string]*IndexerJob
	jobsMu          sync.Mutex
}

// New creates and initializes a new MemorySystem.
// It sets up the PostgreSQL store, embedder, searcher, trust engine, audit logger,
// decay subsystem, peer subsystem, tiered loader, and project indexer based on the config.
//
// v0.7.0+: The embedding mode (cpu/auto/gpu) from config.EmbeddingMode is used to
// configure the HybridSearcher for dual-model RRF dispatch.
func New(ctx context.Context, cfg *core.Config) (*MemorySystem, error) {
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}

	// Create and initialize store
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		return nil, fmt.Errorf("initialize store: %w", err)
	}

	// Create embedder: gRPC sidecar if address configured, otherwise NoOp for testing.
	var emb core.Embedder
	if cfg.EmbeddingAddr != "" && cfg.EmbeddingAddr != "noop" {
		grpcEmb := embed.NewGRPCEmbedder(cfg.EmbeddingAddr, nil)
		if err := grpcEmb.Connect(ctx); err != nil {
			return nil, fmt.Errorf("connect embedding sidecar: %w", err)
		}
		emb = grpcEmb
	} else {
		emb = embed.NewNoOpEmbedder()
	}

	// Create searcher with dual-model RRF config
	srch := search.NewHybridSearcherWithConfig(pgStore, emb, cfg.EmbeddingMode, cfg.RRFK)

	// Create trust engine
	te := trust.NewTrustEngine(pgStore)

	// Create audit logger
	al := audit.NewAuditLogger(pgStore)

	// Create decay engine and consolidator
	de := decay.NewDecayEngine(pgStore)
	con := decay.NewConsolidator(pgStore, emb)

	// Create scheduler (1-hour interval by default)
	sched := decay.NewScheduler(de, 0) // 0 uses default 1-hour interval
	sched.Start()

	// Create KG subsystem components
	llmClient := newOpenAILLMClient(cfg.LLMBaseURL, cfg.LLMAPIKey, cfg.LLMModel)
	entityExtractor := kg.NewEntityExtractor(pgStore, llmClient)
	kgQuery := kg.NewKGQuery(pgStore)
	graphVisualizer := kg.NewGraphVisualizer(pgStore)

	// Create thought chains manager
	chainsManager := thought.NewChainsManager(pgStore, emb)

	// Create dialectic engine
	dialecticEng := dialectic.NewEngine(pgStore, llmClient)

	// Create profile manager for user modeling
	profileMgr := user.NewProfileManager(pgStore)

	// Create project indexer for file indexing
	projectIndexer := index.NewProjectIndexer(pgStore, emb)

	return &MemorySystem{
		store:           pgStore,
		embedder:        emb,
		searcher:        srch,
		trustEngine:     te,
		auditLogger:     al,
		decayEngine:     de,
		scheduler:       sched,
		consolidator:    con,
		entityExtractor: entityExtractor,
		kgQuery:         kgQuery,
		graphVisualizer: graphVisualizer,
		chainsManager:   chainsManager,
		dialecticEngine: dialecticEng,
		profileManager:  profileMgr,
		config:          cfg,
		indexer:         projectIndexer,
		backgroundJobs:  make(map[string]*IndexerJob),
	}, nil
}

// NewWithComponents creates a MemorySystem with explicit components (for testing).
func NewWithComponents(s core.Store, e core.Embedder, sr core.Searcher, cfg *core.Config) *MemorySystem {
	de := decay.NewDecayEngine(s)
	llmClient := newOpenAILLMClient("", "", "") // no-op LLM for tests: empty baseURL skips HTTP calls
	idx := index.NewProjectIndexer(s, e)
	return &MemorySystem{
		store:           s,
		embedder:        e,
		searcher:        sr,
		trustEngine:     trust.NewTrustEngine(s),
		auditLogger:     audit.NewAuditLogger(s),
		decayEngine:     de,
		scheduler:       nil, // tests can set this manually
		consolidator:    decay.NewConsolidator(s, e),
		entityExtractor: kg.NewEntityExtractor(s, llmClient),
		kgQuery:         kg.NewKGQuery(s),
		graphVisualizer: kg.NewGraphVisualizer(s),
		chainsManager:   thought.NewChainsManager(s, e),
		dialecticEngine: dialectic.NewEngine(s, llmClient),
		profileManager:  user.NewProfileManager(s),
		config:          cfg,
		indexer:         idx,
		backgroundJobs:  make(map[string]*IndexerJob),
	}
}

// ─── Foundation Methods (Phase 1) ────────────────────────────────────────────

// AddMemory adds a new memory entry. The embedder generates a vector automatically
// if entry.Vector is nil.
//
// In auto embedding mode, after the primary 384-dim write succeeds, a best-effort
// 1024-dim sidecar write is attempted. Failure of the 1024 write does NOT fail
// the overall operation — a warning is logged and the 384-dim ID is returned.
func (m *MemorySystem) AddMemory(ctx context.Context, entry core.MemoryEntry) (string, error) {
	if entry.Vector == nil && m.embedder != nil {
		vector, err := m.embedder.Embed(ctx, entry.Content)
		if err != nil {
			return "", fmt.Errorf("embed content: %w", err)
		}
		entry.Vector = vector
	}

	id, err := m.store.AddMemory(ctx, &entry)
	if err != nil {
		return id, err
	}

	// Dual-write: best-effort 1024-dim sidecar in auto mode.
	// The embedder.Dim() == 1024 check is intentionally NOT used: the default
	// GRPCEmbedder.Dim() == 384, but it can still produce 1024-dim vectors on
	// demand via Embed1024() (which routes to bge-large on the sidecar). The
	// Embed1024 call is cheap when the embedder doesn't support 1024 (NoOp
	// returns a zero vector; the AddMemory1024 INSERT will reject it and we
	// log + continue).
	if m.config != nil && m.config.EmbeddingMode == core.EmbeddingModeAuto && m.embedder != nil {
		vec1024, err1024 := m.embedder.Embed1024(ctx, entry.Content)
		if err1024 != nil {
			log.Printf("warn: dual-write 1024 sidecar failed at embed: %v", err1024)
			return id, nil
		}
		if _, err1024 = m.store.AddMemory1024(ctx, id, vec1024); err1024 != nil {
			log.Printf("warn: dual-write 1024 sidecar failed at insert: %v", err1024)
		}
	}

	return id, nil
}

// QueryMemories performs a semantic search using the configured searcher.
func (m *MemorySystem) QueryMemories(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if opts == nil {
		opts = &core.SearchOptions{TopK: 10, Threshold: 0.7}
	}

	switch opts.Strategy {
	case "text_only":
		return m.searcher.TextSearch(ctx, query, opts)
	case "vector_only":
		vector, err := m.embedder.Embed(ctx, query)
		if err != nil {
			return nil, fmt.Errorf("embed query: %w", err)
		}
		return m.searcher.VectorSearch(ctx, vector, opts)
	default:
		// Default: hybrid search using tiered/parallel strategy
		vector, err := m.embedder.Embed(ctx, query)
		if err != nil {
			return nil, fmt.Errorf("embed query: %w", err)
		}
		return m.searcher.HybridSearch(ctx, query, vector, opts)
	}
}

// GetMemory retrieves a memory by ID.
func (m *MemorySystem) GetMemory(ctx context.Context, id string) (*core.MemoryEntry, error) {
	return m.store.GetMemory(ctx, id, false)
}

// DeleteMemory soft-deletes a memory.
func (m *MemorySystem) DeleteMemory(ctx context.Context, id string) error {
	return m.store.DeleteMemory(ctx, id)
}

// CountMemories returns the count of active memories.
func (m *MemorySystem) CountMemories(ctx context.Context) (int64, error) {
	return m.store.CountMemories(ctx)
}

// GetStatus returns system health and stats.
func (m *MemorySystem) GetStatus(ctx context.Context) (*core.StatusResult, error) {
	return m.store.Stats(ctx)
}

// Close shuts down the memory system gracefully.
func (m *MemorySystem) Close(ctx context.Context) error {
	var errs []error
	if m.scheduler != nil {
		m.scheduler.Stop()
	}
	if err := m.embedder.Close(ctx); err != nil {
		errs = append(errs, err)
	}
	if err := m.store.Close(ctx); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return fmt.Errorf("close errors: %v", errs)
	}
	return nil
}

// ─── Audit Methods (Phase 2) ─────────────────────────────────────────────────

// LogAuditEvent logs a structured audit event.
func (m *MemorySystem) LogAuditEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	return m.auditLogger.LogEvent(ctx, event)
}

// GetAuditEvents retrieves audit events with optional session and type filters.
func (m *MemorySystem) GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	return m.auditLogger.GetEvents(ctx, sessionID, eventType, limit)
}

// ─── Trust Methods (Phase 2) ─────────────────────────────────────────────────

// GetTrustScore returns the current trust metrics for a memory.
func (m *MemorySystem) GetTrustScore(ctx context.Context, memoryID string) (*core.TrustResult, error) {
	return m.trustEngine.GetTrustScore(ctx, memoryID)
}

// AdjustTrust modifies a memory's trust score based on a feedback signal.
func (m *MemorySystem) AdjustTrust(ctx context.Context, memoryID string, signal core.TrustSignal) (*core.TrustAdjustment, error) {
	return m.trustEngine.AdjustTrust(ctx, memoryID, signal)
}

// ListArchived returns archived memories up to the given limit.
func (m *MemorySystem) ListArchived(ctx context.Context, limit int) ([]*core.MemoryEntry, error) {
	return m.trustEngine.ListArchived(ctx, limit)
}

// ─── Decay Methods (Phase 2) ─────────────────────────────────────────────────

// GetDecayStatus returns current decay statistics.
func (m *MemorySystem) GetDecayStatus(ctx context.Context) (*core.DecayStatus, error) {
	return m.decayEngine.GetDecayStatus(ctx)
}

// AdjustDecayRate changes the decay rate for a specific memory.
func (m *MemorySystem) AdjustDecayRate(ctx context.Context, memoryID string, rate float64) error {
	return m.decayEngine.AdjustDecayRate(ctx, memoryID, rate)
}

// TriggerConsolidation runs a consolidation pass over active memories.
func (m *MemorySystem) TriggerConsolidation(ctx context.Context, force bool) (*core.ConsolidationStats, error) {
	return m.consolidator.Consolidate(ctx, force)
}

// ListFadingMemories returns memories approaching the archive threshold.
func (m *MemorySystem) ListFadingMemories(ctx context.Context, limit int) ([]*core.MemoryEntry, error) {
	return m.decayEngine.ListFadingMemories(ctx, limit)
}

// ─── Knowledge Graph Methods (Phase 3 Track A) ─────────────────────────────────

// ExtractEntities extracts entities from text using the LLM and upserts them to the store.
func (m *MemorySystem) ExtractEntities(ctx context.Context, text string) ([]string, error) {
	return m.entityExtractor.ExtractEntities(ctx, text)
}

// QueryKnowledgeGraph performs a knowledge graph traversal starting from the given entity.
func (m *MemorySystem) QueryKnowledgeGraph(ctx context.Context, params kg.QueryParams) (*kg.QueryResult, error) {
	return m.kgQuery.Query(ctx, params)
}

// SearchEntities searches for entities by name.
func (m *MemorySystem) SearchEntities(ctx context.Context, name string, limit int) ([]*core.Entity, error) {
	return m.kgQuery.SearchEntities(ctx, name, limit)
}

// GetEntitiesByType retrieves entities of a specific type.
func (m *MemorySystem) GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*core.Entity, error) {
	return m.kgQuery.GetEntitiesByType(ctx, entityType, limit)
}

// CreateEntityRelationship creates a relationship between two entities.
func (m *MemorySystem) CreateEntityRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return m.kgQuery.CreateRelationship(ctx, sourceID, targetID, relType, confidence)
}

// GetEntityGraph retrieves all entities and relationships connected to the given entity
// within the specified depth.
func (m *MemorySystem) GetEntityGraph(ctx context.Context, entityID string, depth int) ([]*core.Entity, []core.EntityRelationship, error) {
	return kg.GetEntityGraph(ctx, m.store, entityID, depth)
}

// RenderGraphHTML produces a self-contained HTML visualization of the knowledge graph
// surrounding the given entity.
func (m *MemorySystem) RenderGraphHTML(ctx context.Context, entityID string, depth int) (string, error) {
	return m.graphVisualizer.RenderHTML(ctx, entityID, depth)
}

// ─── Thought Chain Methods (Phase 4A) ─────────────────────────────────────

// StartThoughtChain creates a new thought chain and returns its ID.
func (m *MemorySystem) StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	return m.chainsManager.StartChain(ctx, sessionID, parentChainID)
}

// AddThought adds a thought to an existing chain. If the embedder is available,
// it generates an embedding for the thought text automatically.
func (m *MemorySystem) AddThought(ctx context.Context, chainID, text string, thoughtNumber, totalThoughts int, nextNeeded bool) (string, error) {
	return m.chainsManager.AddThought(ctx, chainID, text, thoughtNumber, totalThoughts, nextNeeded)
}

// GetThoughtChain retrieves a thought chain with all its thoughts.
func (m *MemorySystem) GetThoughtChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	return m.chainsManager.GetChain(ctx, chainID)
}

// GetRelatedThoughtChains performs semantic search over thought chains.
func (m *MemorySystem) GetRelatedThoughtChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	return m.chainsManager.GetRelatedChains(ctx, query, limit)
}

// ReviseThought creates a revision of an existing thought in a chain.
func (m *MemorySystem) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, newText string) (*core.Thought, error) {
	return m.chainsManager.ReviseThought(ctx, chainID, thoughtNumber, newText)
}

// BranchThought creates a branch from an existing thought in a chain.
func (m *MemorySystem) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	return m.chainsManager.BranchThought(ctx, chainID, fromThoughtNumber, branchID, text)
}

// PauseThoughtChain pauses a thought chain.
func (m *MemorySystem) PauseThoughtChain(ctx context.Context, chainID string) error {
	return m.chainsManager.PauseChain(ctx, chainID)
}

// ResumeThoughtChain resumes a paused thought chain.
func (m *MemorySystem) ResumeThoughtChain(ctx context.Context, chainID string) error {
	return m.chainsManager.ResumeChain(ctx, chainID)
}

// AbandonThoughtChain abandons a thought chain.
func (m *MemorySystem) AbandonThoughtChain(ctx context.Context, chainID string) error {
	return m.chainsManager.AbandonChain(ctx, chainID)
}

// ─── Dialectic Methods (Phase 4 Track B) ─────────────────────────────────────

// FindContradictions discovers pairs of memories that contradict each other.
func (m *MemorySystem) FindContradictions(ctx context.Context, query string, limit int) ([]*core.Contradiction, error) {
	return m.dialecticEngine.FindContradictions(ctx, query, limit)
}

// ResolveContradiction resolves a contradiction by generating arguments and
// synthesizing a resolution via LLM.
func (m *MemorySystem) ResolveContradiction(ctx context.Context, contradictionID string) (*core.Resolution, error) {
	return m.dialecticEngine.ResolveContradiction(ctx, contradictionID)
}

// ChallengeMemory submits a challenge against a memory and generates a response.
func (m *MemorySystem) ChallengeMemory(ctx context.Context, memoryID, challengerID, challengeText string) (*core.ChallengeEvent, error) {
	return m.dialecticEngine.ChallengeMemory(ctx, memoryID, challengerID, challengeText)
}

// GetDialecticHistory returns the dialectic event history for a memory.
func (m *MemorySystem) GetDialecticHistory(ctx context.Context, memoryID string, limit int) ([]*core.DialecticEvent, error) {
	return m.dialecticEngine.GetDialecticHistory(ctx, memoryID, limit)
}

// ─── Indexer Methods (Phase 2 Part 2) ──────────────────────────────────────────

// SearchProject performs a semantic search over indexed project files.
// It embeds the query text and searches for matching chunks, returning
// results filtered by the given options.
func (m *MemorySystem) SearchProject(ctx context.Context, query string, topK int, paths []string, fileTypes []string) ([]*core.ChunkResult, error) {
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	if topK <= 0 {
		topK = 20
	}
	opts := &core.SearchProjectOptions{
		TopK:      topK,
		Threshold: 0.5,
		Paths:     paths,
		FileTypes: fileTypes,
	}
	return m.indexer.Search(ctx, query, opts)
}

// IndexProject triggers indexing of the project at the given path.
// If background is true, it runs indexing in a goroutine and returns a job ID
// immediately. If background is false, it runs synchronously and returns the
// job status after completion.
func (m *MemorySystem) IndexProject(ctx context.Context, path string, force bool, background bool) (string, string, error) {
	if path == "" {
		path = "."
	}

	opts := &core.IndexOptions{
		Path:  path,
		Force: force,
	}

	if background {
		jobID := fmt.Sprintf("idx-%d", time.Now().UnixNano())

		m.jobsMu.Lock()
		m.backgroundJobs[jobID] = &IndexerJob{
			ID:        jobID,
			Status:    "running",
			Message:   "Indexing started in background",
			StartedAt: time.Now(),
		}
		m.jobsMu.Unlock()

		go func() {
			err := m.indexer.Index(context.Background(), path, opts)

			m.jobsMu.Lock()
			defer m.jobsMu.Unlock()
			if job, ok := m.backgroundJobs[jobID]; ok {
				if err != nil {
					job.Status = "failed"
					job.Message = err.Error()
				} else {
					job.Status = "completed"
					job.Message = "Indexing completed successfully"
				}
			}
		}()

		return jobID, "running", nil
	}

	// Synchronous indexing
	err := m.indexer.Index(ctx, path, opts)
	if err != nil {
		return "", "failed", err
	}

	return "", "completed", nil
}

// GetFileContents reconstructs a file's contents from its indexed chunks.
// If triggerIndex is true and the file is not found, it will attempt to
// index the current directory first, then retry the lookup.
func (m *MemorySystem) GetFileContents(ctx context.Context, filePath string, triggerIndex bool) (*core.FileContentsResult, error) {
	if filePath == "" {
		return nil, fmt.Errorf("filePath is required")
	}

	result, err := m.store.GetFileChunksByPath(ctx, filePath)
	if err != nil {
		return nil, fmt.Errorf("get file chunks: %w", err)
	}

	if result == nil && triggerIndex {
		// Trigger re-indexing of the current directory
		_ = m.indexer.Index(ctx, ".", &core.IndexOptions{Force: false})

		// Retry the lookup
		result, err = m.store.GetFileChunksByPath(ctx, filePath)
		if err != nil {
			return nil, fmt.Errorf("get file chunks after re-index: %w", err)
		}
	}

	return result, nil
}

// GetIndexerJobStatus returns the status of a background indexing job.
func (m *MemorySystem) GetIndexerJobStatus(jobID string) (*IndexerJob, error) {
	m.jobsMu.Lock()
	defer m.jobsMu.Unlock()
	job, ok := m.backgroundJobs[jobID]
	if !ok {
		return nil, fmt.Errorf("job not found: %s", jobID)
	}
	return job, nil
}

// newOpenAILLMClient creates an LLMClient that connects to an OpenAI-compatible API.
// It uses the provided API key and constructs a production HTTP client with retry logic.
func newOpenAILLMClient(baseURL, apiKey, model string) core.LLMClient {
	return llm.NewOpenAIClient(baseURL, apiKey, model)
}

// ─── Peer/Multi-Peer Methods (Phase 1 wire-up) ────────────────────────────────

// ListPeers returns a list of peer profiles.
func (m *MemorySystem) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	if limit <= 0 {
		limit = 100
	}
	return m.store.ListPeers(ctx, limit)
}

// AddPeer registers a new peer profile. If the peer ID is empty, one is generated.
func (m *MemorySystem) AddPeer(ctx context.Context, peer *core.PeerProfile) (string, error) {
	return m.store.AddPeer(ctx, peer)
}

// ShareMemory shares a memory with a peer. The grantedBy field indicates who
// authorized the share. Permission is typically "SHARED" or "INHERITED".
func (m *MemorySystem) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	return m.store.ShareMemory(ctx, memoryID, peerID, permission, grantedBy)
}

// GetPeerMemories returns memories owned by a peer, optionally filtered by a query.
func (m *MemorySystem) GetPeerMemories(ctx context.Context, peerID, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return m.store.GetPeerMemories(ctx, peerID, query, opts)
}

// GetSharedMemories returns memories shared with the current peer context.
func (m *MemorySystem) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	return m.store.GetSharedMemories(ctx, peerID, limit)
}

// ─── User Profile Methods (Phase 2 Part 1) ────────────────────────────────────

// GetUserProfile retrieves the user profile for the given peer ID.
// If no profile exists, a default one is returned (not persisted).
// The includeDialecticNotes flag controls whether dialectic_notes are included.
func (m *MemorySystem) GetUserProfile(ctx context.Context, peerID string, includeDialecticNotes bool) (*core.UserProfile, error) {
	return m.profileManager.GetProfile(ctx, peerID, includeDialecticNotes)
}

// UpdateUserProfile applies a partial update to the user profile for the given peer ID.
// Only non-nil/non-empty fields in the update are applied. If no profile exists,
// a default one is created and then updated.
func (m *MemorySystem) UpdateUserProfile(ctx context.Context, peerID string, update *core.UserProfileUpdate) (*core.UserProfile, error) {
	return m.profileManager.UpdateProfile(ctx, peerID, update)
}

// ─── Security Summary Method (Phase 2 Part 1) ──────────────────────────────────

// GetSecuritySummary aggregates audit_log data for the last N hours.
// Returns counts by event_type, severity, and agent_name.
func (m *MemorySystem) GetSecuritySummary(ctx context.Context, hours int) (*core.SecuritySummary, error) {
	if hours <= 0 {
		hours = 24
	}
	return m.store.GetSecuritySummary(ctx, hours)
}

// ─── Agent Tools Methods (Phase 3: Lazy Tool Exposure) ──────────────────────────

// RecordToolRequest records that a peer has requested access to a tool.
// If the peer already has a record for this tool, the request is silently ignored.
func (m *MemorySystem) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	return m.store.RecordToolRequest(ctx, peerID, toolServer, toolName)
}

// IncrementToolUse increments the use count for a peer's tool and returns
// whether the tool has reached the bypass threshold (use_count >= 5).
// After bypass is reached, the agent can call the tool directly without
// going through the broker.
func (m *MemorySystem) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	return m.store.IncrementToolUse(ctx, peerID, toolServer, toolName)
}

// GetAgentTools returns all tool records for a given peer.
func (m *MemorySystem) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	return m.store.GetAgentTools(ctx, peerID)
}

// GetInitialToolSet returns the default initial tool set for a peer, which
// is the 5 core memory tools plus any role-specific extras.
// The peerID is used to look up any previously-requested tools from agent_tools.
func (m *MemorySystem) GetInitialToolSet(ctx context.Context, peerID string) ([]string, error) {
	// Start with default core tools
	tools := core.DefaultInitialTools()

	// Add any tools the peer has already been exposed to via demand-driven expansion
	records, err := m.store.GetAgentTools(ctx, peerID)
	if err != nil {
		return tools, nil // return defaults even if query fails
	}

	seen := make(map[string]bool)
	for _, t := range tools {
		seen[t] = true
	}
	for _, rec := range records {
		// Combine server and tool name as "server.tool" format
		// But for initial tool set return, we use the tool_name only
		// since all tools are on the "memoryManager" server
		fullName := rec.ToolServer + "." + rec.ToolName
		if !seen[fullName] {
			tools = append(tools, fullName)
			seen[fullName] = true
		}
	}

	return tools, nil
}
