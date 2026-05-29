package store

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"neuralgentics/src/neuralgentics/memory/core"
)

//go:embed migrations/postgres/*.sql
var migrationsFS embed.FS

// PostgresStore implements core.Store using pgx/v5 + pgxpool.
type PostgresStore struct {
	pool           *pgxpool.Pool
	config         *core.Config
	initialized    bool
	useVectorscale bool
}

// NewPostgresStore creates a new PostgresStore. Call Initialize() before use.
func NewPostgresStore(cfg *core.Config) *PostgresStore {
	return &PostgresStore{
		config: cfg,
	}
}

// Pool returns the underlying pgxpool.Pool for advanced usage.
func (s *PostgresStore) Pool() *pgxpool.Pool {
	return s.pool
}

// Initialize creates the connection pool, runs migrations, and detects vectorscale.
func (s *PostgresStore) Initialize(ctx context.Context) error {
	if s.initialized {
		return nil
	}

	poolConfig, err := pgxpool.ParseConfig(s.config.DatabaseURL)
	if err != nil {
		return fmt.Errorf("parse database URL: %w", err)
	}
	poolConfig.MinConns = 1
	poolConfig.MaxConns = 10
	poolConfig.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return fmt.Errorf("create connection pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return fmt.Errorf("ping database: %w", err)
	}

	s.pool = pool

	if err := s.runMigrations(); err != nil {
		slog.Warn("migration warning", "error", err)
	}

	s.useVectorscale = s.detectVectorscale(ctx)

	slog.Info("postgres store initialized",
		"vectorscale", s.useVectorscale,
		"index_type", s.indexType(),
	)

	s.initialized = true
	return nil
}

// Close closes the connection pool.
func (s *PostgresStore) Close(ctx context.Context) error {
	if s.pool != nil {
		s.pool.Close()
		s.pool = nil
	}
	s.initialized = false
	return nil
}

// Ping checks database connectivity.
func (s *PostgresStore) Ping(ctx context.Context) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	return s.pool.Ping(ctx)
}

// Stats returns database status information.
func (s *PostgresStore) Stats(ctx context.Context) (*core.StatusResult, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	var memoryCount, entityCount, peerCount, chainCount int

	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*) FROM memories WHERE is_archived = FALSE").Scan(&memoryCount); err != nil {
		memoryCount = 0
	}
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*) FROM entities").Scan(&entityCount); err != nil {
		entityCount = 0
	}
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*) FROM peers").Scan(&peerCount); err != nil {
		peerCount = 0
	}
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*) FROM thought_chains").Scan(&chainCount); err != nil {
		chainCount = 0
	}

	return &core.StatusResult{
		MemoryCount: memoryCount,
		EntityCount: entityCount,
		PeerCount:   peerCount,
		ChainCount:  chainCount,
		Dimension:   384,
		Initialized: s.initialized,
		Ready:       s.initialized && s.pool != nil,
		VectorStyle: s.indexType(),
	}, nil
}

// UseVectorscale reports whether the vectorscale extension is available.
func (s *PostgresStore) UseVectorscale() bool {
	return s.useVectorscale
}

func (s *PostgresStore) indexType() string {
	if s.useVectorscale {
		return "pgvectorScale"
	}
	return "pgvector"
}

func (s *PostgresStore) detectVectorscale(ctx context.Context) bool {
	if s.pool == nil {
		return false
	}
	var exists int
	err := s.pool.QueryRow(ctx, CheckVectorscale).Scan(&exists)
	return err == nil && exists == 1
}

func (s *PostgresStore) runMigrations() error {
	source, err := iofs.New(migrationsFS, "migrations/postgres")
	if err != nil {
		return fmt.Errorf("create migration source: %w", err)
	}

	m, err := migrate.NewWithSourceInstance("iofs", source, s.config.DatabaseURL)
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}
	defer m.Close()

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("run migrations: %w", err)
	}

	return nil
}

// ─── Row Scanning Helpers ────────────────────────────────────────────────────

