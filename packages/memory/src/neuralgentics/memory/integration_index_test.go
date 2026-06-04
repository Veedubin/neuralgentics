package memory

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// TestIntegration_AddProjectChunk tests adding a file chunk to the
// project_chunks table and verifying it is retrievable.
func TestIntegration_AddProjectChunk(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	defer pgStore.Close(ctx)

	// Add multiple chunks for different files
	chunks := []core.ChunkResult{
		{
			FilePath:  "/src/main.go",
			Content:   "package main\n\nimport \"fmt\"",
			StartLine: 1,
			EndLine:   3,
		},
		{
			FilePath:  "/src/main.go",
			Content:   "func main() {\n\tfmt.Println(\"hello\")",
			StartLine: 5,
			EndLine:   7,
		},
		{
			FilePath:  "/src/utils.go",
			Content:   "package utils\n\nfunc Helper() string {\n\treturn \"helper\"",
			StartLine: 1,
			EndLine:   5,
		},
	}

	for i, chunk := range chunks {
		id, err := pgStore.AddProjectChunk(ctx, &chunk)
		if err != nil {
			t.Fatalf("failed to add chunk %d: %v", i, err)
		}
		if id == "" {
			t.Fatalf("expected non-empty chunk ID for chunk %d", i)
		}
		t.Logf("added chunk %d: %s", i, id)
	}

	// Verify chunks count
	var count int
	err := pgStore.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM project_chunks").Scan(&count)
	if err != nil {
		t.Fatalf("failed to count project chunks: %v", err)
	}
	if count != 3 {
		t.Fatalf("expected 3 project chunks, got %d", count)
	}
}

// TestIntegration_GetFileChunksByPath tests reconstructing file contents
// from indexed chunks by file path.
func TestIntegration_GetFileChunksByPath(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	defer pgStore.Close(ctx)

	// Add multiple chunks for the same file
	filePath := "/src/example.go"
	chunks := []core.ChunkResult{
		{
			FilePath:  filePath,
			Content:   "package example\n\nimport \"fmt\"",
			StartLine: 1,
			EndLine:   3,
		},
		{
			FilePath:  filePath,
			Content:   "// Example function demonstrates chunk reconstruct",
			StartLine: 5,
			EndLine:   5,
		},
	}

	for _, chunk := range chunks {
		_, err := pgStore.AddProjectChunk(ctx, &chunk)
		if err != nil {
			t.Fatalf("failed to add chunk: %v", err)
		}
	}

	// Reconstruct file
	result, err := pgStore.GetFileChunksByPath(ctx, filePath)
	if err != nil {
		t.Fatalf("failed to get file chunks: %v", err)
	}
	if result.FilePath != filePath {
		t.Fatalf("expected file path %s, got: %s", filePath, result.FilePath)
	}
	if result.Contents == "" {
		t.Fatal("expected non-empty contents")
	}
	if !result.IsPartial {
		t.Log("note: file is marked as partial (multiple chunks)")
	}
	t.Logf("reconstructed %d chars for %s", len(result.Contents), filePath)
}

// TestIntegration_DeleteChunksByPath tests deleting all chunks for a given
// file path and verifying the deletion is reflected in the database.
func TestIntegration_DeleteChunksByPath(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	defer pgStore.Close(ctx)

	// Add chunks for two different files
	filePaths := []string{"/src/file_a.go", "/src/file_b.go"}
	for _, fp := range filePaths {
		for i := 0; i < 2; i++ {
			_, err := pgStore.AddProjectChunk(ctx, &core.ChunkResult{
				FilePath:  fp,
				Content:   "line " + string(rune('A'+i)),
				StartLine: i*10 + 1,
				EndLine:   (i + 1) * 10,
			})
			if err != nil {
				t.Fatalf("failed to add chunk for %s: %v", fp, err)
			}
		}
	}

	// Verify 4 chunks total
	var totalCount int
	pgStore.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM project_chunks").Scan(&totalCount)
	if totalCount != 4 {
		t.Fatalf("expected 4 chunks total, got %d", totalCount)
	}

	// Delete chunks for file_a.go
	err := pgStore.DeleteChunksByPath(ctx, "/src/file_a.go")
	if err != nil {
		t.Fatalf("failed to delete chunks by path: %v", err)
	}

	// Verify file_a chunks are gone, file_b chunks remain
	var remainingA int
	pgStore.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM project_chunks WHERE file_path = '/src/file_a.go'").Scan(&remainingA)
	if remainingA != 0 {
		t.Fatalf("expected 0 chunks for file_a after delete, got %d", remainingA)
	}

	var remainingB int
	pgStore.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM project_chunks WHERE file_path = '/src/file_b.go'").Scan(&remainingB)
	if remainingB != 2 {
		t.Fatalf("expected 2 chunks for file_b, got %d", remainingB)
	}

	var totalAfter int
	pgStore.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM project_chunks").Scan(&totalAfter)
	if totalAfter != 2 {
		t.Fatalf("expected 2 chunks total after delete, got %d", totalAfter)
	}
}
