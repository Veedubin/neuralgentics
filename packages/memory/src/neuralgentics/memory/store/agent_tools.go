package store

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── SQL Constants for Agent Tools ──────────────────────────────────────────

const (
	InsertAgentTool = `
		INSERT INTO agent_tools (peer_id, tool_server, tool_name)
		VALUES ($1, $2, $3)
		ON CONFLICT (peer_id, tool_server, tool_name) DO NOTHING`

	IncrementAgentToolUse = `
		UPDATE agent_tools
		SET use_count = use_count + 1,
		    last_used_at = NOW(),
		    bypass_broker = (use_count + 1 >= 5)
		WHERE peer_id = $1 AND tool_server = $2 AND tool_name = $3
		RETURNING use_count, bypass_broker`

	GetAgentToolsByPeer = `
		SELECT id, peer_id, tool_server, tool_name, first_requested_at,
		       last_used_at, use_count, bypass_broker
		FROM agent_tools
		WHERE peer_id = $1
		ORDER BY first_requested_at`
)

// ─── Agent Tools Methods ────────────────────────────────────────────────────

// RecordToolRequest records that a peer has requested access to a tool.
// If the peer already has access (unique constraint on peer_id, tool_server,
// tool_name), the request is silently ignored (ON CONFLICT DO NOTHING).
func (s *PostgresStore) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}

	_, err := s.pool.Exec(ctx, InsertAgentTool, peerID, toolServer, toolName)
	if err != nil {
		return fmt.Errorf("record tool request: %w", err)
	}
	return nil
}

// IncrementToolUse increments the use_count for a peer's tool and returns
// whether the tool has reached the bypass threshold (use_count >= 5).
// If the tool is not tracked for this peer, it returns fmt.Errorf.
func (s *PostgresStore) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	if s.pool == nil {
		return false, fmt.Errorf("database pool not initialized")
	}

	var useCount int
	var bypassBroker bool
	err := s.pool.QueryRow(ctx, IncrementAgentToolUse, peerID, toolServer, toolName).Scan(&useCount, &bypassBroker)
	if err != nil {
		return false, fmt.Errorf("increment tool use: %w", err)
	}
	return bypassBroker, nil
}

// GetAgentTools returns all tool records for a given peer.
func (s *PostgresStore) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	rows, err := s.pool.Query(ctx, GetAgentToolsByPeer, peerID)
	if err != nil {
		return nil, fmt.Errorf("get agent tools: %w", err)
	}
	defer rows.Close()

	var results []*core.ToolRecord
	for rows.Next() {
		var rec core.ToolRecord
		var lastUsedAt *time.Time
		err := rows.Scan(
			&rec.ID, &rec.PeerID, &rec.ToolServer, &rec.ToolName,
			&rec.FirstRequestedAt, &lastUsedAt, &rec.UseCount, &rec.BypassBroker,
		)
		if err != nil {
			slog.Warn("scan agent tool row", "err", err)
			continue
		}
		rec.LastUsedAt = lastUsedAt
		results = append(results, &rec)
	}
	return results, nil
}
