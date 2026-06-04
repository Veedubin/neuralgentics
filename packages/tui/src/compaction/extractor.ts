/**
 * Compaction Extraction Engine (T-026)
 *
 * Calls gemma4:31b (or the configured extraction model) to extract
 * structured facts from filtered conversation text.
 *
 * The extraction prompt is ~50 tokens per spec:
 * "Extract the most important facts from this conversation.
 *  Return JSON: {facts: [{text, confidence, tags}]}. Confidence 0-1."
 */

import { EXTRACTION_PROMPT, type ExtractedFact, type ExtractionResponse } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Maximum attempts to parse the LLM response as JSON. */
const MAX_PARSE_ATTEMPTS = 2;

/** Fallback confidence when the model doesn't provide one. */
const FALLBACK_CONFIDENCE = 0.7;

// ─── Parse LLM Response ─────────────────────────────────────────────────────────

/**
 * Parse the extraction model's response into an ExtractionResponse.
 *
 * The model may return:
 * 1. Clean JSON: `{facts: [...]}`
 * 2. JSON in a markdown code block: ```json\n{facts: [...]}\n```
 * 3. Text with embedded JSON
 *
 * We try multiple strategies and fall back gracefully.
 */
export function parseExtractionResponse(raw: string): ExtractionResponse {
  // Strategy 1: Direct JSON parse
  try {
    const parsed = JSON.parse(raw) as ExtractionResponse;
    if (isValidExtractionResponse(parsed)) {
      return normalizeResponse(parsed);
    }
  } catch {
    // Not clean JSON — try next strategy
  }

  // Strategy 2: Extract JSON from markdown code block
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]) as ExtractionResponse;
      if (isValidExtractionResponse(parsed)) {
        return normalizeResponse(parsed);
      }
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 3: Find first { and last } and try to parse
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const jsonStr = raw.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(jsonStr) as ExtractionResponse;
      if (isValidExtractionResponse(parsed)) {
        return normalizeResponse(parsed);
      }
    } catch {
      // Give up — return empty
    }
  }

  // Fallback: return empty facts (compaction will still succeed with 0 facts)
  console.warn("[compaction] Failed to parse extraction response, returning empty facts");
  return { facts: [] };
}

/**
 * Validate that the parsed response has the expected shape.
 */
function isValidExtractionResponse(obj: unknown): obj is ExtractionResponse {
  if (typeof obj !== "object" || obj === null) return false;
  const record = obj as Record<string, unknown>;
  if (!Array.isArray(record.facts)) return false;
  return record.facts.every((fact: unknown) => {
    if (typeof fact !== "object" || fact === null) return false;
    const f = fact as Record<string, unknown>;
    return typeof f.text === "string";
  });
}

/**
 * Normalize the extraction response: ensure confidence and tags defaults.
 */
function normalizeResponse(response: ExtractionResponse): ExtractionResponse {
  return {
    facts: response.facts.map((fact) => ({
      text: fact.text,
      confidence: typeof fact.confidence === "number"
        ? Math.min(1, Math.max(0, fact.confidence))
        : FALLBACK_CONFIDENCE,
      tags: Array.isArray(fact.tags)
        ? fact.tags.filter((t: unknown) => typeof t === "string").map((t: string) => t)
        : [],
    })),
  };
}

// ─── Extraction Engine ───────────────────────────────────────────────────────────

/**
 * Extract facts from conversation text using the extraction model.
 *
 * @param extractionText - The filtered conversation text.
 * @param callModel - Function to call the extraction model (LLM inference).
 * @param modelId - The model ID to use for extraction (default: gemma4:31b).
 * @param provider - The provider for the extraction model (default: ollama).
 * @param maxFacts - Maximum number of facts to extract (default: 50).
 * @returns An ExtractionResponse with the extracted facts.
 */
export async function extractFacts(
  extractionText: string,
  callModel: (modelId: string, provider: string, prompt: string) => Promise<string>,
  modelId: string = "gemma4:31b",
  provider: string = "ollama",
  maxFacts: number = 50,
): Promise<ExtractionResponse> {
  if (extractionText.trim().length === 0) {
    return { facts: [] };
  }

  // Build the full prompt
  const prompt = `${EXTRACTION_PROMPT}\n\n${extractionText}`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt++) {
    try {
      const rawResponse = await callModel(modelId, provider, prompt);
      const parsed = parseExtractionResponse(rawResponse);

      // Truncate to max facts
      if (parsed.facts.length > maxFacts) {
        parsed.facts = parsed.facts.slice(0, maxFacts);
      }

      return parsed;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[compaction] Extraction attempt ${attempt + 1} failed: ${lastError.message}`);

      // If the model call itself failed (not parse error), don't retry
      if (lastError.message.includes("model") || lastError.message.includes("provider")) {
        break;
      }
    }
  }

  // Model unavailable or extraction failed — throw with a descriptive message
  throw new Error(
    `Extraction model ${modelId} failed after ${MAX_PARSE_ATTEMPTS} attempts: ` +
    `${lastError?.message ?? "unknown error"}`,
  );
}