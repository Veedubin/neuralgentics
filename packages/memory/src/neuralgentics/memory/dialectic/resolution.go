package dialectic

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// resolutionResponse is the JSON structure expected from the LLM for resolution synthesis.
type resolutionResponse struct {
	Resolution      string   `json:"resolution"`
	Winner          string   `json:"winner"`
	Reasoning       string   `json:"reasoning"`
	Confidence      float64  `json:"confidence"`
	Recommendations []string `json:"recommendations"`
}

// resolutionPromptTemplate is the prompt used to ask the LLM to synthesize a resolution.
const resolutionPromptTemplate = `Based on these arguments for Memory A and Memory B, synthesize a resolution:

Arguments for A: %s
Arguments for B: %s

Contradiction context: %s

Return JSON with the following structure:
{
  "resolution": "<summary of the resolution>",
  "winner": "<A|B|inconclusive>",
  "reasoning": "<detailed reasoning>",
  "confidence": <0.0-1.0>,
  "recommendations": ["<recommendation1>", "<recommendation2>"]
}

Return ONLY valid JSON. Do not include any explanation or markdown.`

// SynthesizeResolution produces a Resolution from the generated arguments by
// calling the LLM. It maps the LLM's response fields onto the core.Resolution struct.
func SynthesizeResolution(ctx context.Context, llm core.LLMClient, contradiction *core.Contradiction, args *ArgumentsResult) (*core.Resolution, error) {
	if contradiction == nil {
		return nil, fmt.Errorf("contradiction must not be nil")
	}
	if args == nil {
		return nil, fmt.Errorf("arguments must not be nil")
	}

	argsForA := formatArguments(args.ProA)
	argsForB := formatArguments(args.ProB)

	prompt := fmt.Sprintf(resolutionPromptTemplate, argsForA, argsForB, contradiction.Description)

	messages := []core.ConversationMessage{
		{Role: "system", Content: "You are a dialectic resolution engine. Synthesize contradictory arguments into a structured resolution. Return only valid JSON."},
		{Role: "user", Content: prompt},
	}

	response, err := llm.Chat(ctx, messages, 0.3)
	if err != nil {
		return nil, fmt.Errorf("llm chat: %w", err)
	}

	// Parse JSON from LLM response, stripping markdown fences if present.
	cleaned := stripMarkdownFences(response)

	var resp resolutionResponse
	if err := json.Unmarshal([]byte(cleaned), &resp); err != nil {
		return nil, fmt.Errorf("parse LLM response as JSON: %w (response: %q)", err, cleaned)
	}

	// Map winner to canonical values.
	winner := normaliseWinner(resp.Winner)
	confidence := resp.Confidence
	if confidence < 0 {
		confidence = 0
	}
	if confidence > 1 {
		confidence = 1
	}

	resolution := &core.Resolution{
		ContradictionID: contradiction.ID,
		WinnerMemory:    winner,
		Explanation:     resp.Reasoning,
		Confidence:      confidence,
		Recommendations: resp.Recommendations,
		CreatedAt:       time.Now(),
	}

	if resolution.Explanation == "" {
		resolution.Explanation = resp.Resolution
	}

	return resolution, nil
}

// formatArguments formats a slice of Arguments into a human-readable string
// for the LLM prompt.
func formatArguments(args []core.Argument) string {
	if len(args) == 0 {
		return "(none)"
	}
	var parts []string
	for _, a := range args {
		evidence := strings.Join(a.Evidence, ", ")
		if evidence == "" {
			evidence = "(no evidence)"
		}
		parts = append(parts, fmt.Sprintf("- [%s] %s (confidence: %.2f, evidence: %s)",
			a.MemoryID, a.Text, a.Confidence, evidence))
	}
	return strings.Join(parts, "\n")
}

// normaliseWinner maps LLM winner values to canonical values used by core.Resolution.
func normaliseWinner(winner string) string {
	switch strings.ToLower(strings.TrimSpace(winner)) {
	case "a":
		return "A"
	case "b":
		return "B"
	default:
		return "inconclusive"
	}
}
