package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Loader reads SKILL.md files from a base directory on the filesystem.
type Loader struct {
	baseDir string
}

// NewLoader creates a Loader that reads skills from baseDir.
// Each skill is expected at <baseDir>/<skill-name>/SKILL.md.
func NewLoader(baseDir string) *Loader {
	return &Loader{baseDir: baseDir}
}

// Load reads and parses a single skill by name.
// It looks for <baseDir>/<name>/SKILL.md.
func (l *Loader) Load(name string) (*Skill, error) {
	skillPath := filepath.Join(l.baseDir, name, "SKILL.md")

	content, err := os.ReadFile(skillPath)
	if err != nil {
		return nil, fmt.Errorf("read skill %q from %s: %w", name, skillPath, err)
	}

	skill := Parse(skillPath, string(content))
	return skill, nil
}

// LoadAll walks the base directory and loads all SKILL.md files found.
// It skips directories that do not contain a SKILL.md file.
func (l *Loader) LoadAll() ([]*Skill, error) {
	var skills []*Skill

	entries, err := os.ReadDir(l.baseDir)
	if err != nil {
		return nil, fmt.Errorf("read skills directory %s: %w", l.baseDir, err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		// Skip hidden directories
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		skillPath := filepath.Join(l.baseDir, entry.Name(), "SKILL.md")

		// Check if SKILL.md exists
		info, err := os.Stat(skillPath)
		if err != nil || info.IsDir() {
			continue
		}

		content, err := os.ReadFile(skillPath)
		if err != nil {
			return nil, fmt.Errorf("read skill %q: %w", entry.Name(), err)
		}

		skill := Parse(skillPath, string(content))
		skills = append(skills, skill)
	}

	return skills, nil
}
