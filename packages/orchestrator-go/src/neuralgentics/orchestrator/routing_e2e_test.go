// Package orchestrator end-to-end routing tests verify the complete
// routing matrix: TaskType → AgentRole, intent classification, forbidden
// agent enforcement, and matrix integrity (no duplicate task types).
package orchestrator

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

// ============================================================================
// Test 1: E2E Routing All Task Types
// ============================================================================

// TestE2E_RoutingAllTaskTypes verifies every TaskType resolves to the correct
// AgentRole and that the agent name string matches the expected constant value.
func TestE2E_RoutingAllTaskTypes(t *testing.T) {
	tests := []struct {
		taskType  TaskType
		wantAgent AgentRole
		wantName  string // expected string value of the AgentRole constant
	}{
		{TaskTypeCodeImpl, AgentCoder, "coder"},
		{TaskTypeArchDesign, AgentArchitect, "architect"},
		{TaskTypeFileFinding, AgentExplorer, "explorer"},
		{TaskTypeTesting, AgentTester, "tester"},
		{TaskTypeLinting, AgentLinter, "linter"},
		{TaskTypeGit, AgentGit, "git"},
		{TaskTypeDocumentation, AgentWriter, "writer"},
		{TaskTypeWebScraping, AgentScraper, "scraper"},
		{TaskTypeMCPDebug, AgentMCPSpecialist, "mcp-specialist"},
		{TaskTypeRelease, AgentRelease, "release"},
	}

	for _, tt := range tests {
		t.Run(string(tt.taskType), func(t *testing.T) {
			got, err := ResolveAgent(tt.taskType)
			if err != nil {
				t.Fatalf("ResolveAgent(%s) returned unexpected error: %v", tt.taskType, err)
			}
			if got != tt.wantAgent {
				t.Errorf("ResolveAgent(%s) = %q, want AgentRole %q", tt.taskType, got, tt.wantAgent)
			}
			// Assert the string representation matches the constant value exactly.
			if string(got) != tt.wantName {
				t.Errorf("ResolveAgent(%s) agent name = %q, want %q", tt.taskType, string(got), tt.wantName)
			}
		})
	}
}

// ============================================================================
// Test 2: E2E Routing By Intent
// ============================================================================

// intentRule maps a compiled regex pattern to the expected TaskType.
type intentRule struct {
	pattern  *regexp.Regexp
	taskType TaskType
}

// classifyIntent matches user input to a TaskType using keyword patterns.
// Returns the first matching TaskType, or an error if nothing matches.
func classifyIntent(input string, rules []intentRule) (TaskType, error) {
	lower := strings.ToLower(input)
	for _, rule := range rules {
		if rule.pattern.MatchString(lower) {
			return rule.taskType, nil
		}
	}
	return "", fmt.Errorf("no intent rule matched input: %q", input)
}

// intentRules is the keyword matcher for user intents.
// Rules are ordered by specificity: more specific patterns (readme, linter)
// come before broader patterns (write, code) to avoid false matches.
var intentRules = []intentRule{
	// Documentation must come before CodeImpl so "write a README" → docs, not code.
	{regexp.MustCompile(`\b(readme|docs|documentation|markdown|document)\b`), TaskTypeDocumentation},
	// Linting must come before CodeImpl so "fix the linter errors" → lint, not code.
	{regexp.MustCompile(`\b(lint(?:er)?|format|style|prettier|eslint|check\s*style)\b`), TaskTypeLinting},
	{regexp.MustCompile(`\b(design|architect|schema|trade.?off|system\s*design)\b`), TaskTypeArchDesign},
	{regexp.MustCompile(`\b(find|locate|search\s*for|where\s*is|glob|list\s*files)\b`), TaskTypeFileFinding},
	{regexp.MustCompile(`\b(test|spec|suite|unit\s*test|integration\s*test)\b`), TaskTypeTesting},
	{regexp.MustCompile(`\b(commit|branch|tag|merge|push|pull\s*request|git)\b`), TaskTypeGit},
	{regexp.MustCompile(`\b(scrape|fetch\s*url|crawl|extract\s*data|web\s*research)\b`), TaskTypeWebScraping},
	{regexp.MustCompile(`\b(mcp|server\s*debug|protocol\s*debug|tool\s*debug)\b`), TaskTypeMCPDebug},
	{regexp.MustCompile(`\b(release|version|bump|changelog|publish)\b`), TaskTypeRelease},
	// CodeImpl is last so domain-specific patterns win over generic "write".
	{regexp.MustCompile(`\b(write|implement|code|function|class|bug\s*fix|refactor)\b`), TaskTypeCodeImpl},
}

