package core

import (
	"context"
	"errors"
	"log"
	"os"
	"time"
)

// ErrMissingDatabaseURL is returned when the required database URL is not configured.
// The Go backend reads NEURALGENTICS_DB_URL first (what the TUI sets) and falls
// back to MEMINI_DB_URL (legacy from the memini rename) for backward compat.
var ErrMissingDatabaseURL = errors.New("NEURALGENTICS_DB_URL (or legacy MEMINI_DB_URL) environment variable is required")

// EmbeddingMode defines which embedding pipeline to use for memory operations.
// Mirrors Python memoryManager v0.7.0 EMBEDDING_MODE.
type EmbeddingMode string

const (
	EmbeddingModeCPU  EmbeddingMode = "cpu"  // 384-dim MiniLM only
	EmbeddingModeAuto EmbeddingMode = "auto" // both 384 + 1024, RRF fused
	EmbeddingModeGPU  EmbeddingMode = "gpu"  // 1024-dim BGE-Large only
)

// Config holds all configuration for the Go memory module.
// It maps 1:1 to the Python memoryManager environment variables.
type Config struct {
	// Core
	DatabaseURL   string `envconfig:"NEURALGENTICS_DB_URL" required:"true"`
	ProjectID     string `envconfig:"MEMINI_PROJECT_ID" default:"neuralgentics-default"`
	EmbeddingAddr string `envconfig:"MEMINI_EMBEDDING_ADDR" default:"unix:///tmp/neuralgentics-embed.sock"`

	// Dual-model RRF
	EmbeddingMode EmbeddingMode `envconfig:"EMBEDDING_MODE" default:"auto"`
	RRFK          int           `envconfig:"RRF_K" default:"60"`

	// LLM (for tiered loading, KG, dialectic)
	LLMBaseURL string `envconfig:"NEURAL_LLM_BASE_URL" default:"http://localhost:8903/v1"`
	LLMAPIKey  string `envconfig:"NEURAL_LLM_API_KEY"`
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

	// Sidecar (experimental — not yet wired into the backend)
	SidecarAutoStart bool   `envconfig:"SIDECAR_AUTO_START" default:"false"` // when true, Go backend attempts to spawn sidecar via sidecar.sh
	SidecarEnvFile   string `envconfig:"SIDECAR_ENV_FILE" default:""`        // optional path to env file (used by sidecar.sh)

	// Operational
	SchemaVersion string `envconfig:"MEMINI_SCHEMA_VERSION" default:"1"`
	LogLevel      string `envconfig:"MEMINI_LOG_LEVEL" default:"info"`
}

// ErrInvalidEmbeddingMode is returned when EmbeddingMode is not cpu/auto/gpu.
var ErrInvalidEmbeddingMode = errors.New("EMBEDDING_MODE must be one of: cpu, auto, gpu")

// Validate checks the configuration for critical errors and clamps ranges.
func (c *Config) Validate() error {
	if c.DatabaseURL == "" {
		return ErrMissingDatabaseURL
	}

	// Default and validate embedding mode
	if c.EmbeddingMode == "" {
		c.EmbeddingMode = EmbeddingModeAuto
	}

	switch c.EmbeddingMode {
	case EmbeddingModeCPU, EmbeddingModeAuto, EmbeddingModeGPU:
		// valid
	default:
		return ErrInvalidEmbeddingMode
	}

	// Clamp RRF_K to [1, 1000]
	if c.RRFK < 1 {
		c.RRFK = 1
	}
	if c.RRFK > 1000 {
		c.RRFK = 1000
	}
	if c.RRFK == 0 {
		c.RRFK = 60 // default when env var is unset
	}

	// SidecarAutoStart is experimental — warn if enabled
	if c.SidecarAutoStart {
		log.Printf("WARNING: SidecarAutoStart=true is experimental and not yet wired into the backend (will be enabled in v0.9.0)")
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

// ResolveDatabaseURL returns the database URL from the environment.
// It checks NEURALGENTICS_DB_URL first (what the TUI sets), then falls
// back to MEMINI_DB_URL (legacy from the memini rename) for backward
// compatibility. Returns empty string if neither is set.
func ResolveDatabaseURL() string {
	if url := os.Getenv("NEURALGENTICS_DB_URL"); url != "" {
		return url
	}
	return os.Getenv("MEMINI_DB_URL")
}

// LoadConfigFromEnv builds a Config from environment variables.
// Database URL resolution uses ResolveDatabaseURL (NEURALGENTICS_DB_URL
// takes precedence over legacy MEMINI_DB_URL). The returned Config
// still needs Validate() called if you want range checks.
func LoadConfigFromEnv() *Config {
	return &Config{
		DatabaseURL:      ResolveDatabaseURL(),
		ProjectID:        envOr("MEMINI_PROJECT_ID", "neuralgentics-default"),
		EmbeddingAddr:    envOr("MEMINI_EMBEDDING_ADDR", "unix:///tmp/neuralgentics-embed.sock"),
		EmbeddingMode:    EmbeddingMode(envOr("EMBEDDING_MODE", "auto")),
		RRFK:             envIntOr("RRF_K", 60),
		LLMBaseURL:       envOr("NEURAL_LLM_BASE_URL", "http://localhost:8903/v1"),
		LLMAPIKey:        os.Getenv("NEURAL_LLM_API_KEY"),
		LLMModel:         envOr("NEURAL_LLM_MODEL", "qwen3-0.6b"),
		SidecarAutoStart: envBoolOr("SIDECAR_AUTO_START", false),
		SidecarEnvFile:   envOr("SIDECAR_ENV_FILE", ""),
		LogLevel:         envOr("MEMINI_LOG_LEVEL", "info"),
		SchemaVersion:    envOr("MEMINI_SCHEMA_VERSION", "1"),
	}
}

// envOr returns the env var value or the fallback.
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envIntOr returns the env var value parsed as int, or the fallback.
func envIntOr(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return fallback
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// envBoolOr returns the env var value parsed as bool, or the fallback.
// Accepts "true", "1", "yes" (case-insensitive) as true; everything else is false.
func envBoolOr(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	switch v {
	case "true", "1", "yes", "TRUE", "True", "YES", "Yes":
		return true
	default:
		return false
	}
}
