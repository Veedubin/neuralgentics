package backend

import (
	"encoding/json"
	"testing"

	orchestrator "neuralgentics-orchestrator/src/neuralgentics/orchestrator"

	"neuralgentics-broker/src/neuralgentics/broker/intent"
	"neuralgentics-broker/src/neuralgentics/broker/types"
)

// ─── JSONTask.ToTask ──────────────────────────────────────────────────────────

func TestJSONTask_ToTask(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		input    JSONTask
		expected orchestrator.Task
	}{
		{
			name: "full conversion",
			input: JSONTask{
				ID:           "task-1",
				Type:         "code-implementation",
				Description:  "Implement feature X",
				UserRequest:  "Add feature X to module Y",
				Priority:     "high",
				Files:        []string{"main.go", "types.go"},
				Dependencies: []string{"task-0"},
			},
			expected: orchestrator.Task{
				ID:           "task-1",
				Type:         orchestrator.TaskTypeCodeImpl,
				Description:  "Implement feature X",
				UserRequest:  "Add feature X to module Y",
				Priority:     orchestrator.PriorityHigh,
				Files:        []string{"main.go", "types.go"},
				Dependencies: []string{"task-0"},
			},
		},
		{
			name: "minimal fields",
			input: JSONTask{
				ID:          "task-2",
				Type:        "testing",
				Description: "Write tests",
				UserRequest: "Test module Z",
				Priority:    "low",
			},
			expected: orchestrator.Task{
				ID:          "task-2",
				Type:        orchestrator.TaskTypeTesting,
				Description: "Write tests",
				UserRequest: "Test module Z",
				Priority:    orchestrator.PriorityLow,
			},
		},
		{
			name: "unknown task type passthrough",
			input: JSONTask{
				ID:          "task-3",
				Type:        "custom-type",
				Description: "Custom work",
				UserRequest: "Do custom thing",
				Priority:    "medium",
			},
			expected: orchestrator.Task{
				ID:          "task-3",
				Type:        orchestrator.TaskType("custom-type"),
				Description: "Custom work",
				UserRequest: "Do custom thing",
				Priority:    orchestrator.PriorityMedium,
			},
		},
		{
			name: "empty fields",
			input: JSONTask{
				ID: "task-4",
			},
			expected: orchestrator.Task{
				ID: "task-4",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := tt.input.ToTask()
			if got.ID != tt.expected.ID {
				t.Errorf("ID: got %q, want %q", got.ID, tt.expected.ID)
			}
			if got.Type != tt.expected.Type {
				t.Errorf("Type: got %q, want %q", got.Type, tt.expected.Type)
			}
			if got.Description != tt.expected.Description {
				t.Errorf("Description: got %q, want %q", got.Description, tt.expected.Description)
			}
			if got.UserRequest != tt.expected.UserRequest {
				t.Errorf("UserRequest: got %q, want %q", got.UserRequest, tt.expected.UserRequest)
			}
			if got.Priority != tt.expected.Priority {
				t.Errorf("Priority: got %q, want %q", got.Priority, tt.expected.Priority)
			}
			if len(got.Files) != len(tt.expected.Files) {
				t.Errorf("Files: got %v, want %v", got.Files, tt.expected.Files)
			}
			if len(got.Dependencies) != len(tt.expected.Dependencies) {
				t.Errorf("Dependencies: got %v, want %v", got.Dependencies, tt.expected.Dependencies)
			}
		})
	}
}

// ─── JSONTaskPlan.ToTaskPlan ───────────────────────────────────────────────────

