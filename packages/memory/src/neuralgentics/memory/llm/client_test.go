package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

func TestChat_Success(t *testing.T) {
	expected := "Hello from the LLM!"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/chat/completions" {
			t.Errorf("expected /chat/completions, got %s", r.URL.Path)
		}

		// Verify request body
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Model != "test-model" {
			t.Errorf("expected model test-model, got %s", req.Model)
		}
		if len(req.Messages) != 1 {
			t.Errorf("expected 1 message, got %d", len(req.Messages))
		}
		if req.Messages[0].Content != "hello" {
			t.Errorf("expected content 'hello', got %s", req.Messages[0].Content)
		}

		resp := chatResponse{
			Choices: []chatChoice{
				{Message: chatMessage{Content: expected}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	result, err := client.Chat(context.Background(), []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.5)
	if err != nil {
		t.Fatalf("Chat() error: %v", err)
	}
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

func TestChat_APIKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-key-123" {
			t.Errorf("expected Bearer test-key-123, got %s", auth)
		}
		resp := chatResponse{
			Choices: []chatChoice{
				{Message: chatMessage{Content: "ok"}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "test-key-123", "test-model")
	_, err := client.Chat(context.Background(), []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.1)
	if err != nil {
		t.Fatalf("Chat() error: %v", err)
	}
}

func TestChat_ServerError_Retries(t *testing.T) {
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		resp := chatResponse{
			Choices: []chatChoice{
				{Message: chatMessage{Content: "success after retry"}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	// Use short delays by overriding the client's httpClient for faster tests
	client.httpClient = &http.Client{Timeout: 5 * time.Second}

	result, err := client.Chat(context.Background(), []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.1)
	if err != nil {
		t.Fatalf("Chat() error: %v", err)
	}
	if result != "success after retry" {
		t.Errorf("expected 'success after retry', got %q", result)
	}
	if callCount != 3 {
		t.Errorf("expected 3 calls, got %d", callCount)
	}
}

func TestChat_ServerError_ExhaustedRetries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "internal server error")
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	client.httpClient = &http.Client{Timeout: 5 * time.Second}

	_, err := client.Chat(context.Background(), []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.1)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestChat_ClientError_NoRetry(t *testing.T) {
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, "bad request")
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	client.httpClient = &http.Client{Timeout: 5 * time.Second}

	_, err := client.Chat(context.Background(), []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.1)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// 4xx should not retry
	if callCount != 1 {
		t.Errorf("expected 1 call (no retry), got %d", callCount)
	}
}

func TestChat_EmptyMessages(t *testing.T) {
	client := NewOpenAIClient("http://localhost:8903/v1", "", "test-model")
	_, err := client.Chat(context.Background(), []core.ConversationMessage{}, 0.5)
	if err == nil {
		t.Fatal("expected error for empty messages, got nil")
	}
}

func TestChat_NoChoices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := chatResponse{Choices: []chatChoice{}}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	_, err := client.Chat(context.Background(), []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.1)
	if err == nil {
		t.Fatal("expected error for no choices, got nil")
	}
}

func TestChat_InvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{invalid json`))
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	_, err := client.Chat(context.Background(), []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.1)
	if err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

func TestEmbed_Success(t *testing.T) {
	expectedVec := []float64{0.1, 0.2, 0.3, 0.4}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/embeddings" {
			t.Errorf("expected /embeddings, got %s", r.URL.Path)
		}

		var req embedRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Input != "hello world" {
			t.Errorf("expected input 'hello world', got %s", req.Input)
		}

		resp := embedResponse{
			Data: []embedData{
				{Embedding: expectedVec},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "embed-model")
	vec, err := client.Embed(context.Background(), "hello world")
	if err != nil {
		t.Fatalf("Embed() error: %v", err)
	}
	if len(vec) != len(expectedVec) {
		t.Fatalf("expected %d floats, got %d", len(expectedVec), len(vec))
	}
	for i, v := range vec {
		if v != expectedVec[i] {
			t.Errorf("vec[%d]: expected %f, got %f", i, expectedVec[i], v)
		}
	}
}

func TestEmbed_EmptyText(t *testing.T) {
	client := NewOpenAIClient("http://localhost:8903/v1", "", "test-model")
	_, err := client.Embed(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty text, got nil")
	}
}

func TestEmbed_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "server down")
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	client.httpClient = &http.Client{Timeout: 5 * time.Second}

	_, err := client.Embed(context.Background(), "test")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestEmbed_NoData(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := embedResponse{Data: []embedData{}}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	_, err := client.Embed(context.Background(), "test")
	if err == nil {
		t.Fatal("expected error for no data, got nil")
	}
}

func TestEmbedModel_Separate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req embedRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Model != "text-embedding-3-small" {
			t.Errorf("expected embed model 'text-embedding-3-small', got %s", req.Model)
		}
		resp := embedResponse{
			Data: []embedData{
				{Embedding: []float64{0.5}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewOpenAIClientWithEmbedModel(srv.URL, "", "gpt-4", "text-embedding-3-small")
	_, err := client.Embed(context.Background(), "test")
	if err != nil {
		t.Fatalf("Embed() error: %v", err)
	}
}

func TestHealth_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" || r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	if err := client.Health(context.Background()); err != nil {
		t.Fatalf("Health() error: %v", err)
	}
}

func TestHealth_FallbackEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	client.httpClient = &http.Client{Timeout: 5 * time.Second}

	if err := client.Health(context.Background()); err != nil {
		t.Fatalf("Health() error: %v", err)
	}
}

func TestHealth_Failure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	client.httpClient = &http.Client{Timeout: 5 * time.Second}

	err := client.Health(context.Background())
	if err == nil {
		t.Fatal("expected health error, got nil")
	}
}

func TestClose_NoOp(t *testing.T) {
	client := NewOpenAIClient("http://localhost:8903/v1", "", "test-model")
	if err := client.Close(context.Background()); err != nil {
		t.Fatalf("Close() error: %v", err)
	}
}

func TestContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Second) //故意延迟
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	_, err := client.Chat(ctx, []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.1)
	if err == nil {
		t.Fatal("expected context cancellation error, got nil")
	}
}

func TestRetry_RetriesOnSecondCall(t *testing.T) {
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			w.WriteHeader(http.StatusBadGateway) // 502 = server error
			return
		}
		resp := chatResponse{
			Choices: []chatChoice{
				{Message: chatMessage{Content: "recovered"}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewOpenAIClient(srv.URL, "", "test-model")
	client.httpClient = &http.Client{Timeout: 5 * time.Second}

	result, err := client.Chat(context.Background(), []core.ConversationMessage{
		{Role: "user", Content: "hello"},
	}, 0.1)
	if err != nil {
		t.Fatalf("Chat() error: %v", err)
	}
	if result != "recovered" {
		t.Errorf("expected 'recovered', got %q", result)
	}
	if callCount != 2 {
		t.Errorf("expected 2 calls (1 fail + 1 succeed), got %d", callCount)
	}
}

func TestClientError_Type(t *testing.T) {
	err := &clientError{StatusCode: 400, Body: "bad request"}
	if !isClientError(err) {
		t.Error("expected isClientError to return true for clientError")
	}

	srvErr := &serverError{StatusCode: 500, Body: "internal error"}
	if isClientError(srvErr) {
		t.Error("expected isClientError to return false for serverError")
	}
}
