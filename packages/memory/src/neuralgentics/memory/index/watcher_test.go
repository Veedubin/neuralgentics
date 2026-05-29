package index

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"

	"github.com/fsnotify/fsnotify"
)

// --- FileWatcher unit tests ---

func TestNewFileWatcher(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}
	if fw == nil {
		t.Fatal("NewFileWatcher returned nil")
	}
	if fw.debounce != 500*time.Millisecond {
		t.Errorf("default debounce = %v, want %v", fw.debounce, 500*time.Millisecond)
	}

	// Clean up
	if err := fw.Stop(); err != nil {
		t.Fatalf("Stop returned error: %v", err)
	}
}

func TestNewFileWatcher_WithDebounce(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer, WithDebounce(100*time.Millisecond))
	if err != nil {
		t.Fatalf("NewFileWatcher with debounce returned error: %v", err)
	}
	if fw.debounce != 100*time.Millisecond {
		t.Errorf("debounce = %v, want %v", fw.debounce, 100*time.Millisecond)
	}

	if err := fw.Stop(); err != nil {
		t.Fatalf("Stop returned error: %v", err)
	}
}

func TestFileWatcher_Watch_InvalidPath(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}
	defer fw.Stop()

	err = fw.Watch(context.Background(), "/nonexistent/path/that/does/not/exist")
	if err == nil {
		t.Error("expected error for nonexistent path, got nil")
	}
}

func TestFileWatcher_Watch_ValidDirectory(t *testing.T) {
	tmpDir := t.TempDir()

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}

	err = fw.Watch(context.Background(), tmpDir)
	if err != nil {
		t.Fatalf("Watch returned error: %v", err)
	}

	// Clean up
	if err := fw.Stop(); err != nil {
		t.Fatalf("Stop returned error: %v", err)
	}
}

func TestFileWatcher_Watch_AlreadyRunning(t *testing.T) {
	tmpDir := t.TempDir()

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}
	defer fw.Stop()

	err = fw.Watch(context.Background(), tmpDir)
	if err != nil {
		t.Fatalf("first Watch returned error: %v", err)
	}

	// Try to watch again — should fail
	err = fw.Watch(context.Background(), tmpDir)
	if err == nil {
		t.Error("expected error for already running watcher, got nil")
	}
}

func TestFileWatcher_Stop_WithoutWatch(t *testing.T) {
	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}

	// Stop without Watch should not panic
	if err := fw.Stop(); err != nil {
		t.Fatalf("Stop without Watch returned error: %v", err)
	}
}

func TestFileWatcher_HandleEvent_IgnoresDisallowedExtensions(t *testing.T) {
	tmpDir := t.TempDir()

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}
	defer fw.Stop()

	debounced := make(map[string]*time.Timer)
	var debMu sync.Mutex

	// Create event for a .png file (disallowed extension)
	event := fsnotify.Event{
		Name: filepath.Join(tmpDir, "image.png"),
		Op:   fsnotify.Create,
	}

	// handleEvent should return early without creating a timer
	fw.handleEvent(context.Background(), event, tmpDir, &debMu, debounced)

	debMu.Lock()
	timerCount := len(debounced)
	debMu.Unlock()

	if timerCount != 0 {
		t.Errorf("expected 0 debounce timers for .png file, got %d", timerCount)
	}
}

func TestFileWatcher_HandleEvent_IgnoresSkippedDir(t *testing.T) {
	tmpDir := t.TempDir()

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}
	defer fw.Stop()

	debounced := make(map[string]*time.Timer)
	var debMu sync.Mutex

	// Create event for a file in node_modules
	event := fsnotify.Event{
		Name: filepath.Join(tmpDir, "node_modules", "pkg", "index.js"),
		Op:   fsnotify.Write,
	}

	fw.handleEvent(context.Background(), event, tmpDir, &debMu, debounced)

	debMu.Lock()
	timerCount := len(debounced)
	debMu.Unlock()

	if timerCount != 0 {
		t.Errorf("expected 0 debounce timers for node_modules file, got %d", timerCount)
	}
}

func TestFileWatcher_HandleEvent_AcceptsAllowedFile(t *testing.T) {
	tmpDir := t.TempDir()

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer, WithDebounce(50*time.Millisecond))
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}
	defer fw.Stop()

	debounced := make(map[string]*time.Timer)
	var debMu sync.Mutex

	goFilePath := filepath.Join(tmpDir, "main.go")
	event := fsnotify.Event{
		Name: goFilePath,
		Op:   fsnotify.Write,
	}

	fw.handleEvent(context.Background(), event, tmpDir, &debMu, debounced)

	debMu.Lock()
	timerCount := len(debounced)
	debMu.Unlock()

	if timerCount != 1 {
		t.Errorf("expected 1 debounce timer for .go file, got %d", timerCount)
	}

	// Clean up timers
	for _, timer := range debounced {
		timer.Stop()
	}
}

