package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// BuildContextPackage assembles a ContextPackage for a task and target agent
// by querying the MemoryProvider directly (zero HTTP).
//
// It fetches:
//  1. Relevant memories for the task description
//  2. Trust scores for matched memories
//  3. File paths and code snippets from memory sources
//  4. Scope boundaries and expected output based on task type/agent
func BuildContextPackage(
	ctx context.Context,
	mem MemoryProvider,
	task Task,
	agent AgentRole,
) (ContextPackage, error) {
	// Query relevant memories for the task description
	opts := &SearchOptions{TopK: 10, Threshold: 0.7}
	relevantMemories, err := mem.QueryMemories(ctx, task.Description, opts)
	if err != nil {
		return ContextPackage{}, fmt.Errorf("query memories for context: %w", err)
	}

	// Build trust scores map from relevant memories
	trustScores := make(map[string]float64)
	for _, m := range relevantMemories {
		if m.TrustScore > 0 {
			trustScores[m.ID] = m.TrustScore
		}
	}

	// Extract previous decisions from project/boomerang source types
	var previousDecisions []string
	for _, m := range relevantMemories {
		if m.SourceType == "project" || m.SourceType == "boomerang" {
			previousDecisions = append(previousDecisions, m.Content)
		}
	}
	if len(previousDecisions) == 0 {
		previousDecisions = []string{}
	}

	// Identify relevant file paths from file-type memories
	relevantFiles := extractRelevantFiles(relevantMemories)

	// Extract code snippets from file-type memories
	codeSnippets := extractCodeSnippets(relevantMemories)

	// Resolve scope boundaries based on task type and agent
	scopeBoundaries := resolveScopeBoundaries(task.Type, agent)

	// Resolve expected output
	expectedOutput := resolveExpectedOutput(task.Type)

	// Resolve error handling strategy
	errorHandling := resolveErrorHandling(task.Type)

	// Build task background from task metadata and relevant memories
	taskBackground := buildTaskBackground(task, relevantMemories)

	pkg := ContextPackage{
		UserRequest:       task.UserRequest,
		TaskBackground:    taskBackground,
		RelevantFiles:     relevantFiles,
		CodeSnippets:      codeSnippets,
		PreviousDecisions: previousDecisions,
		ExpectedOutput:    expectedOutput,
		ScopeIn:           scopeBoundaries.InScope,
		ScopeOut:          scopeBoundaries.OutScope,
		ErrorHandling:     errorHandling,
		TrustScores:       trustScores,
	}

	return pkg, nil
}

// StoreContextPackage stores a ContextPackage in memory and returns the memory ID.
func StoreContextPackage(
	ctx context.Context,
	mem MemoryProvider,
	pkg ContextPackage,
	task Task,
	agent AgentRole,
) (string, error) {
	content, err := json.Marshal(pkg)
	if err != nil {
		return "", fmt.Errorf("marshal context package: %w", err)
	}

	metadata := ContextPackageMetadata{
		TaskType:  task.Type,
		AgentRole: agent,
		TaskID:    task.ID,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Project:   "neuralgentics",
		Version:   "1.0",
	}

	metaMap := map[string]any{
		"taskType":  string(metadata.TaskType),
		"agentRole": string(metadata.AgentRole),
		"taskId":    metadata.TaskID,
		"project":   metadata.Project,
		"version":   metadata.Version,
	}

	entry := MemoryEntry{
		Content:    string(content),
		SourceType: "context_package",
		Metadata:   metaMap,
	}

	id, err := mem.AddMemory(ctx, entry)
	if err != nil {
		return "", fmt.Errorf("store context package in memory: %w", err)
	}

	return id, nil
}

// FetchContextPackage retrieves a ContextPackage from memory by ID.
func FetchContextPackage(
	ctx context.Context,
	mem MemoryProvider,
	memoryID string,
) (ContextPackage, error) {
	entry, err := mem.GetMemory(ctx, memoryID)
	if err != nil {
		return ContextPackage{}, fmt.Errorf("fetch context package from memory: %w", err)
	}

	var pkg ContextPackage
	if err := json.Unmarshal([]byte(entry.Content), &pkg); err != nil {
		return ContextPackage{}, fmt.Errorf("unmarshal context package: %w", err)
	}

	return pkg, nil
}

