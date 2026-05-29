package embed

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "neuralgentics/proto/embedding/v1"

	"neuralgentics/src/neuralgentics/memory/core"
)

// GRPCEmbedder connects to the Python embedding sidecar via gRPC
// and implements the core.Embedder interface.
type GRPCEmbedder struct {
	conn   *grpc.ClientConn
	client pb.EmbeddingServiceClient
	addr   string
	logger *slog.Logger
}

// NewGRPCEmbedder creates a new gRPC embedder client.
// addr should be a gRPC target string, e.g. "unix:///tmp/neuralgentics-embed.sock"
// or "localhost:50051".
func NewGRPCEmbedder(addr string, logger *slog.Logger) *GRPCEmbedder {
	if logger == nil {
		logger = slog.Default()
	}
	return &GRPCEmbedder{
		addr:   addr,
		logger: logger,
	}
}

// Connect establishes the gRPC connection to the sidecar.
// Must be called before Embed/EmbedBatch/Health.
func (g *GRPCEmbedder) Connect(ctx context.Context) error {
	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(16 * 1024 * 1024)), // 16 MB
	}

	conn, err := grpc.NewClient(g.addr, opts...)
	if err != nil {
		return fmt.Errorf("grpc dial %s: %w", g.addr, err)
	}

	g.conn = conn
	g.client = pb.NewEmbeddingServiceClient(conn)
	g.logger.Info("gRPC embedder connected", "addr", g.addr)
	return nil
}

// Embed generates a single embedding vector from text.
func (g *GRPCEmbedder) Embed(ctx context.Context, text string) ([]float64, error) {
	if g.client == nil {
		if err := g.Connect(ctx); err != nil {
			return nil, fmt.Errorf("reconnect: %w", err)
		}
	}

	resp, err := g.client.Embed(ctx, &pb.EmbedRequest{
		Text:  text,
		Model: "",
	})
	if err != nil {
		// Attempt a single reconnect on failure
		g.logger.Warn("embed RPC failed, attempting reconnect", "error", err)
		if reconnectErr := g.reconnect(ctx); reconnectErr != nil {
			return nil, fmt.Errorf("embed failed and reconnect failed: original=%w, reconnect=%w", err, reconnectErr)
		}
		resp, err = g.client.Embed(ctx, &pb.EmbedRequest{Text: text, Model: ""})
		if err != nil {
			return nil, fmt.Errorf("embed after reconnect: %w", err)
		}
	}

	return float32SliceToFloat64(resp.Vector), nil
}

// EmbedBatch generates embedding vectors for multiple texts.
func (g *GRPCEmbedder) EmbedBatch(ctx context.Context, texts []string) ([][]float64, error) {
	if g.client == nil {
		if err := g.Connect(ctx); err != nil {
			return nil, fmt.Errorf("reconnect: %w", err)
		}
	}

	stream, err := g.client.EmbedBatch(ctx)
	if err != nil {
		return nil, fmt.Errorf("embed batch open stream: %w", err)
	}

	for _, text := range texts {
		if sendErr := stream.Send(&pb.EmbedRequest{Text: text, Model: ""}); sendErr != nil {
			return nil, fmt.Errorf("embed batch send: %w", sendErr)
		}
	}
	if err := stream.CloseSend(); err != nil {
		return nil, fmt.Errorf("embed batch close send: %w", err)
	}

	var results [][]float64
	for {
		resp, recvErr := stream.Recv()
		if recvErr == io.EOF {
			break
		}
		if recvErr != nil {
			return nil, fmt.Errorf("embed batch receive: %w", recvErr)
		}
		results = append(results, float32SliceToFloat64(resp.Vector))
	}

	return results, nil
}

// Health checks if the embedding sidecar is ready.
func (g *GRPCEmbedder) Health(ctx context.Context) error {
	if g.client == nil {
		if err := g.Connect(ctx); err != nil {
			return fmt.Errorf("connect for health check: %w", err)
		}
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := g.client.Health(ctx, &pb.HealthRequest{})
	if err != nil {
		return fmt.Errorf("health check: %w", err)
	}
	if resp.Status != "ready" {
		return fmt.Errorf("sidecar not ready: %s", resp.Status)
	}
	return nil
}

// Close shuts down the gRPC connection.
func (g *GRPCEmbedder) Close(ctx context.Context) error {
	if g.conn != nil {
		return g.conn.Close()
	}
	return nil
}

// reconnect attempts to re-establish the gRPC connection with a brief backoff.
func (g *GRPCEmbedder) reconnect(ctx context.Context) error {
	if g.conn != nil {
		_ = g.conn.Close()
		g.conn = nil
		g.client = nil
	}

	// Brief backoff before reconnecting
	select {
	case <-time.After(500 * time.Millisecond):
	case <-ctx.Done():
		return ctx.Err()
	}

	if err := g.Connect(ctx); err != nil {
		return fmt.Errorf("reconnect: %w", err)
	}
	return nil
}

// float32SliceToFloat64 converts a []float32 to []float64.
func float32SliceToFloat64(in []float32) []float64 {
	out := make([]float64, len(in))
	for i, v := range in {
		out[i] = float64(v)
	}
	return out
}

// Verify GRPCEmbedder satisfies core.Embedder at compile time.
var _ core.Embedder = (*GRPCEmbedder)(nil)
