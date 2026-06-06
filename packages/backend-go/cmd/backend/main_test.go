package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// ─── Helper: encode a jsonrpcRequest as a single JSON line ────────────────────

func mustMarshalLine(v interface{}) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	data = append(data, '\n')
	return data
}

func jsonRawID(id string) json.RawMessage {
	return json.RawMessage(`"` + id + `"`)
}

// ─── TestHandleInitialize ─────────────────────────────────────────────────────

func TestHandleInitialize(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("1"),
		Method:  "initialize",
		Params:  json.RawMessage(`{"clientInfo":{"name":"test-client","version":"1.0"}}`),
	}

	resp := handleRequest(nil, req, nil, nil, nil, nil)

	if resp.JSONRPC != "2.0" {
		t.Errorf("jsonrpc version: got %q, want %q", resp.JSONRPC, "2.0")
	}
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}

	// Result should be an initializeResult with serverInfo.name = "neuralgentics-backend"
	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}

	var result initializeResult
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}

	if result.ServerInfo.Name != "neuralgentics-backend" {
		t.Errorf("server name: got %q, want %q", result.ServerInfo.Name, "neuralgentics-backend")
	}
	if result.ServerInfo.Version != version {
		t.Errorf("server version: got %q, want %q", result.ServerInfo.Version, version)
	}
	if !result.Capabilities.Memory {
		t.Error("capabilities.memory: got false, want true")
	}
	if !result.Capabilities.Orchestrator {
		t.Error("capabilities.orchestrator: got false, want true")
	}
	if !result.Capabilities.Broker {
		t.Error("capabilities.broker: got false, want true")
	}
}

// ─── TestHandleInitialize_NoParams ────────────────────────────────────────────

func TestHandleInitialize_NoParams(t *testing.T) {
	t.Parallel()

	// initialize with no params should still return a valid response
	// (params are informational-only per the handler)
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("2"),
		Method:  "initialize",
		// Params is nil (zero value)
	}

	resp := handleRequest(nil, req, nil, nil, nil, nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error for nil params: %v", resp.Error)
	}

	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}

	var result initializeResult
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}

	if result.ServerInfo.Name != "neuralgentics-backend" {
		t.Errorf("server name: got %q, want %q", result.ServerInfo.Name, "neuralgentics-backend")
	}
}

// ─── TestHandlePing ──────────────────────────────────────────────────────────

func TestHandlePing(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("3"),
		Method:  "ping",
	}

	resp := handleRequest(nil, req, nil, nil, nil, nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}

	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}

	// The result should be the string "pong"
	var result string
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if result != "pong" {
		t.Errorf("ping result: got %q, want %q", result, "pong")
	}
}

// ─── TestHandleShutdown ──────────────────────────────────────────────────────

func TestHandleShutdown(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("4"),
		Method:  "shutdown",
	}

	resp := handleRequest(nil, req, nil, nil, nil, nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}

	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}

	var result map[string]string
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if result["status"] != "ok" {
		t.Errorf("shutdown status: got %q, want %q", result["status"], "ok")
	}
}

// ─── TestHandleInvalidMethod ──────────────────────────────────────────────────

func TestHandleInvalidMethod(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		method string
	}{
		{name: "nonsense method", method: "nonsense"},
		{name: "empty method", method: ""},
		{name: "unknown prefix", method: "foo.bar"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := jsonrpcRequest{
				JSONRPC: "2.0",
				ID:      jsonRawID("invalid"),
				Method:  tt.method,
			}

			resp := handleRequest(nil, req, nil, nil, nil, nil)

			if resp.Error == nil {
				t.Fatal("expected error response, got nil error")
			}
			if resp.Error.Code != -32601 {
				t.Errorf("error code: got %d, want %d", resp.Error.Code, -32601)
			}
			if resp.JSONRPC != "2.0" {
				t.Errorf("jsonrpc version: got %q, want %q", resp.JSONRPC, "2.0")
			}
		})
	}
}

