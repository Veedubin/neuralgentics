// Package kg provides the Knowledge Graph subsystem for neuralgentics memory.
// It handles entity extraction, graph querying, and visualization.
package kg

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// validEntityTypes lists allowed entity type values.
var validEntityTypes = map[string]bool{
	"PERSON":       true,
	"ORGANIZATION": true,
	"CONCEPT":      true,
	"CODE":         true,
	"PROJECT":      true,
	"LOCATION":     true,
	"UNKNOWN":      true,
}

// extractedEntity is the JSON structure returned by the LLM.
type extractedEntity struct {
	Name          string  `json:"name"`
	EntityType    string  `json:"entity_type"`
	CanonicalName string  `json:"canonical_name,omitempty"`
	Confidence    float64 `json:"confidence"`
}

// extractionResponse wraps the LLM response for entity extraction.
type extractionResponse struct {
	Entities []extractedEntity `json:"entities"`
}

// EntityExtractor extracts entities from text using an LLM client.
// It deduplicates entities by canonical name and upserts them to the store.
type EntityExtractor struct {
	store core.Store
	llm   core.LLMClient
}

// NewEntityExtractor creates an EntityExtractor backed by the given store and LLM client.
func NewEntityExtractor(store core.Store, llm core.LLMClient) *EntityExtractor {
	return &EntityExtractor{
		store: store,
		llm:   llm,
	}
}

// ExtractEntities extracts entities from the given text using the LLM,
// deduplicates by canonical name, and upserts them to the store.
// Returns the IDs of the extracted/updated entities.
func (e *EntityExtractor) ExtractEntities(ctx context.Context, text string) ([]string, error) {
	if text == "" {
		return nil, fmt.Errorf("text must not be empty")
	}

	// Call LLM to extract entities
	entities, err := e.callLLM(ctx, text)
	if err != nil {
		return nil, fmt.Errorf("llm extraction: %w", err)
	}

	if len(entities) == 0 {
		return nil, nil
	}

	// Deduplicate by canonical name (lowercase).
	// If canonical name is empty, use the name field lowercased.
	deduped := e.deduplicate(entities)

	// Upsert each entity to the store
	var ids []string
	for _, ent := range deduped {
		entityType := strings.ToUpper(ent.EntityType)
		if !validEntityTypes[entityType] {
			entityType = "UNKNOWN"
		}

		canonicalName := ent.CanonicalName
		if canonicalName == "" {
			canonicalName = ent.Name
		}

		confidence := ent.Confidence
		if confidence <= 0 {
			confidence = 0.5
		}

		entity := &core.Entity{
			Name:          ent.Name,
			EntityType:    entityType,
			CanonicalName: canonicalName,
			Confidence:    confidence,
			FirstSeenAt:   time.Now(),
			LastSeenAt:    time.Now(),
		}

		id, err := e.store.UpsertEntity(ctx, entity)
		if err != nil {
			// Log and continue — don't fail the whole batch for one bad upsert
			continue
		}
		ids = append(ids, id)
	}

	return ids, nil
}

// callLLM sends a structured prompt to the LLM and parses the JSON response.
func (e *EntityExtractor) callLLM(ctx context.Context, text string) ([]extractedEntity, error) {
	systemPrompt := `You are an entity extraction system. Extract named entities from the given text.
Return a JSON object with an "entities" array. Each entity must have:
- "name": the exact entity name as found in the text
- "entity_type": one of PERSON, ORGANIZATION, CONCEPT, CODE, PROJECT, LOCATION, or UNKNOWN
- "canonical_name": the normalized/canonical form of the name (optional, use same as name if unsure)
- "confidence": a float between 0.0 and 1.0

Return ONLY valid JSON. Do not include any explanation or markdown.`

	userMsg := fmt.Sprintf("Extract entities from this text:\n\n%s", text)

	messages := []core.ConversationMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userMsg},
	}

	response, err := e.llm.Chat(ctx, messages, 0.1)
	if err != nil {
		return nil, fmt.Errorf("llm chat: %w", err)
	}

	// Parse the LLM response as JSON
	response = strings.TrimSpace(response)
	// Strip markdown code fences if present
	if strings.HasPrefix(response, "```") {
		// Find the end of the opening fence line
		if idx := strings.Index(response, "\n"); idx >= 0 {
			response = response[idx+1:]
		}
		// Strip closing fence
		if idx := strings.LastIndex(response, "```"); idx >= 0 {
			response = response[:idx]
		}
		response = strings.TrimSpace(response)
	}

	var resp extractionResponse
	if err := json.Unmarshal([]byte(response), &resp); err != nil {
		return nil, fmt.Errorf("parse llm response as JSON: %w (response: %q)", err, response)
	}

	return resp.Entities, nil
}

// deduplicate removes duplicate entities based on canonical name (case-insensitive).
// Keeps the entity with the highest confidence for each canonical name.
func (e *EntityExtractor) deduplicate(entities []extractedEntity) []extractedEntity {
	seen := make(map[string]extractedEntity)
	for _, ent := range entities {
		key := strings.ToLower(ent.CanonicalName)
		if key == "" {
			key = strings.ToLower(ent.Name)
		}

		existing, ok := seen[key]
		if !ok || ent.Confidence > existing.Confidence {
			seen[key] = ent
		}
	}

	result := make([]extractedEntity, 0, len(seen))
	for _, ent := range seen {
		result = append(result, ent)
	}
	return result
}

// GetEntityGraph retrieves all entities and relationships connected to the given entity
// within the specified depth. It uses BFS traversal to collect all reachable entities.
func GetEntityGraph(ctx context.Context, store core.Store, entityID string, depth int) ([]*core.Entity, []core.EntityRelationship, error) {
	if depth <= 0 {
		depth = 3
	}

	// Verify the starting entity exists
	start, err := store.GetEntity(ctx, entityID)
	if err != nil {
		return nil, nil, fmt.Errorf("get entity %s: %w", entityID, err)
	}

	visited := make(map[string]bool)
	type queueItem struct {
		id    string
		depth int
	}

	queue := []queueItem{{id: entityID, depth: 0}}
	visited[entityID] = true

	var entities []*core.Entity
	seenRels := make(map[string]bool)
	var relationships []core.EntityRelationship
	entities = append(entities, start)

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		if current.depth >= depth {
			continue
		}

		rels, err := store.GetEntityRelationships(ctx, current.id)
		if err != nil {
			continue
		}

		for _, rel := range rels {
			if seenRels[rel.ID] {
				continue
			}
			seenRels[rel.ID] = true
			relationships = append(relationships, rel)

			neighborID := rel.TargetEntityID
			if rel.SourceEntityID != current.id {
				neighborID = rel.SourceEntityID
			}

			if visited[neighborID] {
				continue
			}
			visited[neighborID] = true

			neighbor, err := store.GetEntity(ctx, neighborID)
			if err != nil {
				continue
			}
			entities = append(entities, neighbor)
			queue = append(queue, queueItem{id: neighborID, depth: current.depth + 1})
		}
	}

	return entities, relationships, nil
}
