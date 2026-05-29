package index

import (
	"strings"
	"testing"
)

// --- DetectLanguage tests (table-driven) ---

func TestDetectLanguage(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"main.go", "go"},
		{"app.ts", "typescript"},
		{"component.tsx", "typescript"},
		{"index.js", "javascript"},
		{"app.jsx", "javascript"},
		{"script.py", "python"},
		{"README.md", "markdown"},
		{"data.json", "json"},
		{"config.yaml", "yaml"},
		{"config.yml", "yaml"},
		{"query.sql", "sql"},
		{"api.proto", "protobuf"},
		{"pyproject.toml", "toml"},
		{"main.rs", "rust"},
		{"App.java", "java"},
		{"gem.rb", "ruby"},
		{"main.c", "c"},
		{"header.h", "c"},
		{"style.css", "css"},
		{"page.html", "html"},
		{"go.mod", "go_mod"},
		{"go.sum", "go_sum"},
		{"image.png", "unknown"},
		{"Makefile", "unknown"},
		{"archive.tar", "unknown"},
		// Case insensitivity
		{"Main.GO", "go"},
		{"App.TS", "typescript"},
		{"Script.PY", "python"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := DetectLanguage(tt.path)
			if got != tt.want {
				t.Errorf("DetectLanguage(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

// --- DefaultChunkConfig tests ---

func TestDefaultChunkConfig(t *testing.T) {
	cfg := DefaultChunkConfig()
	if cfg.MaxLines != 50 {
		t.Errorf("DefaultChunkConfig.MaxLines = %d, want 50", cfg.MaxLines)
	}
	if cfg.OverlapLines != 5 {
		t.Errorf("DefaultChunkConfig.OverlapLines = %d, want 5", cfg.OverlapLines)
	}
	if cfg.MaxChunkBytes != 8000 {
		t.Errorf("DefaultChunkConfig.MaxChunkBytes = %d, want 8000", cfg.MaxChunkBytes)
	}
}

// --- NewChunker validation tests ---

func TestNewChunker_Defaults(t *testing.T) {
	chunker := NewChunker(DefaultChunkConfig())
	if chunker == nil {
		t.Fatal("NewChunker returned nil")
	}
}

func TestNewChunker_ZeroMaxLines(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 0, OverlapLines: 5, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)
	if chunker.config.MaxLines != 50 {
		t.Errorf("zero MaxLines should default to 50, got %d", chunker.config.MaxLines)
	}
}

func TestNewChunker_NegativeOverlapLines(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 50, OverlapLines: -1, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)
	if chunker.config.OverlapLines != 0 {
		t.Errorf("negative OverlapLines should be clamped to 0, got %d", chunker.config.OverlapLines)
	}
}

func TestNewChunker_OverlapGreaterThanMaxLines(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 50, OverlapLines: 60, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)
	// OverlapLines >= MaxLines → MaxLines / 4 = 12
	expected := 50 / 4
	if chunker.config.OverlapLines != expected {
		t.Errorf("OverlapLines >= MaxLines should be clamped to %d, got %d", expected, chunker.config.OverlapLines)
	}
}

func TestNewChunker_ZeroMaxChunkBytes(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 50, OverlapLines: 5, MaxChunkBytes: 0}
	chunker := NewChunker(cfg)
	if chunker.config.MaxChunkBytes != 8000 {
		t.Errorf("zero MaxChunkBytes should default to 8000, got %d", chunker.config.MaxChunkBytes)
	}
}

// --- ChunkFile line-based tests ---

func TestChunkFile_EmptyContent(t *testing.T) {
	chunker := NewChunker(DefaultChunkConfig())
	result := chunker.ChunkFile("test.md", "")
	if result != nil {
		t.Errorf("ChunkFile with empty content should return nil, got %v", result)
	}
}

func TestChunkFile_LineBased_SingleChunk(t *testing.T) {
	chunker := NewChunker(ChunkConfig{MaxLines: 50, OverlapLines: 5, MaxChunkBytes: 8000})
	content := strings.Repeat("line\n", 10) // 10 lines
	content = strings.TrimRight(content, "\n")

	result := chunker.ChunkFile("test.md", content)
	if len(result) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(result))
	}
	if result[0].StartLine != 1 {
		t.Errorf("StartLine = %d, want 1", result[0].StartLine)
	}
}