// TestE2E_RoutingByIntent classifies example user intents to TaskTypes,
// then resolves them to AgentRoles and asserts the correct agent is selected.
func TestE2E_RoutingByIntent(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantType  TaskType
		wantAgent AgentRole
	}{
		{
			name:      "write_python_function",
			input:     "write a python function to parse JSON",
			wantType:  TaskTypeCodeImpl,
			wantAgent: AgentCoder,
		},
		{
			name:      "design_database_schema",
			input:     "design the database schema",
			wantType:  TaskTypeArchDesign,
			wantAgent: AgentArchitect,
		},
		{
			name:      "find_test_files",
			input:     "find all the test files",
			wantType:  TaskTypeFileFinding,
			wantAgent: AgentExplorer,
		},
		{
			name:      "run_test_suite",
			input:     "run the test suite",
			wantType:  TaskTypeTesting,
			wantAgent: AgentTester,
		},
		{
			name:      "fix_linter_errors",
			input:     "fix the linter errors",
			wantType:  TaskTypeLinting,
			wantAgent: AgentLinter,
		},
		{
			name:      "commit_changes",
			input:     "commit these changes",
			wantType:  TaskTypeGit,
			wantAgent: AgentGit,
		},
		{
			name:      "write_readme",
			input:     "write a README",
			wantType:  TaskTypeDocumentation,
			wantAgent: AgentWriter,
		},
		{
			name:      "bump_version",
			input:     "bump the version",
			wantType:  TaskTypeRelease,
			wantAgent: AgentRelease,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotType, err := classifyIntent(tt.input, intentRules)
			if err != nil {
				t.Fatalf("classifyIntent(%q) returned unexpected error: %v", tt.input, err)
			}
			if gotType != tt.wantType {
				t.Errorf("classifyIntent(%q) = %q, want %q", tt.input, gotType, tt.wantType)
				return
			}

			gotAgent, err := ResolveAgent(gotType)
			if err != nil {
				t.Fatalf("ResolveAgent(%s) returned unexpected error: %v", gotType, err)
			}
			if gotAgent != tt.wantAgent {
				t.Errorf("ResolveAgent(%s) = %q, want %q", gotType, gotAgent, tt.wantAgent)
			}
		})
	}
}

// ============================================================================
// Test 3: E2E Forbidden Agents Enforced
// ============================================================================

// TestE2E_ForbiddenAgentsEnforced verifies that every agent listed in
// ForbiddenAgents for a task type IS forbidden, and that the designated
// agent is NOT in the forbidden list.
func TestE2E_ForbiddenAgentsEnforced(t *testing.T) {
	for _, rule := range RoutingMatrix {
		t.Run(string(rule.TaskType), func(t *testing.T) {
			// Every agent in ForbiddenAgents must be forbidden.
			for _, forbidden := range rule.ForbiddenAgents {
				if !IsForbiddenAgent(rule.TaskType, forbidden) {
					t.Errorf(
						"IsForbiddenAgent(%s, %s) = false, want true (agent is in ForbiddenAgents list)",
						rule.TaskType, forbidden,
					)
				}
			}

			// The designated agent must NOT be in the forbidden list.
			if IsForbiddenAgent(rule.TaskType, rule.Agent) {
				t.Errorf(
					"IsForbiddenAgent(%s, %s) = true, want false (designated agent should not be forbidden)",
					rule.TaskType, rule.Agent,
				)
			}

			// Also verify via ValidateRouting that the designated agent is valid.
			validation := ValidateRouting(rule.TaskType, rule.Agent)
			if !validation.Valid {
				t.Errorf(
					"ValidateRouting(%s, %s) should be valid, got violation: %s",
					rule.TaskType, rule.Agent, validation.Violation,
				)
			}
		})
	}
}

// ============================================================================
// Test 4: E2E No TaskType Collisions
// ============================================================================

// TestE2E_NoTaskTypeCollisions ensures no two rules in the routing matrix
// share the same TaskType (prevents copy-paste duplication bugs).
func TestE2E_NoTaskTypeCollisions(t *testing.T) {
	seen := make(map[TaskType]int, len(RoutingMatrix))

	for i, rule := range RoutingMatrix {
		if prevIdx, exists := seen[rule.TaskType]; exists {
			t.Errorf(
				"RoutingMatrix[%d] and RoutingMatrix[%d] both have TaskType %s — duplicate task type",
				prevIdx, i, rule.TaskType,
			)
		}
		seen[rule.TaskType] = i
	}

	// Verify we have exactly 10 distinct task types (the full matrix).
	if len(seen) != 10 {
		t.Errorf("expected 10 distinct TaskTypes in RoutingMatrix, got %d", len(seen))
	}
}
