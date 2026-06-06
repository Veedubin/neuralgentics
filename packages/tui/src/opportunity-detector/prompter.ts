/**
 * OpportunityPrompter — User-facing prompt formatting and card drafting.
 * T-034 (P1-c, Addendum 1).
 *
 * Formats detected candidates as TUI dialog strings and Markdown card
 * drafts for TASKS.md. NO auto-action — returns data for the caller
 * to present to the user.
 */

import type { RankedCandidate, CachedCandidate, PatternType } from "./types.js";
import { PATTERN_LABELS } from "./types.js";

// ─── Dialog Formatting ─────────────────────────────────────────────────────────

/** User action in response to a presented opportunity. */
export type OpportunityAction =
  | "accept"        // [Y] Yes, add to skill-self-audit's TODO list
  | "accept_one"    // [1] or [2] — accept only one specific candidate
  | "dismiss"       // [N] Not interested
  | "details"       // [L] Show full breakdown
  | "silence";      // [S] Silence this pattern type for this session

/** Result of formatting candidates for display. */
export interface PromptResult {
  /** The formatted prompt string for the TUI chat panel. */
  prompt: string;
  /** The number of candidates presented. */
  candidateCount: number;
  /** The top candidate (for [1] keybinding). */
  topCandidate: RankedCandidate | null;
}

/**
 * Format candidates as a TUI dialog prompt.
 * Per Addendum 1 §4.6: shows [Y]/[1]/[2]/[N]/[L]/[S] keybindings.
 *
 * @param candidates - Ranked candidates to present.
 * @param maxToShow - Maximum candidates to show in the prompt (default 3).
 */
export function formatOpportunityPrompt(
  candidates: RankedCandidate[],
  maxToShow: number = 3,
): PromptResult {
  if (candidates.length === 0) {
    return {
      prompt: "No new opportunities detected this session.",
      candidateCount: 0,
      topCandidate: null,
    };
  }

  const topCandidates = candidates.slice(0, maxToShow);
  const lines: string[] = [
    `💡 Opportunity Detected: ${candidates.length} candidate skill(s)/script(s)`,
    "",
  ];

  for (const c of topCandidates) {
    lines.push(`#${c.rank} ${PATTERN_LABELS[c.patternType]}: ${c.description}`);
    lines.push(`   Suggestion: ${c.suggestedFix}`);
    lines.push(
      `   Savings: ~${Math.round(c.estimatedTokenSavings * 0.8 * 100)}% tokens ` +
      `(~${c.estimatedTokenSavings.toLocaleString()} saved/session), ` +
      `Build: ${c.buildEffort}`,
    );
    lines.push(`   Priority: ${c.priority}`);
    lines.push("");
  }

  lines.push("  [Y] yes, add all to skill-self-audit's TODO list");
  if (topCandidates.length >= 1) {
    lines.push("  [1] yes, add only #1");
  }
  if (topCandidates.length >= 2) {
    lines.push("  [2] yes, add only #2");
  }
  lines.push("  [N] no, one-off patterns — not interested");
  lines.push("  [L] let me think — show full breakdown for all candidates");
  lines.push("  [S] silence this pattern type for this session");

  return {
    prompt: lines.join("\n"),
    candidateCount: topCandidates.length,
    topCandidate: topCandidates[0] ?? null,
  };
}

/**
 * Format a detailed breakdown for a single candidate (for [L] action).
 */
