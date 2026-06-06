// Package store — thoughts.go: thought chain operations.
package store

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Thought Chain Operations ────────────────────────────────────────────────

// StartThoughtChain creates a new thought chain and returns its ID.
func (s *PostgresStore) StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	chainID := uuid.New().String()

	var id, sid, status string
	var parentID *string
	var createdAt, updatedAt time.Time

	err := s.pool.QueryRow(ctx, InsertThoughtChain, chainID, sessionID, nil, "active").Scan(
		&id, &sid, &parentID, &status, &createdAt, &updatedAt,
	)
	if err != nil {
		return "", fmt.Errorf("start thought chain: %w", err)
	}
	return id, nil
}

// AddThought adds a thought to a chain and returns its ID.
func (s *PostgresStore) AddThought(ctx context.Context, chainID string, thought *core.Thought) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	thoughtID := thought.ID
	if thoughtID == "" {
		thoughtID = uuid.New().String()
	}

	// Format embedding for pgvector if present
	var embedding interface{}
	if thought.Vector != nil {
		embedding = formatVector(thought.Vector)
	}

	// Handle nullable fields
	var revisesThoughtID interface{}
	if thought.RevisesThoughtID != "" {
		revisesThoughtID = thought.RevisesThoughtID
	}
	var branchFromThoughtID interface{}
	if thought.BranchFromThoughtID != "" {
		branchFromThoughtID = thought.BranchFromThoughtID
	}
	var branchID interface{}
	if thought.BranchID != "" {
		branchID = thought.BranchID
	}
	var memoryID interface{}
	if thought.MemoryID != "" {
		memoryID = thought.MemoryID
	}

	var returnedID, returnedChainID, returnedText string
	var returnedThoughtNumber, returnedTotalThoughts int
	var returnedNextThoughtNeeded, returnedIsRevision bool
	var returnedRevisesThoughtID, returnedBranchFromThoughtID, returnedBranchID, returnedContentHash, returnedMemoryID *string
	var returnedCreatedAt time.Time

	err := s.pool.QueryRow(ctx, InsertThought,
		thoughtID, chainID, thought.Text, thought.ThoughtNumber, thought.TotalThoughts,
		thought.NextThoughtNeeded, thought.IsRevision, revisesThoughtID,
		branchFromThoughtID, branchID, embedding, thought.ContentHash, memoryID,
	).Scan(
		&returnedID, &returnedChainID, &returnedText,
		&returnedThoughtNumber, &returnedTotalThoughts,
		&returnedNextThoughtNeeded, &returnedIsRevision,
		&returnedRevisesThoughtID, &returnedBranchFromThoughtID,
		&returnedBranchID, &returnedContentHash, &returnedMemoryID, &returnedCreatedAt,
	)
	if err != nil {
		return "", fmt.Errorf("add thought: %w", err)
	}
	return returnedID, nil
}

// scanThoughtRow scans a single thought row from a query result.
func scanThoughtRow(row pgx.Row) (*core.Thought, error) {
	var t core.Thought
	var revisesThoughtID, branchFromThoughtID, branchID, contentHash, memoryID *string

	err := row.Scan(
		&t.ID, &t.ChainID, &t.Text, &t.ThoughtNumber, &t.TotalThoughts,
		&t.NextThoughtNeeded, &t.IsRevision,
		&revisesThoughtID, &branchFromThoughtID, &branchID,
		&contentHash, &memoryID, &t.CreatedAt,
	)
	if err != nil {
		return nil, err
	}

	if revisesThoughtID != nil {
		t.RevisesThoughtID = *revisesThoughtID
	}
	if branchFromThoughtID != nil {
		t.BranchFromThoughtID = *branchFromThoughtID
	}
	if branchID != nil {
		t.BranchID = *branchID
	}
	if contentHash != nil {
		t.ContentHash = *contentHash
	}
	if memoryID != nil {
		t.MemoryID = *memoryID
	}

	return &t, nil
}