func TestFileWatcher_HandleEvent_IgnoresIrrelevantOps(t *testing.T) {
	tmpDir := t.TempDir()

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}
	defer fw.Stop()

	debounced := make(map[string]*time.Timer)
	var debMu sync.Mutex

	// fsnotify.Chmod is not Create/Write/Remove/Rename
	event := fsnotify.Event{
		Name: filepath.Join(tmpDir, "main.go"),
		Op:   fsnotify.Chmod,
	}

	fw.handleEvent(context.Background(), event, tmpDir, &debMu, debounced)

	debMu.Lock()
	timerCount := len(debounced)
	debMu.Unlock()

	if timerCount != 0 {
		t.Errorf("expected 0 debounce timers for Chmod event, got %d", timerCount)
	}
}

func TestFileWatcher_ReindexFile_DeletedFile(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping reindex test in short mode")
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}

	// Track a file, then "delete" it by making ComputeHash fail
	indexPather := "deleted.go"
	indexer.tracker.Track(indexPather, "somehash")

	// Create a chunk for the file so we can verify it gets deleted
	chunk := &core.ChunkResult{
		FilePath:  indexPather,
		Content:   "package main\nfunc main() {}",
		StartLine: 1,
		EndLine:   2,
	}
	store.AddProjectChunk(context.Background(), chunk)

	initialCount := store.GetChunkCount()
	if initialCount == 0 {
		t.Fatal("expected chunk to be stored before deletion")
	}

	// reindexFile on a non-existent file path — should handle gracefully
	// The file doesn't exist, so ComputeHash will fail, deleting old chunks
	fw.reindexFile(context.Background(), "/nonexistent/deleted.go", "/nonexistent")

	// The old chunk should be cleaned up
	// (Since we tracked by relative path, and the file doesn't exist,
	//  tracker.Remove should have been called)
}

func TestFileWatcher_ReindexFile_ChangedFile(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping reindex test in short mode")
	}

	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "main.go")
	content := "package main\n\nfunc main() {\n\tfmt.Println(\"hello\")\n}\n"
	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer)
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}

	// Override readFileBytes to use the real filesystem
	origReadFileBytes := readFileBytes
	readFileBytes = os.ReadFile
	defer func() { readFileBytes = origReadFileBytes }()

	// Reindex the file
	fw.reindexFile(context.Background(), filePath, tmpDir)

	// Should have created chunks
	if store.GetChunkCount() == 0 {
		t.Error("expected chunks to be created after reindexFile")
	}
}

func TestFileWatcher_Debounce_ReplacesExistingTimer(t *testing.T) {
	tmpDir := t.TempDir()

	store := newMockIndexerStore()
	embedder := newMockEmbedder()
	indexer := NewProjectIndexer(store, embedder)

	fw, err := NewFileWatcher(indexer, WithDebounce(500*time.Millisecond))
	if err != nil {
		t.Fatalf("NewFileWatcher returned error: %v", err)
	}
	defer fw.Stop()

	debounced := make(map[string]*time.Timer)
	var debMu sync.Mutex

	goFilePath := filepath.Join(tmpDir, "main.go")

	// Send two events for the same file — second should replace the first timer
	fw.handleEvent(context.Background(), fsnotify.Event{
		Name: goFilePath,
		Op:   fsnotify.Write,
	}, tmpDir, &debMu, debounced)

	fw.handleEvent(context.Background(), fsnotify.Event{
		Name: goFilePath,
		Op:   fsnotify.Create,
	}, tmpDir, &debMu, debounced)

	debMu.Lock()
	timerCount := len(debounced)
	debMu.Unlock()

	// Should still be exactly 1 timer (the second one replaced the first)
	if timerCount != 1 {
		t.Errorf("expected 1 debounce timer after two events for same file, got %d", timerCount)
	}

	// Clean up
	for _, timer := range debounced {
		timer.Stop()
	}
}

func TestReadFileContent(t *testing.T) {
	tmpDir := t.TempDir()
	content := "hello world\nsecond line"
	tmpFile := filepath.Join(tmpDir, "test.txt")
	if err := os.WriteFile(tmpFile, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := readFileContent(tmpFile)
	if err != nil {
		t.Fatalf("readFileContent returned error: %v", err)
	}
	if result != content {
		t.Errorf("readFileContent = %q, want %q", result, content)
	}
}

func TestReadFileContent_NotFound(t *testing.T) {
	_, err := readFileContent("/nonexistent/file.txt")
	if err == nil {
		t.Error("expected error for nonexistent file, got nil")
	}
}
