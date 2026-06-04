// Package llm provides an OpenAI-compatible HTTP client that implements core.LLMClient.
// It supports chat completions, embeddings, and health checks with retry logic.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

const (
	defaultHTTPTimeout = 60 * time.Second
	maxRetries         = 3
	initialBackoff     = 1 * time.Second
	backoffMultiplier  = 2.0
)

// OpenAIClient implements core.LLMClient using OpenAI-compatible HTTP endpoints.
type OpenAIClient struct {
	baseURL    string
	apiKey     string
	model      string
	embedModel string
	httpClient *http.Client
}

// NewOpenAIClient creates a new OpenAI-compatible LLM client.
// baseURL is the API root (e.g. "http://localhost:8903/v1").
// apiKey may be empty for local/unauthenticated endpoints.
// model is the chat completion model name.
func NewOpenAIClient(baseURL, apiKey, model string) *OpenAIClient {
	return &OpenAIClient{
		baseURL: baseURL,
		apiKey:  apiKey,
		model:   model,
		httpClient: &http.Client{
			Timeout: defaultHTTPTimeout,
		},
	}
}

// NewOpenAIClientWithEmbedModel creates a client with separate chat and embedding models.
func NewOpenAIClientWithEmbedModel(baseURL, apiKey, chatModel, embedModel string) *OpenAIClient {
	c := NewOpenAIClient(baseURL, apiKey, chatModel)
	c.embedModel = embedModel
	return c
}

// Chat sends a chat completion request and returns the assistant's response text.
func (c *OpenAIClient) Chat(ctx context.Context, messages []core.ConversationMessage, temperature float64) (string, error) {
	if len(messages) == 0 {
		return "", fmt.Errorf("llm: messages must not be empty")
	}

	reqBody := chatRequest{
		Model:       c.model,
		Messages:    messages,
		Temperature: temperature,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("llm: marshal chat request: %w", err)
	}

	respBody, err := c.doWithRetry(ctx, http.MethodPost, "/chat/completions", body)
	if err != nil {
		return "", fmt.Errorf("llm: chat request: %w", err)
	}

	var resp chatResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return "", fmt.Errorf("llm: decode chat response: %w", err)
	}

	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("llm: chat response has no choices")
	}

	return resp.Choices[0].Message.Content, nil
}

// Embed sends an embedding request and returns the embedding vector.
func (c *OpenAIClient) Embed(ctx context.Context, text string) ([]float64, error) {
	if text == "" {
		return nil, fmt.Errorf("llm: text must not be empty")
	}

	model := c.embedModel
	if model == "" {
		model = c.model
	}

	reqBody := embedRequest{
		Model: model,
		Input: text,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("llm: marshal embed request: %w", err)
	}

	respBody, err := c.doWithRetry(ctx, http.MethodPost, "/embeddings", body)
	if err != nil {
		return nil, fmt.Errorf("llm: embed request: %w", err)
	}

	var resp embedResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return nil, fmt.Errorf("llm: decode embed response: %w", err)
	}

	if len(resp.Data) == 0 {
		return nil, fmt.Errorf("llm: embed response has no data")
	}

	return resp.Data[0].Embedding, nil
}

// Health checks the LLM endpoint by issuing GET /models (or /health as fallback).
func (c *OpenAIClient) Health(ctx context.Context) error {
	_, err := c.doWithRetry(ctx, http.MethodGet, "/models", nil)
	if err != nil {
		// Fallback: try /health endpoint
		_, err2 := c.doRequest(ctx, http.MethodGet, "/health", nil)
		if err2 != nil {
			return fmt.Errorf("llm: health check failed (models: %v, health: %v)", err, err2)
		}
	}
	return nil
}

// Close is a no-op for HTTP clients.
func (c *OpenAIClient) Close(ctx context.Context) error {
	return nil
}

// doWithRetry executes an HTTP request with exponential backoff retry (3 retries).
// It only retries on server errors (5xx) or network errors; 4xx errors are not retried.
func (c *OpenAIClient) doWithRetry(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			delay := time.Duration(math.Pow(backoffMultiplier, float64(attempt-1))) * initialBackoff
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}

		respBody, err := c.doRequest(ctx, method, path, body)
		if err == nil {
			return respBody, nil
		}

		lastErr = err

		// Don't retry client errors (4xx)
		if isClientError(err) {
			return nil, err
		}
	}

	return nil, fmt.Errorf("llm: %d retries exhausted: %w", maxRetries, lastErr)
}

// doRequest executes a single HTTP request against the LLM endpoint.
func (c *OpenAIClient) doRequest(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	url := c.baseURL + path

	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http do: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	if resp.StatusCode >= 500 {
		return nil, &serverError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	if resp.StatusCode >= 400 {
		return nil, &clientError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	return respBody, nil
}

// isClientError returns true if the error is a 4xx client error (should not retry).
func isClientError(err error) bool {
	_, ok := err.(*clientError)
	return ok
}

// ─── Error types ──────────────────────────────────────────────────────────────

type serverError struct {
	StatusCode int
	Body       string
}

func (e *serverError) Error() string {
	return fmt.Sprintf("server error %d: %s", e.StatusCode, e.Body)
}

type clientError struct {
	StatusCode int
	Body       string
}

func (e *clientError) Error() string {
	return fmt.Sprintf("client error %d: %s", e.StatusCode, e.Body)
}

// ─── OpenAI API request/response types ────────────────────────────────────────

type chatRequest struct {
	Model       string                     `json:"model"`
	Messages    []core.ConversationMessage `json:"messages"`
	Temperature float64                    `json:"temperature"`
}

type chatResponse struct {
	Choices []chatChoice `json:"choices"`
}

type chatChoice struct {
	Message chatMessage `json:"message"`
}

type chatMessage struct {
	Content string `json:"content"`
}

type embedRequest struct {
	Model string `json:"model"`
	Input string `json:"input"`
}

type embedResponse struct {
	Data []embedData `json:"data"`
}

type embedData struct {
	Embedding []float64 `json:"embedding"`
}
