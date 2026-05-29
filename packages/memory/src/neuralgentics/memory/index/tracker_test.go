package index

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

// --- FileTracker unit tests ---

func TestNewFileTracker(t *testing.T) {
	ft := NewFileTracker()
	if ft == nil {
		t.Fatal("NewFileTracker returned nil")
	}
	if len(ft.Snapshot()) != 0 {
		t.Errorf("expected empty hash map, got %d entries", len(ft.Snapshot()))
	}
}

func TestTrackAndGetHash(t *testing.T) {
	ft := NewFileTracker()
	ft.Track("foo.go", "abc123")
	got := ft.GetHash("foo.go")
	if got != "abc123" {
		t.Errorf("GetHash(%q) = %q, want %q", "foo.go", got, "abc123")
	}
}

func TestGetHash_NotTracked(t *testing.T) {
	ft := NewFileTracker()
	got := ft.GetHash("nonexistent.go")
	if got != "" {
		t.Errorf("GetHash for untracked path = %q, want empty string", got)
	}
}

func TestRemove(t *testing.T) {
	ft := NewFileTracker()
	ft.Track("bar.go", "hash1")
	ft.Remove("bar.go")
	got := ft.GetHash("bar.go")
	if got != "" {
		t.Errorf("GetHash after Remove = %q, want empty string", got)
	}
}

func TestSnapshot(t *testing.T) {
	ft := NewFileTracker()
	ft.Track("a.go", "hashA")
	ft.Track("b.go", "hashB")
	snap := ft.Snapshot()
	if len(snap) != 2 {
		t.Fatalf("Snapshot() returned %d entries, want 2", len(snap))
	}
	if snap["a.go"] != "hashA" {
		t.Errorf("Snapshot[a.go] = %q, want %q", snap["a.go"], "hashA")
	}
	if snap["b.go"] != "hashB" {
		t.Errorf("Snapshot[b.go] = %q, want %q", snap["b.go"], "hashB")
	}

	// Snapshot should be a copy — modifying it doesn't affect tracker
	snap["c.go"] = "hashC"
	if ft.GetHash("c.go") != "" {
		t.Error("modifying snapshot should not affect tracker")
	}
}

func TestComputeHash(t *testing.T) {
	// Create a temp file and compute its hash
	tmpDir := t.TempDir()
	content := []byte("hello world")
	tmpFile := filepath.Join(tmpDir, "test.txt")
	if err := os.WriteFile(tmpFile, content, 0o644); err != nil {
		t.Fatalf("failed to write temp file: %v", err)
	}

	ft := NewFileTracker()
	hash, err := ft.ComputeHash(tmpFile)
	if err != nil {
		t.Fatalf("ComputeHash returned error: %v", err)
	}

	// Verify hash matches manual SHA-256
	expected := sha256.Sum256(content)
	expectedHex := hex.EncodeToString(expected[:])
	if hash != expectedHex {
		t.Errorf("ComputeHash = %q, want %q", hash, expectedHex)
	}
}

func TestComputeHash_FileNotFound(t *testing.T) {
	ft := NewFileTracker()
	_, err := ft.ComputeHash("/nonexistent/path/file.go")
	if err == nil {
		t.Error("expected error for nonexistent file, got nil")
	}
}

func TestComputeHash_Consistency(t *testing.T) {
	tmpDir := t.TempDir()
	content := []byte("consistent content")
	tmpFile := filepath.Join(tmpDir, "consistent.go")
	if err := os.WriteFile(tmpFile, content, 0o644); err != nil {
		t.Fatalf("failed to write temp file: %v", err)
	}

	ft := NewFileTracker()
	hash1, err := ft.ComputeHash(tmpFile)
	if err != nil {
		t.Fatalf("first ComputeHash: %v", err)
	}
	hash2, err := ft.ComputeHash(tmpFile)
	if err != nil {
		t.Fatalf("second ComputeHash: %v", err)
	}
	if hash1 != hash2 {
		t.Errorf("same file produced different hashes: %q vs %q", hash1, hash2)
	}
}

