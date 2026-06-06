// Package main implements the Neuralgentics backend binary that exposes
// a JSON-RPC 2.0 server over stdin/stdout, wiring together the memory,
// orchestrator, and broker subsystems for consumption by the TypeScript
// OpenCode plugin.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"neuralgentics-backend/src/neuralgentics/backend"

	"neuralgentics/src/neuralgentics/memory"
	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/kg"

	orchestrator "neuralgentics-orchestrator/src/neuralgentics/orchestrator"

	"neuralgentics-broker/src/neuralgentics/broker"
)

// version is set at build time via -ldflags="-X main.version=...".
// Defaults to "dev" for local builds.
var version = "dev"

// ─── Active Peer Context ────────────────────────────────────────────────────

// activePeerContext tracks the currently active peer for multi-peer operations.
// It is a thread-safe, in-process state manager — each backend process has one
// instance. When peer.switchContext is called, the active peer ID is updated and
// subsequent calls like peer.getSharedMemories use the active peer.
type activePeerContext struct {
	mu         sync.RWMutex
	activePeer string
}

const defaultPeerID = "default"

// newActivePeerContext creates an activePeerContext with the default peer active.
func newActivePeerContext() *activePeerContext {
	return &activePeerContext{
		activePeer: defaultPeerID,
	}
}

// SwitchPeer changes the active peer to the given peer ID.
// An empty peerID resets to the default peer.
// The caller is responsible for validating that the peer exists (done in the handler).
func (a *activePeerContext) SwitchPeer(peerID string) (previousPeerID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	previousPeerID = a.activePeer
	if peerID == "" {
		a.activePeer = defaultPeerID
	} else {
		a.activePeer = peerID
	}
	return previousPeerID
}

// GetActivePeerID returns the currently active peer ID.
func (a *activePeerContext) GetActivePeerID() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.activePeer
}

// ─── JSON-RPC Types ──────────────────────────────────────────────────────────

type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonrpcError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *jsonrpcError   `json:"error,omitempty"`
}

// ─── Request Structs ─────────────────────────────────────────────────────────