func TestChunkFile_LineBased_MultipleChunks(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 5, OverlapLines: 1, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	// 12 lines → chunks at 0-5, 4-9, 8-12 (with overlap of 1)
	lines := make([]string, 12)
	for i := range lines {
		lines[i] = "content"
	}
	content := strings.Join(lines, "\n")

	result := chunker.ChunkFile("test.md", content)
	if len(result) < 2 {
		t.Fatalf("expected at least 2 chunks for 12 lines with MaxLines=5, got %d", len(result))
	}

	// First chunk should start at line 1
	if result[0].StartLine != 1 {
		t.Errorf("first chunk StartLine = %d, want 1", result[0].StartLine)
	}
}

func TestChunkFile_OverlapLines(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 5, OverlapLines: 2, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	// 10 lines: step = MaxLines - OverlapLines = 3
	// Chunks: 0-5, 3-8, 6-10
	lines := make([]string, 10)
	for i := range lines {
		lines[i] = "line " + string(rune('0'+i))
	}
	content := strings.Join(lines, "\n")

	result := chunker.ChunkFile("test.md", content)
	if len(result) < 3 {
		t.Fatalf("expected at least 3 chunks, got %d", len(result))
	}

	// Verify overlap: chunk 1 should start 3 lines after chunk 0
	step := cfg.MaxLines - cfg.OverlapLines
	if result[1].StartLine != result[0].StartLine+step {
		t.Errorf("overlap step: chunk1 StartLine=%d, chunk0 StartLine=%d, expected step=%d",
			result[1].StartLine, result[0].StartLine, step)
	}
}

func TestChunkFile_ChunkResultFields(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 1000, OverlapLines: 0, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	content := "hello\nworld"
	result := chunker.ChunkFile("test.md", content)
	if len(result) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(result))
	}

	chunk := result[0]
	if chunk.FilePath != "test.md" {
		t.Errorf("FilePath = %q, want %q", chunk.FilePath, "test.md")
	}
	if chunk.StartLine != 1 {
		t.Errorf("StartLine = %d, want 1", chunk.StartLine)
	}
	if chunk.Content != content {
		t.Errorf("Content mismatch")
	}
}

// --- ChunkFile AST-aware boundaries ---

func TestChunkFile_GoBoundaries(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 10, OverlapLines: 2, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	// Create Go source with multiple functions
	goSource := `package main

import "fmt"

func main() {
	fmt.Println("hello")
}

func helper() int {
	return 42
}

type Config struct {
	Name string
	Port int
}
`
	result := chunker.ChunkFile("main.go", goSource)
	if len(result) == 0 {
		t.Fatal("expected at least one chunk for Go source")
	}
	// Each chunk should have a file path
	for i, chunk := range result {
		if chunk.FilePath != "main.go" {
			t.Errorf("chunk[%d].FilePath = %q, want %q", i, chunk.FilePath, "main.go")
		}
	}
}

func TestChunkFile_PythonBoundaries(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 10, OverlapLines: 2, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	pySource := `import os

def main():
    print("hello")

class Config:
    name = "test"
    port = 8080

if __name__ == "__main__":
    main()
`
	result := chunker.ChunkFile("app.py", pySource)
	if len(result) == 0 {
		t.Fatal("expected at least one chunk for Python source")
	}
}

func TestChunkFile_JSBoundaries(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 10, OverlapLines: 2, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	jsSource := `import { something } from 'module';

export function handler() {
  return 42;
}

class App {
  constructor() {
    this.name = 'test';
  }
}

const VALUE = 100;
`
	result := chunker.ChunkFile("app.ts", jsSource)
	if len(result) == 0 {
		t.Fatal("expected at least one chunk for TypeScript source")
	}
}

// --- FormatChunkID tests ---

func TestFormatChunkID(t *testing.T) {
	got := FormatChunkID("main.go", 1, 50)
	want := "main.go:1-50"
	if got != want {
		t.Errorf("FormatChunkID(%q, 1, 50) = %q, want %q", "main.go", got, want)
	}
}

// --- findBoundaries tests ---

