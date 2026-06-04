// Package main provides database statistics collection for the migrate CLI report.
package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// dbStats represents key statistics from the neuralgentics database.
type dbStats struct {
	MemoryCount       int       `json:"memoryCount"`
	EntityCount       int       `json:"entityCount"`
	PeerCount         int       `json:"peerCount"`
	ChainCount        int       `json:"chainCount"`
	AvgTrustScore     float64   `json:"avgTrustScore"`
	ArchivedCount     int       `json:"archivedCount"`
	RelationshipCount int       `json:"relationshipCount"`
	Timestamp         time.Time `json:"timestamp"`
}

// collectStats gathers key statistics from the database for reporting.
func collectStats(ctx context.Context, pool *pgxpool.Pool) (*dbStats, error) {
	stats := &dbStats{Timestamp: time.Now().UTC()}

	// Memory count (active only)
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM memories WHERE NOT is_archived").Scan(&stats.MemoryCount); err != nil {
		stats.MemoryCount = 0
	}

	// Entity count
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM entities").Scan(&stats.EntityCount); err != nil {
		stats.EntityCount = 0
	}

	// Peer count
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM peers").Scan(&stats.PeerCount); err != nil {
		stats.PeerCount = 0
	}

	// Thought chain count
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM thought_chains").Scan(&stats.ChainCount); err != nil {
		stats.ChainCount = 0
	}

	// Average trust score
	if err := pool.QueryRow(ctx, "SELECT COALESCE(AVG(trust_score), 0) FROM memories WHERE NOT is_archived").Scan(&stats.AvgTrustScore); err != nil {
		stats.AvgTrustScore = 0
	}

	// Archived count
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM memories WHERE is_archived").Scan(&stats.ArchivedCount); err != nil {
		stats.ArchivedCount = 0
	}

	// Relationship count
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM memory_relationships").Scan(&stats.RelationshipCount); err != nil {
		stats.RelationshipCount = 0
	}

	return stats, nil
}
