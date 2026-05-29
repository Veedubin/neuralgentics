package dialectic

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// challengeResponse is the JSON structure expected from the LLM for challenge processing.
type challengeResponse struct {
	Response         string  `json:"response"`
	MemoryStatus     string  `json:"memory_status"`     // "maintained", "adjusted", "superseded"
	ConfidenceChange float64 `json:"confidence_change"` // -0.3 to +0.3
	Reasoning        string  `json:"reasoning"`
}

// challengePromptTemplate is the prompt used to ask the LLM to process a challenge.
const challengePromptTemplate = `You are analyzing a challenge to a memory.
Original Memory: %s
Challenge: %s

Analyze whether the challenge is valid and should affect the memory's trust.
Consider the following:
1. Does the challenge present new information that contradicts the memory?
2. Is the challenge well-supported by evidence?
3. Should the memory be maintained, adjusted, or superseded?

Previous challenge history: %s

Return JSON with the following structure:
{
  "response": "<your response to the challenge>",
  "memory_status": "<maintained|adjusted|superseded>",
  "confidence_change": <float between -0.3 and +0.3>,
  "reasoning": "<detailed reasoning for your assessment>"
}

Return ONLY valid JSON. Do not include any explanation or markdown.`

// ProcessChallenge handles a challenge and generates a response via LLM.
// It evaluates the challenge against the memory content, considers prior challenge
// history, and returns a ChallengeEvent with the result.
func ProcessChallenge(ctx context.Context, llm core.LLMClient, memory *core.MemoryEntry, challengeText string, history []core.ChallengeEvent) (*core.ChallengeEvent, error) {
	if memory == nil {
		return nil, fmt.Errorf("memory must not be nil")
	}
	if challengeText == "" {
		return nil, fmt.Errorf("challenge text must not be empty")
	}

	// Format history for the prompt.
	historyStr := "none"
	if len(history) > 0 {
		var parts []string
		for _, h := range history {
			parts = append(parts, fmt.Sprintf("- [%s] %s (status: %s)", h.ChallengerID, h.ChallengeText, h.Status))
		}
		historyStr = strings.Join(parts, "\n")
	}

	prompt := fmt.Sprintf(challengePromptTemplate, memory.Content, challengeText, historyStr)

	messages := []core.ConversationMessage{
		{Role: "system", Content: "You are a dialectic challenge analyzer. Assess challenges to memories objectively. Return only valid JSON."},
		{Role: "user", Content: prompt},
	}

	response, err := llm.Chat(ctx, messages, 0.3)
	if err != nil {
		return nil, fmt.Errorf("llm chat: %w", err)
	}

	// Parse JSON from LLM response, stripping markdown fences if present.
	cleaned := stripMarkdownFences(response)

	var resp challengeResponse
	if err := json.Unmarshal([]byte(cleaned), &resp); err != nil {
		return nil, fmt.Errorf("parse LLM response as JSON: %w (response: %q)", err, cleaned)
	}

	// Validate and normalise memory status.
	status := normaliseChallengeStatus(resp.MemoryStatus)
	confidenceChange := clampFloat(resp.ConfidenceChange, -0.3, 0.3)

	return &core.ChallengeEvent{
		ChallengeText:    challengeText,
		ResponseText:     resp.Response,
		Status:           status,
		ConfidenceChange: confidenceChange,
		CreatedAt:        time.Now(),
	}, nil
}

// normaliseChallengeStatus maps LLM memory status values to canonical values.
func normaliseChallengeStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "maintained":
		return "rejected"
	case "adjusted":
		return "accepted"
	case "superseded":
		return "accepted"
	default:
		return "rejected"
	}
}

// clampFloat constrains a float64 value between min and max.
func clampFloat(v, min, max float64) float64 {
	return math.Max(min, math.Min(max, v))
}
