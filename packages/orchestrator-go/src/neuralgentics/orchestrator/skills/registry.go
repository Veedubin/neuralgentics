package skills

import (
	"sort"
	"strings"
	"sync"
)

// Registry is an in-memory store for loaded skills, safe for concurrent use.
type Registry struct {
	mu     sync.RWMutex
	skills map[string]*Skill
}

// NewRegistry creates an empty Registry.
func NewRegistry() *Registry {
	return &Registry{
		skills: make(map[string]*Skill),
	}
}

// Register adds or replaces a skill in the registry.
func (r *Registry) Register(skill *Skill) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.skills[skill.Name] = skill
}

// Get retrieves a skill by name. Returns the skill and true if found,
// or nil and false if not.
func (r *Registry) Get(name string) (*Skill, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	skill, ok := r.skills[name]
	return skill, ok
}

// List returns all registered skills sorted by name.
func (r *Registry) List() []*Skill {
	r.mu.RLock()
	defer r.mu.RUnlock()

	skills := make([]*Skill, 0, len(r.skills))
	for _, skill := range r.skills {
		skills = append(skills, skill)
	}

	sort.Slice(skills, func(i, j int) bool {
		return skills[i].Name < skills[j].Name
	})

	return skills
}

// FindByDescription returns skills whose description contains the query
// string (case-insensitive substring match).
func (r *Registry) FindByDescription(query string) []*Skill {
	r.mu.RLock()
	defer r.mu.RUnlock()

	lowerQuery := strings.ToLower(query)
	var matches []*Skill

	for _, skill := range r.skills {
		if strings.Contains(strings.ToLower(skill.Description), lowerQuery) {
			matches = append(matches, skill)
		}
	}

	sort.Slice(matches, func(i, j int) bool {
		return matches[i].Name < matches[j].Name
	})

	return matches
}
