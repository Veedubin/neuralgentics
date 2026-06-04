// Package user provides user profile modeling for the Neuralgentics memory system.
// It handles CRUD for user_profiles, including communication style, expertise level,
// and preferences tracking across sessions.
package user

import (
	"context"
	"fmt"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ProfileStore is the storage interface needed by ProfileManager.
// This interface matches core.Store but is kept narrow for testability.
type ProfileStore interface {
	GetUserProfile(ctx context.Context, peerID string) (*core.UserProfile, error)
	UpsertUserProfile(ctx context.Context, profile *core.UserProfile) error
}

// ProfileManager handles user profile retrieval and updates.
// It validates inputs, applies defaults, and delegates storage to ProfileStore.
type ProfileManager struct {
	store ProfileStore
}

// NewProfileManager creates a ProfileManager backed by the given store.
func NewProfileManager(store ProfileStore) *ProfileManager {
	return &ProfileManager{store: store}
}

// GetProfile retrieves a user profile for the given peer ID.
// If no profile exists, it returns a default profile rather than an error,
// matching the Python memini-ai behavior (which creates a default on first access).
// The includeDialecticNotes flag controls whether dialectic_notes are included
// in the response (if false, the field is omitted from the returned notes).
func (pm *ProfileManager) GetProfile(ctx context.Context, peerID string, includeDialecticNotes bool) (*core.UserProfile, error) {
	if peerID == "" {
		return nil, fmt.Errorf("user: peerID is required")
	}

	profile, err := pm.store.GetUserProfile(ctx, peerID)
	if err != nil {
		return nil, fmt.Errorf("user: get profile: %w", err)
	}

	// If no profile exists, return a default one (matching Python behavior).
	if profile == nil {
		profile = &core.UserProfile{
			PeerID:             peerID,
			Preferences:        map[string]any{},
			CommunicationStyle: "neutral",
			ExpertiseLevel:     "intermediate",
			DialecticNotes:     []any{},
			WarmedUp:           false,
			SessionCount:       0,
			CreatedAt:          time.Now(),
			UpdatedAt:          time.Now(),
		}
	}

	// Strip dialectic notes if not requested (matching Python include_dialectic_notes=False).
	if !includeDialecticNotes {
		profile.DialecticNotes = nil
	}

	return profile, nil
}

// UpdateProfile applies a partial update to a user profile.
// It merges non-zero fields from the update into the existing profile,
// then upserts the result. If no profile exists yet, one is created
// with defaults merged from the update.
func (pm *ProfileManager) UpdateProfile(ctx context.Context, peerID string, update *core.UserProfileUpdate) (*core.UserProfile, error) {
	if peerID == "" {
		return nil, fmt.Errorf("user: peerID is required")
	}
	if update == nil {
		return nil, fmt.Errorf("user: update is required")
	}

	// Load existing profile (or default).
	existing, err := pm.store.GetUserProfile(ctx, peerID)
	if err != nil {
		return nil, fmt.Errorf("user: load profile for update: %w", err)
	}

	if existing == nil {
		existing = &core.UserProfile{
			PeerID:             peerID,
			Preferences:        map[string]any{},
			CommunicationStyle: "neutral",
			ExpertiseLevel:     "intermediate",
			DialecticNotes:     []any{},
			WarmedUp:           false,
			SessionCount:       0,
		}
	}

	// Apply partial update: only touch fields that are explicitly set.
	if update.Preferences != nil {
		// Merge: new keys override, old keys preserved.
		merged := make(map[string]any, len(existing.Preferences)+len(update.Preferences))
		for k, v := range existing.Preferences {
			merged[k] = v
		}
		for k, v := range update.Preferences {
			merged[k] = v
		}
		existing.Preferences = merged
	}
	if update.CommunicationStyle != "" {
		existing.CommunicationStyle = update.CommunicationStyle
	}
	if update.ExpertiseLevel != "" {
		existing.ExpertiseLevel = update.ExpertiseLevel
	}
	if update.DialecticNotes != nil {
		existing.DialecticNotes = update.DialecticNotes
	}
	if update.WarmedUp != nil {
		existing.WarmedUp = *update.WarmedUp
	}
	if update.SessionCount != nil {
		existing.SessionCount = *update.SessionCount
	}

	existing.UpdatedAt = time.Now()

	if err := pm.store.UpsertUserProfile(ctx, existing); err != nil {
		return nil, fmt.Errorf("user: upsert profile: %w", err)
	}

	return existing, nil
}
