// Package orchestrator provides the Neuralgentics Orchestrator —
// the central routing and protocol enforcement layer.
//
// This file implements the IMPROVE phase (step 7 of 9) of the
// Boomerang Protocol. After quality gates pass, the IMPROVE phase
// extracts patterns from the just-completed work, fetches the L1
// key decisions summary, and reports the result for trust adjustments
// and relationship linking by the orchestrator's normal pathways.
package orchestrator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

// FileFingerprint is the SHA-256 hash of a config file at IMPROVE time.
type FileFingerprint struct {
	Path   string `json:"path"`   // relative to repo root
	SHA256 string `json:"sha256"` // hex-encoded
	Size   int    `json:"size"`   // bytes
}

// ConfigFingerprint captures the hash of all session-config files
// at IMPROVE-call time. If two consecutive IMPROVE calls return
// different fingerprints, the user edited config mid-session and
// a restart is required for the new config to take effect.
type ConfigFingerprint struct {
	AgentsMD       string            `json:"agents_md"`       // AGENTS.md hash
	OpenCodeConfig string            `json:"opencode_config"` // opencode.json hash
	SkillFiles     []FileFingerprint `json:"skill_files"`     // SKILL.md files
	AgentPersonas  []FileFingerprint `json:"agent_personas"`  // agents/*.md files
	HashMismatch   bool              `json:"hash_mismatch"`   // set by orchestrator if previous != current
	CapturedAt     time.Time         `json:"captured_at"`
}

// ImproveResult tracks what the IMPROVE phase accomplished.
type ImproveResult struct {
	TaskID              string             `json:"task_id"`
	PatternsExtracted   int                `json:"patterns_extracted"`
	TrustAdjustments    int                `json:"trust_adjustments"`
	RelationshipsLinked int                `json:"relationships_linked"`
	SummaryGenerated    bool               `json:"summary_generated"`
	Errors              []string           `json:"errors,omitempty"`
	StartedAt           time.Time          `json:"started_at"`
	CompletedAt         time.Time          `json:"completed_at"`
	Duration            string             `json:"duration"`
	ConfigFingerprint   *ConfigFingerprint `json:"config_fingerprint,omitempty"`
	RestartRecommended  bool               `json:"restart_recommended"`
}

// ImproveMemoryProvider is the interface the IMPROVE handler uses to call
// memory tools. The orchestrator's MemoryProvider satisfies this interface.
type ImproveMemoryProvider interface {
	// TriggerExtraction triggers pattern extraction from a conversation buffer.
	TriggerExtraction(ctx context.Context, conversation string) (int, error)
	// GetTier1Summary returns the L1 key decisions summary (~2K tokens, trust >= 0.8).
	GetTier1Summary(ctx context.Context, forceRefresh bool) (string, error)
}

// ImproveHandler runs the IMPROVE phase of the Boomerang Protocol
// (step 7 of 9). After quality gates pass, it extracts patterns from
// the just-completed work, calls memory.triggerExtraction, fetches
// the L1 key decisions summary, and reports the result.
//
// Trust adjustments and relationship linking are handled by the
// orchestrator's normal trust-bump and relationship pathways — the
// IMPROVE handler's job is extraction + summary generation.
type ImproveHandler struct {
	memory   ImproveMemoryProvider
	repoRoot string
}

// NewImproveHandler creates a new IMPROVE handler with the given memory provider.
// If repoRoot is empty, fingerprinting is skipped (returns empty ConfigFingerprint).
func NewImproveHandler(memory ImproveMemoryProvider, repoRoot string) *ImproveHandler {
	return &ImproveHandler{memory: memory, repoRoot: repoRoot}
}

