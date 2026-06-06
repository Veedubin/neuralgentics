// Package store — peers.go: peer and memory-sharing operations.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Peer Operations ───────────────────────────────────────────────────────

// AddPeer adds a peer profile.
func (s *PostgresStore) AddPeer(ctx context.Context, peer *core.PeerProfile) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	peerID := peer.ID
	if peerID == "" {
		peerID = uuid.New().String()
	}
	err := s.pool.QueryRow(ctx, AddPeer, peerID, peer.Name, peer.Role, peer.TrustLevel, "{}").Scan(&peerID)
	if err != nil {
		return "", fmt.Errorf("add peer: %w", err)
	}
	return peerID, nil
}

// GetPeer retrieves a peer by ID.
func (s *PostgresStore) GetPeer(ctx context.Context, id string) (*core.PeerProfile, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	var p core.PeerProfile
	err := s.pool.QueryRow(ctx, GetPeer, id).Scan(&p.ID, &p.Name, &p.Role, &p.TrustLevel, nil, &p.IsActive, &p.CreatedAt, &p.LastActiveAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// ListPeers returns a list of peers.
func (s *PostgresStore) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, ListPeersQuery, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []*core.PeerProfile
	for rows.Next() {
		var p core.PeerProfile
		if err := rows.Scan(&p.ID, &p.Name, &p.Role, &p.TrustLevel, nil, &p.IsActive, &p.CreatedAt, &p.LastActiveAt); err != nil {
			slog.Warn("scan peer row", "err", err)
			continue
		}
		results = append(results, &p)
	}
	return results, nil
}

// UpdatePeerLastActive updates the last_active_at timestamp for a peer.
func (s *PostgresStore) UpdatePeerLastActive(ctx context.Context, id string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, "UPDATE peers SET last_active_at = NOW() WHERE id = $1", id)
	return err
}

// ─── Memory Sharing Operations ───────────────────────────────────────────────

// ShareMemory shares a memory with a peer.
func (s *PostgresStore) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	shareID := uuid.New().String()
	err := s.pool.QueryRow(ctx, ShareMemoryQuery, shareID, memoryID, peerID, permission).Scan(&shareID)
	if err != nil {
		return "", fmt.Errorf("share memory: %w", err)
	}
	return shareID, nil
}

// RevokeShareMemory revokes a memory share.
func (s *PostgresStore) RevokeShareMemory(ctx context.Context, memoryID, peerID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, RevokeShareMemory, memoryID, peerID)
	return err
}

// GetSharedMemories returns memories shared with a peer.
func (s *PostgresStore) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if limit <= 0 {
		limit = 100
	}

	rows, err := s.pool.Query(ctx, GetSharedMemories, peerID, limit)
	if err != nil {
		return nil, fmt.Errorf("get shared memories: %w", err)
	}
	defer rows.Close()

	var results []*core.MemoryEntry
	for rows.Next() {
		var entry core.MemoryEntry
		var metadataBytes []byte
		var permission string
		var sharedAt time.Time

		err := rows.Scan(
			&entry.ID,
			&entry.Content,
			&entry.SourceType,
			&metadataBytes,
			&permission,
			&sharedAt,
		)
		if err != nil {
			slog.Warn("scan shared memory row", "err", err)
			continue
		}

		// Parse metadata JSONB
		if metadataBytes != nil {
			var m map[string]any
			if json.Unmarshal(metadataBytes, &m) == nil {
				entry.Metadata = m
			}
		}

		results = append(results, &entry)
	}

	return results, nil
}

// GetPeerMemories returns memories belonging to a peer that match a query.
func (s *PostgresStore) GetPeerMemories(ctx context.Context, peerID, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Build query to fetch memories belonging to the peer
	limit := 100
	if opts != nil && opts.TopK > 0 {
		limit = opts.TopK
	}

	var rows pgx.Rows
	var err error

	if query != "" {
		// Use text search + peer filter
		rows, err = s.pool.Query(ctx,
			`SELECT id, text, embedding, source_type, content_hash, metadata,
			        trust_score, retrieval_count, is_archived, last_accessed_at,
			        source_path, supersedes_id, structured_fields, change_ratio, created_at_ms,
			        created_at, updated_at
			 FROM memories
			 WHERE peer_id = $1
			   AND is_archived = FALSE
			   AND to_tsvector('english', text) @@ websearch_to_tsquery('english', $2)
			 ORDER BY created_at DESC
			 LIMIT $3`, peerID, query, limit)
	} else {
		// No query, just list by peer
		rows, err = s.pool.Query(ctx,
			`SELECT id, text, embedding, source_type, content_hash, metadata,
			        trust_score, retrieval_count, is_archived, last_accessed_at,
			        source_path, supersedes_id, structured_fields, change_ratio, created_at_ms,
			        created_at, updated_at
			 FROM memories
			 WHERE peer_id = $1
			   AND is_archived = FALSE
			 ORDER BY created_at DESC
			 LIMIT $2`, peerID, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("get peer memories: %w", err)
	}
	defer rows.Close()

	var results []*core.MemoryEntry
	for rows.Next() {
		entry, scanErr := scanMemoryEntry(rows)
		if scanErr != nil {
			continue
		}
		results = append(results, entry)
	}

	return results, nil
}