// scanMemoryEntry scans a full memory row into a core.MemoryEntry.
// Column order must match the SELECT query.
func scanMemoryEntry(row pgx.Row) (*core.MemoryEntry, error) {
	var entry core.MemoryEntry
	var embeddingStr *string
	var metadataBytes []byte
	var structuredFieldsBytes []byte
	var supersedesID *string
	var peerID *string
	var lastAccessedAt *time.Time
	var distance *float64

	err := row.Scan(
		&entry.ID,
		&entry.Content,
		&embeddingStr,
		&entry.SourceType,
		&entry.ContentHash,
		&metadataBytes,
		&entry.TrustScore,
		&entry.RetrievalCount,
		&entry.IsArchived,
		&lastAccessedAt,
		&entry.SourcePath,
		&supersedesID,
		&structuredFieldsBytes,
		&entry.ChangeRatio,
		&entry.CreatedAtMs,
		&entry.CreatedAt,
		&entry.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	entry.LastAccessedAt = lastAccessedAt
	if supersedesID != nil {
		entry.SupersedesID = *supersedesID
	}
	if peerID != nil {
		entry.PeerID = *peerID
	}

	// Parse embedding string '[0.1,0.2,...]' → []float64
	if embeddingStr != nil {
		vec, parseErr := parseVectorString(*embeddingStr)
		if parseErr != nil {
			return nil, fmt.Errorf("parse embedding: %w", parseErr)
		}
		entry.Vector = vec
	}

	// Parse metadata JSONB
	if metadataBytes != nil {
		var m map[string]any
		if json.Unmarshal(metadataBytes, &m) == nil {
			entry.Metadata = m
		}
	}

	// Parse structured_fields JSONB
	if structuredFieldsBytes != nil {
		var sf map[string]any
		if json.Unmarshal(structuredFieldsBytes, &sf) == nil {
			entry.StructuredFields = sf
		}
	}

	// Distance is optional (only present in search queries)
	_ = distance

	return &entry, nil
}

// scanMemoryEntryWithDistance scans a memory row that includes a distance column.
func scanMemoryEntryWithDistance(row pgx.Row) (*core.MemoryEntry, error) {
	var entry core.MemoryEntry
	var embeddingStr *string
	var metadataBytes []byte
	var structuredFieldsBytes []byte
	var supersedesID *string
	var lastAccessedAt *time.Time
	var distance float64

	err := row.Scan(
		&entry.ID,
		&entry.Content,
		&entry.SourceType,
		&entry.TrustScore,
		&entry.RetrievalCount,
		&entry.IsArchived,
		&metadataBytes,
		&embeddingStr,
		&supersedesID,
		&structuredFieldsBytes,
		&entry.ChangeRatio,
		&entry.CreatedAtMs,
		&entry.CreatedAt,
		&entry.UpdatedAt,
		&entry.ContentHash,
		&entry.SourcePath,
		&distance,
	)
	if err != nil {
		return nil, err
	}

	entry.LastAccessedAt = lastAccessedAt
	if supersedesID != nil {
		entry.SupersedesID = *supersedesID
	}

	if embeddingStr != nil {
		vec, parseErr := parseVectorString(*embeddingStr)
		if parseErr != nil {
			return nil, fmt.Errorf("parse embedding: %w", parseErr)
		}
		entry.Vector = vec
	}

	if metadataBytes != nil {
		var m map[string]any
		if json.Unmarshal(metadataBytes, &m) == nil {
			entry.Metadata = m
		}
	}

	if structuredFieldsBytes != nil {
		var sf map[string]any
		if json.Unmarshal(structuredFieldsBytes, &sf) == nil {
			entry.StructuredFields = sf
		}
	}

	score := 1.0 - distance
	entry.Score = &score

	return &entry, nil
}

// parseVectorString parses pgvector text format '[0.1,0.2,...]' to []float64.
func parseVectorString(s string) ([]float64, error) {
	if len(s) == 0 {
		return nil, nil
	}
	// Strip brackets
	if s[0] == '[' {
		s = s[1:]
	}
	if len(s) > 0 && s[len(s)-1] == ']' {
		s = s[:len(s)-1]
	}
	if len(s) == 0 {
		return []float64{}, nil
	}

	// Split by comma
	var result []float64
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			part := s[start:i]
			if len(part) == 0 {
				start = i + 1
				continue
			}
			var f float64
			if _, err := fmt.Sscanf(part, "%g", &f); err != nil {
				return nil, fmt.Errorf("parse vector element %q: %w", part, err)
			}
			result = append(result, f)
			start = i + 1
		}
	}
	return result, nil
}

// mapToJSON converts a map to JSON bytes for PostgreSQL JSONB binding.
func mapToJSON(m map[string]any) []byte {
	if m == nil {
		return []byte("{}")
	}
	data, err := json.Marshal(m)
	if err != nil {
		return []byte("{}")
	}
	return data
}