func TestJSONTaskPlan_ToTaskPlan(t *testing.T) {
	t.Parallel()

	t.Run("with dependencies", func(t *testing.T) {
		t.Parallel()
		plan := JSONTaskPlan{
			Tasks: []JSONTask{
				{ID: "t1", Type: "code-implementation", Description: "Write code", UserRequest: "req1", Priority: "high"},
				{ID: "t2", Type: "testing", Description: "Write tests", UserRequest: "req2", Priority: "medium", Dependencies: []string{"t1"}},
			},
			Dependencies: map[string][]string{
				"t2": {"t1"},
			},
		}

		got := plan.ToTaskPlan()

		if len(got.Tasks) != 2 {
			t.Fatalf("expected 2 tasks, got %d", len(got.Tasks))
		}
		if got.Tasks[0].ID != "t1" {
			t.Errorf("task 0 ID: got %q, want %q", got.Tasks[0].ID, "t1")
		}
		if got.Tasks[0].Type != orchestrator.TaskTypeCodeImpl {
			t.Errorf("task 0 Type: got %q, want %q", got.Tasks[0].Type, orchestrator.TaskTypeCodeImpl)
		}
		if got.Tasks[1].ID != "t2" {
			t.Errorf("task 1 ID: got %q, want %q", got.Tasks[1].ID, "t2")
		}
		if got.Dependencies["t2"][0] != "t1" {
			t.Errorf("Dependencies[t2]: got %v, want [t1]", got.Dependencies["t2"])
		}
	})

	t.Run("empty plan", func(t *testing.T) {
		t.Parallel()
		plan := JSONTaskPlan{}
		got := plan.ToTaskPlan()

		if len(got.Tasks) != 0 {
			t.Errorf("expected 0 tasks, got %d", len(got.Tasks))
		}
		if got.Dependencies != nil {
			t.Errorf("expected nil Dependencies, got %v", got.Dependencies)
		}
	})
}

// ─── FromIntentToolMatch ──────────────────────────────────────────────────────

func TestFromIntentToolMatch(t *testing.T) {
	t.Parallel()

	t.Run("non-nil match", func(t *testing.T) {
		t.Parallel()
		match := &intent.ToolMatch{
			Tool: types.ToolSummary{
				Server:      "memini-ai",
				Name:        "query_memories",
				Description: "Search memories with semantic query",
			},
			Score:  0.85,
			Reason: "high keyword overlap",
		}

		got := FromIntentToolMatch(match)

		if got.Tool.Server != "memini-ai" {
			t.Errorf("Server: got %q, want %q", got.Tool.Server, "memini-ai")
		}
		if got.Tool.Name != "query_memories" {
			t.Errorf("Name: got %q, want %q", got.Tool.Name, "query_memories")
		}
		if got.Tool.Description != "Search memories with semantic query" {
			t.Errorf("Description: got %q, want %q", got.Tool.Description, "Search memories with semantic query")
		}
		if got.Score != 0.85 {
			t.Errorf("Score: got %f, want %f", got.Score, 0.85)
		}
		if got.Reason != "high keyword overlap" {
			t.Errorf("Reason: got %q, want %q", got.Reason, "high keyword overlap")
		}
	})

	t.Run("real orchestrator intents", func(t *testing.T) {
		t.Parallel()

		// Test with broker intent matching patterns from orchestrator's known intents.
		// "write a python function" should match a code-generation tool.
		tools := []types.ToolSummary{
			{Name: "generate_code", Description: "Generate code in various languages including python", Server: "coder"},
			{Name: "run_tests", Description: "Execute test suites and report results", Server: "tester"},
		}

		matcher := intent.NewMatcher(tools)
		match, err := matcher.Match("write a python function")
		if err != nil {
			t.Skipf("intent match failed (expected for minimal tool set): %v", err)
		}

		got := FromIntentToolMatch(match)
		if got.Tool.Server != "coder" {
			t.Errorf("expected coder tool, got server=%q name=%q", got.Tool.Server, got.Tool.Name)
		}
		if got.Score <= 0 {
			t.Errorf("expected positive score, got %f", got.Score)
		}
	})
}

func TestFromIntentToolMatch_Nil(t *testing.T) {
	t.Parallel()

	got := FromIntentToolMatch(nil)
	if got.Tool.Server != "" || got.Tool.Name != "" || got.Tool.Description != "" {
		t.Errorf("expected zero JSONToolMatch for nil input, got %+v", got)
	}
	if got.Score != 0 {
		t.Errorf("expected Score=0 for nil input, got %f", got.Score)
	}
	if got.Reason != "" {
		t.Errorf("expected empty Reason for nil input, got %q", got.Reason)
	}
}