type memoryAddParams struct {
	Content    string         `json:"content"`
	SourceType string         `json:"sourceType,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

type memoryQueryParams struct {
	Query    string `json:"query"`
	Limit    *int   `json:"limit,omitempty"`
	Strategy string `json:"strategy,omitempty"`
}

type memoryGetParams struct {
	ID string `json:"id"`
}

type memoryDeleteParams struct {
	ID string `json:"id"`
}

type memoryAdjustTrustParams struct {
	MemoryID string `json:"memoryId"`
	Signal   string `json:"signal"`
}

type memoryQueryBySourceTypeParams struct {
	SourceType string `json:"sourceType"`
	Limit      *int   `json:"limit,omitempty"`
	SortBy     string `json:"sortBy,omitempty"`
	SortOrder  string `json:"sortOrder,omitempty"`
}

type orchestratorHandleTaskParams struct {
	Task backend.JSONTask `json:"task"`
}

type orchestratorHandleStatelessParams struct {
	Task backend.JSONTask `json:"task"`
}

type orchestratorCompleteCycleParams struct {
	TaskID          string `json:"taskId"`
	Result          string `json:"result"`
	ContextMemoryID string `json:"contextMemoryId"`
}

type orchestratorDispatchParams struct {
	Tasks        backend.JSONTaskPlan `json:"tasks"`
	Dependencies map[string][]string  `json:"dependencies,omitempty"`
}

type orchestratorRouteParams struct {
	TaskType string `json:"taskType"`
}

type brokerBuildCatalogParams struct {
	Role string `json:"role"`
}

type brokerCallParams struct {
	Role       string         `json:"role"`
	ServerName string         `json:"serverName"`
	ToolName   string         `json:"toolName"`
	Args       map[string]any `json:"args"`
}

type brokerMatchIntentParams struct {
	Role   string `json:"role"`
	Intent string `json:"intent"`
}

// ─── Peer Request/Response Structs ─────────────────────────────────────────────

type peerAddPeerParams struct {
	ID          string         `json:"peerId,omitempty"`
	Name        string         `json:"name"`
	Role        string         `json:"role"`
	TrustLevel  float64        `json:"trustLevel"`
	Preferences map[string]any `json:"preferences,omitempty"`
}

type peerShareMemoryParams struct {
	MemoryID   string `json:"memoryId"`
	PeerID     string `json:"targetPeerId"`
	Permission string `json:"permission"`
}

type peerGetPeerMemoriesParams struct {
	PeerID string `json:"peerId"`
	Query  string `json:"query,omitempty"`
	Limit  *int   `json:"limit,omitempty"`
}

type peerGetSharedMemoriesParams struct {
	Limit *int `json:"limit,omitempty"`
}

type peerListPeersParams struct {
	Limit *int `json:"limit,omitempty"`
}

type peerSwitchContextParams struct {
	PeerID string `json:"peerId"`
}

// ─── Status Request/Response Structs ────────────────────────────────────────────

type memoryGetStatusParams struct{}

type memoryCountParams struct{}

// ─── Audit Request Structs ─────────────────────────────────────────────────────

type memoryLogAuditEventParams struct {
	EventType   string         `json:"eventType"`
	Severity    string         `json:"severity,omitempty"`
	SessionID   string         `json:"sessionId,omitempty"`
	PeerID      string         `json:"peerId,omitempty"`
	AgentName   string         `json:"agentName,omitempty"`
	ToolName    string         `json:"toolName,omitempty"`
	MemoryID    string         `json:"memoryId,omitempty"`
	Description string         `json:"description"`
	Details     map[string]any `json:"details,omitempty"`
	StateBefore map[string]any `json:"stateBefore,omitempty"`
	StateAfter  map[string]any `json:"stateAfter,omitempty"`
	IPAddress   string         `json:"ipAddress,omitempty"`
}

type memoryGetAuditEventsParams struct {
	SessionID string `json:"sessionId,omitempty"`
	EventType string `json:"eventType,omitempty"`
	Limit     *int   `json:"limit,omitempty"`
}

// ─── Trust Request Structs ─────────────────────────────────────────────────────

type memoryGetTrustScoreParams struct {
	MemoryID string `json:"memoryId"`
}

type memoryListArchivedParams struct {
	Limit *int `json:"limit,omitempty"`
}

// ─── Decay Request Structs ─────────────────────────────────────────────────────

type memoryGetDecayStatusParams struct{}

type memoryAdjustDecayRateParams struct {
	MemoryID string  `json:"memoryId"`
	Rate     float64 `json:"rate"`
}

type memoryTriggerConsolidationParams struct {
	Force bool `json:"force,omitempty"`
}

type memoryListFadingMemoriesParams struct {
	Limit *int `json:"limit,omitempty"`
}

// ─── Tiered Summary Request Structs ──────────────────────────────────────────

type memoryGetTier0SummaryParams struct {
	ForceRefresh bool `json:"forceRefresh,omitempty"`
}

type memoryGetTier1SummaryParams struct {
	ForceRefresh bool `json:"forceRefresh,omitempty"`
}

// ─── Extraction Request Structs ────────────────────────────────────────────────

type memoryTriggerExtractionParams struct {
	Conversation *string `json:"conversation,omitempty"` // nil means use server buffer
}

type memoryPrecompressExtractionParams struct {
	ContextContent *string `json:"contextContent,omitempty"` // nil means capture current context
}

// ─── Knowledge Graph Request Structs ──────────────────────────────────────────

type memoryExtractEntitiesParams struct {
	Text string `json:"text"`
}

type memoryQueryKGParams struct {
	StartEntity       string   `json:"startEntity"`
	EndEntity         string   `json:"endEntity,omitempty"`
	RelationshipTypes []string `json:"relationshipTypes,omitempty"`
	MaxDepth          *int     `json:"maxDepth,omitempty"`
	Limit             *int     `json:"limit,omitempty"`
}

type memorySearchEntitiesParams struct {
	Name  string `json:"name"`
	Limit *int   `json:"limit,omitempty"`
}

type memoryGetEntitiesByTypeParams struct {
	EntityType string `json:"entityType"`
	Limit      *int   `json:"limit,omitempty"`
}

type memoryCreateEntityRelationshipParams struct {
	SourceID   string  `json:"sourceId"`
	TargetID   string  `json:"targetId"`
	RelType    string  `json:"relType"`
	Confidence float64 `json:"confidence,omitempty"`
}

type memoryGetEntityGraphParams struct {
	EntityID string `json:"entityId"`
	Depth    *int   `json:"depth,omitempty"`
}

type memoryRenderGraphHTMLParams struct {
	EntityID string `json:"entityId"`
	Depth    *int   `json:"depth,omitempty"`
}

// ─── Thought Chain Request Structs ─────────────────────────────────────────────

type memoryStartThoughtChainParams struct {
	SessionID     string `json:"sessionId,omitempty"`
	ParentChainID string `json:"parentChainId,omitempty"`
}

type memoryAddThoughtParams struct {
	ChainID       string `json:"chainId"`
	Thought       string `json:"thought"`
	ThoughtNumber int    `json:"thoughtNumber"`
	TotalThoughts int    `json:"totalThoughts"`
	NextNeeded    bool   `json:"nextThoughtNeeded"`
}

type memoryGetThoughtChainParams struct {
	ChainID string `json:"chainId"`
}

type memoryGetRelatedThoughtChainsParams struct {
	Query string `json:"query"`
	Limit *int   `json:"limit,omitempty"`
}

type memoryReviseThoughtParams struct {
	ChainID       string `json:"chainId"`
	ThoughtNumber int    `json:"thoughtNumber"`
	RevisedText   string `json:"revisedThought"`
}

type memoryBranchThoughtParams struct {
	ChainID       string `json:"chainId"`
	FromThought   int    `json:"fromThoughtNumber"`
	BranchID      string `json:"branchId"`
	Thought       string `json:"thought"`
	ThoughtNumber int    `json:"thoughtNumber"`
	TotalThoughts int    `json:"totalThoughts"`
	NextNeeded    bool   `json:"nextThoughtNeeded"`
}

type memoryPauseThoughtChainParams struct {
	ChainID string `json:"chainId"`
}

type memoryResumeThoughtChainParams struct {
	ChainID string `json:"chainId"`
}

type memoryAbandonThoughtChainParams struct {
	ChainID string `json:"chainId"`
}

// ─── Dialectic Request Structs ─────────────────────────────────────────────────

type memoryFindContradictionsParams struct {
	Query string `json:"query,omitempty"`
	Limit *int   `json:"limit,omitempty"`
}

type memoryResolveContradictionParams struct {
	ContradictionID string `json:"contradictionId"`
}

type memoryChallengeMemoryParams struct {
	MemoryID      string `json:"memoryId"`
	ChallengerID  string `json:"challengerId,omitempty"`
	ChallengeText string `json:"challengeText"`
}

type memoryGetDialecticHistoryParams struct {
	MemoryID string `json:"memoryId"`
	Limit    *int   `json:"limit,omitempty"`
}

// ─── User Profile Request Structs ──────────────────────────────────────────────

type userGetProfileParams struct {
	PeerID                string `json:"peerId"`
	IncludeDialecticNotes *bool  `json:"includeDialecticNotes,omitempty"`
}

type userUpdateProfileParams struct {
	PeerID             string         `json:"peerId"`
	Preferences        map[string]any `json:"preferences,omitempty"`
	CommunicationStyle string         `json:"communicationStyle,omitempty"`
	ExpertiseLevel     string         `json:"expertiseLevel,omitempty"`
	DialecticNotes     []any          `json:"dialecticNotes,omitempty"`
	WarmedUp           *bool          `json:"warmedUp,omitempty"`
	SessionCount       *int           `json:"sessionCount,omitempty"`
}

// ─── Audit Request Struct (Security Summary) ────────────────────────────────────

type auditGetSecuritySummaryParams struct {
	Hours *int `json:"hours,omitempty"`
}

// ─── Indexer Request Structs (Phase 2 Part 2) ──────────────────────────────────

type indexerSearchParams struct {
	Query     string   `json:"query"`
	TopK      *int     `json:"topK,omitempty"`
	Paths     []string `json:"paths,omitempty"`
	FileTypes []string `json:"fileTypes,omitempty"`
}

type indexerIndexParams struct {
	Path       string `json:"path,omitempty"`
	Force      bool   `json:"force,omitempty"`
	Background bool   `json:"background,omitempty"`
}

type indexerGetFileContentsParams struct {
	FilePath     string `json:"filePath"`
	TriggerIndex bool   `json:"triggerIndex,omitempty"`
}

// ─── Agent Tools Request Structs (Phase 3: Lazy Tool Exposure) ──────────────

type agentRecordToolRequestParams struct {
	PeerID     string `json:"peerId"`
	ToolServer string `json:"toolServer"`
	ToolName   string `json:"toolName"`
}

type agentIncrementToolUseParams struct {
	PeerID     string `json:"peerId"`
	ToolServer string `json:"toolServer"`
	ToolName   string `json:"toolName"`
}

type agentGetToolsParams struct {
	PeerID string `json:"peerId"`
}

type agentGetInitialToolSetParams struct {
	PeerID string `json:"peerId"`
}

type initializeParams struct {
	ClientInfo map[string]string `json:"clientInfo,omitempty"`
}

// ─── Response Structs ────────────────────────────────────────────────────────

type initializeResult struct {
	ServerInfo   serverInfo   `json:"serverInfo"`
	Capabilities capabilities `json:"capabilities"`
}

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type capabilities struct {
	Memory       bool `json:"memory"`
	Orchestrator bool `json:"orchestrator"`
	Broker       bool `json:"broker"`
}

// ─── Main ────────────────────────────────────────────────────────────────────

func main() {
	// Handle --version / -v before any subsystem initialization.
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Printf("neuralgentics-backend %s\n", version)
		os.Exit(0)
	}

	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	dbURL := os.Getenv("NEURALGENTICS_DB_URL")
	if dbURL == "" {
		dbURL = "postgresql://postgres:password@localhost:5434/neuralgentics"
	}

	// Read embedding config from env. Defaults: noop embedder, cpu mode.
	// Set MEMINI_EMBEDDING_ADDR to a real gRPC target (e.g.
	// "unix:///tmp/neuralgentics-embed.sock" or "localhost:50051") to enable
	// real embeddings. Set EMBEDDING_MODE=auto to enable dual-model RRF.
	embeddingAddr := os.Getenv("MEMINI_EMBEDDING_ADDR")
	embeddingMode := os.Getenv("EMBEDDING_MODE")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── Initialize subsystems ────────────────────────────────────────────
	cfg := &core.Config{
		DatabaseURL:   dbURL,
		EmbeddingAddr: embeddingAddr,
		EmbeddingMode: core.EmbeddingMode(embeddingMode),
	}
	memSys, err := memory.New(ctx, cfg)
	if err != nil {
		log.Fatalf("failed to initialize memory system: %v", err)
	}

	adapter := orchestrator.NewMemorySystemAdapter(memSys)

	orch, err := orchestrator.New(&orchestrator.OrchestratorConfig{
		Memory:             adapter,
		ProtocolStrictness: orchestrator.StrictnessStandard,
		MaxConcurrent:      5,
		UseStatelessAgents: true,
	})
	if err != nil {
		log.Fatalf("failed to initialize orchestrator: %v", err)
	}

	brk := broker.NewBroker()

	// Wire the MemorySystem as the broker's ToolExposer for lazy tool exposure.
	// This allows the broker to track which tools each agent has requested and
	// determine when an agent can bypass the broker for direct tool calls.
	brk.SetToolExposer(&memorySystemExposer{memSys: memSys})

	log.Println("neuralgentics-backend: initialized successfully")

	// Create the active peer context for multi-peer operations.
	peerCtx := newActivePeerContext()

	// ── Ready signal ─────────────────────────────────────────────────────
	// Emit a JSON-RPC notification (no id) on stdout so the client knows
	// the backend is ready to accept requests. Without this, the client's
	// `waitForReady()` blocks on the first stdout line, which never comes
	// because the backend is a pure request/response server. This causes
	// the OpenCode plugin to hang on launch.
	emitReadyNotification()

	// ── Signal handling ──────────────────────────────────────────────────
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	go func() {
		sig := <-sigCh
		log.Printf("received signal %v, shutting down...", sig)
		cancel()

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()

		if err := orch.Close(shutdownCtx); err != nil {
			log.Printf("error closing orchestrator: %v", err)
		}
		if err := memSys.Close(shutdownCtx); err != nil {
			log.Printf("error closing memory system: %v", err)
		}

		os.Exit(0)
	}()

	// ── JSON-RPC read loop ───────────────────────────────────────────────
	if err := handleStream(os.Stdin, os.Stdout, func(req jsonrpcRequest) jsonrpcResponse {
		return handleRequest(ctx, req, memSys, orch, brk, peerCtx)
	}); err != nil {
		log.Printf("stdin scanner error: %v", err)
	}
}

// ─── Request Processing ──────────────────────────────────────────────────────

// processRequest parses a single JSON-RPC request line, dispatches it to the
// provided handler, and returns the response. It is the testable core of the
// read loop in main(). The handler receives the parsed jsonrpcRequest and
// returns the jsonrpcResponse.
func processRequest(line []byte, handler func(jsonrpcRequest) jsonrpcResponse) jsonrpcResponse {
	var req jsonrpcRequest
	if err := json.Unmarshal(line, &req); err != nil {
		return jsonrpcResponse{
			JSONRPC: "2.0",
			Error:   &jsonrpcError{Code: -32700, Message: "Parse error"},
		}
	}
	return handler(req)
}

// handleStream reads JSON-RPC requests line-by-line from r, dispatches each
// to the provided handler, and writes responses to w. It returns the first
// scanner error encountered, if any.
func handleStream(r io.Reader, w io.Writer, handler func(jsonrpcRequest) jsonrpcResponse) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		resp := processRequest(line, handler)
		writeResponseTo(w, resp)
	}

	return scanner.Err()
}

// ─── Request Router ──────────────────────────────────────────────────────────

func handleRequest(
	ctx context.Context,
	req jsonrpcRequest,
	memSys *memory.MemorySystem,
	orch *orchestrator.Orchestrator,
	brk *broker.Broker,
	peerCtx *activePeerContext,
) jsonrpcResponse {
	switch req.Method {
	// Lifecycle
	case "initialize":
		return handleInitialize(req)
	case "shutdown":
		return handleShutdown(req)
	case "ping":
		return handlePing(req)

	// Memory — CRUD (Phase 1 part 1, already wired)
	case "memory.add":
		return handleMemoryAdd(ctx, req, memSys)
	case "memory.query":
		return handleMemoryQuery(ctx, req, memSys)
	case "memory.get":
		return handleMemoryGet(ctx, req, memSys)
	case "memory.delete":
		return handleMemoryDelete(ctx, req, memSys)
	case "memory.adjustTrust":
		return handleMemoryAdjustTrust(ctx, req, memSys)
	case "memory.queryBySourceType":
		return handleMemoryQueryBySourceType(ctx, req, memSys)

	// Memory — Status
	case "memory.status":
		return handleMemoryGetStatus(ctx, req, memSys)
	case "memory.count":
		return handleMemoryCount(ctx, req, memSys)

	// Memory — Audit
	case "memory.logAuditEvent":
		return handleMemoryLogAuditEvent(ctx, req, memSys)
	case "memory.getAuditLog":
		return handleMemoryGetAuditEvents(ctx, req, memSys)

	// Memory — Trust
	case "memory.getTrustScore":
		return handleMemoryGetTrustScore(ctx, req, memSys)
	case "memory.listArchived":
		return handleMemoryListArchived(ctx, req, memSys)

	// Memory — Decay
	case "memory.getDecayStatus":
		return handleMemoryGetDecayStatus(ctx, req, memSys)
	case "memory.adjustDecayRate":
		return handleMemoryAdjustDecayRate(ctx, req, memSys)
	case "memory.triggerConsolidation":
		return handleMemoryTriggerConsolidation(ctx, req, memSys)
	case "memory.listFadingMemories":
		return handleMemoryListFadingMemories(ctx, req, memSys)

	// Memory — Tiered Summaries
	case "memory.getTier0Summary":
		return handleMemoryGetTier0Summary(ctx, req, memSys)
	case "memory.getTier1Summary":
		return handleMemoryGetTier1Summary(ctx, req, memSys)

	// Memory — Extraction (T-EXPOSE-001c)
	case "memory.triggerExtraction":
		return handleMemoryTriggerExtraction(ctx, req, memSys)
	case "memory.precompressExtraction":
		return handleMemoryPrecompressExtraction(ctx, req, memSys)

	// Memory — Knowledge Graph
	case "memory.extractEntities":
		return handleMemoryExtractEntities(ctx, req, memSys)
	case "memory.queryKG":
		return handleMemoryQueryKG(ctx, req, memSys)
	case "memory.searchEntities":
		return handleMemorySearchEntities(ctx, req, memSys)
	case "memory.getEntitiesByType":
		return handleMemoryGetEntitiesByType(ctx, req, memSys)
	case "memory.createEntityRelationship":
		return handleMemoryCreateEntityRelationship(ctx, req, memSys)
	case "memory.getEntityGraph":
		return handleMemoryGetEntityGraph(ctx, req, memSys)
	case "memory.renderGraphHTML":
		return handleMemoryRenderGraphHTML(ctx, req, memSys)

	// Memory — Thought Chains
	case "memory.startThoughtChain":
		return handleMemoryStartThoughtChain(ctx, req, memSys)
	case "memory.addThought":
		return handleMemoryAddThought(ctx, req, memSys)
	case "memory.getThoughtChain":
		return handleMemoryGetThoughtChain(ctx, req, memSys)
	case "memory.getRelatedThoughtChains":
		return handleMemoryGetRelatedThoughtChains(ctx, req, memSys)
	case "memory.reviseThought":
		return handleMemoryReviseThought(ctx, req, memSys)
	case "memory.branchThought":
		return handleMemoryBranchThought(ctx, req, memSys)
	case "memory.pauseThoughtChain":
		return handleMemoryPauseThoughtChain(ctx, req, memSys)
	case "memory.resumeThoughtChain":
		return handleMemoryResumeThoughtChain(ctx, req, memSys)
	case "memory.abandonThoughtChain":
		return handleMemoryAbandonThoughtChain(ctx, req, memSys)

	// Memory — Dialectic
	case "memory.findContradictions":
		return handleMemoryFindContradictions(ctx, req, memSys)
	case "memory.resolveContradiction":
		return handleMemoryResolveContradiction(ctx, req, memSys)
	case "memory.challengeMemory":
		return handleMemoryChallengeMemory(ctx, req, memSys)
	case "memory.getDialecticHistory":
		return handleMemoryGetDialecticHistory(ctx, req, memSys)

	// User Profile
	case "user.getProfile":
		return handleUserGetProfile(ctx, req, memSys)
	case "user.updateProfile":
		return handleUserUpdateProfile(ctx, req, memSys)

	// Audit — Security Summary
	case "audit.getSecuritySummary":
		return handleAuditGetSecuritySummary(ctx, req, memSys)

	// Indexer (Phase 2 Part 2)
	case "indexer.search":
		return handleIndexerSearch(ctx, req, memSys)
	case "indexer.index":
		return handleIndexerIndex(ctx, req, memSys)
	case "indexer.getFileContents":
		return handleIndexerGetFileContents(ctx, req, memSys)

	// Orchestrator
	case "orchestrator.handleTask":
		return handleOrchestratorHandleTask(ctx, req, orch)
	case "orchestrator.handleStateless":
		return handleOrchestratorHandleStateless(ctx, req, orch)
	case "orchestrator.completeCycle":
		return handleOrchestratorCompleteCycle(ctx, req, orch)
	case "orchestrator.dispatch":
		return handleOrchestratorDispatch(ctx, req, orch)
	case "orchestrator.route":
		return handleOrchestratorRoute(req, orch)

	// Broker
	case "broker.buildCatalog":
		return handleBrokerBuildCatalog(req, brk)
	case "broker.call":
		return handleBrokerCall(req, brk)
	case "broker.matchIntent":
		return handleBrokerMatchIntent(req, brk)

	// Peer/Multi-Peer
	case "peer.listPeers":
		return handlePeerListPeers(ctx, req, memSys)
	case "peer.addPeer":
		return handlePeerAddPeer(ctx, req, memSys)
	case "peer.shareMemory":
		return handlePeerShareMemory(ctx, req, memSys)
	case "peer.getPeerMemories":
		return handlePeerGetPeerMemories(ctx, req, memSys)
	case "peer.getSharedMemories":
		return handlePeerGetSharedMemories(ctx, req, memSys, peerCtx)
	case "peer.switchContext":
		return handlePeerSwitchContext(ctx, req, memSys, peerCtx)

	// Agent Tools (Lazy Tool Exposure)
	case "agent.recordToolRequest":
		return handleAgentRecordToolRequest(ctx, req, memSys)
	case "agent.incrementToolUse":
		return handleAgentIncrementToolUse(ctx, req, memSys)
	case "agent.getTools":
		return handleAgentGetTools(ctx, req, memSys)
	case "agent.getInitialToolSet":
		return handleAgentGetInitialToolSet(ctx, req, memSys)

	default:
		return errorResponse(req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

// ─── Lifecycle Handlers ──────────────────────────────────────────────────────

func handleInitialize(req jsonrpcRequest) jsonrpcResponse {
	var params initializeParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	_ = params.ClientInfo // informational only

	return successResponse(req.ID, initializeResult{
		ServerInfo: serverInfo{
			Name:    "neuralgentics-backend",
			Version: version,
		},
		Capabilities: capabilities{
			Memory:       true,
			Orchestrator: true,
			Broker:       true,
		},
	})
}

func handleShutdown(req jsonrpcRequest) jsonrpcResponse {
	return successResponse(req.ID, map[string]string{"status": "ok"})
}

func handlePing(req jsonrpcRequest) jsonrpcResponse {
	return successResponse(req.ID, "pong")
}

// ─── Memory Handlers ─────────────────────────────────────────────────────────

func handleMemoryAdd(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryAddParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.Content == "" {
		return errorResponse(req.ID, -32602, "Invalid params: content is required")
	}

	sourceType := params.SourceType
	if sourceType == "" {
		sourceType = "session"
	}

	contentHash := fmt.Sprintf("%x", sha256.Sum256([]byte(params.Content)))

	entry := core.MemoryEntry{
		Content:     params.Content,
		SourceType:  sourceType,
		ContentHash: contentHash,
		TrustScore:  0.5,
		Metadata:    params.Metadata,
	}

	id, err := memSys.AddMemory(ctx, entry)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"id": id})
}

func handleMemoryQuery(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryQueryParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.Query == "" {
		return errorResponse(req.ID, -32602, "Invalid params: query is required")
	}

	opts := &core.SearchOptions{TopK: 10, Threshold: 0.7}
	if params.Limit != nil {
		opts.TopK = *params.Limit
	}
	if params.Strategy != "" {
		opts.Strategy = params.Strategy
	}

	results, err := memSys.QueryMemories(ctx, params.Query, opts)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, results)
}

func handleMemoryGet(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: id is required")
	}

	result, err := memSys.GetMemory(ctx, params.ID)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, result)
}

func handleMemoryDelete(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryDeleteParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: id is required")
	}

	if err := memSys.DeleteMemory(ctx, params.ID); err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{})
}

func handleMemoryAdjustTrust(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryAdjustTrustParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.MemoryID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: memoryId is required")
	}
	if params.Signal == "" {
		return errorResponse(req.ID, -32602, "Invalid params: signal is required")
	}

	adj, err := memSys.AdjustTrust(ctx, params.MemoryID, core.TrustSignal(params.Signal))
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]interface{}{
		"oldScore":         adj.OldScore,
		"newScore":         adj.NewScore,
		"adjustmentAmount": adj.AdjustmentAmount,
	})
}

// handleMemoryQueryBySourceType returns memories filtered by sourceType,
// sorted by created_at DESC by default. This is used by the TUI's
// checkpoint persistence feature (T-079) to find the most recent
// compaction checkpoint.
func handleMemoryQueryBySourceType(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryQueryBySourceTypeParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.SourceType == "" {
		return errorResponse(req.ID, -32602, "Invalid params: sourceType is required")
	}

	limit := 10
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	filter := &core.SearchFilter{
		SourceTypes: []string{params.SourceType},
	}

	results, err := memSys.ListMemoriesBySourceType(ctx, filter, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, results)
}

// ─── Orchestrator Handlers ──────────────────────────────────────────────────

func handleOrchestratorHandleTask(ctx context.Context, req jsonrpcRequest, orch *orchestrator.Orchestrator) jsonrpcResponse {
	var params orchestratorHandleTaskParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	task := params.Task.ToTask()
	result, err := orch.HandleTask(ctx, task)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, result)
}

func handleOrchestratorHandleStateless(ctx context.Context, req jsonrpcRequest, orch *orchestrator.Orchestrator) jsonrpcResponse {
	var params orchestratorHandleStatelessParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	task := params.Task.ToTask()
	result, err := orch.HandleTaskStateless(ctx, task)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, result)
}

func handleOrchestratorCompleteCycle(ctx context.Context, req jsonrpcRequest, orch *orchestrator.Orchestrator) jsonrpcResponse {
	var params orchestratorCompleteCycleParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	wrapUp, err := orch.CompleteTaskCycle(ctx, params.TaskID, orchestrator.StatelessTaskResult{
		MemoryID:    params.Result,
		Description: "",
	}, params.ContextMemoryID)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, wrapUp)
}

func handleOrchestratorDispatch(ctx context.Context, req jsonrpcRequest, orch *orchestrator.Orchestrator) jsonrpcResponse {
	var params orchestratorDispatchParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	plan := params.Tasks.ToTaskPlan()
	// Merge dependencies if provided
	if params.Dependencies != nil {
		plan.Dependencies = params.Dependencies
	}

	results, err := orch.Dispatch(ctx, plan)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, results)
}

func handleOrchestratorRoute(req jsonrpcRequest, orch *orchestrator.Orchestrator) jsonrpcResponse {
	var params orchestratorRouteParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	agent, err := orch.Route(orchestrator.TaskType(params.TaskType))
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"agent": string(agent)})
}

// ─── Broker Handlers ─────────────────────────────────────────────────────────

func handleBrokerBuildCatalog(req jsonrpcRequest, brk *broker.Broker) jsonrpcResponse {
	var params brokerBuildCatalogParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	cat := brk.BuildServerCatalog(params.Role)
	return successResponse(req.ID, cat)
}

func handleBrokerCall(req jsonrpcRequest, brk *broker.Broker) jsonrpcResponse {
	var params brokerCallParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	result, err := brk.Call(params.Role, params.ServerName, params.ToolName, params.Args)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, result)
}

func handleBrokerMatchIntent(req jsonrpcRequest, brk *broker.Broker) jsonrpcResponse {
	var params brokerMatchIntentParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	match, err := brk.MatchIntent(params.Role, params.Intent)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, backend.FromIntentToolMatch(match))
}

// ─── Peer Handlers ─────────────────────────────────────────────────────────────

func handlePeerListPeers(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params peerListPeersParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	limit := 100
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	peers, err := memSys.ListPeers(ctx, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, peers)
}

func handlePeerAddPeer(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params peerAddPeerParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.Name == "" {
		return errorResponse(req.ID, -32602, "Invalid params: name is required")
	}

	role := params.Role
	if role == "" {
		role = "guest"
	}
	trustLevel := params.TrustLevel
	if trustLevel == 0 {
		trustLevel = 0.5
	}

	peer := &core.PeerProfile{
		ID:          params.ID,
		Name:        params.Name,
		Role:        role,
		TrustLevel:  trustLevel,
		Preferences: params.Preferences,
		IsActive:    true,
	}

	id, err := memSys.AddPeer(ctx, peer)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"id": id})
}

func handlePeerShareMemory(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params peerShareMemoryParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.MemoryID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: memoryId is required")
	}
	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: targetPeerId is required")
	}

	permission := params.Permission
	if permission == "" {
		permission = "shared"
	}

	shareID, err := memSys.ShareMemory(ctx, params.MemoryID, params.PeerID, permission, "")
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"id": shareID})
}

func handlePeerGetPeerMemories(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params peerGetPeerMemoriesParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: peerId is required")
	}

	opts := &core.SearchOptions{TopK: 10, Threshold: 0.7}
	if params.Limit != nil && *params.Limit > 0 {
		opts.TopK = *params.Limit
	}

	results, err := memSys.GetPeerMemories(ctx, params.PeerID, params.Query, opts)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, results)
}

func handlePeerGetSharedMemories(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem, peerCtx *activePeerContext) jsonrpcResponse {
	var params peerGetSharedMemoriesParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	limit := 100
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	// Use the active peer from the peer context instead of hardcoded "".
	peerID := peerCtx.GetActivePeerID()

	results, err := memSys.GetSharedMemories(ctx, peerID, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, results)
}

func handlePeerSwitchContext(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem, peerCtx *activePeerContext) jsonrpcResponse {
	var params peerSwitchContextParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: peerId is required")
	}

	// Validate that the peer exists by checking the peer list.
	// ListPeers with a generous limit lets us find any peer.
	peers, err := memSys.ListPeers(ctx, 1000)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	found := false
	for _, p := range peers {
		if p.ID == params.PeerID {
			found = true
			break
		}
	}
	if !found {
		return errorResponse(req.ID, -32603, fmt.Sprintf("Peer %q not found", params.PeerID))
	}

	previousPeerID := peerCtx.SwitchPeer(params.PeerID)
	switchedAt := time.Now().UTC().Format(time.RFC3339)

	return successResponse(req.ID, map[string]any{
		"success":        true,
		"previousPeerId": previousPeerID,
		"newPeerId":      params.PeerID,
		"switchedAt":     switchedAt,
	})
}

// ─── Status Handlers ──────────────────────────────────────────────────────────

func handleMemoryGetStatus(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	// No params required; allow nil/empty params (validate JSON if present)
	if req.Params != nil {
		var params memoryGetStatusParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	result, err := memSys.GetStatus(ctx)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}
	return successResponse(req.ID, result)
}

func handleMemoryCount(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	// No params required; allow nil/empty params (validate JSON if present)
	if req.Params != nil {
		var params memoryCountParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	count, err := memSys.CountMemories(ctx)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}
	return successResponse(req.ID, map[string]int64{"count": count})
}

// ─── Audit Handlers ───────────────────────────────────────────────────────────

func handleMemoryLogAuditEvent(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryLogAuditEventParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.EventType == "" {
		return errorResponse(req.ID, -32602, "Invalid params: eventType is required")
	}

	severity := params.Severity
	if severity == "" {
		severity = "info"
	}

	event := &core.AuditEvent{
		EventType:   params.EventType,
		Severity:    severity,
		SessionID:   params.SessionID,
		PeerID:      params.PeerID,
		AgentName:   params.AgentName,
		ToolName:    params.ToolName,
		MemoryID:    params.MemoryID,
		Description: params.Description,
		Details:     params.Details,
		StateBefore: params.StateBefore,
		StateAfter:  params.StateAfter,
		IPAddress:   params.IPAddress,
	}

	id, err := memSys.LogAuditEvent(ctx, event)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"id": id})
}

func handleMemoryGetAuditEvents(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetAuditEventsParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	limit := 100
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	events, err := memSys.GetAuditEvents(ctx, params.SessionID, params.EventType, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, events)
}

// ─── Trust Handlers ───────────────────────────────────────────────────────────

func handleMemoryGetTrustScore(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetTrustScoreParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.MemoryID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: memoryId is required")
	}

	result, err := memSys.GetTrustScore(ctx, params.MemoryID)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, result)
}

func handleMemoryListArchived(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryListArchivedParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	limit := 50
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	memories, err := memSys.ListArchived(ctx, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, memories)
}

// ─── Decay Handlers ───────────────────────────────────────────────────────────

func handleMemoryGetDecayStatus(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	// No params required; validate JSON if present
	if req.Params != nil {
		var params memoryGetDecayStatusParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	result, err := memSys.GetDecayStatus(ctx)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}
	return successResponse(req.ID, result)
}

func handleMemoryAdjustDecayRate(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryAdjustDecayRateParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.MemoryID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: memoryId is required")
	}

	if err := memSys.AdjustDecayRate(ctx, params.MemoryID, params.Rate); err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{})
}

func handleMemoryTriggerConsolidation(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryTriggerConsolidationParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	stats, err := memSys.TriggerConsolidation(ctx, params.Force)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, stats)
}

func handleMemoryListFadingMemories(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryListFadingMemoriesParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	limit := 20
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	memories, err := memSys.ListFadingMemories(ctx, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, memories)
}

// ─── Tiered Summary Handlers ──────────────────────────────────────────────────

func handleMemoryGetTier0Summary(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetTier0SummaryParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	if memSys == nil {
		return errorResponse(req.ID, -32603, "Internal error: memory system not initialized")
	}

	summary, err := memSys.GetTier0Summary(ctx, params.ForceRefresh)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, summary)
}

func handleMemoryGetTier1Summary(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetTier1SummaryParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	if memSys == nil {
		return errorResponse(req.ID, -32603, "Internal error: memory system not initialized")
	}

	summary, err := memSys.GetTier1Summary(ctx, params.ForceRefresh)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, summary)
}

// ─── Extraction Handlers (T-EXPOSE-001c) ────────────────────────────────────────

func handleMemoryTriggerExtraction(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryTriggerExtractionParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	if memSys == nil {
		return errorResponse(req.ID, -32603, "Internal error: memory system not initialized")
	}

	conversation := ""
	if params.Conversation != nil {
		conversation = *params.Conversation
	}

	result, err := memSys.TriggerExtraction(ctx, conversation)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	var memoryIDs []string
	if result != nil {
		memoryIDs = result.MemoryIDs
	}
	count := 0
	if result != nil {
		count = result.Count
	}

	return successResponse(req.ID, map[string]interface{}{
		"extracted":   count,
		"memoryIds":   memoryIDs,
		"triggeredAt": time.Now().Format(time.RFC3339),
	})
}

func handleMemoryPrecompressExtraction(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryPrecompressExtractionParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	if memSys == nil {
		return errorResponse(req.ID, -32603, "Internal error: memory system not initialized")
	}

	contextContent := ""
	if params.ContextContent != nil {
		contextContent = *params.ContextContent
	}

	result, err := memSys.PrecompressExtraction(ctx, contextContent)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	captured := false
	contextSize := 0
	if result != nil {
		captured = result.MemoriesExtracted > 0
		contextSize = len(result.Context)
	}

	return successResponse(req.ID, map[string]interface{}{
		"captured":    captured,
		"contextSize": contextSize,
		"capturedAt":  time.Now().Format(time.RFC3339),
	})
}

// ─── Knowledge Graph Handlers ─────────────────────────────────────────────────

func handleMemoryExtractEntities(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryExtractEntitiesParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.Text == "" {
		return errorResponse(req.ID, -32602, "Invalid params: text is required")
	}

	ids, err := memSys.ExtractEntities(ctx, params.Text)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]interface{}{"entityIds": ids})
}

func handleMemoryQueryKG(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryQueryKGParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.StartEntity == "" {
		return errorResponse(req.ID, -32602, "Invalid params: startEntity is required")
	}

	qp := kg.QueryParams{
		StartEntity:       params.StartEntity,
		EndEntity:         params.EndEntity,
		RelationshipTypes: params.RelationshipTypes,
	}
	if params.MaxDepth != nil {
		qp.MaxDepth = *params.MaxDepth
	}
	if params.Limit != nil {
		qp.Limit = *params.Limit
	}

	result, err := memSys.QueryKnowledgeGraph(ctx, qp)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, result)
}

func handleMemorySearchEntities(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memorySearchEntitiesParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.Name == "" {
		return errorResponse(req.ID, -32602, "Invalid params: name is required")
	}

	limit := 10
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	entities, err := memSys.SearchEntities(ctx, params.Name, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, entities)
}

func handleMemoryGetEntitiesByType(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetEntitiesByTypeParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.EntityType == "" {
		return errorResponse(req.ID, -32602, "Invalid params: entityType is required")
	}

	limit := 10
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	entities, err := memSys.GetEntitiesByType(ctx, params.EntityType, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, entities)
}

func handleMemoryCreateEntityRelationship(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryCreateEntityRelationshipParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.SourceID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: sourceId is required")
	}
	if params.TargetID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: targetId is required")
	}
	if params.RelType == "" {
		return errorResponse(req.ID, -32602, "Invalid params: relType is required")
	}

	confidence := params.Confidence
	if confidence <= 0 {
		confidence = 1.0
	}

	id, err := memSys.CreateEntityRelationship(ctx, params.SourceID, params.TargetID, params.RelType, confidence)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"id": id})
}

func handleMemoryGetEntityGraph(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetEntityGraphParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.EntityID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: entityId is required")
	}

	depth := 1
	if params.Depth != nil && *params.Depth > 0 {
		depth = *params.Depth
	}

	entities, relationships, err := memSys.GetEntityGraph(ctx, params.EntityID, depth)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]interface{}{
		"entities":      entities,
		"relationships": relationships,
	})
}

func handleMemoryRenderGraphHTML(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryRenderGraphHTMLParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.EntityID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: entityId is required")
	}

	depth := 1
	if params.Depth != nil && *params.Depth > 0 {
		depth = *params.Depth
	}

	html, err := memSys.RenderGraphHTML(ctx, params.EntityID, depth)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"html": html})
}

// ─── Thought Chain Handlers ────────────────────────────────────────────────────

func handleMemoryStartThoughtChain(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryStartThoughtChainParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	id, err := memSys.StartThoughtChain(ctx, params.SessionID, params.ParentChainID)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"id": id})
}

func handleMemoryAddThought(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryAddThoughtParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ChainID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: chainId is required")
	}
	if params.Thought == "" {
		return errorResponse(req.ID, -32602, "Invalid params: thought is required")
	}
	if params.ThoughtNumber <= 0 {
		return errorResponse(req.ID, -32602, "Invalid params: thoughtNumber must be positive")
	}
	if params.TotalThoughts <= 0 {
		return errorResponse(req.ID, -32602, "Invalid params: totalThoughts must be positive")
	}

	id, err := memSys.AddThought(ctx, params.ChainID, params.Thought, params.ThoughtNumber, params.TotalThoughts, params.NextNeeded)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"id": id})
}

func handleMemoryGetThoughtChain(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetThoughtChainParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ChainID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: chainId is required")
	}

	chain, err := memSys.GetThoughtChain(ctx, params.ChainID)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, chain)
}

func handleMemoryGetRelatedThoughtChains(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetRelatedThoughtChainsParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.Query == "" {
		return errorResponse(req.ID, -32602, "Invalid params: query is required")
	}

	limit := 10
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	chains, err := memSys.GetRelatedThoughtChains(ctx, params.Query, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, chains)
}

func handleMemoryReviseThought(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryReviseThoughtParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ChainID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: chainId is required")
	}
	if params.ThoughtNumber <= 0 {
		return errorResponse(req.ID, -32602, "Invalid params: thoughtNumber must be positive")
	}
	if params.RevisedText == "" {
		return errorResponse(req.ID, -32602, "Invalid params: revisedThought is required")
	}

	thought, err := memSys.ReviseThought(ctx, params.ChainID, params.ThoughtNumber, params.RevisedText)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, thought)
}

func handleMemoryBranchThought(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryBranchThoughtParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ChainID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: chainId is required")
	}
	if params.BranchID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: branchId is required")
	}
	if params.Thought == "" {
		return errorResponse(req.ID, -32602, "Invalid params: thought is required")
	}

	thought, err := memSys.BranchThought(ctx, params.ChainID, params.FromThought, params.BranchID, params.Thought)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, thought)
}

func handleMemoryPauseThoughtChain(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryPauseThoughtChainParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ChainID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: chainId is required")
	}

	if err := memSys.PauseThoughtChain(ctx, params.ChainID); err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{})
}

func handleMemoryResumeThoughtChain(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryResumeThoughtChainParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ChainID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: chainId is required")
	}

	if err := memSys.ResumeThoughtChain(ctx, params.ChainID); err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{})
}

func handleMemoryAbandonThoughtChain(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryAbandonThoughtChainParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ChainID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: chainId is required")
	}

	if err := memSys.AbandonThoughtChain(ctx, params.ChainID); err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{})
}

// ─── Dialectic Handlers ──────────────────────────────────────────────────────

func handleMemoryFindContradictions(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryFindContradictionsParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	limit := 10
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	contradictions, err := memSys.FindContradictions(ctx, params.Query, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, contradictions)
}

func handleMemoryResolveContradiction(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryResolveContradictionParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.ContradictionID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: contradictionId is required")
	}

	resolution, err := memSys.ResolveContradiction(ctx, params.ContradictionID)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, resolution)
}

func handleMemoryChallengeMemory(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryChallengeMemoryParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.MemoryID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: memoryId is required")
	}
	if params.ChallengeText == "" {
		return errorResponse(req.ID, -32602, "Invalid params: challengeText is required")
	}

	event, err := memSys.ChallengeMemory(ctx, params.MemoryID, params.ChallengerID, params.ChallengeText)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, event)
}

func handleMemoryGetDialecticHistory(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params memoryGetDialecticHistoryParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.MemoryID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: memoryId is required")
	}

	limit := 50
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}

	events, err := memSys.GetDialecticHistory(ctx, params.MemoryID, limit)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, events)
}

// ─── User Profile Handlers ──────────────────────────────────────────────────────

func handleUserGetProfile(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params userGetProfileParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: peerId is required")
	}

	includeNotes := false
	if params.IncludeDialecticNotes != nil {
		includeNotes = *params.IncludeDialecticNotes
	}

	profile, err := memSys.GetUserProfile(ctx, params.PeerID, includeNotes)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, profile)
}

func handleUserUpdateProfile(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params userUpdateProfileParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: peerId is required")
	}

	update := &core.UserProfileUpdate{
		Preferences:        params.Preferences,
		CommunicationStyle: params.CommunicationStyle,
		ExpertiseLevel:     params.ExpertiseLevel,
		DialecticNotes:     params.DialecticNotes,
		WarmedUp:           params.WarmedUp,
		SessionCount:       params.SessionCount,
	}

	profile, err := memSys.UpdateUserProfile(ctx, params.PeerID, update)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, profile)
}

// ─── Audit Security Summary Handler ─────────────────────────────────────────────

func handleAuditGetSecuritySummary(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params auditGetSecuritySummaryParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	hours := 24
	if params.Hours != nil && *params.Hours > 0 {
		hours = *params.Hours
	}

	summary, err := memSys.GetSecuritySummary(ctx, hours)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, summary)
}

// ─── Indexer Handlers (Phase 2 Part 2) ──────────────────────────────────────────

func handleIndexerSearch(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params indexerSearchParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.Query == "" {
		return errorResponse(req.ID, -32602, "Invalid params: query is required")
	}

	topK := 20
	if params.TopK != nil && *params.TopK > 0 {
		topK = *params.TopK
	}

	results, err := memSys.SearchProject(ctx, params.Query, topK, params.Paths, params.FileTypes)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]interface{}{
		"count":  len(results),
		"chunks": results,
	})
}

func handleIndexerIndex(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params indexerIndexParams
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
		}
	}

	jobID, status, err := memSys.IndexProject(ctx, params.Path, params.Force, params.Background)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	result := map[string]interface{}{
		"success": true,
		"status":  status,
		"message": fmt.Sprintf("Indexing %s", status),
	}
	if jobID != "" {
		result["jobId"] = jobID
		result["message"] = fmt.Sprintf("Indexing started in background (jobId: %s)", jobID)
	}

	return successResponse(req.ID, result)
}

func handleIndexerGetFileContents(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params indexerGetFileContentsParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.FilePath == "" {
		return errorResponse(req.ID, -32602, "Invalid params: filePath is required")
	}

	result, err := memSys.GetFileContents(ctx, params.FilePath, params.TriggerIndex)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	if result == nil {
		return successResponse(req.ID, map[string]interface{}{
			"success":   false,
			"filePath":  params.FilePath,
			"content":   "",
			"chunks":    []interface{}{},
			"lineCount": 0,
			"error":     "File not found in index",
		})
	}

	lineCount := len(splitLines(result.Contents))

	return successResponse(req.ID, map[string]interface{}{
		"success":   true,
		"filePath":  result.FilePath,
		"content":   result.Contents,
		"isPartial": result.IsPartial,
		"lineCount": lineCount,
	})
}

// splitLines counts lines in a string without allocating a slice.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

// ─── Agent Tools Handlers (Phase 3: Lazy Tool Exposure) ───────────────────

func handleAgentRecordToolRequest(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params agentRecordToolRequestParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: peerId is required")
	}
	if params.ToolServer == "" {
		return errorResponse(req.ID, -32602, "Invalid params: toolServer is required")
	}
	if params.ToolName == "" {
		return errorResponse(req.ID, -32602, "Invalid params: toolName is required")
	}

	if err := memSys.RecordToolRequest(ctx, params.PeerID, params.ToolServer, params.ToolName); err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]string{"status": "recorded"})
}

func handleAgentIncrementToolUse(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params agentIncrementToolUseParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: peerId is required")
	}
	if params.ToolServer == "" {
		return errorResponse(req.ID, -32602, "Invalid params: toolServer is required")
	}
	if params.ToolName == "" {
		return errorResponse(req.ID, -32602, "Invalid params: toolName is required")
	}

	bypass, err := memSys.IncrementToolUse(ctx, params.PeerID, params.ToolServer, params.ToolName)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	// Get the current use count from the agent_tools record
	records, _ := memSys.GetAgentTools(ctx, params.PeerID)
	useCount := 0
	for _, rec := range records {
		if rec.ToolServer == params.ToolServer && rec.ToolName == params.ToolName {
			useCount = rec.UseCount
			break
		}
	}

	return successResponse(req.ID, map[string]interface{}{
		"useCount":     useCount,
		"bypassBroker": bypass,
	})
}

func handleAgentGetTools(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params agentGetToolsParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: peerId is required")
	}

	records, err := memSys.GetAgentTools(ctx, params.PeerID)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, records)
}

func handleAgentGetInitialToolSet(ctx context.Context, req jsonrpcRequest, memSys *memory.MemorySystem) jsonrpcResponse {
	var params agentGetInitialToolSetParams
	if err := parseParams(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	if params.PeerID == "" {
		return errorResponse(req.ID, -32602, "Invalid params: peerId is required")
	}

	tools, err := memSys.GetInitialToolSet(ctx, params.PeerID)
	if err != nil {
		return errorResponse(req.ID, -32603, "Internal error: "+err.Error())
	}

	return successResponse(req.ID, map[string]interface{}{
		"peerId": params.PeerID,
		"tools":  tools,
	})
}

// ─── Tool Exposer Adapter ───────────────────────────────────────────────────

// memorySystemExposer adapts a MemorySystem to implement broker.ToolExposer.
// It bridges the broker's lazy tool exposure tracking with the postgres-backed
// agent_tools table.
type memorySystemExposer struct {
	memSys *memory.MemorySystem
}

// RecordToolRequest records that a peer has requested access to a tool.
func (e *memorySystemExposer) RecordToolRequest(peerID, toolServer, toolName string) error {
	return e.memSys.RecordToolRequest(context.Background(), peerID, toolServer, toolName)
}

// IncrementToolUse increments the use count and returns whether bypass is reached.
func (e *memorySystemExposer) IncrementToolUse(peerID, toolServer, toolName string) (bool, error) {
	return e.memSys.IncrementToolUse(context.Background(), peerID, toolServer, toolName)
}

// GetAgentTools returns all tool records for a peer, converted to broker format.
func (e *memorySystemExposer) GetAgentTools(peerID string) ([]broker.ToolExposure, error) {
	records, err := e.memSys.GetAgentTools(context.Background(), peerID)
	if err != nil {
		return nil, err
	}

	result := make([]broker.ToolExposure, len(records))
	for i, rec := range records {
		result[i] = broker.ToolExposure{
			ToolServer:   rec.ToolServer,
			ToolName:     rec.ToolName,
			UseCount:     rec.UseCount,
			BypassBroker: rec.BypassBroker,
		}
	}
	return result, nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func parseParams(raw json.RawMessage, target interface{}) error {
	if raw == nil {
		return fmt.Errorf("params required")
	}
	return json.Unmarshal(raw, target)
}

func writeResponseTo(w io.Writer, resp jsonrpcResponse) {
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("error marshaling response: %v", err)
		return
	}
	data = append(data, '\n')
	if _, err := w.Write(data); err != nil {
		log.Printf("error writing response: %v", err)
	}
}

func writeResponse(resp jsonrpcResponse) {
	writeResponseTo(os.Stdout, resp)
}

func successResponse(id json.RawMessage, result interface{}) jsonrpcResponse {
	return jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
}

func errorResponse(id json.RawMessage, code int, message string) jsonrpcResponse {
	return jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &jsonrpcError{Code: code, Message: message},
	}
}

// jsonrpcNotification is a JSON-RPC 2.0 notification (no id field). The
// client uses the absence of an id to know this is a server-pushed event
// (not a response to a request) and ignores it for correlation purposes.
type jsonrpcNotification struct {
	JSONRPC string                 `json:"jsonrpc"`
	Method  string                 `json:"method"`
	Params  map[string]interface{} `json:"params,omitempty"`
}

// emitReadyNotificationTo writes a {"method":"ready"} notification to w.
// This is the signal the GoBackendClient waits for to consider the backend
// initialized and ready to accept JSON-RPC requests.
func emitReadyNotificationTo(w io.Writer) {
	notif := jsonrpcNotification{
		JSONRPC: "2.0",
		Method:  "ready",
		Params: map[string]interface{}{
			"server": "neuralgentics-backend",
			"time":   time.Now().UTC().Format(time.RFC3339Nano),
		},
	}
	data, err := json.Marshal(notif)
	if err != nil {
		log.Printf("error marshaling ready notification: %v", err)
		return
	}
	data = append(data, '\n')
	if _, err := w.Write(data); err != nil {
		log.Printf("error writing ready notification: %v", err)
	}
}

func emitReadyNotification() {
	emitReadyNotificationTo(os.Stdout)
}