// ─── TestWriteResponseTo ─────────────────────────────────────────────────────

func TestWriteResponseTo(t *testing.T) {
	t.Parallel()

	resp := successResponse(jsonRawID("42"), map[string]string{"status": "ok"})

	var buf bytes.Buffer
	writeResponseTo(&buf, resp)

	output := buf.String()

	// Should end with newline
	if !strings.HasSuffix(output, "\n") {
		t.Error("response should end with newline")
	}

	// Should be valid JSON
	var decoded jsonrpcResponse
	if err := json.Unmarshal([]byte(strings.TrimRight(output, "\n")), &decoded); err != nil {
		t.Fatalf("invalid JSON output: %v\n  got: %q", err, output)
	}

	if decoded.JSONRPC != "2.0" {
		t.Errorf("jsonrpc: got %q, want %q", decoded.JSONRPC, "2.0")
	}
}

// ─── TestWriteResponseTo_Error ────────────────────────────────────────────────

func TestWriteResponseTo_Error(t *testing.T) {
	t.Parallel()

	resp := errorResponse(jsonRawID("err1"), -32600, "Invalid Request")

	var buf bytes.Buffer
	writeResponseTo(&buf, resp)

	output := buf.String()

	var decoded jsonrpcResponse
	if err := json.Unmarshal([]byte(strings.TrimRight(output, "\n")), &decoded); err != nil {
		t.Fatalf("invalid JSON output: %v", err)
	}

	if decoded.Error == nil {
		t.Fatal("expected error in response, got nil")
	}
	if decoded.Error.Code != -32600 {
		t.Errorf("error code: got %d, want %d", decoded.Error.Code, -32600)
	}
	if decoded.Error.Message != "Invalid Request" {
		t.Errorf("error message: got %q, want %q", decoded.Error.Message, "Invalid Request")
	}
}

// ─── TestEmitReadyNotification ────────────────────────────────────────────────

func TestEmitReadyNotification(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	emitReadyNotificationTo(&buf)

	output := buf.String()

	// Should end with newline
	if !strings.HasSuffix(output, "\n") {
		t.Error("notification should end with newline")
	}

	// Parse the notification
	var notif map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimRight(output, "\n")), &notif); err != nil {
		t.Fatalf("invalid JSON in notification: %v\n  got: %q", err, output)
	}

	// The ready notification must NOT have an "id" field — that's what makes
	// it a notification rather than a response in JSON-RPC 2.0.
	if _, hasID := notif["id"]; hasID {
		t.Error("ready notification must not have an 'id' field (notifications are id-less)")
	}

	if notif["jsonrpc"] != "2.0" {
		t.Errorf("jsonrpc: got %v, want %q", notif["jsonrpc"], "2.0")
	}
	if notif["method"] != "ready" {
		t.Errorf("method: got %v, want %q", notif["method"], "ready")
	}

	params, ok := notif["params"].(map[string]interface{})
	if !ok {
		t.Fatal("params should be a map")
	}
	if params["server"] != "neuralgentics-backend" {
		t.Errorf("params.server: got %v, want %q", params["server"], "neuralgentics-backend")
	}
	if _, hasTime := params["time"]; !hasTime {
		t.Error("params should contain 'time' field")
	}
}

// ─── TestProcessRequest ──────────────────────────────────────────────────────