export function formatDetailedBreakdown(candidate: RankedCandidate): string {
  const lines: string[] = [
    `═══ Detailed Breakdown: ${PATTERN_LABELS[candidate.patternType]} ═══`,
    "",
    `Pattern: ${candidate.patternType}`,
    `Description: ${candidate.description}`,
    `Suggestion: ${candidate.suggestedFix}`,
    `Priority: ${candidate.priority}`,
    `Scope: ${candidate.scopeAllProjects ? "All projects (1.5×)" : "This project only (1.0×)"}`,
    "",
    `Est. Token Savings: ${candidate.estimatedTokenSavings.toLocaleString()} per session`,
    `Frequency: ${candidate.frequency} occurrence(s)`,
    `Score: ${candidate.score.toFixed(1)} (= savings × freq × scope)`,
    `Build Effort: ${candidate.buildEffort}`,
    "",
  ];

  if (candidate.evidence.toolNames?.length) {
    lines.push(`Tools: ${candidate.evidence.toolNames.join(", ")}`);
  }
  if (candidate.evidence.filePaths?.length) {
    lines.push(`Files: ${candidate.evidence.filePaths.join(", ")}`);
  }
  if (candidate.evidence.cardIds?.length) {
    lines.push(`Cards: ${candidate.evidence.cardIds.join(", ")}`);
  }
  if (candidate.evidence.totalCalls) {
    lines.push(`Total Calls: ${candidate.evidence.totalCalls}`);
  }
  if (candidate.evidence.totalTokens) {
    lines.push(`Total Tokens: ${candidate.evidence.totalTokens.toLocaleString()}`);
  }

  lines.push("═══════════════════════════════════════");
  return lines.join("\n");
}

// ─── Card Drafting ──────────────────────────────────────────────────────────────

/**
 * Draft a T-NNN card in Markdown for TASKS.md.
 * Per Addendum 1 §4.7: card auto-draft format.
 *
 * @param candidate - The candidate to draft a card for.
 * @param cardNumber - The card number (e.g. 34 for T-034).
 */
export function draftCard(candidate: RankedCandidate, cardNumber: number): string {
  const lines: string[] = [
    `## T-${String(cardNumber).padStart(3, "0")} [skill-creation] Build ${extractSkillName(candidate.suggestedFix)}`,
    "",
    `**Status:** ready`,
    `**Priority:** ${candidate.priority}`,
    `**Assignee:** boomerang-agent-builder`,
    `**Source:** Detected by opportunity-detector`,
    "",
    "### Pattern Detected",
    candidate.description,
    "",
    "### Proposed Skill/Script",
    `- **Name:** ${extractSkillName(candidate.suggestedFix)}`,
    `- **Description:** ${candidate.suggestedFix}`,
    `- **Priority:** ${candidate.priority}`,
    `- **Token savings:** ~${candidate.estimatedTokenSavings.toLocaleString()} per session`,
    `- **Build effort:** ${candidate.buildEffort}`,
    "",
    "### Acceptance",
    `- [ ] Skill file exists at \`skills/${extractSkillName(candidate.suggestedFix).toLowerCase().replace(/\s+/g, "-")}/SKILL.md\``,
    `- [ ] Tool registered in broker`,
    `- [ ] Token report shows improvement`,
    "",
  ];

  return lines.join("\n");
}

// ─── /opportunities Command Result ──────────────────────────────────────────────

/** Result of the /opportunities command handler. */
export interface OpportunitiesCommandResult {
  /** Command name. */
  command: "opportunities";
  /** Message to display in chat panel. */
  message: string;
  /** Whether to refresh the kanban board. */
  refreshKanban: boolean;
  /** The ranked candidates (for further processing). */
  candidates: RankedCandidate[];
}

/**
 * Handle the `/opportunities` command.
 *
 * Sub-commands:
 * - `/opportunities` — show top 3 candidates
 * - `/opportunities list` — show all candidates
 * - `/opportunities cached` — show cached opportunities from previous sessions (T-085)
 * - `/opportunities --refresh` — force re-scan
 */
