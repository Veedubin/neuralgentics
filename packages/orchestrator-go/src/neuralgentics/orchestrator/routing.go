package orchestrator

import "fmt"

// RoutingMatrix defines the CODE-LEVEL ENFORCED mapping from TaskType to AgentRole.
// The orchestrator MUST delegate based on these rules — no exceptions.
var RoutingMatrix = []RoutingRule{
	{
		TaskType:        TaskTypeCodeImpl,
		Agent:           AgentCoder,
		ForbiddenAgents: []AgentRole{AgentExplorer},
		Description:     "Writing/editing code, tests, config",
	},
	{
		TaskType:        TaskTypeArchDesign,
		Agent:           AgentArchitect,
		ForbiddenAgents: []AgentRole{AgentCoder, AgentExplorer},
		Description:     "System design, trade-offs, research",
	},
	{
		TaskType:        TaskTypeFileFinding,
		Agent:           AgentExplorer,
		ForbiddenAgents: []AgentRole{AgentArchitect, AgentCoder, AgentTester, AgentWriter, AgentLinter, AgentGit, AgentScraper, AgentMCPSpecialist, AgentRelease},
		Description:     "ONLY glob/find operations — no analysis",
	},
	{
		TaskType:        TaskTypeTesting,
		Agent:           AgentTester,
		ForbiddenAgents: []AgentRole{AgentCoder},
		Description:     "Test writing and test execution",
	},
	{
		TaskType:        TaskTypeLinting,
		Agent:           AgentLinter,
		ForbiddenAgents: []AgentRole{AgentCoder, AgentArchitect, AgentTester},
		Description:     "Code style enforcement",
	},
	{
		TaskType:        TaskTypeGit,
		Agent:           AgentGit,
		ForbiddenAgents: []AgentRole{AgentCoder, AgentArchitect, AgentTester, AgentLinter},
		Description:     "Commits, branches, tags",
	},
	{
		TaskType:        TaskTypeDocumentation,
		Agent:           AgentWriter,
		ForbiddenAgents: []AgentRole{AgentExplorer},
		Description:     "Markdown, README, docs",
	},
	{
		TaskType:        TaskTypeWebScraping,
		Agent:           AgentScraper,
		ForbiddenAgents: []AgentRole{AgentExplorer},
		Description:     "URL fetching, data extraction",
	},
	{
		TaskType:        TaskTypeMCPDebug,
		Agent:           AgentMCPSpecialist,
		ForbiddenAgents: []AgentRole{AgentExplorer},
		Description:     "MCP protocol, server issues",
	},
	{
		TaskType:        TaskTypeRelease,
		Agent:           AgentRelease,
		ForbiddenAgents: []AgentRole{AgentCoder, AgentArchitect, AgentTester, AgentLinter, AgentExplorer, AgentScraper, AgentWriter, AgentGit, AgentMCPSpecialist},
		Description:     "Version bumps, changelogs",
	},
}

// routingByType is the lookup table for O(1) TaskType → RoutingRule resolution.
var routingByType map[TaskType]RoutingRule

func init() {
	routingByType = make(map[TaskType]RoutingRule, len(RoutingMatrix))
	for _, rule := range RoutingMatrix {
		routingByType[rule.TaskType] = rule
	}
}

// ResolveAgent returns the designated AgentRole for a given TaskType.
// Returns an error if no routing rule exists for the task type and
// noDefault is true.
func ResolveAgent(taskType TaskType) (AgentRole, error) {
	rule, ok := routingByType[taskType]
	if !ok {
		return "", fmt.Errorf("no routing rule for task type: %s", taskType)
	}
	return rule.Agent, nil
}

// IsForbiddenAgent checks whether a given agent is forbidden for a task type.
func IsForbiddenAgent(taskType TaskType, agent AgentRole) bool {
	rule, ok := routingByType[taskType]
	if !ok {
		return false
	}
	for _, forbidden := range rule.ForbiddenAgents {
		if forbidden == agent {
			return true
		}
	}
	return false
}

// GetRoutingRule returns the full routing rule for a task type, or nil.
func GetRoutingRule(taskType TaskType) *RoutingRule {
	rule, ok := routingByType[taskType]
	if !ok {
		return nil
	}
	return &rule
}

// ValidateRouting validates that a task type → agent assignment is correct.
// Returns a RoutingValidation with valid=true if the routing is correct,
// or valid=false with a violation message if it's not.
func ValidateRouting(taskType TaskType, agent AgentRole) RoutingValidation {
	rule, ok := routingByType[taskType]
	if !ok {
		// No routing rule defined — allow any agent
		return RoutingValidation{Valid: true, ExpectedAgent: ""}
	}

	if rule.Agent != agent {
		return RoutingValidation{
			Valid:         false,
			ExpectedAgent: rule.Agent,
			Violation:     fmt.Sprintf("ROUTING VIOLATION: %s should use %s, not %s", taskType, rule.Agent, agent),
		}
	}

	for _, forbidden := range rule.ForbiddenAgents {
		if forbidden == agent {
			return RoutingValidation{
				Valid:         false,
				ExpectedAgent: rule.Agent,
				Violation:     fmt.Sprintf("ROUTING VIOLATION: %s is forbidden for %s", agent, taskType),
			}
		}
	}

	return RoutingValidation{Valid: true, ExpectedAgent: rule.Agent}
}