// GetThoughtChain retrieves a thought chain with all its thoughts.
func (s *PostgresStore) GetThoughtChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Get the chain itself
	var tc core.ThoughtChain
	var sessionID *string
	var parentChainID *string

	err := s.pool.QueryRow(ctx, GetThoughtChainByID, chainID).Scan(
		&tc.ID, &sessionID, &parentChainID, &tc.Status, &tc.CreatedAt, &tc.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("get thought chain: %w", err)
	}

	if sessionID != nil {
		tc.SessionID = *sessionID
	}
	if parentChainID != nil {
		tc.ParentChainID = *parentChainID
	}

	// Get all thoughts for this chain
	rows, err := s.pool.Query(ctx, GetThoughtsByChain, chainID)
	if err != nil {
		return nil, fmt.Errorf("get thoughts for chain: %w", err)
	}
	defer rows.Close()

	var thoughts []core.Thought
	for rows.Next() {
		var t core.Thought
		var revisesThoughtID, branchFromThoughtID, branchID, contentHash, memoryID *string

		err := rows.Scan(
			&t.ID, &t.ChainID, &t.Text, &t.ThoughtNumber, &t.TotalThoughts,
			&t.NextThoughtNeeded, &t.IsRevision,
			&revisesThoughtID, &branchFromThoughtID, &branchID,
			&contentHash, &memoryID, &t.CreatedAt,
		)
		if err != nil {
			slog.Warn("scan thought row", "err", err)
			continue
		}

		if revisesThoughtID != nil {
			t.RevisesThoughtID = *revisesThoughtID
		}
		if branchFromThoughtID != nil {
			t.BranchFromThoughtID = *branchFromThoughtID
		}
		if branchID != nil {
			t.BranchID = *branchID
		}
		if contentHash != nil {
			t.ContentHash = *contentHash
		}
		if memoryID != nil {
			t.MemoryID = *memoryID
		}

		thoughts = append(thoughts, t)
	}

	tc.Thoughts = thoughts
	return &tc, nil
}

