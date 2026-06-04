package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================================
// Parser Tests
// ============================================================================

const testSkillContent = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

## Description

This is a test skill used for validating the parser.

## Instructions

You are a test agent. Your role is:

1. **Run Tests**: Execute test suites
2. **Report Results**: Provide clear feedback

## Triggers

Use this skill when:
- Running unit tests
- Running integration tests

## Model

Use **Test Model v1** for execution.
`

func TestParse_BasicSections(t *testing.T) {
	skill := Parse("/skills/test-skill/SKILL.md", testSkillContent)

	if skill.Name != "test-skill" {
		t.Errorf("Name = %q, want %q", skill.Name, "test-skill")
	}

	if skill.Description == "" {
		t.Error("Description should not be empty")
	}

	if len(skill.Sections) < 3 {
		t.Errorf("expected at least 3 sections, got %d", len(skill.Sections))
	}

	// Check specific sections
	foundInstructions := false
	foundTriggers := false
	foundModel := false
	for _, s := range skill.Sections {
		switch s.Heading {
		case "Instructions":
			foundInstructions = true
			if !strings.Contains(s.Body, "Run Tests") {
				t.Errorf("Instructions body missing expected content, got: %s", s.Body)
			}
		case "Triggers":
			foundTriggers = true
			if !strings.Contains(s.Body, "unit tests") {
				t.Errorf("Triggers body missing expected content, got: %s", s.Body)
			}
		case "Model":
			foundModel = true
		}
	}

	if !foundInstructions {
		t.Error("Instructions section not found")
	}
	if !foundTriggers {
		t.Error("Triggers section not found")
	}
	if !foundModel {
		t.Error("Model section not found")
	}
}

func TestParse_FrontmatterStripped(t *testing.T) {
	skill := Parse("/skills/test-skill/SKILL.md", testSkillContent)

	// Frontmatter should not appear in the content
	if strings.Contains(skill.Content, "name: test-skill") {
		t.Error("Frontmatter should be stripped from Content")
	}
	if strings.Contains(skill.Content, "---") {
		t.Error("Frontmatter delimiters should be stripped from Content")
	}
}

func TestParse_NoFrontmatter(t *testing.T) {
	content := `# No Frontmatter Skill

First paragraph after heading.

## Section One

Body of section one.
`
	skill := Parse("/skills/no-frontmatter/SKILL.md", content)

	if skill.Name != "no-frontmatter" {
		t.Errorf("Name = %q, want %q", skill.Name, "no-frontmatter")
	}

	if !strings.Contains(skill.Description, "First paragraph") {
		t.Errorf("Description should contain first paragraph, got: %q", skill.Description)
	}
}

func TestParse_DescriptionFromFirstParagraph(t *testing.T) {
	content := `---
name: my-skill
---

# My Skill

This is the first paragraph that should become the description.

## Instructions

Do things.
`
	skill := Parse("/skills/my-skill/SKILL.md", content)

	if !strings.Contains(skill.Description, "first paragraph") {
		t.Errorf("Description should be from first paragraph, got: %q", skill.Description)
	}
}

func TestParse_DescriptionFallsBackToHeading(t *testing.T) {
	content := `# Heading Only Skill

## Description

This is the fallback description from heading.
`
	skill := Parse("/skills/heading-only/SKILL.md", content)

	// Falls back to "Description" heading text when no paragraph between # and ##
	if skill.Description != "Description" {
		t.Errorf("Description fallback = %q, want %q", skill.Description, "Description")
	}
}

func TestParse_NameFromDirectory(t *testing.T) {
	skill := Parse("/some/path/boomerang-coder/SKILL.md", "# Test\n\n## Section\nBody")

	if skill.Name != "boomerang-coder" {
		t.Errorf("Name = %q, want %q", skill.Name, "boomerang-coder")
	}
}

// ============================================================================
// Loader Tests
// ============================================================================

func TestLoad_ExistingSkill(t *testing.T) {
	// Create a temp directory with a skill
	tmpDir := t.TempDir()
	skillDir := filepath.Join(tmpDir, "my-test-skill")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatal(err)
	}

	skillContent := `---
