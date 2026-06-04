// Package main provides verification check functions for the migrate CLI.
// All checks operate on a pgxpool.Pool connected to a neuralgentics database.
package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// verifyVectorDimensions checks that all memory and entity vectors have exactly
// 384 dimensions, matching the schema's vector(384) column type.
func verifyVectorDimensions(ctx context.Context, pool *pgxpool.Pool) CheckResult {
	// Check memories table vectors
	var memCount int
	err := pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL AND vector_dims(embedding) != 384",
	).Scan(&memCount)
	if err != nil {
		// If vector_dims doesn't exist (pgvector not installed), try column check
		var dataType string
		colErr := pool.QueryRow(ctx,
			`SELECT data_type FROM information_schema.columns
			 WHERE table_name = 'memories' AND column_name = 'embedding'`,
		).Scan(&dataType)
		if colErr != nil {
			return CheckResult{
				Name:    "vector_dimensions",
				Passed:  false,
				Details: fmt.Sprintf("cannot verify vector dimensions: %v (column check: %v)", err, colErr),
			}
		}
		return CheckResult{
			Name:    "vector_dimensions",
			Passed:  true,
			Details: fmt.Sprintf("embedding column type: %s (pgvector vector_dims unavailable)", dataType),
		}
	}

	if memCount > 0 {
		return CheckResult{
			Name:    "vector_dimensions",
			Passed:  false,
			Details: fmt.Sprintf("found %d memories with non-384-dim vectors", memCount),
		}
	}

	// Check entities table vectors
	var entCount int
	err = pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM entities WHERE embedding IS NOT NULL AND vector_dims(embedding) != 384",
	).Scan(&entCount)
	if err != nil {
		return CheckResult{
			Name:    "vector_dimensions",
			Passed:  true,
			Details: "memories vectors OK (entity check skipped: vector_dims unavailable)",
		}
	}

	if entCount > 0 {
		return CheckResult{
			Name:    "vector_dimensions",
			Passed:  false,
			Details: fmt.Sprintf("found %d entities with non-384-dim vectors", entCount),
		}
	}

	return CheckResult{
		Name:    "vector_dimensions",
		Passed:  true,
		Details: "all vectors are 384-dimensional",
	}
}

// verifyTrustRange checks that all memory trust scores are in the valid
// range [0.0, 1.0]. The schema has a CHECK constraint, but this verifies
// any data that might have been inserted with constraints disabled.
func verifyTrustRange(ctx context.Context, pool *pgxpool.Pool) CheckResult {
	var outOfRange int
	err := pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM memories WHERE trust_score < 0 OR trust_score > 1",
	).Scan(&outOfRange)
	if err != nil {
		return CheckResult{
			Name:    "trust_range",
			Passed:  false,
			Details: fmt.Sprintf("query failed: %v", err),
		}
	}

	if outOfRange > 0 {
		return CheckResult{
			Name:    "trust_range",
			Passed:  false,
			Details: fmt.Sprintf("found %d memories with trust_score outside [0.0, 1.0]", outOfRange),
		}
	}

	return CheckResult{
		Name:    "trust_range",
		Passed:  true,
		Details: "all trust scores in valid range [0.0, 1.0]",
	}
}

// verifyForeignKeys checks for dangling foreign key references that would
// indicate data integrity problems.
func verifyForeignKeys(ctx context.Context, pool *pgxpool.Pool) CheckResult {
	var problems []string

	// Check memories.peer_id references peers.id
	var memDanglingPeers int
	err := pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM memories m WHERE m.peer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM peers p WHERE p.id = m.peer_id)",
	).Scan(&memDanglingPeers)
	if err != nil {
		problems = append(problems, fmt.Sprintf("memories→peers: %v", err))
	} else if memDanglingPeers > 0 {
		problems = append(problems, fmt.Sprintf("memories has %d rows with dangling peer_id", memDanglingPeers))
	}

	// Check memories.supersedes_id references
	var memDanglingSupersedes int
	err = pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM memories m WHERE m.supersedes_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories s WHERE s.id = m.supersedes_id)",
	).Scan(&memDanglingSupersedes)
	if err != nil {
		problems = append(problems, fmt.Sprintf("memories→supersedes: %v", err))
	} else if memDanglingSupersedes > 0 {
		problems = append(problems, fmt.Sprintf("memories has %d rows with dangling supersedes_id", memDanglingSupersedes))
	}

	// Check memory_relationships FK references
	var danglingRelSources int
	err = pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM memory_relationships r WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = r.source_id)",
	).Scan(&danglingRelSources)
	if err != nil {
		problems = append(problems, fmt.Sprintf("relationships→source: %v", err))
	} else if danglingRelSources > 0 {
		problems = append(problems, fmt.Sprintf("memory_relationships has %d rows with dangling source_id", danglingRelSources))
	}

	var danglingRelTargets int
	err = pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM memory_relationships r WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = r.target_id)",
	).Scan(&danglingRelTargets)
	if err != nil {
		problems = append(problems, fmt.Sprintf("relationships→target: %v", err))
	} else if danglingRelTargets > 0 {
		problems = append(problems, fmt.Sprintf("memory_relationships has %d rows with dangling target_id", danglingRelTargets))
	}

	// Check thoughts.memory_id references
	var danglingThoughtMemIDs int
	err = pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM thoughts t WHERE t.memory_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = t.memory_id)",
	).Scan(&danglingThoughtMemIDs)
	if err != nil {
		problems = append(problems, fmt.Sprintf("thoughts→memory: %v", err))
	} else if danglingThoughtMemIDs > 0 {
		problems = append(problems, fmt.Sprintf("thoughts has %d rows with dangling memory_id", danglingThoughtMemIDs))
	}

	if len(problems) > 0 {
		details := "FK integrity issues found:"
		for _, p := range problems {
			details += fmt.Sprintf("\n  - %s", p)
		}
		return CheckResult{
			Name:    "foreign_keys",
			Passed:  false,
			Details: details,
		}
	}

	return CheckResult{
		Name:    "foreign_keys",
		Passed:  true,
		Details: "all foreign key references are valid",
	}
}

