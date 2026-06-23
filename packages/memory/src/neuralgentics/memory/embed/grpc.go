package embed

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "neuralgentics/proto/embedding/v1"

	"neuralgentics/src/neuralgentics/memory/core"
)

// GRPCEmbedder connects to the Python embedding sidecar via gRPC
// and implements the core.Embedder interface.
type GRPCEmbedder struct {
	conn         *grpc.ClientConn
	client       pb.EmbeddingServiceClient
	addr         string
	logger       *slog.Logger
	healthy      atomic.Bool  // true when last health check succeeded
	healthTicker *time.Ticker // stopped by Close()
}

// NewGRPCEmbedder creates a new gRPC embedder client.
// addr should be a gRPC target string, e.g. "unix:///tmp/neuralgentics-embed.sock"
// or "localhost:50051".
func NewGRPCEmbedder(addr string, logger *slog.Logger) *GRPCEmbedder {
	if logger == nil {
		logger = slog.Default()
	}
	g := &GRPCEmbedder{
		addr:   addr,
		logger: logger,
	}
	g.healthy.Store(true) // optimistic until first health check
	return g
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

// Embed generates a single 384-dim embedding vector from text.
func (g *GRPCEmbedder) Embed(ctx context.Context, text string) ([]float64, error) {
	return g.embedWithModel(ctx, text, "") // empty model = default (MiniLM 384-dim)
}

// Embed1024 generates a single 1024-dim embedding vector from text.
func (g *GRPCEmbedder) Embed1024(ctx context.Context, text string) ([]float64, error) {
	return g.embedWithModel(ctx, text, "bge-large") // request 1024-dim BGE-Large model
}

// embedWithModel sends a single embedding request with an optional model hint.
func (g *GRPCEmbedder) embedWithModel(ctx context.Context, text, model string) ([]float64, error) {
	if g.client == nil {
		if err := g.Connect(ctx); err != nil {
			return nil, fmt.Errorf("reconnect: %w", err)
		}
	}

	resp, err := g.client.Embed(ctx, &pb.EmbedRequest{
		Text:  text,
		Model: model,
	})
	if err != nil {
		g.logger.Warn("embed RPC failed, attempting reconnect", "error", err)
		if reconnectErr := g.reconnect(ctx); reconnectErr != nil {
			return nil, fmt.Errorf("embed failed and reconnect failed: original=%w, reconnect=%w (hint: run scripts/sidecar.sh status)", err, reconnectErr)
		}
		resp, err = g.client.Embed(ctx, &pb.EmbedRequest{Text: text, Model: model})
		if err != nil {
			return nil, fmt.Errorf("embed after reconnect: %w", err)
		}
	}

	return float32SliceToFloat64(resp.Vector), nil
}

// Dim returns the default embedding dimension (384 for MiniLM).
func (g *GRPCEmbedder) Dim() int {
	return 384
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
		return nil, fmt.Errorf("embed batch open stream: %w (hint: run scripts/sidecar.sh status)", err)
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
			return nil, fmt.Errorf("embed batch receive: %w (hint: run scripts/sidecar.sh status)", recvErr)
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
		return fmt.Errorf("health check: %w (hint: run scripts/sidecar.sh status)", err)
	}
	if resp.Status != "ready" {
		return fmt.Errorf("sidecar not ready: %s", resp.Status)
	}
	return nil
}

// Close shuts down the gRPC connection and stops the health check ticker.
func (g *GRPCEmbedder) Close(ctx context.Context) error {
	if g.healthTicker != nil {
		g.healthTicker.Stop()
	}
	if g.conn != nil {
		return g.conn.Close()
	}
	return nil
}

// StartHealthCheck launches a background goroutine that calls Health periodically.
// It returns a *time.Ticker so the caller can Stop() it on shutdown.
// The health status is accessible via IsHealthy().
func (g *GRPCEmbedder) StartHealthCheck(ctx context.Context, interval time.Duration) *time.Ticker {
	ticker := time.NewTicker(interval)
	g.healthTicker = ticker
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := g.Health(ctx); err != nil {
					g.healthy.Store(false)
					g.logger.Warn("sidecar health check failed", "error", err,
						"hint", "run: scripts/sidecar.sh status && scripts/sidecar.sh start")
				} else {
					g.healthy.Store(true)
				}
			}
		}
	}()
	return ticker
}

// IsHealthy returns true if the last background health check succeeded.
func (g *GRPCEmbedder) IsHealthy() bool {
	return g.healthy.Load()
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
