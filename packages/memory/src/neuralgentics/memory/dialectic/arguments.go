package dialectic

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ArgumentsResult holds pro/con arguments for two contradictory memories
// plus an overall analysis from the LLM.
type ArgumentsResult struct {
	ProA            []core.Argument `json:"pro_a_arguments"`
	ProB            []core.Argument `json:"pro_b_arguments"`
	Analysis        string          `json:"analysis"`
	PreferredMemory string          `json:"preferred_memory"` // "A", "B", or "neither"
	Confidence      float64         `json:"confidence"`
}

// argumentsPromptTemplate is the prompt used to ask the LLM to generate
// pro/con arguments for two contradictory memories.
const argumentsPromptTemplate = `You are analyzing two contradictory memories and generating arguments for each side.

Memory A (id: %s): %s
Memory B (id: %s): %s

Return JSON with the following structure:
{
  "pro_a_arguments": [
    {"memoryId": "<id_A>", "text": "<argument text>", "confidence": <0.0-1.0>, "evidence": ["<evidence1>"]}
  ],
  "pro_b_arguments": [
    {"memoryId": "<id_B>", "text": "<argument text>", "confidence": <0.0-1.0>, "evidence": ["<evidence1>"]}
  ],
  "analysis": "<overall analysis of the contradiction>",
  "preferred_memory": "<A|B|neither>",
  "confidence": <0.0-1.0>
}

Return ONLY valid JSON. Do not include any explanation or markdown.`

// GenerateArguments builds pro/con arguments for two contradictory memories
// by calling the LLM and parsing the structured JSON response.
func GenerateArguments(ctx context.Context, llm core.LLMClient, memA, memB *core.MemoryEntry) (*ArgumentsResult, error) {
	if memA == nil || memB == nil {
		return nil, fmt.Errorf("both memories must be non-nil")
	}

	prompt := fmt.Sprintf(argumentsPromptTemplate, memA.ID, memA.Content, memB.ID, memB.Content)

	messages := []core.ConversationMessage{
		{Role: "system", Content: "You are a dialectic reasoning engine. Analyze contradictory information and produce structured JSON output."},
		{Role: "user", Content: prompt},
	}

	response, err := llm.Chat(ctx, messages, 0.3)
	if err != nil {
		return nil, fmt.Errorf("llm chat: %w", err)
	}

	// Parse JSON from LLM response, stripping markdown fences if present.
	cleaned := stripMarkdownFences(response)

	var result ArgumentsResult
	if err := json.Unmarshal([]byte(cleaned), &result); err != nil {
		return nil, fmt.Errorf("parse LLM response as JSON: %w (response: %q)", err, cleaned)
	}

	// Validate and normalise preferred memory value.
	result.PreferredMemory = normalisePreferredMemory(result.PreferredMemory)

	// Clamp confidence.
	if result.Confidence < 0 {
		result.Confidence = 0
	}
	if result.Confidence > 1 {
		result.Confidence = 1
	}

	return &result, nil
}

// normalisePreferredMemory maps preferred memory strings to canonical values.
func normalisePreferredMemory(pref string) string {
	switch strings.ToLower(strings.TrimSpace(pref)) {
	case "a":
		return "A"
	case "b":
		return "B"
	default:
		return "neither"
	}
}

// stripMarkdownFences removes ```json and ``` wrappers from LLM output.
func stripMarkdownFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		// Find the end of the opening fence line (may include language tag).
		if idx := strings.Index(s, "\n"); idx >= 0 {
			s = s[idx+1:]
		}
		// Strip closing fence.
		if idx := strings.LastIndex(s, "```"); idx >= 0 {
			s = s[:idx]
		}
		s = strings.TrimSpace(s)
	}
	return s
}
