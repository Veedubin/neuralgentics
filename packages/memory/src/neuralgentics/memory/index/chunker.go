package index

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ChunkConfig controls how files are split into chunks.
type ChunkConfig struct {
	// MaxLines is the target maximum number of lines per chunk.
	MaxLines int
	// OverlapLines is the number of overlapping lines between consecutive chunks.
	OverlapLines int
	// MaxChunkBytes limits the byte size of a single chunk (0 = unlimited).
	MaxChunkBytes int
}

// DefaultChunkConfig returns the standard chunking configuration:
// ~50 lines per chunk with 5 lines of overlap.
func DefaultChunkConfig() ChunkConfig {
	return ChunkConfig{
		MaxLines:      50,
		OverlapLines:  5,
		MaxChunkBytes: 8000,
	}
}

// Chunker splits file content into semantic chunks for indexing.
type Chunker struct {
	config ChunkConfig
}

// NewChunker creates a new Chunker with the given configuration.
func NewChunker(config ChunkConfig) *Chunker {
	if config.MaxLines <= 0 {
		config.MaxLines = 50
	}
	if config.OverlapLines < 0 {
		config.OverlapLines = 0
	}
	if config.OverlapLines >= config.MaxLines {
		config.OverlapLines = config.MaxLines / 4
	}
	if config.MaxChunkBytes <= 0 {
		config.MaxChunkBytes = 8000
	}
	return &Chunker{config: config}
}

// DetectLanguage returns a language identifier based on file extension.
// Returns "unknown" for unrecognized extensions.
func DetectLanguage(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".go":
		return "go"
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx":
		return "javascript"
	case ".py":
		return "python"
	case ".md":
		return "markdown"
	case ".json":
		return "json"
	case ".yaml", ".yml":
		return "yaml"
	case ".sql":
		return "sql"
	case ".proto":
		return "protobuf"
	case ".toml":
		return "toml"
	case ".rs":
		return "rust"
	case ".java":
		return "java"
	case ".rb":
		return "ruby"
	case ".c", ".h":
		return "c"
	case ".css":
		return "css"
	case ".html":
		return "html"
	case ".mod":
		return "go_mod"
	case ".sum":
		return "go_sum"
	default:
		return "unknown"
	}
}

// ChunkFile splits file content into ChunkResult entries.
// It splits based on language-aware boundaries when possible and
// falls back to line-based chunking otherwise.
func (c *Chunker) ChunkFile(path string, content string) []core.ChunkResult {
	if content == "" {
		return nil
	}

	lines := strings.Split(content, "\n")
	lang := DetectLanguage(path)

	// Languages with AST-aware boundary detection
	switch lang {
	case "go", "typescript", "javascript", "python":
		return c.chunkWithBoundaries(path, lines, lang)
	default:
		return c.chunkLineBased(path, lines)
	}
}

// chunkLineBased creates chunks of MaxLines with OverlapLines overlap.
func (c *Chunker) chunkLineBased(path string, lines []string) []core.ChunkResult {
	var results []core.ChunkResult
	totalLines := len(lines)

	start := 0
	for start < totalLines {
		end := start + c.config.MaxLines
		if end > totalLines {
			end = totalLines
		}

		chunkContent := strings.Join(lines[start:end], "\n")
		result := core.ChunkResult{
			FilePath:  path,
			Content:   chunkContent,
			StartLine: start + 1, // 1-indexed
			EndLine:   end,
			Score:     0,
		}
		results = append(results, result)

		// Advance by (MaxLines - OverlapLines)
		step := c.config.MaxLines - c.config.OverlapLines
		if step <= 0 {
			step = 1
		}
		start += step
	}

	return results
}

// chunkWithBoundaries uses language-specific boundary detection to split
// at function/class boundaries when possible, falling back to line-based.
func (c *Chunker) chunkWithBoundaries(path string, lines []string, lang string) []core.ChunkResult {
	boundaries := findBoundaries(lines, lang)
	if len(boundaries) == 0 {
		return c.chunkLineBased(path, lines)
	}

	var results []core.ChunkResult
	totalLines := len(lines)

	// Add start boundary if not present
	if boundaries[0] > 0 {
		boundaries = append([]int{0}, boundaries...)
	}
	// Add end boundary if not present
	if boundaries[len(boundaries)-1] < totalLines {
		boundaries = append(boundaries, totalLines)
	}

	for i := 0; i < len(boundaries)-1; i++ {
		start := boundaries[i]
		end := boundaries[i+1]

		// If the boundary chunk is too large, split it further
		chunkLines := end - start
		if chunkLines > c.config.MaxLines*2 {
			subChunks := c.splitLargeBoundary(path, lines, start, end)
			results = append(results, subChunks...)
			continue
		}

		chunkContent := strings.Join(lines[start:end], "\n")
		results = append(results, core.ChunkResult{
			FilePath:  path,
			Content:   chunkContent,
			StartLine: start + 1, // 1-indexed
			EndLine:   end,
			Score:     0,
		})
	}

	return results
}