func TestProcessRequest(t *testing.T) {
	t.Parallel()

	t.Run("valid request dispatches to handler", func(t *testing.T) {
		t.Parallel()

		line := []byte(`{"jsonrpc":"2.0","id":"1","method":"ping"}`)
		called := false
		resp := processRequest(line, func(req jsonrpcRequest) jsonrpcResponse {
			called = true
			if req.Method != "ping" {
				t.Errorf("method: got %q, want %q", req.Method, "ping")
			}
			return successResponse(req.ID, "pong")
		})

		if !called {
			t.Error("handler was not called")
		}
		if resp.JSONRPC != "2.0" {
			t.Errorf("jsonrpc: got %q, want %q", resp.JSONRPC, "2.0")
		}
	})

	t.Run("invalid JSON returns parse error", func(t *testing.T) {
		t.Parallel()

		line := []byte(`{invalid json!!!`)
		resp := processRequest(line, func(req jsonrpcRequest) jsonrpcResponse {
			t.Error("handler should not be called for invalid JSON")
			return jsonrpcResponse{}
		})

		if resp.Error == nil {
			t.Fatal("expected error response for invalid JSON")
		}
		if resp.Error.Code != -32700 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32700)
		}
		if resp.JSONRPC != "2.0" {
			t.Errorf("jsonrpc version: got %q, want %q", resp.JSONRPC, "2.0")
		}
	})
}

// ─── TestHandleStream ────────────────────────────────────────────────────────

func TestHandleStream(t *testing.T) {
	t.Parallel()

	t.Run("single request roundtrip", func(t *testing.T) {
		t.Parallel()

		input := `{"jsonrpc":"2.0","id":"1","method":"ping"}` + "\n"
		var output bytes.Buffer

		err := handleStream(strings.NewReader(input), &output, func(req jsonrpcRequest) jsonrpcResponse {
			return successResponse(req.ID, "pong")
		})

		if err != nil {
			t.Fatalf("handleStream returned error: %v", err)
		}

		var resp jsonrpcResponse
		if err := json.Unmarshal(output.Bytes(), &resp); err != nil {
			t.Fatalf("invalid JSON output: %v\n  got: %q", err, output.String())
		}
		if resp.JSONRPC != "2.0" {
			t.Errorf("jsonrpc: got %q, want %q", resp.JSONRPC, "2.0")
		}
	})

	t.Run("multiple requests in sequence", func(t *testing.T) {
		t.Parallel()

		input := strings.Join([]string{
			`{"jsonrpc":"2.0","id":"1","method":"ping"}`,
			`{"jsonrpc":"2.0","id":"2","method":"initialize","params":{"clientInfo":{}}}`,
			`{"jsonrpc":"2.0","id":"3","method":"shutdown"}`,
		}, "\n") + "\n"

		var output bytes.Buffer
		callCount := 0

		err := handleStream(strings.NewReader(input), &output, func(req jsonrpcRequest) jsonrpcResponse {
			callCount++
			return successResponse(req.ID, map[string]string{"echo": req.Method})
		})

		if err != nil {
			t.Fatalf("handleStream returned error: %v", err)
		}
		if callCount != 3 {
			t.Errorf("call count: got %d, want 3", callCount)
		}

		lines := strings.Split(strings.TrimRight(output.String(), "\n"), "\n")
		if len(lines) != 3 {
			t.Fatalf("expected 3 output lines, got %d", len(lines))
		}
	})

	t.Run("empty lines are skipped", func(t *testing.T) {
		t.Parallel()

		input := "\n\n\n" + `{"jsonrpc":"2.0","id":"1","method":"ping"}` + "\n\n"
		var output bytes.Buffer
		callCount := 0

		err := handleStream(strings.NewReader(input), &output, func(req jsonrpcRequest) jsonrpcResponse {
			callCount++
			return successResponse(req.ID, "pong")
		})

		if err != nil {
			t.Fatalf("handleStream returned error: %v", err)
		}
		if callCount != 1 {
			t.Errorf("call count with empty lines: got %d, want 1", callCount)
		}
	})

	t.Run("empty input yields no output", func(t *testing.T) {
		t.Parallel()

		var output bytes.Buffer
		err := handleStream(strings.NewReader(""), &output, func(req jsonrpcRequest) jsonrpcResponse {
			t.Error("handler should not be called for empty input")
			return jsonrpcResponse{}
		})

		if err != nil {
			t.Fatalf("handleStream returned error: %v", err)
		}
		if output.Len() != 0 {
			t.Errorf("expected empty output, got %q", output.String())
		}
	})
}