// StoreAgentWrapUp stores an agent wrap-up in memory and returns the memory ID.
func StoreAgentWrapUp(
	ctx context.Context,
	mem MemoryProvider,
	wrapUp AgentWrapUp,
	task Task,
	agent AgentRole,
	contextMemoryID string,
	durationMs int64,
	success bool,
) (string, error) {
	content, err := json.Marshal(wrapUp)
	if err != nil {
		return "", fmt.Errorf("marshal agent wrap-up: %w", err)
	}

	metaMap := map[string]any{
		"taskType":        string(task.Type),
		"agentRole":       string(agent),
		"taskId":          task.ID,
		"contextMemoryId": contextMemoryID,
		"project":         "neuralgentics",
		"durationMs":      durationMs,
		"success":         success,
	}

	entry := MemoryEntry{
		Content:    string(content),
		SourceType: "agent_wrap_up",
		Metadata:   metaMap,
	}

	id, err := mem.AddMemory(ctx, entry)
	if err != nil {
		return "", fmt.Errorf("store agent wrap-up in memory: %w", err)
	}

	return id, nil
}

// FetchAgentWrapUp retrieves an agent wrap-up from memory by ID.
func FetchAgentWrapUp(
	ctx context.Context,
	mem MemoryProvider,
	wrapUpMemoryID string,
) (AgentWrapUp, error) {
	entry, err := mem.GetMemory(ctx, wrapUpMemoryID)
	if err != nil {
		return AgentWrapUp{}, fmt.Errorf("fetch agent wrap-up from memory: %w", err)
	}

	var wrapUp AgentWrapUp
	if err := json.Unmarshal([]byte(entry.Content), &wrapUp); err != nil {
		return AgentWrapUp{}, fmt.Errorf("unmarshal agent wrap-up: %w", err)
	}

	return wrapUp, nil
}

// BuildSeedPrompt builds a seed prompt string and stores context in memory.
// Returns the seed prompt and context memory ID.
func BuildSeedPrompt(
	ctx context.Context,
	mem MemoryProvider,
	task Task,
	contextPkg ContextPackage,
	agent AgentRole,
) (SeedPrompt, string, error) {
	contextMemoryID, err := StoreContextPackage(ctx, mem, contextPkg, task, agent)
	if err != nil {
		return SeedPrompt{}, "", fmt.Errorf("store context for seed prompt: %w", err)
	}

	prompt := FormatSeedPrompt(task.Description, contextMemoryID)

	seedPrompt := SeedPrompt{
		Task:     task.Description,
		MemoryID: contextMemoryID,
		Prompt:   prompt,
	}

	return seedPrompt, contextMemoryID, nil
}

// FormatSeedPrompt generates a seed prompt string from a task description and memory ID.
func FormatSeedPrompt(task string, memoryID string) string {
	sb := strings.Builder{}
	sb.WriteString("---\n")
	sb.WriteString("## Task\n")
	sb.WriteString(task)
	sb.WriteString("\n\n")
	sb.WriteString("## Memory Context\n")
	sb.WriteString("Your full context package is stored in the memini-core memory system at ID: `")
	sb.WriteString(memoryID)
	sb.WriteString("`\n\n")
	sb.WriteString("## Protocol (MANDATORY - Do NOT skip)\n\n")
	sb.WriteString("### 1. Context Retrieval\n")
	sb.WriteString("Fetch your context package from memory using the ID above.\n\n")
	sb.WriteString("### 2. Memory Queries (during work)\n")
	sb.WriteString("Query memory as needed for relevant context.\n\n")
	sb.WriteString("### 3. Wrap-Up Storage (before returning)\n")
	sb.WriteString("Store your wrap-up in memory with sourceType=\"agent_wrap_up\".\n\n")
	sb.WriteString("### 4. Trust Signal\n")
	sb.WriteString("Adjust trust on the context memory: signal=\"agent_used\".\n\n")
	sb.WriteString("### 5. Return Format\n")
	sb.WriteString("Return ONLY: {memory_id: \"<wrap_up_memory_id>\", description: \"<one-line summary>\"}\n")
	sb.WriteString("---")
	return sb.String()
}

// ============================================================================
// Internal helpers
// ============================================================================

func extractRelevantFiles(memories []*MemoryEntry) []string {
	seen := make(map[string]bool)
	var files []string
	for _, m := range memories {
		if m.SourceType == "file" && m.SourcePath != "" && !seen[m.SourcePath] {
			seen[m.SourcePath] = true
			files = append(files, m.SourcePath)
		}
	}
	if files == nil {
		files = []string{}
	}
	return files
}

func extractCodeSnippets(memories []*MemoryEntry) map[string]string {
	snippets := make(map[string]string)
	count := 0
	for _, m := range memories {
		if m.SourceType == "file" && count < 5 {
			snippets[m.SourcePath] = m.Content
			count++
		}
	}
	return snippets
}

