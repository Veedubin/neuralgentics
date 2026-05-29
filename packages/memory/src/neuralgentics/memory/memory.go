package memory

import (
	"context"
	"fmt"

	"neuralgentics/src/neuralgentics/memory/audit"
	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/decay"
	"neuralgentics/src/neuralgentics/memory/dialectic"
	"neuralgentics/src/neuralgentics/memory/embed"
	"neuralgentics/src/neuralgentics/memory/kg"
	"neuralgentics/src/neuralgentics/memory/search"
	"neuralgentics/src/neuralgentics/memory/store"
	"neuralgentics/src/neuralgentics/memory/thought"
	"neuralgentics/src/neuralgentics/memory/trust"
)

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
	config          *core.Config
}

// New creates and initializes a new MemorySystem.
// It sets up the PostgreSQL store, embedder, searcher, trust engine, audit logger,
// decay subsystem, peer subsystem, tiered loader, and project indexer based on the config.
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

	// Create searcher
	srch := search.NewHybridSearcher(pgStore, emb)

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
	llmClient := newOpenAILLMClient(cfg.LLMBaseURL, cfg.LLMModel)
	entityExtractor := kg.NewEntityExtractor(pgStore, llmClient)
	kgQuery := kg.NewKGQuery(pgStore)
	graphVisualizer := kg.NewGraphVisualizer(pgStore)

	// Create thought chains manager
	chainsManager := thought.NewChainsManager(pgStore, emb)

	// Create dialectic engine
	dialecticEng := dialectic.NewEngine(pgStore, llmClient)

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
		config:          cfg,
	}, nil
}

// NewWithComponents creates a MemorySystem with explicit components (for testing).
func NewWithComponents(s core.Store, e core.Embedder, sr core.Searcher, cfg *core.Config) *MemorySystem {
	de := decay.NewDecayEngine(s)
	llmClient := newOpenAILLMClient("", "") // stub LLM for tests
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
		config:          cfg,
	}
}

// ─── Foundation Methods (Phase 1) ────────────────────────────────────────────

// AddMemory adds a new memory entry. The embedder generates a vector automatically
// if entry.Vector is nil.
func (m *MemorySystem) AddMemory(ctx context.Context, entry core.MemoryEntry) (string, error) {
	if entry.Vector == nil && m.embedder != nil {
		vector, err := m.embedder.Embed(ctx, entry.Content)
		if err != nil {
			return "", fmt.Errorf("embed content: %w", err)
		}
		entry.Vector = vector
	}
	return m.store.AddMemory(ctx, &entry)
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

// newOpenAILLMClient creates an LLMClient that connects to an OpenAI-compatible API.
// This will be replaced with a full implementation in a future phase; for now it
// returns a stub client. Production deployments should provide an LLMClient
// via NewWithComponents or dependency injection.
func newOpenAILLMClient(baseURL, model string) core.LLMClient {
	// TODO: Implement full OpenAI-compatible HTTP client (Phase 5).
	return &stubLLMClient{baseURL: baseURL, model: model}
}

// stubLLMClient is a placeholder LLM client that returns errors on use.
// It will be replaced with a real OpenAI-compatible HTTP client.
type stubLLMClient struct {
	baseURL string
	model   string
}

func (s *stubLLMClient) Chat(ctx context.Context, messages []core.ConversationMessage, temperature float64) (string, error) {
	return "", fmt.Errorf("stubLLMClient: LLM not configured; provide an LLMClient via NewWithComponents or implement OpenAI client (baseURL=%s, model=%s)", s.baseURL, s.model)
}

func (s *stubLLMClient) Embed(ctx context.Context, text string) ([]float64, error) {
	return nil, fmt.Errorf("stubLLMClient: LLM not configured")
}

func (s *stubLLMClient) Health(ctx context.Context) error {
	return fmt.Errorf("stubLLMClient: LLM not configured")
}

func (s *stubLLMClient) Close(ctx context.Context) error {
	return nil
}