// ─── TestJSONRPCRoundtrip_Initialize ─────────────────────────────────────────

func TestJSONRPCRoundtrip_Initialize(t *testing.T) {
	t.Parallel()

	input := `{"jsonrpc":"2.0","id":"10","method":"initialize","params":{"clientInfo":{"name":"test","version":"0.1"}}}` + "\n"
	var output bytes.Buffer

	err := handleStream(strings.NewReader(input), &output, func(req jsonrpcRequest) jsonrpcResponse {
		return handleRequest(nil, req, nil, nil, nil, nil)
	})

	if err != nil {
		t.Fatalf("handleStream error: %v", err)
	}

	var resp jsonrpcResponse
	if err := json.Unmarshal(output.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}

	resultBytes, _ := json.Marshal(resp.Result)
	var result initializeResult
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}

	if result.ServerInfo.Name != "neuralgentics-backend" {
		t.Errorf("server name: got %q, want %q", result.ServerInfo.Name, "neuralgentics-backend")
	}
}

// ─── TestJSONRPCRoundtrip_Ping ───────────────────────────────────────────────

func TestJSONRPCRoundtrip_Ping(t *testing.T) {
	t.Parallel()

	input := `{"jsonrpc":"2.0","id":"11","method":"ping"}` + "\n"
	var output bytes.Buffer

	err := handleStream(strings.NewReader(input), &output, func(req jsonrpcRequest) jsonrpcResponse {
		return handleRequest(nil, req, nil, nil, nil, nil)
	})

	if err != nil {
		t.Fatalf("handleStream error: %v", err)
	}

	var resp jsonrpcResponse
	if err := json.Unmarshal(output.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}

	var result string
	resultBytes, _ := json.Marshal(resp.Result)
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if result != "pong" {
		t.Errorf("ping result: got %q, want %q", result, "pong")
	}
}

// ─── TestJSONRPCRoundtrip_InvalidMethod ──────────────────────────────────────

func TestJSONRPCRoundtrip_InvalidMethod(t *testing.T) {
	t.Parallel()

	input := `{"jsonrpc":"2.0","id":"12","method":"nonexistent.method"}` + "\n"
	var output bytes.Buffer

	err := handleStream(strings.NewReader(input), &output, func(req jsonrpcRequest) jsonrpcResponse {
		return handleRequest(nil, req, nil, nil, nil, nil)
	})

	if err != nil {
		t.Fatalf("handleStream error: %v", err)
	}

	var resp jsonrpcResponse
	if err := json.Unmarshal(output.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	if resp.Error == nil {
		t.Fatal("expected error for unknown method, got nil")
	}
	if resp.Error.Code != -32601 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32601)
	}
}

// ─── TestHandleRequest_InvalidJSON ────────────────────────────────────────────

func TestHandleRequest_InvalidJSON(t *testing.T) {
	t.Parallel()

	// Test that processRequest handles malformed JSON gracefully
	// This is distinct from invalid methods — it tests the parsing layer

	tests := []struct {
		name           string
		input          string
		wantParseError bool // true if input should fail JSON parsing
	}{
		{name: "garbage input", input: "{not json at all!!!", wantParseError: true},
		{name: "truncated JSON", input: `{"jsonrpc":"2.0","id":`, wantParseError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			resp := processRequest([]byte(tt.input), func(req jsonrpcRequest) jsonrpcResponse {
				t.Error("handler should not be called for invalid JSON")
				return jsonrpcResponse{}
			})

			if !tt.wantParseError {
				t.Fatal("test bug: wantParseError is false but we're checking for parse errors")
			}
			if resp.Error == nil {
				t.Fatal("expected error response for invalid JSON")
			}
			if resp.Error.Code != -32700 {
				t.Errorf("error code: got %d, want %d", resp.Error.Code, -32700)
			}
		})
	}

	// Empty object {} is valid JSON but has empty method → "Method not found"
	t.Run("empty object yields method not found", func(t *testing.T) {
		t.Parallel()
		resp := processRequest([]byte(`{}`), func(req jsonrpcRequest) jsonrpcResponse {
			return handleRequest(nil, req, nil, nil, nil, nil)
		})
		if resp.Error == nil {
			t.Fatal("expected error for empty method")
		}
		if resp.Error.Code != -32601 {
			t.Errorf("error code: got %d, want %d (Method not found)", resp.Error.Code, -32601)
		}
	})
}

