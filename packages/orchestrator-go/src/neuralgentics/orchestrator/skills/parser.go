package skills

import (
	"path/filepath"
	"strings"
	"time"
)

// Parse parses raw SKILL.md content into a Skill struct.
// The name is derived from the parent directory of location.
// Frontmatter (YAML between --- markers) is skipped if present.
// Sections are split by ## headings; the # heading is not a section.
func Parse(location string, content string) *Skill {
	name := deriveSkillName(location)
	lines := strings.Split(content, "\n")

	// Strip frontmatter if present
	lines = stripFrontmatter(lines)

	sections := parseSections(lines)
	description := extractDescription(lines)
	body := strings.Join(lines, "\n")

	return &Skill{
		Name:        name,
		Description: description,
		Location:    location,
		Content:     body,
		Sections:    sections,
		LoadedAt:    time.Now(),
	}
}

// deriveSkillName extracts the skill name from the parent directory.
// For "/path/to/skills/boomerang-coder/SKILL.md" it returns "boomerang-coder".
func deriveSkillName(location string) string {
	dir := filepath.Dir(location)
	return filepath.Base(dir)
}

// stripFrontmatter removes YAML frontmatter delimited by --- markers.
func stripFrontmatter(lines []string) []string {
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return lines
	}

	// Find closing ---
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			return lines[i+1:]
		}
	}

	// No closing --- found; return as-is
	return lines
}

// parseSections splits the markdown into sections based on ## headings.
// The top-level # heading is NOT captured as a section — only ## and deeper.
func parseSections(lines []string) []SkillSection {
	var sections []SkillSection
	var currentHeading string
	var bodyLines []string

	for _, line := range lines {
		if strings.HasPrefix(line, "## ") {
			// Flush previous section
			if currentHeading != "" {
				sections = append(sections, SkillSection{
					Heading: currentHeading,
					Body:    strings.TrimSpace(strings.Join(bodyLines, "\n")),
				})
			}
			currentHeading = strings.TrimPrefix(line, "## ")
			currentHeading = strings.TrimSpace(currentHeading)
			bodyLines = nil
			continue
		}

		if currentHeading != "" {
			bodyLines = append(bodyLines, line)
		}
	}

	// Flush last section
	if currentHeading != "" {
		sections = append(sections, SkillSection{
			Heading: currentHeading,
			Body:    strings.TrimSpace(strings.Join(bodyLines, "\n")),
		})
	}

	return sections
}

// extractDescription finds the first non-empty paragraph after the # heading,
// or falls back to the first ## heading text.
func extractDescription(lines []string) string {
	pastH1 := false
	paragraphLines := []string{}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Track when we pass the # heading
		if strings.HasPrefix(trimmed, "# ") && !strings.HasPrefix(trimmed, "## ") {
			pastH1 = true
			continue
		}

		// Skip ## headings during description scanning
		if strings.HasPrefix(trimmed, "## ") {
			// If we have accumulated paragraph lines, that's the description
			if pastH1 && len(paragraphLines) > 0 {
				return strings.TrimSpace(strings.Join(paragraphLines, " "))
			}
			// Otherwise, use the ## heading text as fallback description
			if pastH1 && len(paragraphLines) == 0 {
				return strings.TrimPrefix(trimmed, "## ")
			}
			continue
		}

		// Accumulate paragraph lines after the # heading
		if pastH1 {
			if trimmed == "" {
				// Empty line = paragraph boundary
				if len(paragraphLines) > 0 {
					return strings.TrimSpace(strings.Join(paragraphLines, " "))
				}
				continue
			}
			paragraphLines = append(paragraphLines, trimmed)
		}
	}

	// Return whatever paragraph we accumulated
	if len(paragraphLines) > 0 {
		return strings.TrimSpace(strings.Join(paragraphLines, " "))
	}

	return ""
}