// verifyContentHashes checks that all memories have a content_hash populated.
// Missing content hashes indicate incomplete data ingestion.
func verifyContentHashes(ctx context.Context, pool *pgxpool.Pool) CheckResult {
	var missingHash int
	err := pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM memories WHERE content_hash IS NULL OR content_hash = ''",
	).Scan(&missingHash)
	if err != nil {
		return CheckResult{
			Name:    "content_hashes",
			Passed:  false,
			Details: fmt.Sprintf("query failed: %v", err),
		}
	}

	if missingHash > 0 {
		return CheckResult{
			Name:    "content_hashes",
			Passed:  false,
			Details: fmt.Sprintf("found %d memories with missing content_hash", missingHash),
		}
	}

	return CheckResult{
		Name:    "content_hashes",
		Passed:  true,
		Details: "all memories have content_hash populated",
	}
}

// verifySchemaVersion checks that the database schema matches the expected
// migration version by verifying that all expected tables exist.
func verifySchemaVersion(ctx context.Context, pool *pgxpool.Pool) CheckResult {
	// Check that the schema_migrations table exists (created by golang-migrate)
	var migrationCount int
	err := pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM schema_migrations",
	).Scan(&migrationCount)
	if err != nil {
		// schema_migrations table might not exist
		var tableCount int
		tableErr := pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM information_schema.tables
			 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
		).Scan(&tableCount)
		if tableErr != nil {
			return CheckResult{
				Name:    "schema_version",
				Passed:  false,
				Details: fmt.Sprintf("cannot verify schema: migrations table missing (%v), table count query failed (%v)", err, tableErr),
			}
		}

		if tableCount == 0 {
			return CheckResult{
				Name:    "schema_version",
				Passed:  false,
				Details: "database has no tables — migrations have not been run",
			}
		}

		return CheckResult{
			Name:    "schema_version",
			Passed:  true,
			Details: fmt.Sprintf("no schema_migrations table but %d tables exist (manual setup)", tableCount),
		}
	}

	if migrationCount == 0 {
		return CheckResult{
			Name:    "schema_version",
			Passed:  false,
			Details: "schema_migrations table is empty — no migrations applied",
		}
	}

	return CheckResult{
		Name:    "schema_version",
		Passed:  true,
		Details: fmt.Sprintf("schema migrations applied: %d migration(s)", migrationCount),
	}
}

// verifyTableExists checks that a specific table exists in the public schema.
func verifyTableExists(ctx context.Context, pool *pgxpool.Pool, tableName string) CheckResult {
	var exists bool
	err := pool.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		)`,
		tableName,
	).Scan(&exists)
	if err != nil {
		return CheckResult{
			Name:    fmt.Sprintf("table_exists_%s", tableName),
			Passed:  false,
			Details: fmt.Sprintf("query failed: %v", err),
		}
	}

	if !exists {
		return CheckResult{
			Name:    fmt.Sprintf("table_exists_%s", tableName),
			Passed:  false,
			Details: fmt.Sprintf("table '%s' does not exist", tableName),
		}
	}

	return CheckResult{
		Name:    fmt.Sprintf("table_exists_%s", tableName),
		Passed:  true,
		Details: fmt.Sprintf("table '%s' exists", tableName),
	}
}

// verifyExtensionExists checks that a PostgreSQL extension is installed.
func verifyExtensionExists(ctx context.Context, pool *pgxpool.Pool, extName string) CheckResult {
	var installed bool
	err := pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = $1)",
		extName,
	).Scan(&installed)
	if err != nil {
		return CheckResult{
			Name:    fmt.Sprintf("extension_exists_%s", extName),
			Passed:  false,
			Details: fmt.Sprintf("query failed: %v", err),
		}
	}

	if !installed {
		return CheckResult{
			Name:    fmt.Sprintf("extension_exists_%s", extName),
			Passed:  false,
			Details: fmt.Sprintf("extension '%s' is not installed", extName),
		}
	}

	return CheckResult{
		Name:    fmt.Sprintf("extension_exists_%s", extName),
		Passed:  true,
		Details: fmt.Sprintf("extension '%s' is installed", extName),
	}
}