export function handleOpportunitiesCommand(
  candidates: RankedCandidate[],
  subCommand?: string,
): OpportunitiesCommandResult {
  const sub = (subCommand ?? "").toLowerCase().trim();

  // T-085: /opportunities cached is async — signal caller to use handleCachedOpportunitiesCommand
  if (sub === "cached") {
    return {
      command: "opportunities",
      message: "_cached_", // Signal to caller that async handler is needed
      refreshKanban: false,
      candidates: [],
    };
  }

  if (sub === "list") {
    // Show all candidates
    if (candidates.length === 0) {
      return {
        command: "opportunities",
        message: "No opportunities detected. Run /opportunities --refresh to force a new scan.",
        refreshKanban: false,
        candidates: [],
      };
    }

    const lines = candidates.map((c) => formatCandidateLine(c));
    return {
      command: "opportunities",
      message: `All opportunities (${candidates.length}):\n\n${lines.join("\n\n")}`,
      refreshKanban: false,
      candidates,
    };
  }

  if (sub === "--refresh" || sub === "refresh") {
    // Signal that a re-scan is needed
    return {
      command: "opportunities",
      message: "Re-scanning for opportunities...",
      refreshKanban: false,
      candidates,
    };
  }

  // Default: show top 3
  const result = formatOpportunityPrompt(candidates, 3);
  return {
    command: "opportunities",
    message: result.prompt,
    refreshKanban: false,
    candidates,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Format a single candidate as a one-liner. */
function formatCandidateLine(c: RankedCandidate): string {
  const scope = c.scopeAllProjects ? "global" : "local";
  return (
    `#${c.rank} [${c.priority}] ${PATTERN_LABELS[c.patternType]}: ${c.description}\n` +
    `    Suggestion: ${c.suggestedFix}\n` +
    `    Savings: ~${c.estimatedTokenSavings.toLocaleString()} tokens (${scope}), ` +
    `Build: ${c.buildEffort}, Score: ${c.score.toFixed(1)}`
  );
}

/** Extract a skill name from the suggested fix string. */
function extractSkillName(suggestedFix: string): string {
  // Try to extract the skill name from backticks
  const match = suggestedFix.match(/`([^`]+)`/);
  if (match) return match[1]!;

  // Fallback: use first meaningful phrase
  const words = suggestedFix.split(/\s+/).slice(0, 3);
  return words.join(" ");
}

// ─── Cached Opportunities (T-085) ────────────────────────────────────────────────

/**
 * Format cached opportunities for display.
 *
 * Shows candidates from previous sessions with staleness indicators.
 * Stale entries (>7 days old) get a ⚠️ Stale label.
 */
export function formatCachedOpportunities(candidates: CachedCandidate[]): string {
  if (candidates.length === 0) {
    return "No cached opportunities";
  }

  const lines: string[] = [
    `📂 Cached Opportunities (${candidates.length} from previous sessions)`,
    "",
  ];

  for (const c of candidates) {
    const staleLabel = c.stale ? " ⚠️ Stale" : "";
    const ageDays = Math.round((Date.now() - new Date(c.cachedAt).getTime()) / (24 * 60 * 60 * 1000));
    lines.push(`  ${PATTERN_LABELS[c.patternType]}: ${c.description.slice(0, 80)}${staleLabel}`);
    lines.push(`    Session: ${c.sessionId.slice(0, 8)}... | Age: ${ageDays}d | Savings: ~${c.estimatedTokenSavings.toLocaleString()} tokens`);
    lines.push("");
  }

  lines.push("═══════════════════════════════════════");
  return lines.join("\n");
}

/**
 * Async handler for `/opportunities cached` command (T-085).
 *
 * Fetches cached opportunities from memory store and formats them.
 * Uses getCachedCandidates for staleness tracking.
 *
 * @param client - NeuralgenticsClient for memory persistence.
 * @returns CommandResult with formatted cached opportunities message.
 */
export async function handleCachedOpportunitiesCommand(
  client: { call: (method: string, params: Record<string, unknown>) => Promise<unknown> },
): Promise<OpportunitiesCommandResult> {
  // Dynamic import to avoid circular deps
  const { getCachedCandidates } = await import("./detector.js");

  try {
    const result = await getCachedCandidates(client);

    if (result.cacheEmpty) {
      return {
        command: "opportunities",
        message: "No cached opportunities",
        refreshKanban: false,
        candidates: [],
      };
    }

    // Convert CachedCandidates to RankedCandidates for display (add rank + score)
    const ranked: RankedCandidate[] = result.candidates.map((c, i) => ({
      ...c,
      score: c.estimatedTokenSavings * c.frequency * (c.scopeAllProjects ? 1.5 : 1.0),
      rank: i + 1,
    }));

    const message = formatCachedOpportunities(result.candidates);

    return {
      command: "opportunities",
      message,
      refreshKanban: false,
      candidates: ranked,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      command: "opportunities",
      message: `/opportunities cached failed: ${msg}`,
      refreshKanban: false,
      candidates: [],
    };
  }
}