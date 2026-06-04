package user

import (
	"context"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockProfileStore implements ProfileStore for testing.
type mockProfileStore struct {
	profile *core.UserProfile
	err     error
	upserts []*core.UserProfile
}

func (m *mockProfileStore) GetUserProfile(ctx context.Context, peerID string) (*core.UserProfile, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.profile, nil
}

func (m *mockProfileStore) UpsertUserProfile(ctx context.Context, profile *core.UserProfile) error {
	if m.err != nil {
		return m.err
	}
	m.upserts = append(m.upserts, profile)
	return nil
}

func TestGetProfile_DefaultWhenNotFound(t *testing.T) {
	store := &mockProfileStore{profile: nil} // no profile stored
	pm := NewProfileManager(store)

	profile, err := pm.GetProfile(context.Background(), "peer-123", false)
	if err != nil {
		t.Fatalf("GetProfile returned error: %v", err)
	}

	if profile.PeerID != "peer-123" {
		t.Errorf("expected PeerID=peer-123, got %s", profile.PeerID)
	}
	if profile.CommunicationStyle != "neutral" {
		t.Errorf("expected CommunicationStyle=neutral, got %s", profile.CommunicationStyle)
	}
	if profile.ExpertiseLevel != "intermediate" {
		t.Errorf("expected ExpertiseLevel=intermediate, got %s", profile.ExpertiseLevel)
	}
	if profile.SessionCount != 0 {
		t.Errorf("expected SessionCount=0, got %d", profile.SessionCount)
	}
	if profile.WarmedUp {
		t.Error("expected WarmedUp=false for new profile")
	}
	if profile.DialecticNotes != nil {
		t.Errorf("expected nil DialecticNotes when includeDialecticNotes=false, got %v", profile.DialecticNotes)
	}
}

func TestGetProfile_WithDialecticNotes(t *testing.T) {
	existing := &core.UserProfile{
		PeerID:             "peer-456",
		CommunicationStyle: "technical",
		ExpertiseLevel:     "expert",
		DialecticNotes:     []any{"note1", "note2"},
		SessionCount:       5,
		WarmedUp:           true,
		CreatedAt:          time.Now(),
		UpdatedAt:          time.Now(),
	}
	store := &mockProfileStore{profile: existing}
	pm := NewProfileManager(store)

	profile, err := pm.GetProfile(context.Background(), "peer-456", true)
	if err != nil {
		t.Fatalf("GetProfile returned error: %v", err)
	}
	if len(profile.DialecticNotes) != 2 {
		t.Errorf("expected 2 DialecticNotes, got %d", len(profile.DialecticNotes))
	}
}

func TestGetProfile_EmptyPeerID(t *testing.T) {
	store := &mockProfileStore{}
	pm := NewProfileManager(store)

	_, err := pm.GetProfile(context.Background(), "", false)
	if err == nil {
		t.Fatal("expected error for empty peerID, got nil")
	}
}

func TestGetProfile_ExistingProfile(t *testing.T) {
	existing := &core.UserProfile{
		PeerID:             "peer-789",
		CommunicationStyle: "concise",
		ExpertiseLevel:     "advanced",
		Preferences:        map[string]any{"theme": "dark"},
		SessionCount:       10,
		WarmedUp:           true,
		CreatedAt:          time.Now(),
		UpdatedAt:          time.Now(),
	}
	store := &mockProfileStore{profile: existing}
	pm := NewProfileManager(store)

	profile, err := pm.GetProfile(context.Background(), "peer-789", false)
	if err != nil {
		t.Fatalf("GetProfile returned error: %v", err)
	}
	if profile.CommunicationStyle != "concise" {
		t.Errorf("expected CommunicationStyle=concise, got %s", profile.CommunicationStyle)
	}
	if profile.SessionCount != 10 {
		t.Errorf("expected SessionCount=10, got %d", profile.SessionCount)
	}
}

func TestUpdateProfile_CreateNew(t *testing.T) {
	store := &mockProfileStore{} // no existing profile
	pm := NewProfileManager(store)

	warmedUp := true
	count := 3
	update := &core.UserProfileUpdate{
		CommunicationStyle: "detailed",
		Preferences:        map[string]any{"editor": "vim"},
		WarmedUp:           &warmedUp,
		SessionCount:       &count,
	}

	profile, err := pm.UpdateProfile(context.Background(), "peer-new", update)
	if err != nil {
		t.Fatalf("UpdateProfile returned error: %v", err)
	}

	if profile.CommunicationStyle != "detailed" {
		t.Errorf("expected CommunicationStyle=detailed, got %s", profile.CommunicationStyle)
	}
	if profile.Preferences["editor"] != "vim" {
		t.Errorf("expected preferences.editor=vim, got %v", profile.Preferences["editor"])
	}
	if !profile.WarmedUp {
		t.Error("expected WarmedUp=true")
	}
	if profile.SessionCount != 3 {
		t.Errorf("expected SessionCount=3, got %d", profile.SessionCount)
	}
	if len(store.upserts) != 1 {
		t.Fatalf("expected 1 upsert, got %d", len(store.upserts))
	}
}

func TestUpdateProfile_MergeExisting(t *testing.T) {
	existing := &core.UserProfile{
		PeerID:             "peer-merge",
		CommunicationStyle: "neutral",
		ExpertiseLevel:     "intermediate",
		Preferences:        map[string]any{"theme": "dark", "language": "en"},
		SessionCount:       5,
		WarmedUp:           false,
		CreatedAt:          time.Now(),
		UpdatedAt:          time.Now(),
	}
	store := &mockProfileStore{profile: existing}
	pm := NewProfileManager(store)

	count := 6
	update := &core.UserProfileUpdate{
		CommunicationStyle: "technical",
		Preferences:        map[string]any{"theme": "light"}, // override "dark"
		SessionCount:       &count,
	}

	profile, err := pm.UpdateProfile(context.Background(), "peer-merge", update)
	if err != nil {
		t.Fatalf("UpdateProfile returned error: %v", err)
	}

	if profile.CommunicationStyle != "technical" {
		t.Errorf("expected CommunicationStyle=technical, got %s", profile.CommunicationStyle)
	}
	if profile.Preferences["theme"] != "light" {
		t.Errorf("expected preferences.theme=light, got %v", profile.Preferences["theme"])
	}
	if profile.Preferences["language"] != "en" {
		t.Errorf("expected preferences.language=en (preserved), got %v", profile.Preferences["language"])
	}
	if profile.SessionCount != 6 {
		t.Errorf("expected SessionCount=6, got %d", profile.SessionCount)
	}
	if profile.ExpertiseLevel != "intermediate" {
		t.Errorf("expected ExpertiseLevel=intermediate (unchanged), got %s", profile.ExpertiseLevel)
	}
}

func TestUpdateProfile_EmptyPeerID(t *testing.T) {
	store := &mockProfileStore{}
	pm := NewProfileManager(store)

	_, err := pm.UpdateProfile(context.Background(), "", &core.UserProfileUpdate{})
	if err == nil {
		t.Fatal("expected error for empty peerID, got nil")
	}
}

func TestUpdateProfile_NilUpdate(t *testing.T) {
	store := &mockProfileStore{}
	pm := NewProfileManager(store)

	_, err := pm.UpdateProfile(context.Background(), "peer-123", nil)
	if err == nil {
		t.Fatal("expected error for nil update, got nil")
	}
}

func TestUpdateProfile_PartialUpdate(t *testing.T) {
	existing := &core.UserProfile{
		PeerID:             "peer-123",
		CommunicationStyle: "neutral",
		ExpertiseLevel:     "beginner",
		Preferences:        map[string]any{},
		SessionCount:       1,
		WarmedUp:           false,
		CreatedAt:          time.Now(),
		UpdatedAt:          time.Now(),
	}
	store := &mockProfileStore{profile: existing}
	pm := NewProfileManager(store)

	// Only update communication style — everything else stays
	update := &core.UserProfileUpdate{
		CommunicationStyle: "concise",
	}

	profile, err := pm.UpdateProfile(context.Background(), "peer-123", update)
	if err != nil {
		t.Fatalf("UpdateProfile returned error: %v", err)
	}

	if profile.CommunicationStyle != "concise" {
		t.Errorf("expected CommunicationStyle=concise, got %s", profile.CommunicationStyle)
	}
	if profile.ExpertiseLevel != "beginner" {
		t.Errorf("expected ExpertiseLevel=beginner (unchanged), got %s", profile.ExpertiseLevel)
	}
	if profile.SessionCount != 1 {
		t.Errorf("expected SessionCount=1 (unchanged), got %d", profile.SessionCount)
	}
}

func TestGetProfile_StoreError(t *testing.T) {
	store := &mockProfileStore{err: context.DeadlineExceeded}
	pm := NewProfileManager(store)

	_, err := pm.GetProfile(context.Background(), "peer-err", false)
	if err == nil {
		t.Fatal("expected error from store, got nil")
	}
}

func TestUpdateProfile_StoreErrorOnLoad(t *testing.T) {
	store := &mockProfileStore{err: context.DeadlineExceeded}
	pm := NewProfileManager(store)

	warmedUp := true
	_, err := pm.UpdateProfile(context.Background(), "peer-err", &core.UserProfileUpdate{
		CommunicationStyle: "technical",
		WarmedUp:           &warmedUp,
	})
	if err == nil {
		t.Fatal("expected error from store on load, got nil")
	}
}

func TestUpdateProfile_DialecticNotesUpdate(t *testing.T) {
	store := &mockProfileStore{} // no existing profile
	pm := NewProfileManager(store)

	notes := []any{"reasoning step 1", "reasoning step 2"}
	update := &core.UserProfileUpdate{
		DialecticNotes: notes,
	}

	profile, err := pm.UpdateProfile(context.Background(), "peer-notes", update)
	if err != nil {
		t.Fatalf("UpdateProfile returned error: %v", err)
	}

	if len(profile.DialecticNotes) != 2 {
		t.Errorf("expected 2 DialecticNotes, got %d", len(profile.DialecticNotes))
	}
}