func TestComputeHash_DifferentContent(t *testing.T) {
	tmpDir := t.TempDir()

	fileA := filepath.Join(tmpDir, "a.go")
	fileB := filepath.Join(tmpDir, "b.go")
	if err := os.WriteFile(fileA, []byte("content A"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fileB, []byte("content B"), 0o644); err != nil {
		t.Fatal(err)
	}

	ft := NewFileTracker()
	hashA, _ := ft.ComputeHash(fileA)
	hashB, _ := ft.ComputeHash(fileB)
	if hashA == hashB {
		t.Error("different content should produce different hashes")
	}
}

func TestHasChanged_NeverTracked(t *testing.T) {
	ft := NewFileTracker()
	if !ft.HasChanged("new_file.go", "anyhash") {
		t.Error("file never tracked should be considered changed")
	}
}

func TestHasChanged_SameHash(t *testing.T) {
	ft := NewFileTracker()
	ft.Track("same.go", "hash123")
	if ft.HasChanged("same.go", "hash123") {
		t.Error("file with same hash should not be considered changed")
	}
}

func TestHasChanged_DifferentHash(t *testing.T) {
	ft := NewFileTracker()
	ft.Track("changed.go", "old_hash")
	if !ft.HasChanged("changed.go", "new_hash") {
		t.Error("file with different hash should be considered changed")
	}
}

// --- ShouldIndexPath tests (table-driven) ---

func TestShouldIndexPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		// Allowed extensions
		{"main.go", true},
		{"pkg/handler.ts", true},
		{"app.tsx", true},
		{"index.js", true},
		{"script.py", true},
		{"README.md", true},
		{"config.json", true},
		{"app.yaml", true},
		{"app.yml", true},
		{"query.sql", true},
		{"api.proto", true},
		{"go.mod", true},
		{"go.sum", true},
		{"main.rs", true},
		{"App.java", true},
		{"gem.rb", true},
		{"main.c", true},
		{"main.h", true},
		{"style.css", true},
		{"page.html", true},
		{"pyproject.toml", true},

		// Disallowed extensions
		{"image.png", false},
		{"archive.zip", false},
		{"data.csv", false},
		{"binary.exe", false},
		{"font.woff2", false},
		{"video.mp4", false},
		{"Makefile", false}, // no extension

		// Inside skipped directories
		{"node_modules/pkg/index.js", false},
		{".git/config", false},
		{"dist/bundle.js", false},
		{"__pycache__/module.pyc", false}, // .pyc not .py, but also inside skipped dir
		{".venv/lib/python.py", false},
		{"vendor/pkg/vendor.go", false},
		{".cache/data.json", false},
		{".next/build.js", false},
		{".nuxt/dist.js", false},
		{"build/output.js", false},
		{".tox/env/config.toml", false},
		{".mypy_cache/data.json", false},
		{".pytest_cache/data.json", false},
		{"src/node_modules/pkg/index.js", false},
		{"project/.git/HEAD", false},

		// Nested: allowed file in non-skipped dir
		{"src/main.go", true},
		{"pkg/utils/helpers.py", true},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := ShouldIndexPath(tt.path)
			if got != tt.want {
				t.Errorf("ShouldIndexPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

// --- CollectFiles tests ---

func TestCollectFiles_BasicDirectory(t *testing.T) {
	tmpDir := t.TempDir()
	// Create a simple directory structure
	files := []string{
		"main.go",
		"README.md",
		"config.yaml",
	}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(tmpDir, f), []byte("content"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	result, err := CollectFiles(tmpDir)
	if err != nil {
		t.Fatalf("CollectFiles returned error: %v", err)
	}
	if len(result) != 3 {
		t.Errorf("CollectFiles returned %d files, want 3", len(result))
	}
}

func TestCollectFiles_SkipsIgnoredDirs(t *testing.T) {
	tmpDir := t.TempDir()
	// Create files in normal and ignored directories
	if err := os.MkdirAll(filepath.Join(tmpDir, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(tmpDir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(tmpDir, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Indexable file
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Files in ignored dirs
	if err := os.WriteFile(filepath.Join(tmpDir, "node_modules", "pkg.js"), []byte("var x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, ".git", "config"), []byte("git config"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "dist", "bundle.js"), []byte("bundle"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := CollectFiles(tmpDir)
	if err != nil {
		t.Fatalf("CollectFiles returned error: %v", err)
	}
	if len(result) != 1 {
		t.Errorf("CollectFiles returned %d files, want 1 (ignored dirs filtered)", len(result))
	}
	if len(result) > 0 && result[0] != "main.go" {
		t.Errorf("CollectFiles[0] = %q, want %q", result[0], "main.go")
	}
}

func TestCollectFiles_SkipsDisallowedExtensions(t *testing.T) {
	tmpDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpDir, "good.go"), []byte("good"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "bad.png"), []byte("bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "data.csv"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := CollectFiles(tmpDir)
	if err != nil {
		t.Fatalf("CollectFiles returned error: %v", err)
	}
	if len(result) != 1 {
		t.Errorf("CollectFiles returned %d files, want 1 (only .go)", len(result))
	}
}

func TestCollectFiles_NonexistentDir(t *testing.T) {
	_, err := CollectFiles("/nonexistent/directory/path")
	if err == nil {
		t.Error("expected error for nonexistent directory, got nil")
	}
}

func TestCollectFiles_EmptyDirectory(t *testing.T) {
	tmpDir := t.TempDir()
	result, err := CollectFiles(tmpDir)
	if err != nil {
		t.Fatalf("CollectFiles returned error: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("CollectFiles on empty dir returned %d files, want 0", len(result))
	}
}
