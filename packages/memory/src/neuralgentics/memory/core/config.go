package core

import (
	"context"
	"errors"
	"time"
)

// ErrMissingDatabaseURL is returned when the required database URL is not configured.
var ErrMissingDatabaseURL = errors.New("MEMINI_DB_URL environment variable is required")

// Config holds all configuration for the Go memory module.
// It maps 1:1 to the Python memini-ai-dev environment variables.
type Config struct {
	// Core
	DatabaseURL   string `envconfig:"MEMINI_DB_URL" required:"true"`
	ProjectID     string `envconfig:"MEMINI_PROJECT_ID" default:"neuralgentics-default"`
	EmbeddingAddr string `envconfig:"MEMINI_EMBEDDING_ADDR" default:"unix:///tmp/neuralgentics-embed.sock"`

	// LLM (for tiered loading, KG, dialectic)
	LLMBaseURL string `envconfig:"NEURAL_LLM_BASE_URL" default:"http://localhost:8903/v1"`
	LLMModel   string `envconfig:"NEURAL_LLM_MODEL" default:"qwen3-0.6b"`

	// Feature gates (all default false — same as Python)
	TrustEngine    bool `envconfig:"MEMINI_TRUST_ENGINE"`
	MemoryGraph    bool `envconfig:"MEMINI_MEMORY_GRAPH"`
	AutoExtract    bool `envconfig:"MEMINI_AUTO_EXTRACT"`
	TieredLoading  bool `envconfig:"MEMINI_TIERED_LOADING"`
	KGEnabled      bool `envconfig:"MEMINI_KG_ENABLED"`
	MultiPeer      bool `envconfig:"MEMINI_MULTI_PEER_ENABLED"`
	Dialectic      bool `envconfig:"MEMINI_DIALECTIC_ENABLED"`
	ThoughtChains  bool `envconfig:"THOUGHT_CHAINS"`
	DecayEnabled   bool `envconfig:"MEMINI_DECAY_ENABLED"`
	IndexerEnabled bool `envconfig:"MEMINI_INDEXER_ENABLED"`
	AuditEnabled   bool `envconfig:"MEMINI_AUDIT_ENABLED"`

	// Operational
	SchemaVersion string `envconfig:"MEMINI_SCHEMA_VERSION" default:"1"`
	LogLevel      string `envconfig:"MEMINI_LOG_LEVEL" default:"info"`
}

// Validate checks the configuration for critical errors.
func (c *Config) Validate() error {
	if c.DatabaseURL == "" {
		return ErrMissingDatabaseURL
	}
	return nil
}

// ContextSuite is a convenience struct for passing context through subsystems.
type ContextSuite struct {
	Ctx       context.Context
	Config    *Config
	Cancel    context.CancelFunc
	StartTime time.Time
}

// SuiteWithTimeout returns a ContextSuite with the given timeout.
func SuiteWithTimeout(ctx context.Context, cfg *Config, timeout time.Duration) *ContextSuite {
	child, cancel := context.WithTimeout(ctx, timeout)
	return &ContextSuite{
		Ctx:       child,
		Config:    cfg,
		Cancel:    cancel,
		StartTime: time.Now(),
	}
}
