package embed

import (
	"context"

	"neuralgentics/src/neuralgentics/memory/core"
)

// EmbeddingDimension is the fixed 384-dim vector dimension for the NoOp embedder.
const EmbeddingDimension = 384

// EmbeddingDimension1024 is the 1024-dim vector dimension for dual-model RRF.
const EmbeddingDimension1024 = 1024

// NoOpEmbedder returns a fixed zero vector of the specified dimension.
// It satisfies the core.Embedder interface and is used for testing
// where real embedding quality is not needed.
type NoOpEmbedder struct {
	dim int
}

// NewNoOpEmbedder creates a NoOpEmbedder with 384-dimension zero vectors.
func NewNoOpEmbedder() *NoOpEmbedder {
	return &NoOpEmbedder{dim: EmbeddingDimension}
}

// NewNoOpEmbedder1024 creates a NoOpEmbedder with 1024-dimension zero vectors.
func NewNoOpEmbedder1024() *NoOpEmbedder {
	return &NoOpEmbedder{dim: EmbeddingDimension1024}
}

// Embed returns a zero vector of the configured dimension.
func (n *NoOpEmbedder) Embed(ctx context.Context, text string) ([]float64, error) {
	return make([]float64, n.dim), nil
}

// Embed1024 returns a zero vector of 1024 dimensions.
func (n *NoOpEmbedder) Embed1024(ctx context.Context, text string) ([]float64, error) {
	return make([]float64, EmbeddingDimension1024), nil
}

// EmbedBatch returns zero vectors for each input text.
func (n *NoOpEmbedder) EmbedBatch(ctx context.Context, texts []string) ([][]float64, error) {
	result := make([][]float64, len(texts))
	for i := range texts {
		result[i] = make([]float64, n.dim)
	}
	return result, nil
}

// Health always returns nil (NoOp embedder is always healthy).
func (n *NoOpEmbedder) Health(ctx context.Context) error {
	return nil
}

// Close is a no-op.
func (n *NoOpEmbedder) Close(ctx context.Context) error {
	return nil
}

// Dim returns the vector dimension this embedder produces.
func (n *NoOpEmbedder) Dim() int {
	return n.dim
}

// Verify NoOpEmbedder satisfies core.Embedder at compile time.
var _ core.Embedder = (*NoOpEmbedder)(nil)