// GetRelatedChains finds thought chains related to a query using vector similarity.
// It embeds the query and searches for similar thoughts, then returns their parent chains.
func (s *PostgresStore) GetRelatedChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if limit <= 0 {
		limit = 10
	}

	// First, try text-based search on thought content
	// We search for thoughts matching the query text, collect unique chain IDs,
	// then fetch the full chains.
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT chain_id
		FROM thoughts
		WHERE to_tsvector('english', thought) @@ websearch_to_tsquery('english', $1)
		LIMIT $2
	`, query, limit)
	if err != nil {
		return nil, fmt.Errorf("get related chains: %w", err)
	}
	defer rows.Close()

	var chainIDs []string
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			slog.Warn("scan related chain row", "err", err)
			continue
		}
		chainIDs = append(chainIDs, cid)
	}

	if len(chainIDs) == 0 {
		return nil, nil
	}

	// Build a parameterized query for fetching chains by IDs
	var results []*core.ThoughtChain
	for _, cid := range chainIDs {
		tc, err := s.GetThoughtChain(ctx, cid)
		if err != nil {
			continue
		}
		results = append(results, tc)
	}

	return results, nil
}

// ReviseThought creates a revision of an existing thought. It finds the original
// thought by chain_id and thought_number, creates a new revision thought with
// is_revision=true and revises_thought_id pointing to the original.
func (s *PostgresStore) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, revisedText string) (*core.Thought, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Find original thought
	original, err := scanThoughtRow(s.pool.QueryRow(ctx, GetThoughtByNumber, chainID, thoughtNumber))
	if err != nil {
		return nil, fmt.Errorf("find original thought: %w", err)
	}

	// Create revision thought
	revisionID := uuid.New().String()
	contentHash := fmt.Sprintf("%x", sha256.Sum256([]byte(revisedText)))[:32]

	var returnedID, returnedChainID, returnedText string
	var returnedThoughtNumber, returnedTotalThoughts int
	var returnedNextThoughtNeeded, returnedIsRevision bool
	var returnedRevisesThoughtID, returnedBranchFromThoughtID, returnedBranchID, returnedContentHash, returnedMemoryID *string
	var returnedCreatedAt time.Time

	err = s.pool.QueryRow(ctx, InsertThoughtRevision,
		revisionID, chainID, revisedText, original.ThoughtNumber, original.TotalThoughts,
		original.NextThoughtNeeded, original.ID, // revises_thought_id = original.ID
		nil,              // embedding - will be updated separately
		contentHash, nil, // content_hash, memory_id (set later by bridge)
	).Scan(
		&returnedID, &returnedChainID, &returnedText,
		&returnedThoughtNumber, &returnedTotalThoughts,
		&returnedNextThoughtNeeded, &returnedIsRevision,
		&returnedRevisesThoughtID, &returnedBranchFromThoughtID,
		&returnedBranchID, &returnedContentHash, &returnedMemoryID, &returnedCreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert revision thought: %w", err)
	}

	revision := &core.Thought{
		ID:                returnedID,
		ChainID:           returnedChainID,
		Text:              returnedText,
		ThoughtNumber:     returnedThoughtNumber,
		TotalThoughts:     returnedTotalThoughts,
		NextThoughtNeeded: returnedNextThoughtNeeded,
		IsRevision:        returnedIsRevision,
		ContentHash:       derefString(returnedContentHash),
		CreatedAt:         returnedCreatedAt,
	}

	if returnedRevisesThoughtID != nil {
		revision.RevisesThoughtID = *returnedRevisesThoughtID
	}
	if returnedMemoryID != nil {
		revision.MemoryID = *returnedMemoryID
	}

	return revision, nil
}

// BranchThought creates a branch from an existing thought. It finds the original
// thought by chain_id and thought_number, creates a new thought with
// branch_from_thought_id and branch_id set.
func (s *PostgresStore) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Find original thought
	original, err := scanThoughtRow(s.pool.QueryRow(ctx, GetThoughtByNumber, chainID, fromThoughtNumber))
	if err != nil {
		return nil, fmt.Errorf("find original thought for branch: %w", err)
	}

	// Create branch thought
	branchIDStr := uuid.New().String()
	contentHash := fmt.Sprintf("%x", sha256.Sum256([]byte(text)))[:32]
	newThoughtNumber := original.ThoughtNumber + 1

	var returnedID, returnedChainID, returnedText string
	var returnedThoughtNumber, returnedTotalThoughts int
	var returnedNextThoughtNeeded, returnedIsRevision bool
	var returnedRevisesThoughtID, returnedBranchFromThoughtID, returnedBranchID, returnedContentHash, returnedMemoryID *string
	var returnedCreatedAt time.Time

	err = s.pool.QueryRow(ctx, InsertThoughtBranch,
		branchIDStr, chainID, text, newThoughtNumber, original.TotalThoughts,
		original.NextThoughtNeeded,
		original.ID,      // branch_from_thought_id
		branchID,         // branch_id from caller
		nil,              // embedding
		contentHash, nil, // content_hash, memory_id
	).Scan(
		&returnedID, &returnedChainID, &returnedText,
		&returnedThoughtNumber, &returnedTotalThoughts,
		&returnedNextThoughtNeeded, &returnedIsRevision,
		&returnedRevisesThoughtID, &returnedBranchFromThoughtID,
		&returnedBranchID, &returnedContentHash, &returnedMemoryID, &returnedCreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert branch thought: %w", err)
	}

	branch := &core.Thought{
		ID:                returnedID,
		ChainID:           returnedChainID,
		Text:              returnedText,
		ThoughtNumber:     returnedThoughtNumber,
		TotalThoughts:     returnedTotalThoughts,
		NextThoughtNeeded: returnedNextThoughtNeeded,
		IsRevision:        returnedIsRevision,
		ContentHash:       derefString(returnedContentHash),
		CreatedAt:         returnedCreatedAt,
	}

	if returnedRevisesThoughtID != nil {
		branch.RevisesThoughtID = *returnedRevisesThoughtID
	}
	if returnedBranchFromThoughtID != nil {
		branch.BranchFromThoughtID = *returnedBranchFromThoughtID
	}
	if returnedBranchID != nil {
		branch.BranchID = *returnedBranchID
	}
	if returnedMemoryID != nil {
		branch.MemoryID = *returnedMemoryID
	}

	return branch, nil
}

// PauseThoughtChain pauses a thought chain by setting its status to 'paused'.
func (s *PostgresStore) PauseThoughtChain(ctx context.Context, chainID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	var id string
	err := s.pool.QueryRow(ctx, UpdateThoughtChainStatus, "paused", chainID).Scan(&id, nil)
	if err != nil {
		return fmt.Errorf("pause thought chain: %w", err)
	}
	return nil
}

// ResumeThoughtChain resumes a paused thought chain by setting its status to 'active'.
func (s *PostgresStore) ResumeThoughtChain(ctx context.Context, chainID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	var id string
	err := s.pool.QueryRow(ctx, UpdateThoughtChainStatus, "active", chainID).Scan(&id, nil)
	if err != nil {
		return fmt.Errorf("resume thought chain: %w", err)
	}
	return nil
}

// AbandonThoughtChain abandons a thought chain by setting its status to 'abandoned'.
func (s *PostgresStore) AbandonThoughtChain(ctx context.Context, chainID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	var id string
	err := s.pool.QueryRow(ctx, UpdateThoughtChainStatus, "abandoned", chainID).Scan(&id, nil)
	if err != nil {
		return fmt.Errorf("abandon thought chain: %w", err)
	}
	return nil
}

// ─── Thought Helper Functions ─────────────────────────────────────────────────

// derefString returns the dereferenced string or empty string if nil.
func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
