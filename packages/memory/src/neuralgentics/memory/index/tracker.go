package index

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// FileTracker tracks file content hashes to detect changes between indexing runs.
// It is safe for concurrent use.
type FileTracker struct {
	mu     sync.RWMutex
	hashes map[string]string // relative path → SHA-256 hex hash
}

// NewFileTracker creates a new FileTracker with an empty hash map.
func NewFileTracker() *FileTracker {
	return &FileTracker{
		hashes: make(map[string]string),
	}
}

// ComputeHash reads the file at path and returns its SHA-256 hex digest.
// Returns an error if the file cannot be read.
func (ft *FileTracker) ComputeHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("compute hash for %q: %w", path, err)
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

// HasChanged returns true if the file at path has a different hash than the
// previously tracked hash. A file that was never tracked is considered changed.
func (ft *FileTracker) HasChanged(path string, oldHash string) bool {
	ft.mu.RLock()
	tracked, exists := ft.hashes[path]
	ft.mu.RUnlock()

	if !exists {
		return true // never seen = changed
	}
	return tracked != oldHash
}

// Track stores the hash for a given file path.
func (ft *FileTracker) Track(path string, hash string) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	ft.hashes[path] = hash
}

// GetHash returns the tracked hash for a given file path, or empty string if not tracked.
func (ft *FileTracker) GetHash(path string) string {
	ft.mu.RLock()
	defer ft.mu.RUnlock()
	return ft.hashes[path]
}

// Remove removes a path from tracking.
func (ft *FileTracker) Remove(path string) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	delete(ft.hashes, path)
}

// Snapshot returns a copy of all tracked file hashes.
func (ft *FileTracker) Snapshot() map[string]string {
	ft.mu.RLock()
	defer ft.mu.RUnlock()

	result := make(map[string]string, len(ft.hashes))
	for k, v := range ft.hashes {
		result[k] = v
	}
	return result
}

// ShouldSkipDir returns true for directories that should be excluded from indexing.
// This includes node_modules, .git, dist, __pycache__, .venv, vendor, and hidden dirs.
var SkipDirs = map[string]bool{
	"node_modules":  true,
	".git":          true,
	"dist":          true,
	"__pycache__":   true,
	".venv":         true,
	"vendor":        true,
	".cache":        true,
	".next":         true,
	".nuxt":         true,
	"build":         true,
	".tox":          true,
	".mypy_cache":   true,
	".pytest_cache": true,
}

// AllowedExtensions lists file extensions that should be indexed.
var AllowedExtensions = map[string]bool{
	".go":    true,
	".ts":    true,
	".tsx":   true,
	".js":    true,
	".py":    true,
	".md":    true,
	".json":  true,
	".yaml":  true,
	".yml":   true,
	".sql":   true,
	".proto": true,
	".toml":  true,
	".mod":   true,
	".sum":   true,
	".rs":    true,
	".java":  true,
	".rb":    true,
	".c":     true,
	".h":     true,
	".css":   true,
	".html":  true,
}

// ShouldIndexPath checks whether a file path should be indexed based on
// its extension and whether it belongs to a skipped directory.
func ShouldIndexPath(relPath string) bool {
	ext := filepath.Ext(relPath)
	if !AllowedExtensions[ext] {
		return false
	}

	// Check each path component against skip dirs
	dir := filepath.Dir(relPath)
	for dir != "." && dir != "" {
		base := filepath.Base(dir)
		if SkipDirs[base] {
			return false
		}
		dir = filepath.Dir(dir)
	}
	return true
}

// CollectFiles walks the directory at root and returns all file paths that
// pass ShouldIndexPath, as relative paths from root.
func CollectFiles(root string) ([]string, error) {
	var files []string

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			if SkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}

		rel, err := filepath.Rel(root, path)
		if err != nil {
			return fmt.Errorf("relative path for %q: %w", path, err)
		}

		if ShouldIndexPath(rel) {
			files = append(files, rel)
		}
		return nil
	})

	return files, err
}