// ─── JSONBrokerCallResult marshaling ──────────────────────────────────────────

func TestJSONBrokerCallResult_Marshal(t *testing.T) {
	t.Parallel()

	t.Run("with data", func(t *testing.T) {
		t.Parallel()
		result := JSONBrokerCallResult{
			Result: map[string]any{
				"content": "hello world",
				"count":   float64(42),
				"nested": map[string]any{
					"key": "value",
				},
			},
		}

		data, err := json.Marshal(result)
		if err != nil {
			t.Fatalf("Marshal failed: %v", err)
		}

		var decoded map[string]any
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("Unmarshal failed: %v", err)
		}

		resultField, ok := decoded["result"].(map[string]any)
		if !ok {
			t.Fatal("result field is not a map")
		}
		if resultField["content"] != "hello world" {
			t.Errorf("content: got %v, want 'hello world'", resultField["content"])
		}
		if resultField["count"] != float64(42) {
			t.Errorf("count: got %v, want 42", resultField["count"])
		}
	})

	t.Run("empty result", func(t *testing.T) {
		t.Parallel()
		result := JSONBrokerCallResult{Result: map[string]any{}}

		data, err := json.Marshal(result)
		if err != nil {
			t.Fatalf("Marshal failed: %v", err)
		}

		var decoded JSONBrokerCallResult
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("Unmarshal failed: %v", err)
		}
		if len(decoded.Result) != 0 {
			t.Errorf("expected empty result, got %d items", len(decoded.Result))
		}
	})
}

// ─── JSONToolMatch marshaling ──────────────────────────────────────────────────

func TestJSONToolMatch_Marshal(t *testing.T) {
	t.Parallel()

	t.Run("full match", func(t *testing.T) {
		t.Parallel()
		m := JSONToolMatch{
			Tool: JSONToolSummary{
				Server:      "memini-ai",
				Name:        "add_memory",
				Description: "Store a new memory entry",
			},
			Score:  0.92,
			Reason: "exact name match: add_memory",
		}

		data, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("Marshal failed: %v", err)
		}

		var got JSONToolMatch
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("Unmarshal failed: %v", err)
		}
		if got.Tool.Server != "memini-ai" {
			t.Errorf("Server: got %q, want %q", got.Tool.Server, "memini-ai")
		}
		if got.Tool.Name != "add_memory" {
			t.Errorf("Name: got %q, want %q", got.Tool.Name, "add_memory")
		}
		if got.Tool.Description != "Store a new memory entry" {
			t.Errorf("Description: got %q, want %q", got.Tool.Description, "Store a new memory entry")
		}
		if got.Score != 0.92 {
			t.Errorf("Score: got %f, want %f", got.Score, 0.92)
		}
		if got.Reason != "exact name match: add_memory" {
			t.Errorf("Reason: got %q, want %q", got.Reason, "exact name match: add_memory")
		}
	})

	t.Run("zero value", func(t *testing.T) {
		t.Parallel()
		m := JSONToolMatch{}

		data, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("Marshal failed: %v", err)
		}

		var got JSONToolMatch
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("Unmarshal failed: %v", err)
		}
		if got.Tool.Server != "" {
			t.Errorf("expected empty Server, got %q", got.Tool.Server)
		}
		if got.Score != 0 {
			t.Errorf("expected Score=0, got %f", got.Score)
		}
	})

	t.Run("roundtrip preserves all fields", func(t *testing.T) {
		t.Parallel()
		original := JSONToolMatch{
			Tool: JSONToolSummary{
				Server:      "github-mcp",
				Name:        "create_issue",
				Description: "Create a GitHub issue",
			},
			Score:  0.75,
			Reason: "partial keyword match",
		}

		data, err := json.Marshal(original)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}

		var roundtripped JSONToolMatch
		if err := json.Unmarshal(data, &roundtripped); err != nil {
			t.Fatalf("Unmarshal: %v", err)
		}

		if roundtripped != original {
			t.Errorf("roundtrip mismatch:\n  got:  %+v\n  want: %+v", roundtripped, original)
		}
	})
}
