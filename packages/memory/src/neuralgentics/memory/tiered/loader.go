package tiered

import (
	"context"
	"fmt"
	"strings"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// Summary represents a generated tiered summary.
type Summary struct {
	Content     string    `json:"content"`
	GeneratedAt time.Time `json:"generatedAt"`
	TokenCount  int       `json:"tokenCount"` // approximate token count
	Tier        string    `json:"tier"`       // "L0" or "L1"
}

// ExtractionResult holds the output of a memory extraction from conversation text.
type ExtractionResult struct {
	MemoryIDs []string `json:"memoryIds"`
	Count     int      `json:"count"`
}

// PrecompressResult holds the output of a pre-compression context capture.
type PrecompressResult struct {
	MemoriesExtracted int      `json:"memoriesExtracted"`
	MemoryIDs         []string `json:"memoryIds"`
	Context           string   `json:"context"`
}

// LLM prompt templates for each tier.
const (
	// l0SystemPrompt is the system instruction for L0 summaries (~100 tokens).
	l0SystemPrompt = `You are a memory summarizer. Generate a concise project summary of approximately 100 tokens. Focus on the most important facts and current state. Do not include information you are not given.`

	// l0UserPromptTemplate is the user prompt for L0 summaries.
	l0UserPromptTemplate = `Summarize the following memories in approximately 100 tokens. Focus on the most important facts, decisions, and current project state:` + "\n\n%s"

	// l1SystemPrompt is the system instruction for L1 summaries (~2K tokens).
	l1SystemPrompt = `You are a memory summarizer. Generate a structured list of key decisions and important patterns from memories. Be thorough but organized. Do not include information you are not given.`

	// l1UserPromptTemplate is the user prompt for L1 summaries.
	l1UserPromptTemplate = `List the key decisions, patterns, and important facts from the following memories. Organize them by category:` + "\n\n%s"

	// extractionSystemPrompt is the system instruction for memory extraction.
	extractionSystemPrompt = `You are a memory extraction system. Analyze the conversation and extract distinct facts, decisions, and insights as separate memories. Each memory should be a single, atomic piece of information. Output one memory per line, prefixed with "- ". Do not include information not present in the conversation.`

	// extractionUserPromptTemplate is the user prompt for memory extraction.
	extractionUserPromptTemplate = `Extract all distinct facts, decisions, and insights from the following conversation as separate memories:` + "\n\n%s"

	// precompressSystemPrompt is the system instruction for pre-compression context capture.
	precompressSystemPrompt = `You are a context preservation system. Analyze the conversation context and extract any important facts, decisions, or insights that should be preserved as memories before context is lost.`

	// precompressUserPromptTemplate is the user prompt for pre-compression.
	precompressUserPromptTemplate = `Analyze this context and extract any important information that should be preserved as memories:` + "\n\n%s"

	// Trust thresholds for each tier.
	l0MinTrust = 0.5
	l1MinTrust = 0.8

	// Memory limits for each tier.
	l0Limit = 20
	l1Limit = 100
)

// TieredLoader generates L0 and L1 summaries from stored memories using an LLM.
// It uses a SummaryCache to avoid redundant LLM calls within TTL windows.
//
// The loader depends on the core.Store interface for retrieving memories and
// the core.LLMClient interface for generating summaries. This enables testing
// with mock implementations.
type TieredLoader struct {
	store core.Store
	llm   core.LLMClient
	cache *SummaryCache
}

// NewTieredLoader creates a new TieredLoader with the given store, LLM client, and cache.
// If cache is nil, a new default SummaryCache is created.
func NewTieredLoader(store core.Store, llm core.LLMClient, cache *SummaryCache) *TieredLoader {
	if cache == nil {
		cache = NewSummaryCache()
	}
	return &TieredLoader{
		store: store,
		llm:   llm,
		cache: cache,
	}
}

// GetTier0Summary returns an L0 summary (~100 tokens) of high-trust memories.
// It first checks the cache; if a valid cached summary exists, it is returned.
// Otherwise, it queries memories with trust >= 0.5 (limit 20), formats a prompt,
// and calls the LLM to generate the summary.
// Use forceRefresh=true to bypass the cache and regenerate.
func (l *TieredLoader) GetTier0Summary(ctx context.Context, forceRefresh bool) (*Summary, error) {
	if !forceRefresh {
		if cached, ok := l.cache.Get(CacheKeyL0); ok {
			return &Summary{
				Content:     cached,
				GeneratedAt: time.Now(),
				Tier:        "L0",
			}, nil
		}
	}

	memories, err := l.fetchHighTrustMemories(ctx, l0MinTrust, l0Limit)
	if err != nil {
		return nil, fmt.Errorf("tiered L0: fetch memories: %w", err)
	}

	if len(memories) == 0 {
		return &Summary{
			Content:     "No high-trust memories available.",
			GeneratedAt: time.Now(),
			TokenCount:  6,
			Tier:        "L0",
		}, nil
	}

	content := formatMemories(memories)
	userPrompt := fmt.Sprintf(l0UserPromptTemplate, content)

	result, err := l.llm.Chat(ctx, []core.ConversationMessage{
		{Role: "system", Content: l0SystemPrompt},
		{Role: "user", Content: userPrompt},
	}, 0.3) // low temperature for consistent summaries
	if err != nil {
		return nil, fmt.Errorf("tiered L0: LLM chat: %w", err)
	}

	summary := &Summary{
		Content:     result,
		GeneratedAt: time.Now(),
		TokenCount:  estimateTokens(result),
		Tier:        "L0",
	}

	l.cache.Set(CacheKeyL0, result, DefaultL0TTL)
	return summary, nil
}

// GetTier1Summary returns an L1 summary (~2K tokens) of key decisions from highest-trust memories.
// It first checks the cache; if a valid cached summary exists, it is returned.
// Otherwise, it queries memories with trust >= 0.8 (limit 100), formats a prompt,
// and calls the LLM to generate the summary.
// Use forceRefresh=true to bypass the cache and regenerate.
func (l *TieredLoader) GetTier1Summary(ctx context.Context, forceRefresh bool) (*Summary, error) {
	if !forceRefresh {
		if cached, ok := l.cache.Get(CacheKeyL1); ok {
			return &Summary{
				Content:     cached,
				GeneratedAt: time.Now(),
				Tier:        "L1",
			}, nil
		}
	}

	memories, err := l.fetchHighTrustMemories(ctx, l1MinTrust, l1Limit)
	if err != nil {
		return nil, fmt.Errorf("tiered L1: fetch memories: %w", err)
	}

	if len(memories) == 0 {
		return &Summary{
			Content:     "No key decisions available.",
			GeneratedAt: time.Now(),
			TokenCount:  5,
			Tier:        "L1",
		}, nil
	}

	content := formatMemories(memories)
	userPrompt := fmt.Sprintf(l1UserPromptTemplate, content)

	result, err := l.llm.Chat(ctx, []core.ConversationMessage{
		{Role: "system", Content: l1SystemPrompt},
		{Role: "user", Content: userPrompt},
	}, 0.3)
	if err != nil {
		return nil, fmt.Errorf("tiered L1: LLM chat: %w", err)
	}

	summary := &Summary{
		Content:     result,
		GeneratedAt: time.Now(),
		TokenCount:  estimateTokens(result),
		Tier:        "L1",
	}

	l.cache.Set(CacheKeyL1, result, DefaultL1TTL)
	return summary, nil
}

// TriggerExtraction extracts memories from a conversation string using the LLM.
// It sends the conversation to the LLM with an extraction prompt, parses the
// response into individual memories, and stores each one.
func (l *TieredLoader) TriggerExtraction(ctx context.Context, conversation string) (*ExtractionResult, error) {
	if conversation == "" {
		return &ExtractionResult{}, nil
	}

	userPrompt := fmt.Sprintf(extractionUserPromptTemplate, conversation)

	result, err := l.llm.Chat(ctx, []core.ConversationMessage{
		{Role: "system", Content: extractionSystemPrompt},
		{Role: "user", Content: userPrompt},
	}, 0.4) // slightly higher temperature for diverse extractions
	if err != nil {
		return nil, fmt.Errorf("tiered extraction: LLM chat: %w", err)
	}

	memories := parseExtractedMemories(result)
	var ids []string
	for _, mem := range memories {
		id, err := l.store.AddMemory(ctx, &core.MemoryEntry{
			Content:    mem,
			SourceType: "boomerang",
		})
		if err != nil {
			// Log but continue — partial extraction is acceptable.
			continue
		}
		ids = append(ids, id)
	}

	return &ExtractionResult{
		MemoryIDs: ids,
		Count:     len(ids),
	}, nil
}

// PrecompressExtraction captures context and extracts memories before compaction.
// It is similar to TriggerExtraction but designed for pre-compaction context preservation.
// If contextContent is empty, it returns an empty result without calling the LLM.
func (l *TieredLoader) PrecompressExtraction(ctx context.Context, contextContent string) (*PrecompressResult, error) {
	if contextContent == "" {
		return &PrecompressResult{}, nil
	}

	userPrompt := fmt.Sprintf(precompressUserPromptTemplate, contextContent)

	result, err := l.llm.Chat(ctx, []core.ConversationMessage{
		{Role: "system", Content: precompressSystemPrompt},
		{Role: "user", Content: userPrompt},
	}, 0.4)
	if err != nil {
		return nil, fmt.Errorf("tiered precompress: LLM chat: %w", err)
	}

	memories := parseExtractedMemories(result)
	var ids []string
	for _, mem := range memories {
		id, err := l.store.AddMemory(ctx, &core.MemoryEntry{
			Content:    mem,
			SourceType: "boomerang",
		})
		if err != nil {
			continue
		}
		ids = append(ids, id)
	}

	return &PrecompressResult{
		MemoriesExtracted: len(ids),
		MemoryIDs:         ids,
		Context:           contextContent,
	}, nil
}

// InvalidateCache removes cached summaries for a specific tier.
// Use "L0", "L1", or "" for both.
func (l *TieredLoader) InvalidateCache(tier string) {
	switch tier {
	case "L0":
		l.cache.Invalidate(CacheKeyL0)
	case "L1":
		l.cache.Invalidate(CacheKeyL1)
	default:
		l.cache.InvalidateAll()
	}
}

// fetchHighTrustMemories retrieves memories with trust score >= minTrust, limited to limit entries.
// It excludes archived memories and sorts by trust score descending.
func (l *TieredLoader) fetchHighTrustMemories(ctx context.Context, minTrust float64, limit int) ([]*core.MemoryEntry, error) {
	notArchived := false
	filter := &core.SearchFilter{
		MinTrustScore: minTrust,
		IsArchived:    &notArchived,
	}

	memories, err := l.store.ListMemories(ctx, filter, limit)
	if err != nil {
		return nil, err
	}

	// Filter by minimum trust score (in case store doesn't support it natively).
	var filtered []*core.MemoryEntry
	for _, m := range memories {
		if m.TrustScore >= minTrust {
			filtered = append(filtered, m)
		}
	}

	return filtered, nil
}

// formatMemories formats a slice of MemoryEntry into a newline-separated string suitable for LLM prompts.
func formatMemories(memories []*core.MemoryEntry) string {
	var lines []string
	for _, m := range memories {
		lines = append(lines, fmt.Sprintf("- [%s] %s (trust: %.2f)", m.SourceType, m.Content, m.TrustScore))
	}
	return strings.Join(lines, "\n")
}

// estimateTokens provides a rough token estimate (1 token ≈ 4 characters).
func estimateTokens(text string) int {
	return len(text) / 4
}

// parseExtractedMemories splits LLM output into individual memory strings.
// Each line starting with "- " is treated as a separate memory.
// Lines without the prefix are ignored (they are LLM commentary).
func parseExtractedMemories(llmOutput string) []string {
	var memories []string
	lines := strings.Split(llmOutput, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "- ") {
			mem := strings.TrimPrefix(line, "- ")
			mem = strings.TrimSpace(mem)
			if mem != "" {
				memories = append(memories, mem)
			}
		}
	}
	return memories
}
