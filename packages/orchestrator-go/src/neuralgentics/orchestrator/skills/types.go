// Package skills provides runtime loading and parsing of markdown skill files
// for the Neuralgentics Orchestrator.
package skills

import "time"

// Skill represents a parsed SKILL.md file with structured sections.
type Skill struct {
	Name        string         // Derived from parent directory name
	Description string         // First non-empty paragraph or ## heading text
	Location    string         // File path of the SKILL.md
	Content     string         // Raw file content
	Sections    []SkillSection // Parsed sections split by ## headings
	LoadedAt    time.Time      // When the skill was loaded
}

// SkillSection is a heading + body pair extracted from a markdown file.
type SkillSection struct {
	Heading string // e.g., "## Instructions"
	Body    string // Section content (trimmed)
}