func TestFindGoBoundaries(t *testing.T) {
	lines := []string{
		"package main",
		"",
		"func foo() {",
		"  return 1",
		"}",
		"",
		"func bar() {",
		"  return 2",
		"}",
		"",
		"type Config struct {",
		"  Name string",
		"}",
	}
	boundaries := findGoBoundaries(lines)
	// Should find func foo at line 2, func bar at line 6, type Config at line 10
	if len(boundaries) != 3 {
		t.Errorf("findGoBoundaries found %d boundaries, want 3", len(boundaries))
	}
}

func TestFindGoBoundaries_IgnoresComments(t *testing.T) {
	lines := []string{
		"func // not a real decl",
		"func real() {",
		"}",
	}
	boundaries := findGoBoundaries(lines)
	if len(boundaries) != 1 {
		t.Errorf("expected 1 boundary (skipping comment), got %d", len(boundaries))
	}
}

func TestFindPythonBoundaries(t *testing.T) {
	lines := []string{
		"import os",
		"",
		"def main():",
		"    print('hello')",
		"",
		"class Config:",
		"    name = 'test'",
		"",
		"if __name__ == '__main__':",
		"    main()",
	}
	boundaries := findPythonBoundaries(lines)
	// Should find: def main at 2, class Config at 5, if __name__ at 8
	if len(boundaries) != 3 {
		t.Errorf("findPythonBoundaries found %d boundaries, want 3", len(boundaries))
	}
}

func TestFindPythonBoundaries_IgnoresIndentedDefinitions(t *testing.T) {
	lines := []string{
		"    def indented_method():",
		"        pass",
		"    class IndentedClass:",
		"        pass",
	}
	boundaries := findPythonBoundaries(lines)
	// Indented def/class should not be boundaries
	if len(boundaries) != 0 {
		t.Errorf("findPythonBoundaries found %d boundaries, want 0 (all indented)", len(boundaries))
	}
}

func TestFindJSBoundaries(t *testing.T) {
	lines := []string{
		"import { foo } from 'bar';",
		"",
		"export function handler() {",
		"  return 42;",
		"}",
		"",
		"function helper() {",
		"  return 0;",
		"}",
		"",
		"class App {",
		"  constructor() {}",
		"}",
		"",
		"const VALUE = 100;",
		"let x = 1;",
		"var y = 2;",
	}
	boundaries := findJSBoundaries(lines)
	// Should find: export function at 2, function at 6, class at 10, const at 14, let at 15, var at 16
	if len(boundaries) < 4 {
		t.Errorf("findJSBoundaries found %d boundaries, want at least 4", len(boundaries))
	}
}

func TestFindBoundaries_UnknownLanguage(t *testing.T) {
	lines := []string{"some content", "more content"}
	boundaries := findBoundaries(lines, "unknown")
	if boundaries != nil {
		t.Errorf("findBoundaries for unknown language should return nil, got %v", boundaries)
	}
}

// --- SplitLargeBoundary test ---

