// Package store — profiles_security.go: user profile and security summary operations.
package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── User Profile Operations ──────────────────────────────────────────────────

// GetUserProfile retrieves a user profile by peer ID.
// Returns nil,nil if no profile is found for the given peer.
func (s *PostgresStore) GetUserProfile(ctx context.Context, peerID string) (*core.UserProfile, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	var p core.UserProfile
	var preferencesJSON []byte
	var dialecticNotesJSON []byte
	var peerIDScan string

	err := s.pool.QueryRow(ctx, GetUserProfileQuery, peerID).Scan(
		&p.ID, &peerIDScan, &preferencesJSON, &p.CommunicationStyle, &p.ExpertiseLevel,
		&dialecticNotesJSON, &p.WarmedUp, &p.SessionCount, &p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil // no profile found — caller creates default
		}
		return nil, fmt.Errorf("get user profile: %w", err)
	}

	p.PeerID = peerIDScan

	// Parse JSONB fields
	if preferencesJSON != nil {
		p.Preferences = make(map[string]any)
		_ = json.Unmarshal(preferencesJSON, &p.Preferences)
	}
	if p.Preferences == nil {
		p.Preferences = map[string]any{}
	}

	if dialecticNotesJSON != nil {
		p.DialecticNotes = make([]any, 0)
		_ = json.Unmarshal(dialecticNotesJSON, &p.DialecticNotes)
	}
	if p.DialecticNotes == nil {
		p.DialecticNotes = []any{}
	}

	return &p, nil
}

// UpsertUserProfile creates or updates a user profile.
// If a profile with the same peer_id already exists, it is fully replaced.
func (s *PostgresStore) UpsertUserProfile(ctx context.Context, profile *core.UserProfile) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}

	preferencesJSON, err := json.Marshal(profile.Preferences)
	if err != nil {
		return fmt.Errorf("marshal preferences: %w", err)
	}
	dialecticNotesJSON, err := json.Marshal(profile.DialecticNotes)
	if err != nil {
		return fmt.Errorf("marshal dialectic_notes: %w", err)
	}

	_, err = s.pool.Exec(ctx, UpsertUserProfileQuery,
		profile.PeerID,
		preferencesJSON,
		profile.CommunicationStyle,
		profile.ExpertiseLevel,
		dialecticNotesJSON,
		profile.WarmedUp,
		profile.SessionCount,
	)
	if err != nil {
		return fmt.Errorf("upsert user profile: %w", err)
	}

	return nil
}

// ─── Security Summary ──────────────────────────────────────────────────────────

// GetSecuritySummary aggregates audit_log data for the last N hours.
// Returns counts by event_type, severity, and agent_name.
func (s *PostgresStore) GetSecuritySummary(ctx context.Context, hours int) (*core.SecuritySummary, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if hours <= 0 {
		hours = 24
	}

	hoursStr := fmt.Sprintf("%d", hours)
	summary := &core.SecuritySummary{
		EventsPerType:  map[string]int{},
		EventsPerAgent: map[string]int{},
		SeverityCounts: map[string]int{},
	}

	// Total events
	if err := s.pool.QueryRow(ctx, SecuritySummaryTotalEvents, hoursStr).Scan(&summary.TotalEvents); err != nil {
		return nil, fmt.Errorf("security summary total: %w", err)
	}

	// Critical count
	if err := s.pool.QueryRow(ctx, SecuritySummaryCriticalCount, hoursStr).Scan(&summary.CriticalCount); err != nil {
		return nil, fmt.Errorf("security summary critical: %w", err)
	}

	// Events per type
	typeRows, err := s.pool.Query(ctx, SecuritySummaryEventsPerType, hoursStr)
	if err != nil {
		return nil, fmt.Errorf("security summary per type: %w", err)
	}
	defer typeRows.Close()
	for typeRows.Next() {
		var eventType string
		var count int
		if err := typeRows.Scan(&eventType, &count); err != nil {
			continue
		}
		summary.EventsPerType[eventType] = count
	}

	// Events per agent
	agentRows, err := s.pool.Query(ctx, SecuritySummaryEventsPerAgent, hoursStr)
	if err != nil {
		return nil, fmt.Errorf("security summary per agent: %w", err)
	}
	defer agentRows.Close()
	for agentRows.Next() {
		var agentName string
		var count int
		if err := agentRows.Scan(&agentName, &count); err != nil {
			continue
		}
		summary.EventsPerAgent[agentName] = count
	}

	// Severity counts
	sevRows, err := s.pool.Query(ctx, SecuritySummarySeverityCounts, hoursStr)
	if err != nil {
		return nil, fmt.Errorf("security summary severity: %w", err)
	}
	defer sevRows.Close()
	for sevRows.Next() {
		var severity string
		var count int
		if err := sevRows.Scan(&severity, &count); err != nil {
			continue
		}
		summary.SeverityCounts[severity] = count
	}

	return summary, nil
}