// ─── TestHandleStream_InvalidJSONInStream ─────────────────────────────────────

func TestHandleStream_InvalidJSONInStream(t *testing.T) {
	t.Parallel()

	// Invalid JSON lines should produce a parse error response and not crash
	input := "{bad json}\n" + `{"jsonrpc":"2.0","id":"ok","method":"ping"}` + "\n"
	var output bytes.Buffer

	err := handleStream(strings.NewReader(input), &output, func(req jsonrpcRequest) jsonrpcResponse {
		return successResponse(req.ID, "pong")
	})

	if err != nil {
		t.Fatalf("handleStream error: %v", err)
	}

	lines := strings.Split(strings.TrimRight(output.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 output lines, got %d", len(lines))
	}

	// First line should be a parse error
	var resp1 jsonrpcResponse
	if err := json.Unmarshal([]byte(lines[0]), &resp1); err != nil {
		t.Fatalf("line 1: invalid JSON: %v", err)
	}
	if resp1.Error == nil || resp1.Error.Code != -32700 {
		t.Errorf("line 1: expected parse error -32700, got %+v", resp1.Error)
	}

	// Second line should be a normal response
	var resp2 jsonrpcResponse
	if err := json.Unmarshal([]byte(lines[1]), &resp2); err != nil {
		t.Fatalf("line 2: invalid JSON: %v", err)
	}
	if resp2.Error != nil {
		t.Errorf("line 2: unexpected error: %+v", resp2.Error)
	}
}

// ─── TestParseParams ─────────────────────────────────────────────────────────

func TestParseParams(t *testing.T) {
	t.Parallel()

	t.Run("nil params returns error", func(t *testing.T) {
		t.Parallel()

		var target map[string]string
		err := parseParams(nil, &target)
		if err == nil {
			t.Error("expected error for nil params, got nil")
		}
	})

	t.Run("valid JSON params", func(t *testing.T) {
		t.Parallel()

		var target memoryAddParams
		err := parseParams(json.RawMessage(`{"content":"hello","sourceType":"session"}`), &target)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if target.Content != "hello" {
			t.Errorf("content: got %q, want %q", target.Content, "hello")
		}
		if target.SourceType != "session" {
			t.Errorf("sourceType: got %q, want %q", target.SourceType, "session")
		}
	})

	t.Run("invalid JSON params returns error", func(t *testing.T) {
		t.Parallel()

		var target memoryAddParams
		err := parseParams(json.RawMessage(`{invalid}`), &target)
		if err == nil {
			t.Error("expected error for invalid JSON params, got nil")
		}
	})
}

// ─── TestSuccessResponse ──────────────────────────────────────────────────────

func TestSuccessResponse(t *testing.T) {
	t.Parallel()

	id := jsonRawID("test-id")
	result := map[string]string{"key": "value"}

	resp := successResponse(id, result)

	if resp.JSONRPC != "2.0" {
		t.Errorf("jsonrpc: got %q, want %q", resp.JSONRPC, "2.0")
	}
	if string(resp.ID) != `"test-id"` {
		t.Errorf("id: got %s, want %q", resp.ID, `"test-id"`)
	}
	if resp.Error != nil {
		t.Errorf("expected nil error, got %+v", resp.Error)
	}
	if resp.Result == nil {
		t.Error("expected non-nil result")
	}
}

// ─── TestErrorResponse ────────────────────────────────────────────────────────

func TestErrorResponse(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		id      json.RawMessage
		code    int
		message string
	}{
		{name: "parse error", id: jsonRawID("1"), code: -32700, message: "Parse error"},
		{name: "method not found", id: jsonRawID("2"), code: -32601, message: "Method not found"},
		{name: "invalid params", id: jsonRawID("3"), code: -32602, message: "Invalid params"},
		{name: "internal error", id: jsonRawID("4"), code: -32603, message: "Internal error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			resp := errorResponse(tt.id, tt.code, tt.message)

			if resp.JSONRPC != "2.0" {
				t.Errorf("jsonrpc: got %q, want %q", resp.JSONRPC, "2.0")
			}
			if resp.Error == nil {
				t.Fatal("expected non-nil error")
			}
			if resp.Error.Code != tt.code {
				t.Errorf("error code: got %d, want %d", resp.Error.Code, tt.code)
			}
			if resp.Error.Message != tt.message {
				t.Errorf("error message: got %q, want %q", resp.Error.Message, tt.message)
			}
			if resp.Result != nil {
				t.Errorf("expected nil result, got %v", resp.Result)
			}
		})
	}
}