func resolveScopeBoundaries(taskType TaskType, agent AgentRole) ScopeBoundaries {
	resolvedAgent, err := ResolveAgent(taskType)
	isSameAgent := err == nil && resolvedAgent == agent

	switch taskType {
	case TaskTypeCodeImpl:
		outScope := []string{}
		if isSameAgent {
			outScope = []string{"Architecture decisions", "Test infrastructure design"}
		}
		return ScopeBoundaries{
			InScope:  []string{"Write/edit code", "Implement features", "Fix bugs"},
			OutScope: outScope,
		}
	case TaskTypeArchDesign:
		return ScopeBoundaries{
			InScope:  []string{"System design", "Trade-off analysis", "Research"},
			OutScope: []string{"Code implementation", "File finding"},
		}
	case TaskTypeTesting:
		return ScopeBoundaries{
			InScope:  []string{"Write tests", "Run tests", "Coverage analysis"},
			OutScope: []string{"Implementation changes"},
		}
	case TaskTypeFileFinding:
		return ScopeBoundaries{
			InScope:  []string{"Glob/find files by name", "Map directory structure"},
			OutScope: []string{"Code analysis", "Pattern detection", "Research"},
		}
	case TaskTypeLinting:
		return ScopeBoundaries{
			InScope:  []string{"Lint code", "Format code", "Style checks"},
			OutScope: []string{"Code changes", "Architecture"},
		}
	case TaskTypeGit:
		return ScopeBoundaries{
			InScope:  []string{"Commits", "Branches", "Tags", "Push/Pull"},
			OutScope: []string{"Code implementation", "Testing"},
		}
	case TaskTypeDocumentation:
		return ScopeBoundaries{
			InScope:  []string{"Markdown", "README", "API docs"},
			OutScope: []string{"Code implementation"},
		}
	case TaskTypeWebScraping:
		return ScopeBoundaries{
			InScope:  []string{"URL fetching", "Data extraction", "Research"},
			OutScope: []string{"Code implementation"},
		}
	case TaskTypeMCPDebug:
		return ScopeBoundaries{
			InScope:  []string{"MCP protocol", "Server debugging", "Schema validation"},
			OutScope: []string{"Feature implementation"},
		}
	case TaskTypeRelease:
		return ScopeBoundaries{
			InScope:  []string{"Version bumps", "Changelogs", "Git tags"},
			OutScope: []string{"Feature implementation", "Testing"},
		}
	default:
		return ScopeBoundaries{
			InScope:  []string{fmt.Sprintf("%s tasks", taskType)},
			OutScope: []string{},
		}
	}
}

func resolveExpectedOutput(taskType TaskType) string {
	switch taskType {
	case TaskTypeCodeImpl:
		return "Modified files with implementation, 100-300 word summary"
	case TaskTypeArchDesign:
		return "Design document with trade-offs and recommendations"
	case TaskTypeTesting:
		return "Test files with coverage summary"
	case TaskTypeFileFinding:
		return "List of file paths matching query"
	case TaskTypeDocumentation:
		return "Markdown documentation files"
	case TaskTypeLinting:
		return "Linting results and auto-fixes applied"
	case TaskTypeGit:
		return "Git operation result (commit hash, branch name, etc.)"
	case TaskTypeRelease:
		return "Version bump, changelog, git tag"
	default:
		return "Summary of work completed"
	}
}

func resolveErrorHandling(taskType TaskType) string {
	switch taskType {
	case TaskTypeCodeImpl:
		return "Type errors -> fix types. Runtime errors -> add guards. Never swallow exceptions."
	case TaskTypeTesting:
		return "Flaky tests -> add retries. Missing deps -> skip with warning."
	default:
		return "Log errors, never swallow exceptions. Escalate to orchestrator if blocked."
	}
}

func buildTaskBackground(task Task, memories []*MemoryEntry) string {
	var parts []string

	parts = append(parts, fmt.Sprintf("Task: %s", task.Description))
	parts = append(parts, fmt.Sprintf("Type: %s", task.Type))
	parts = append(parts, fmt.Sprintf("Priority: %s", task.Priority))

	if len(task.Files) > 0 {
		parts = append(parts, fmt.Sprintf("Files: %s", strings.Join(task.Files, ", ")))
	}

	if len(memories) > 0 {
		parts = append(parts, fmt.Sprintf("\nContext from memory (%d results):", len(memories)))
		limit := 5
		if len(memories) < limit {
			limit = len(memories)
		}
		for i := 0; i < limit; i++ {
			m := memories[i]
			content := m.Content
			if len(content) > 200 {
				content = content[:200]
			}
			parts = append(parts, fmt.Sprintf("- [%s] %s", m.SourceType, content))
		}
	}

	return strings.Join(parts, "\n")
}