// splitLargeBoundary splits a boundary-based chunk that exceeds MaxLines*2
// into smaller line-based chunks with overlap.
func (c *Chunker) splitLargeBoundary(path string, lines []string, start, end int) []core.ChunkResult {
	var results []core.ChunkResult
	pos := start
	for pos < end {
		chunkEnd := pos + c.config.MaxLines
		if chunkEnd > end {
			chunkEnd = end
		}

		chunkContent := strings.Join(lines[pos:chunkEnd], "\n")
		results = append(results, core.ChunkResult{
			FilePath:  path,
			Content:   chunkContent,
			StartLine: pos + 1,
			EndLine:   chunkEnd,
			Score:     0,
		})

		step := c.config.MaxLines - c.config.OverlapLines
		if step <= 0 {
			step = 1
		}
		pos += step
	}
	return results
}

// findBoundaries finds semantic boundary line numbers based on language.
// Returns line indices (0-based) where function/class definitions start.
func findBoundaries(lines []string, lang string) []int {
	switch lang {
	case "go":
		return findGoBoundaries(lines)
	case "python":
		return findPythonBoundaries(lines)
	case "typescript", "javascript":
		return findJSBoundaries(lines)
	default:
		return nil
	}
}

// findGoBoundaries finds function and method declarations in Go code.
func findGoBoundaries(lines []string) []int {
	var boundaries []int
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if isGoFunctionDecl(trimmed) || isGoTypeDecl(trimmed) {
			boundaries = append(boundaries, i)
		}
	}
	return boundaries
}

func isGoFunctionDecl(line string) bool {
	// Match: func Name( or func (receiver) Name(
	if !strings.HasPrefix(line, "func ") {
		return false
	}
	// Filter out comments
	if strings.HasPrefix(line, "func //") {
		return false
	}
	return strings.Contains(line, "(")
}

func isGoTypeDecl(line string) bool {
	return strings.HasPrefix(line, "type ") && strings.Contains(line, "struct")
}

// findPythonBoundaries finds function and class definitions in Python code.
func findPythonBoundaries(lines []string) []int {
	var boundaries []int
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		// Python functions/classes start at column 0
		if len(line) > 0 && (line[0] != '\t' && !unicode.IsSpace(rune(line[0]))) {
			if strings.HasPrefix(trimmed, "def ") || strings.HasPrefix(trimmed, "class ") {
				boundaries = append(boundaries, i)
			}
			// Top-level if/for/while/try also serve as natural boundaries
			if strings.HasPrefix(trimmed, "if __name__") {
				boundaries = append(boundaries, i)
			}
		}
	}
	return boundaries
}

// findJSBoundaries finds function, class, and export declarations in JS/TS code.
func findJSBoundaries(lines []string) []int {
	var boundaries []int
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if isJSBoundary(trimmed) {
			boundaries = append(boundaries, i)
		}
	}
	return boundaries
}

func isJSBoundary(line string) bool {
	// Export declarations
	if strings.HasPrefix(line, "export ") {
		return true
	}
	// Function declarations
	if strings.HasPrefix(line, "function ") {
		return true
	}
	// Class declarations
	if strings.HasPrefix(line, "class ") {
		return true
	}
	// Const/let/var at module scope (heuristic: starts at column 0)
	if strings.HasPrefix(line, "const ") ||
		strings.HasPrefix(line, "let ") ||
		strings.HasPrefix(line, "var ") {
		return true
	}
	return false
}

// FormatChunkID generates a unique identifier for a chunk based on its file path and line range.
func FormatChunkID(filePath string, startLine, endLine int) string {
	return fmt.Sprintf("%s:%d-%d", filePath, startLine, endLine)
}
