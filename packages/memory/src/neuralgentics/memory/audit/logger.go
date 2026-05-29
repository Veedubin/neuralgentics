// Package audit provides structured audit logging for the Neuralgentics memory system.
//
// The AuditLogger validates events, applies defaults, and delegates storage
// to the core.Store interface — it never references the concrete PostgresStore.
package audit

import (
	"context"
	"fmt"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// validSeverities is the set of allowed severity levels.
var validSeverities = map[string]bool{
	"info":     true,
	"warning":  true,
	"critical": true,
}

// AuditLogger validates and records audit events via the core.Store interface.
type AuditLogger struct {
	store core.Store
}

// NewAuditLogger creates an AuditLogger backed by the given store.
func NewAuditLogger(store core.Store) *AuditLogger {
	return &AuditLogger{store: store}
}

// LogEvent validates an audit event, applies defaults, and persists it.
// It returns the generated event ID.
//
// Validation rules:
//   - EventType must be non-empty.
//   - Severity must be one of "info", "warning", "critical"; defaults to "info" if empty.
//   - OccurredAt defaults to time.Now() if zero.
func (l *AuditLogger) LogEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	if event == nil {
		return "", fmt.Errorf("audit: event is nil")
	}

	if event.EventType == "" {
		return "", fmt.Errorf("audit: EventType is required")
	}

	// Default severity
	if event.Severity == "" {
		event.Severity = "info"
	}

	// Validate severity
	if !validSeverities[event.Severity] {
		return "", fmt.Errorf("audit: invalid severity %q, must be one of info, warning, critical", event.Severity)
	}

	// Default OccurredAt
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now()
	}

	id, err := l.store.LogAuditEvent(ctx, event)
	if err != nil {
		return "", fmt.Errorf("audit: log event: %w", err)
	}
	return id, nil
}

// GetEvents retrieves audit events with optional filters.
// If limit <= 0, it defaults to 100.
func (l *AuditLogger) GetEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	if limit <= 0 {
		limit = 100
	}

	events, err := l.store.GetAuditEvents(ctx, sessionID, eventType, limit)
	if err != nil {
		return nil, fmt.Errorf("audit: get events: %w", err)
	}
	return events, nil
}

// LogTrustAdjustment is a convenience wrapper that creates an audit event
// with type "trust_adjustment" and persists it.
func (l *AuditLogger) LogTrustAdjustment(ctx context.Context, adj *core.TrustAdjustment) (string, error) {
	if adj == nil {
		return "", fmt.Errorf("audit: adjustment is nil")
	}

	event := &core.AuditEvent{
		EventType:   "trust_adjustment",
		Severity:    "info",
		MemoryID:    adj.MemoryID,
		Description: adj.Reason,
		Details: map[string]any{
			"oldScore":         adj.OldScore,
			"newScore":         adj.NewScore,
			"signal":           adj.Signal,
			"adjustmentAmount": adj.AdjustmentAmount,
		},
		StateBefore: map[string]any{"trustScore": adj.OldScore},
		StateAfter:  map[string]any{"trustScore": adj.NewScore},
		OccurredAt:  adj.CreatedAt,
	}

	return l.LogEvent(ctx, event)
}

// LogMemoryMutation is a convenience wrapper that creates an audit event
// with type "memory_mutation" and persists it.
func (l *AuditLogger) LogMemoryMutation(ctx context.Context, memoryID, mutationType, description string, details map[string]any) (string, error) {
	event := &core.AuditEvent{
		EventType:   "memory_mutation",
		Severity:    "info",
		MemoryID:    memoryID,
		Description: description,
		Details:     details,
	}

	if details == nil {
		event.Details = map[string]any{"mutationType": mutationType}
	} else {
		event.Details["mutationType"] = mutationType
	}

	return l.LogEvent(ctx, event)
}

// LogToolInvocation is a convenience wrapper that creates an audit event
// with type "tool_invocation" and persists it.
func (l *AuditLogger) LogToolInvocation(ctx context.Context, sessionID, agentName, toolName string, details map[string]any) (string, error) {
	event := &core.AuditEvent{
		EventType: "tool_invocation",
		Severity:  "info",
		SessionID: sessionID,
		AgentName: agentName,
		ToolName:  toolName,
		Details:   details,
	}

	if details == nil {
		event.Details = map[string]any{}
	}

	return l.LogEvent(ctx, event)
}
