// Package store — audit_trust.go: audit log and trust adjustment operations.
package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Audit Operations ─────────────────────────────────────────────────────────

// LogAuditEvent logs an audit event.
func (s *PostgresStore) LogAuditEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	eventID := event.ID
	if eventID == "" {
		eventID = uuid.New().String()
	}
	_, err := s.pool.Exec(ctx, InsertAuditEvent,
		eventID, event.EventType, event.Severity, nil, event.PeerID,
		event.AgentName, event.ToolName, event.MemoryID, event.Description,
		nil, nil, nil,
	)
	if err != nil {
		return "", fmt.Errorf("log audit event: %w", err)
	}
	return eventID, nil
}

// GetAuditEvents retrieves audit events with optional filters for sessionID and eventType.
func (s *PostgresStore) GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	if limit <= 0 {
		limit = 100
	}

	// Build dynamic WHERE clause
	query := `SELECT id, event_type, severity, session_id, peer_id, agent_name,
       tool_name, memory_id, description, details, state_before, state_after,
       ip_address, occurred_at, created_at
FROM audit_log`
	var args []any
	argNum := 1

	var conditions []string

	if sessionID != "" {
		conditions = append(conditions, fmt.Sprintf("session_id = $%d", argNum))
		args = append(args, sessionID)
		argNum++
	}

	if eventType != "" {
		conditions = append(conditions, fmt.Sprintf("event_type = $%d", argNum))
		args = append(args, eventType)
		argNum++
	}

	if len(conditions) > 0 {
		query += " WHERE " + conditions[0]
		for i := 1; i < len(conditions); i++ {
			query += " AND " + conditions[i]
		}
	}

	query += fmt.Sprintf(" ORDER BY occurred_at DESC LIMIT $%d", argNum)
	args = append(args, limit)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get audit events: %w", err)
	}
	defer rows.Close()

	var results []*core.AuditEvent
	for rows.Next() {
		var evt core.AuditEvent
		var detailsJSON, stateBeforeJSON, stateAfterJSON []byte

		err := rows.Scan(
			&evt.ID, &evt.EventType, &evt.Severity, &evt.SessionID,
			&evt.PeerID, &evt.AgentName, &evt.ToolName, &evt.MemoryID,
			&evt.Description, &detailsJSON, &stateBeforeJSON, &stateAfterJSON,
			&evt.IPAddress, &evt.OccurredAt, &evt.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan audit event row: %w", err)
		}

		// Parse JSONB fields
		if detailsJSON != nil {
			var d map[string]any
			if json.Unmarshal(detailsJSON, &d) == nil {
				evt.Details = d
			}
		}
		if stateBeforeJSON != nil {
			var sb map[string]any
			if json.Unmarshal(stateBeforeJSON, &sb) == nil {
				evt.StateBefore = sb
			}
		}
		if stateAfterJSON != nil {
			var sa map[string]any
			if json.Unmarshal(stateAfterJSON, &sa) == nil {
				evt.StateAfter = sa
			}
		}

		results = append(results, &evt)
	}

	return results, nil
}

// ─── Trust Adjustment Operations ─────────────────────────────────────────────────

// LogTrustAdjustment logs a trust score adjustment.
func (s *PostgresStore) LogTrustAdjustment(ctx context.Context, adj *core.TrustAdjustment) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	adjID := adj.ID
	if adjID == "" {
		adjID = uuid.New().String()
	}
	err := s.pool.QueryRow(ctx, InsertTrustAdjustment,
		adjID, adj.MemoryID, adj.OldScore, adj.NewScore, adj.Signal, adj.AdjustmentAmount, adj.Reason,
	).Scan(&adjID)
	if err != nil {
		return "", fmt.Errorf("log trust adjustment: %w", err)
	}
	return adjID, nil
}

// GetTrustAdjustments retrieves trust adjustments for a memory.
func (s *PostgresStore) GetTrustAdjustments(ctx context.Context, memoryID string, limit int) ([]*core.TrustAdjustment, error) {
	return nil, fmt.Errorf("not implemented: GetTrustAdjustments")
}

// ─── Decay Operations ────────────────────────────────────────────────────────

// UpdateDecayRate updates the decay rate for a memory.
func (s *PostgresStore) UpdateDecayRate(ctx context.Context, memoryID string, rate float64) error {
	// Phase 1: store in metadata
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, "UPDATE memories SET metadata = jsonb_set(metadata, '{decay_rate}', $1::jsonb) WHERE id = $2", fmt.Sprintf("%g", rate), memoryID)
	return err
}

// ListFadingMemories returns memories approaching archive threshold.
func (s *PostgresStore) ListFadingMemories(ctx context.Context, threshold float64, limit int) ([]*core.MemoryEntry, error) {
	return nil, fmt.Errorf("not implemented: ListFadingMemories")
}