name: my-test-skill
---

# My Test Skill

A test skill description.

## Instructions

Do the thing.
`
	skillFile := filepath.Join(skillDir, "SKILL.md")
	if err := os.WriteFile(skillFile, []byte(skillContent), 0644); err != nil {
		t.Fatal(err)
	}

	loader := NewLoader(tmpDir)
	skill, err := loader.Load("my-test-skill")
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if skill.Name != "my-test-skill" {
		t.Errorf("Name = %q, want %q", skill.Name, "my-test-skill")
	}

	if len(skill.Sections) < 1 {
		t.Errorf("expected at least 1 section, got %d", len(skill.Sections))
	}
}

func TestLoad_NonExistentSkill(t *testing.T) {
	tmpDir := t.TempDir()
	loader := NewLoader(tmpDir)

	_, err := loader.Load("does-not-exist")
	if err == nil {
		t.Error("Load() should return error for non-existent skill")
	}
}

func TestLoadAll(t *testing.T) {
	tmpDir := t.TempDir()

	// Create two skills
	for _, name := range []string{"skill-a", "skill-b"} {
		skillDir := filepath.Join(tmpDir, name)
		if err := os.MkdirAll(skillDir, 0755); err != nil {
			t.Fatal(err)
		}
		content := "# " + name + "\n\n" + name + " description.\n\n## Section\nBody\n"
		if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	loader := NewLoader(tmpDir)
	skills, err := loader.LoadAll()
	if err != nil {
		t.Fatalf("LoadAll() error: %v", err)
	}

	if len(skills) != 2 {
		t.Errorf("LoadAll() returned %d skills, want 2", len(skills))
	}

	names := make(map[string]bool)
	for _, s := range skills {
		names[s.Name] = true
	}
	if !names["skill-a"] || !names["skill-b"] {
		t.Errorf("LoadAll() missing expected skills, got: %v", names)
	}
}

func TestLoadAll_SkipsDirectoriesWithoutSkillFile(t *testing.T) {
	tmpDir := t.TempDir()

	// Create a dir with SKILL.md
	skillDir := filepath.Join(tmpDir, "good-skill")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("# Good\n\nDesc\n\n## S\nB\n"), 0644); err != nil {
		t.Fatal(err)
	}

	// Create a dir without SKILL.md
	emptyDir := filepath.Join(tmpDir, "empty-dir")
	if err := os.MkdirAll(emptyDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create a hidden dir (should be skipped)
	hiddenDir := filepath.Join(tmpDir, ".hidden")
	if err := os.MkdirAll(hiddenDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hiddenDir, "SKILL.md"), []byte("# Hidden\n\nDesc\n"), 0644); err != nil {
		t.Fatal(err)
	}

	loader := NewLoader(tmpDir)
	skills, err := loader.LoadAll()
	if err != nil {
		t.Fatalf("LoadAll() error: %v", err)
	}

	if len(skills) != 1 {
		t.Errorf("LoadAll() returned %d skills, want 1", len(skills))
	}
	if len(skills) > 0 && skills[0].Name != "good-skill" {
		t.Errorf("LoadAll() skill name = %q, want %q", skills[0].Name, "good-skill")
	}
}

// ============================================================================
// Registry Tests
// ============================================================================

func TestRegistry_RegisterAndGet(t *testing.T) {
	reg := NewRegistry()

	skill := &Skill{
		Name:        "test-skill",
		Description: "A test skill",
		Sections: []SkillSection{
			{Heading: "Instructions", Body: "Do things"},
		},
	}

	reg.Register(skill)

	got, ok := reg.Get("test-skill")
	if !ok {
		t.Error("Get() returned not found")
	}
	if got.Name != "test-skill" {
		t.Errorf("Get() name = %q, want %q", got.Name, "test-skill")
	}
}

func TestRegistry_GetNotFound(t *testing.T) {
	reg := NewRegistry()

	_, ok := reg.Get("nonexistent")
	if ok {
		t.Error("Get() should return false for nonexistent skill")
	}
}

func TestRegistry_List(t *testing.T) {
	reg := NewRegistry()

	skillA := &Skill{Name: "beta-skill", Description: "Beta"}
	skillB := &Skill{Name: "alpha-skill", Description: "Alpha"}

	reg.Register(skillA)
	reg.Register(skillB)

	skills := reg.List()
	if len(skills) != 2 {
		t.Fatalf("List() returned %d skills, want 2", len(skills))
	}

	// Should be sorted by name
	if skills[0].Name != "alpha-skill" {
		t.Errorf("List()[0].Name = %q, want %q", skills[0].Name, "alpha-skill")
	}
	if skills[1].Name != "beta-skill" {
		t.Errorf("List()[1].Name = %q, want %q", skills[1].Name, "beta-skill")
	}
}

func TestRegistry_FindByDescription(t *testing.T) {
	reg := NewRegistry()

	reg.Register(&Skill{Name: "coder", Description: "Fast code generation specialist"})
	reg.Register(&Skill{Name: "architect", Description: "Architecture and design decisions"})
	reg.Register(&Skill{Name: "tester", Description: "Testing specialist for code"})

	// Find by "code" — should match coder and tester
	matches := reg.FindByDescription("code")
	if len(matches) != 2 {
		t.Errorf("FindByDescription(\"code\") returned %d, want 2", len(matches))
	}

	// Find by "design" — should match architect
	matches = reg.FindByDescription("design")
	if len(matches) != 1 {
		t.Errorf("FindByDescription(\"design\") returned %d, want 1", len(matches))
	}
	if len(matches) > 0 && matches[0].Name != "architect" {
		t.Errorf("FindByDescription(\"design\") name = %q, want %q", matches[0].Name, "architect")
	}

	// Case insensitive
	matches = reg.FindByDescription("FAST")
	if len(matches) != 1 {
		t.Errorf("FindByDescription(\"FAST\") case-insensitive returned %d, want 1", len(matches))
	}
}

func TestRegistry_ConcurrentAccess(t *testing.T) {
	reg := NewRegistry()

	// Concurrent writes
	done := make(chan bool)
	for i := 0; i < 100; i++ {
		go func(n int) {
			reg.Register(&Skill{Name: "skill", Description: "concurrent"})
			done <- true
		}(i)
	}
	for i := 0; i < 100; i++ {
		<-done
	}

	// Concurrent reads
	for i := 0; i < 100; i++ {
		go func() {
			_, _ = reg.Get("skill")
			_ = reg.List()
			done <- true
		}()
	}
	for i := 0; i < 100; i++ {
		<-done
	}

	// Should not panic — just verify we can still read
	_, ok := reg.Get("skill")
	if !ok {
		t.Error("Concurrent access corrupted registry")
	}
}

// ============================================================================
// Integration: Load from real skills directory (if available)
// ============================================================================

func TestLoadAll_RealSkills(t *testing.T) {
	realDir := "/home/jcharles/Projects/MCP-Servers/.opencode/skills"
	if _, err := os.Stat(realDir); os.IsNotExist(err) {
		t.Skip("Real skills directory not available")
	}

	loader := NewLoader(realDir)
	skills, err := loader.LoadAll()
	if err != nil {
		t.Fatalf("LoadAll() from real dir error: %v", err)
	}

	if len(skills) == 0 {
		t.Error("LoadAll() returned no skills from real directory")
	}

	t.Logf("Loaded %d skills from real directory", len(skills))
	for _, s := range skills {
		t.Logf("  - %s: %q (%d sections)", s.Name, s.Description, len(s.Sections))
		if s.Name == "" {
			t.Errorf("Skill at %s has empty name", s.Location)
		}
		if len(s.Sections) == 0 {
			t.Errorf("Skill %s has no sections", s.Name)
		}
	}
}