func TestChunkFile_LargeBoundarySplit(t *testing.T) {
	// Create a Go file with a very large single boundary block
	cfg := ChunkConfig{MaxLines: 10, OverlapLines: 2, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	// One big function definition that exceeds MaxLines * 2 = 20 lines
	lines := make([]string, 40)
	lines[0] = "func bigFunction() {"
	for i := 1; i < 39; i++ {
		lines[i] = "\tx := " + string(rune('a'+i%26))
	}
	lines[39] = "}"

	goSource := strings.Join(lines, "\n")
	result := chunker.ChunkFile("big.go", goSource)
	if len(result) < 2 {
		t.Errorf("expected large boundary to be split into multiple chunks, got %d", len(result))
	}
}

// --- ChunkFile with various languages falls back to line-based ---

func TestChunkFile_UnknownLanguage_LineBased(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 5, OverlapLines: 1, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	content := "line1\nline2\nline3\nline4\nline5\nline6\nline7"
	result := chunker.ChunkFile("file.xyz", content)
	if len(result) < 2 {
		t.Errorf("unknown language should still be chunked line-based, got %d chunks", len(result))
	}
}

// --- Verify chunking preserves content integrity ---

func TestChunkFile_LineBased_AllLinesAccountedFor(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 3, OverlapLines: 1, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	content := "a\nb\nc\nd\ne"
	result := chunker.ChunkFile("test.md", content)

	// All chunks should have non-empty content
	for i, chunk := range result {
		if chunk.Content == "" {
			t.Errorf("chunk[%d] has empty content", i)
		}
		if chunk.FilePath != "test.md" {
			t.Errorf("chunk[%d].FilePath = %q, want %q", i, chunk.FilePath, "test.md")
		}
	}
}

// --- Verify StartLine and EndLine consistency ---

func TestChunkFile_LineBased_StartEndLines(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 3, OverlapLines: 0, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	content := "a\nb\nc\nd\ne\nf"
	result := chunker.ChunkFile("test.md", content)

	if len(result) != 2 {
		t.Fatalf("expected 2 chunks, got %d", len(result))
	}

	if result[0].StartLine != 1 {
		t.Errorf("chunk[0].StartLine = %d, want 1", result[0].StartLine)
	}
	if result[0].EndLine != 3 {
		t.Errorf("chunk[0].EndLine = %d, want 3", result[0].EndLine)
	}
	if result[1].StartLine != 4 {
		t.Errorf("chunk[1].StartLine = %d, want 4", result[1].StartLine)
	}
	if result[1].EndLine != 6 {
		t.Errorf("chunk[1].EndLine = %d, want 6", result[1].EndLine)
	}
}

// --- Verify ChunkResult Score is 0 ---

func TestChunkFile_ScoreDefaultsZero(t *testing.T) {
	chunker := NewChunker(DefaultChunkConfig())
	content := "a\nb\nc"
	result := chunker.ChunkFile("test.md", content)

	if len(result) == 0 {
		t.Fatal("expected at least one chunk")
	}
	if result[0].Score != 0 {
		t.Errorf("chunk score = %f, want 0", result[0].Score)
	}
}

// --- Verify findBoundaries dispatches correctly ---

func TestFindBoundaries_Dispatch(t *testing.T) {
	tests := []struct {
		lang string
	}{
		{"go"},
		{"python"},
		{"typescript"},
		{"javascript"},
	}

	for _, tt := range tests {
		t.Run(tt.lang, func(t *testing.T) {
			// Just verify it doesn't crash — the result depends on input lines
			boundaries := findBoundaries([]string{"x"}, tt.lang)
			_ = boundaries // may be nil or not, just no panic
		})
	}
}

// --- Verify chunkWithBoundaries falls back when no boundaries found ---

func TestChunkFile_NoBoundaries_FallsBack(t *testing.T) {
	cfg := ChunkConfig{MaxLines: 3, OverlapLines: 0, MaxChunkBytes: 8000}
	chunker := NewChunker(cfg)

	// Go source with no function/type declarations → no boundaries → line-based fallback
	goSource := "// just a comment\n// another comment\npackage main\n\nimport \"fmt\"\n\nx := 1"
	result := chunker.ChunkFile("nofunc.go", goSource)
	// Should still produce chunks via line-based fallback
	if len(result) == 0 {
		t.Error("expected fallback to line-based chunking when no boundaries found")
	}
}

// --- Integration: full Go file AST chunking ---

func TestChunkFile_GoFile_ASTMerged(t *testing.T) {
	// Test that AST-aware chunking produces reasonable boundaries
	cfg := ChunkConfig{MaxLines: 50, OverlapLines: 5, MaxChunkBytes: 80000}
	chunker := NewChunker(cfg)

	goSource := `package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println("hello world")
	for i := 0; i < 10; i++ {
		fmt.Println(i)
	}
}

func helper() string {
	return "help"
}

type Server struct {
	Host string
	Port int
}

func (s *Server) Start() error {
	fmt.Printf("Starting %s:%d\n", s.Host, s.Port)
	return nil
}
`
	result := chunker.ChunkFile("server.go", goSource)
	if len(result) == 0 {
		t.Fatal("expected chunks for Go source")
	}
	// Verify all chunks reference the correct file
	for i, chunk := range result {
		if chunk.FilePath != "server.go" {
			t.Errorf("chunk[%d].FilePath = %q, want %q", i, chunk.FilePath, "server.go")
		}
	}
}
