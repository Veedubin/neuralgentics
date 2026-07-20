// Package backend provides JSON intermediary types for the neuralgentics
// backend binary. These types mirror the orchestrator structs but use
// JSON-friendly field types (e.g., string for Priority instead of typed enum),
// allowing clean unmarshaling from JSON-RPC params.
package backend

import (
	orchestrator "neuralgentics-orchestrator/src/neuralgentics/orchestrator"

	"github.com/Veedubin/neuralgentics-broker/src/neuralgentics/broker/intent"
)

// JSONTask is the JSON-friendly representation of orchestrator.Task.
// It mirrors the Task struct but uses string types for enums to allow
// clean JSON unmarshaling.
type JSONTask struct {
	ID           string   `json:"id"`
	Type         string   `json:"type"`
	Description  string   `json:"description"`
	UserRequest  string   `json:"userRequest"`
	Priority     string   `json:"priority"`
	Files        []string `json:"files,omitempty"`
	Dependencies []string `json:"dependencies,omitempty"`
}

// ToTask converts a JSONTask to an orchestrator.Task.
func (t JSONTask) ToTask() orchestrator.Task {
	return orchestrator.Task{
		ID:           t.ID,
		Type:         orchestrator.TaskType(t.Type),
		Description:  t.Description,
		UserRequest:  t.UserRequest,
		Priority:     orchestrator.Priority(t.Priority),
		Files:        t.Files,
		Dependencies: t.Dependencies,
	}
}

// JSONTaskPlan is the JSON-friendly representation of orchestrator.TaskPlan.
type JSONTaskPlan struct {
	Tasks        []JSONTask          `json:"tasks"`
	Dependencies map[string][]string `json:"dependencies"`
}

// ToTaskPlan converts a JSONTaskPlan to an orchestrator.TaskPlan.
func (p JSONTaskPlan) ToTaskPlan() orchestrator.TaskPlan {
	tasks := make([]orchestrator.Task, len(p.Tasks))
	for i, t := range p.Tasks {
		tasks[i] = t.ToTask()
	}
	return orchestrator.TaskPlan{
		Tasks:        tasks,
		Dependencies: p.Dependencies,
	}
}

// JSONBrokerCallResult wraps a broker call result for JSON serialization.
type JSONBrokerCallResult struct {
	Result map[string]any `json:"result"`
}

// JSONToolMatch wraps an intent.ToolMatch for JSON serialization.
type JSONToolMatch struct {
	Tool   JSONToolSummary `json:"tool"`
	Score  float64         `json:"score"`
	Reason string          `json:"reason"`
}

// JSONToolSummary is a minimal tool summary for JSON output.
type JSONToolSummary struct {
	Server      string `json:"server"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// FromIntentToolMatch converts an intent.ToolMatch to a JSONToolMatch.
func FromIntentToolMatch(m *intent.ToolMatch) JSONToolMatch {
	if m == nil {
		return JSONToolMatch{}
	}
	return JSONToolMatch{
		Tool: JSONToolSummary{
			Server:      m.Tool.Server,
			Name:        m.Tool.Name,
			Description: m.Tool.Description,
		},
		Score:  m.Score,
		Reason: m.Reason,
	}
}
