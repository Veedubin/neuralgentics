package embed

import (
	"context"

	"neuralgentics/src/neuralgentics/memory/core"
)

// EmbeddingDimension is the fixed vector dimension for the NoOp embedder.
const EmbeddingDimension = 384

// NoOpEmbedder returns a fixed zero vector of 384 dimensions.
// It satisfies the core.Embedder interface and is used for testing
// where real embedding quality is not needed.
type NoOpEmbedder struct {
	dim int
}

// NewNoOpEmbedder creates a NoOpEmbedder with 384-dimension zero vectors.
func NewNoOpEmbedder() *NoOpEmbedder {
	return &NoOpEmbedder{dim: EmbeddingDimension}
}

// Embed returns a 384-dimension zero vector for the input text.
func (n *NoOpEmbedder) Embed(ctx context.Context, text string) ([]float64, error) {
	return make([]float64, n.dim), nil
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

// Verify NoOpEmbedder satisfies core.Embedder at compile time.
var _ core.Embedder = (*NoOpEmbedder)(nil)