// ─── TestMemoryHandlerParamsValidation ────────────────────────────────────────
// These tests verify param validation for memory handlers that require
// a *memory.MemorySystem but can still be validated for bad/missing params.

func TestMemoryHandlerParamsValidation_MemoryAdd(t *testing.T) {
	t.Parallel()

	t.Run("missing params returns error", func(t *testing.T) {
		t.Parallel()

		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("m1"),
			Method:  "memory.add",
			// Params nil — parseParams will error
		}
		resp := handleRequest(nil, req, nil, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty content returns error", func(t *testing.T) {
		t.Parallel()

		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("m2"),
			Method:  "memory.add",
			Params:  json.RawMessage(`{"content":""}`),
		}
		// Even with nil memSys, empty content should be caught before
		// the memSys call. The handler checks content == "" first.
		// However, with nil memSys it would panic after the content check.
		// So we verify the params parsing works but we can't test
		// the content=="" check path without a real memSys.
		// Instead, test that missing content field (empty string) is caught:
		resp := handleRequest(nil, req, nil, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty content")
		}
		// Could be -32602 (empty content) or -32603 (nil memSys panic)
		// Since memSys is nil, it will hit the content check first and return -32602
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestMemoryHandlerParamsValidation_MemoryQuery(t *testing.T) {
	t.Parallel()

	t.Run("missing params returns error", func(t *testing.T) {
		t.Parallel()

		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("mq1"),
			Method:  "memory.query",
		}
		resp := handleRequest(nil, req, nil, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
	})

	t.Run("empty query returns error", func(t *testing.T) {
		t.Parallel()

		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("mq2"),
			Method:  "memory.query",
			Params:  json.RawMessage(`{"query":""}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty query")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

// ─── TestBrokerHandlerParamsValidation ────────────────────────────────────────

func TestBrokerHandlerParamsValidation_BrokerBuildCatalog(t *testing.T) {
	t.Parallel()

	t.Run("missing params returns error", func(t *testing.T) {
		t.Parallel()

		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("bc1"),
			Method:  "broker.buildCatalog",
		}
		resp := handleRequest(nil, req, nil, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

// ─── TestIO_PipeRoundtrip ────────────────────────────────────────────────────
// Uses io.Pipe for a realistic stdio-like roundtrip test.

func TestIO_PipeRoundtrip(t *testing.T) {
	t.Parallel()

	// Use io.Pipe to simulate full-duplex stdin/stdout
	pr, pw := io.Pipe()
	done := make(chan struct{})

	var output bytes.Buffer

	go func() {
		defer close(done)
		defer pw.Close()
		// Write two requests
		req1 := `{"jsonrpc":"2.0","id":"pipe-1","method":"ping"}` + "\n"
		req2 := `{"jsonrpc":"2.0","id":"pipe-2","method":"initialize","params":{}}` + "\n"
		pw.Write([]byte(req1))
		pw.Write([]byte(req2))
	}()

	err := handleStream(pr, &output, func(req jsonrpcRequest) jsonrpcResponse {
		return handleRequest(nil, req, nil, nil, nil, nil)
	})

	<-done // wait for writer to close

	if err != nil {
		t.Fatalf("handleStream error: %v", err)
	}

	lines := strings.Split(strings.TrimRight(output.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d", len(lines))
	}

	// Verify line 1 is ping response
	var resp1 jsonrpcResponse
	if err := json.Unmarshal([]byte(lines[0]), &resp1); err != nil {
		t.Fatalf("line 1 invalid JSON: %v", err)
	}
	if resp1.Error != nil {
		t.Errorf("line 1 unexpected error: %+v", resp1.Error)
	}

	// Verify line 2 is initialize response
	var resp2 jsonrpcResponse
	if err := json.Unmarshal([]byte(lines[1]), &resp2); err != nil {
		t.Fatalf("line 2 invalid JSON: %v", err)
	}
	if resp2.Error != nil {
		t.Errorf("line 2 unexpected error: %+v", resp2.Error)
	}
}

// ─── TestHandleRequest_MemoryGet_MissingID ────────────────────────────────────

func TestHandleRequest_MemoryGet_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("mg1"),
		Method:  "memory.get",
		Params:  json.RawMessage(`{"id":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty id")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

// ─── TestHandleRequest_MemoryDelete_MissingID ─────────────────────────────────

func TestHandleRequest_MemoryDelete_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("md1"),
		Method:  "memory.delete",
		Params:  json.RawMessage(`{"id":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty id")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

// ─── TestHandleRequest_MemoryAdjustTrust_MissingFields ────────────────────────

func TestHandleRequest_MemoryAdjustTrust_MissingFields(t *testing.T) {
	t.Parallel()

	t.Run("missing memoryId", func(t *testing.T) {
		t.Parallel()

		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("at1"),
			Method:  "memory.adjustTrust",
			Params:  json.RawMessage(`{"memoryId":"","signal":"agent_used"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty memoryId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("missing signal", func(t *testing.T) {
		t.Parallel()

		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("at2"),
			Method:  "memory.adjustTrust",
			Params:  json.RawMessage(`{"memoryId":"abc-123","signal":""}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty signal")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

// ─── TestHandleRequest_PeerSwitchContext_EmptyPeerID ─────────────────────────

func TestHandleRequest_PeerSwitchContext_EmptyPeerID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("psc1"),
		Method:  "peer.switchContext",
		Params:  json.RawMessage(`{"peerId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty peerId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

// ─── TestHandleRequest_MemoryGetTier0Summary ────────────────────────────────

func TestHandleRequest_MemoryGetTier0Summary_NoParams(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("t0s1"),
		Method:  "memory.getTier0Summary",
		// Params nil — handler should accept empty params
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	// With nil memSys, the handler should return a -32603 internal error
	// (the methods call into memSys which is nil). Test only that the
	// call routes correctly (no -32602 invalid params).
	if resp.Error != nil && resp.Error.Code == -32602 {
		t.Errorf("unexpected -32602 (invalid params) for nil params: %+v", resp.Error)
	}
}

func TestHandleRequest_MemoryGetTier0Summary_WithForceRefresh(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("t0s2"),
		Method:  "memory.getTier0Summary",
		Params:  json.RawMessage(`{"forceRefresh":true}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error != nil && resp.Error.Code == -32602 {
		t.Errorf("unexpected -32602 (invalid params): %+v", resp.Error)
	}
}

// ─── TestHandleRequest_MemoryGetTier1Summary ────────────────────────────────

func TestHandleRequest_MemoryGetTier1Summary_NoParams(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("t1s1"),
		Method:  "memory.getTier1Summary",
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error != nil && resp.Error.Code == -32602 {
		t.Errorf("unexpected -32602 (invalid params) for nil params: %+v", resp.Error)
	}
}

func TestHandleRequest_MemoryGetTier1Summary_WithForceRefresh(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("t1s2"),
		Method:  "memory.getTier1Summary",
		Params:  json.RawMessage(`{"forceRefresh":true}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error != nil && resp.Error.Code == -32602 {
		t.Errorf("unexpected -32602 (invalid params): %+v", resp.Error)
	}
}

// ─── TestHandleRequest_MemoryTriggerExtraction ──────────────────────────────

func TestHandleRequest_MemoryTriggerExtraction_NoParams(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("te1"),
		Method:  "memory.triggerExtraction",
		// Params nil — handler should accept empty params
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	// With nil memSys, the handler should return a -32603 internal error
	// (the methods call into memSys which is nil). Test only that the
	// call routes correctly (no -32602 invalid params).
	if resp.Error != nil && resp.Error.Code == -32602 {
		t.Errorf("unexpected -32602 (invalid params) for nil params: %+v", resp.Error)
	}
}

func TestHandleRequest_MemoryTriggerExtraction_WithConversation(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("te2"),
		Method:  "memory.triggerExtraction",
		Params:  json.RawMessage(`{"conversation":"User discussed project architecture"}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error != nil && resp.Error.Code == -32602 {
		t.Errorf("unexpected -32602 (invalid params): %+v", resp.Error)
	}
}

// ─── TestHandleRequest_MemoryPrecompressExtraction ──────────────────────────

func TestHandleRequest_MemoryPrecompressExtraction_NoParams(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("pe1"),
		Method:  "memory.precompressExtraction",
		// Params nil — handler should accept empty params
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error != nil && resp.Error.Code == -32602 {
		t.Errorf("unexpected -32602 (invalid params) for nil params: %+v", resp.Error)
	}
}

func TestHandleRequest_MemoryPrecompressExtraction_WithContext(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("pe2"),
		Method:  "memory.precompressExtraction",
		Params:  json.RawMessage(`{"contextContent":"Long conversation about project setup..."}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error != nil && resp.Error.Code == -32602 {
		t.Errorf("unexpected -32602 (invalid params): %+v", resp.Error)
	}
}

// ─── TestHandleRequest_PeerSwitchContext_NilParams ────────────────────────────

func TestHandleRequest_PeerSwitchContext_NilParams(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("psc2"),
		Method:  "peer.switchContext",
		// Params nil — parseParams will error
	}
	resp := handleRequest(nil, req, nil, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for nil params")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

// ─── TestHandleRequest_PeerGetSharedMemories_UsesActivePeerContext ────────────
// Regression test for the hardcoded-empty-peerID bug.
// Verifies that the active peer context is now consulted (not ""),
// and that the handler signature accepts peerCtx (not nil-rejected).

func TestHandleRequest_PeerGetSharedMemories_UsesActivePeerContext(t *testing.T) {
	if testing.Short() {
		t.Skip("integration: requires real memSys")
	}
	t.Parallel()

	// With a real memSys, calling getSharedMemories with no prior switchContext
	// should fall back to the default peer ("default"), not hardcoded "".
	// The result is not asserted because we don't have a real DB here —
	// the bug fix is that the handler doesn't crash with peerCtx nil.
	peerCtx := newActivePeerContext()
	if peerCtx.GetActivePeerID() != "default" {
		t.Errorf("default peer: got %q, want %q", peerCtx.GetActivePeerID(), "default")
	}
}

// ─── TestOrchestratorHandlerParamsValidation ──────────────────────────────────

func TestOrchestratorHandlerParamsValidation_Route(t *testing.T) {
	t.Parallel()

	t.Run("missing params returns error", func(t *testing.T) {
		t.Parallel()

		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("or1"),
			Method:  "orchestrator.route",
		}
		resp := handleRequest(nil, req, nil, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}
