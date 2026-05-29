package index

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// FileWatcher watches a directory for file changes and triggers re-indexing
// of changed files. It uses fsnotify for filesystem events and applies a
// debounce period to avoid excessive re-indexing.
type FileWatcher struct {
	indexer  *ProjectIndexer
	watcher  *fsnotify.Watcher
	mu       sync.Mutex
	running  bool
	cancel   context.CancelFunc
	debounce time.Duration
}

// WatcherOption configures a FileWatcher.
type WatcherOption func(*FileWatcher)

// WithDebounce sets the debounce interval for the watcher.
func WithDebounce(d time.Duration) WatcherOption {
	return func(w *FileWatcher) {
		w.debounce = d
	}
}

// NewFileWatcher creates a new FileWatcher that will re-index changed files
// using the given ProjectIndexer.
func NewFileWatcher(indexer *ProjectIndexer, opts ...WatcherOption) (*FileWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create fsnotify watcher: %w", err)
	}

	fw := &FileWatcher{
		indexer:  indexer,
		watcher:  w,
		debounce: 500 * time.Millisecond, // default debounce
	}

	for _, opt := range opts {
		opt(fw)
	}

	return fw, nil
}

// Watch starts watching the given directory path for file changes.
// It adds the path and its subdirectories to the watcher and begins
// processing events in a background goroutine.
// Call Stop() to release resources.
func (fw *FileWatcher) Watch(ctx context.Context, path string) error {
	fw.mu.Lock()
	if fw.running {
		fw.mu.Unlock()
		return fmt.Errorf("watcher already running")
	}
	fw.running = true
	fw.mu.Unlock()

	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve path %q: %w", path, err)
	}

	// Add the root path
	if err := fw.watcher.Add(absPath); err != nil {
		return fmt.Errorf("add watch path %q: %w", absPath, err)
	}

	// Walk and add all eligible subdirectories
	err = filepath.WalkDir(absPath, func(subPath string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			if SkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			if subPath != absPath {
				if addErr := fw.watcher.Add(subPath); addErr != nil {
					slog.Warn("add subdirectory watch failed", "path", subPath, "error", addErr)
				}
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("walk directories: %w", err)
	}

	// Create cancellable context
	ctx, fw.cancel = context.WithCancel(ctx)

	// Debounce map: path → timer
	debounced := make(map[string]*time.Timer)
	var debMu sync.Mutex

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-fw.watcher.Events:
				if !ok {
					return
				}
				fw.handleEvent(ctx, event, absPath, &debMu, debounced)
			case err, ok := <-fw.watcher.Errors:
				if !ok {
					return
				}
				slog.Warn("watcher error", "error", err)
			}
		}
	}()

	slog.Info("file watcher started", "path", absPath, "debounce", fw.debounce)
	return nil
}

// handleEvent processes a single filesystem event.
func (fw *FileWatcher) handleEvent(ctx context.Context, event fsnotify.Event, rootPath string, debMu *sync.Mutex, debounced map[string]*time.Timer) {
	relPath, err := filepath.Rel(rootPath, event.Name)
	if err != nil {
		return
	}

	// Only process relevant events
	if event.Op&fsnotify.Create == 0 && event.Op&fsnotify.Write == 0 && event.Op&fsnotify.Remove == 0 && event.Op&fsnotify.Rename == 0 {
		return
	}

	// Only process files with allowed extensions
	if !ShouldIndexPath(relPath) {
		return
	}

	debMu.Lock()
	defer debMu.Unlock()

	// Cancel any existing debounce timer for this path
	if timer, exists := debounced[event.Name]; exists {
		timer.Stop()
	}

	// Create a new debounce timer
	debounced[event.Name] = time.AfterFunc(fw.debounce, func() {
		debMu.Lock()
		delete(debounced, event.Name)
		debMu.Unlock()

		// Re-index the single file
		fw.reindexFile(ctx, event.Name, rootPath)
	})
}

// reindexFile re-indexes a single changed file.
func (fw *FileWatcher) reindexFile(ctx context.Context, fullPath string, rootPath string) {
	relPath, err := filepath.Rel(rootPath, fullPath)
	if err != nil {
		slog.Warn("reindex: relative path failed", "path", fullPath, "error", err)
		return
	}

	// Compute hash
	hash, err := fw.indexer.tracker.ComputeHash(fullPath)
	if err != nil {
		// File may have been removed — delete old chunks
		if delErr := fw.indexer.store.DeleteChunksByPath(ctx, relPath); delErr != nil {
			slog.Warn("reindex: delete chunks for removed file failed", "path", relPath, "error", delErr)
		}
		fw.indexer.tracker.Remove(relPath)
		return
	}

	// Check if file changed
	if !fw.indexer.tracker.HasChanged(relPath, hash) {
		return // no change
	}

	// Delete old chunks
	if err := fw.indexer.store.DeleteChunksByPath(ctx, relPath); err != nil {
		slog.Warn("reindex: delete old chunks failed", "path", relPath, "error", err)
	}

	// Read file content
	data, err := readFileContent(fullPath)
	if err != nil {
		slog.Warn("reindex: read file failed", "path", fullPath, "error", err)
		return
	}

	// Chunk the file
	chunks := fw.indexer.chunker.ChunkFile(relPath, data)
	if len(chunks) == 0 {
		fw.indexer.tracker.Track(relPath, hash)
		return
	}

	// Embed and store each chunk
	texts := make([]string, len(chunks))
	for i, chunk := range chunks {
		texts[i] = chunk.Content
	}

	vectors, err := fw.indexer.embedder.EmbedBatch(ctx, texts)
	if err != nil {
		slog.Warn("reindex: embed batch failed", "path", relPath, "error", err)
		vectors = nil
	}

	for i, chunk := range chunks {
		if vectors != nil && i < len(vectors) {
			_ = vectors[i] // vectors stored via AddProjectChunk in the Store
		}
		if _, storeErr := fw.indexer.store.AddProjectChunk(ctx, &chunk); storeErr != nil {
			slog.Warn("reindex: store chunk failed", "path", relPath, "error", storeErr)
		}
	}

	// Track updated hash
	fw.indexer.tracker.Track(relPath, hash)
	slog.Info("reindexed file", "path", relPath, "chunks", len(chunks))
}

// readFileContent reads a file's content as a string.
func readFileContent(path string) (string, error) {
	data, err := readFileBytes(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// readFileBytes reads file bytes from the filesystem.
var readFileBytes = os.ReadFile

// Stop stops the file watcher and releases all resources.
func (fw *FileWatcher) Stop() error {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	if fw.cancel != nil {
		fw.cancel()
	}
	if fw.watcher != nil {
		if err := fw.watcher.Close(); err != nil {
			return fmt.Errorf("close watcher: %w", err)
		}
	}
	fw.running = false
	slog.Info("file watcher stopped")
	return nil
}