// Run executes the IMPROVE phase. It is safe to call multiple times
// (idempotent: returns the result of extraction + summary for this call only).
func (h *ImproveHandler) Run(ctx context.Context, taskID string, conversation string) (*ImproveResult, error) {
	result := &ImproveResult{
		TaskID:    taskID,
		StartedAt: time.Now(),
	}
	defer func() {
		result.CompletedAt = time.Now()
		result.Duration = result.CompletedAt.Sub(result.StartedAt).String()
	}()

	// Compute config fingerprint so callers can detect mid-session edits.
	fp := ComputeConfigFingerprint(h.repoRoot)
	result.ConfigFingerprint = fp
	// Note: HashMismatch is set by the orchestrator (which tracks the
	// previous fingerprint), not here.
	result.RestartRecommended = false

	// 1. Trigger extraction (catches patterns from the conversation).
	//    If the conversation is empty, skip extraction rather than failing.
	if conversation != "" {
		extracted, err := h.memory.TriggerExtraction(ctx, conversation)
		if err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("triggerExtraction: %v", err))
		} else {
			result.PatternsExtracted = extracted
		}
	}

	// 2. Fetch L1 key decisions summary.
	summary, err := h.memory.GetTier1Summary(ctx, false)
	if err != nil {
		result.Errors = append(result.Errors, fmt.Sprintf("getTier1Summary: %v", err))
	} else {
		result.SummaryGenerated = summary != ""
	}

	// 3. Trust adjustments happen in the orchestrator loop, not here.
	//    This handler reports the result of extraction + summary.
	//    Actual AdjustTrust calls happen via the Orchestrator's normal
	//    trust-bump pathway when memories are queried during work.
	result.TrustAdjustments = 0

	log.Printf("[IMPROVE] complete task_id=%s patterns=%d summary=%t",
		taskID, result.PatternsExtracted, result.SummaryGenerated)

	return result, nil
}

// ComputeConfigFingerprint reads AGENTS.md, opencode.json, and the
// .opencode/skills/*/SKILL.md and .opencode/agents/*.md files, hashes
// them with SHA-256, and returns the fingerprint struct. If a file
// is missing, the field is the empty string (not an error — config
// files may be optional). If repoRoot is empty, returns an empty
// fingerprint struct with no error.
func ComputeConfigFingerprint(repoRoot string) *ConfigFingerprint {
	fp := &ConfigFingerprint{CapturedAt: time.Now()}

	if repoRoot == "" {
		return fp
	}

	// AGENTS.md (at repoRoot/AGENTS.md or repoRoot/.opencode/AGENTS.md)
	for _, rel := range []string{"AGENTS.md", ".opencode/AGENTS.md"} {
		if hash, _, ok := hashFile(repoRoot, rel); ok {
			fp.AgentsMD = hash
			break
		}
	}

	// .opencode/opencode.json
	if hash, _, ok := hashFile(repoRoot, ".opencode/opencode.json"); ok {
		fp.OpenCodeConfig = hash
	}

	// .opencode/skills/*/SKILL.md
	skillsDir := filepath.Join(repoRoot, ".opencode", "skills")
	if entries, err := os.ReadDir(skillsDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			skillPath := filepath.Join(".opencode", "skills", entry.Name(), "SKILL.md")
			if hash, size, ok := hashFile(repoRoot, skillPath); ok {
				fp.SkillFiles = append(fp.SkillFiles, FileFingerprint{
					Path: skillPath, SHA256: hash, Size: size,
				})
			}
		}
	}

	// .opencode/agents/*.md
	agentsDir := filepath.Join(repoRoot, ".opencode", "agents")
	if entries, err := os.ReadDir(agentsDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
				continue
			}
			agentPath := filepath.Join(".opencode", "agents", entry.Name())
			if hash, size, ok := hashFile(repoRoot, agentPath); ok {
				fp.AgentPersonas = append(fp.AgentPersonas, FileFingerprint{
					Path: agentPath, SHA256: hash, Size: size,
				})
			}
		}
	}

	return fp
}

// hashFile reads the file at repoRoot+relPath, returns (sha256-hex, size, ok).
func hashFile(repoRoot, relPath string) (string, int, bool) {
	full := filepath.Join(repoRoot, relPath)
	data, err := os.ReadFile(full)
	if err != nil {
		return "", 0, false
	}
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:]), len(data), true
}
