/**
 * `opencode.json` merge algorithm — TypeScript port of the Python
 * `neuralgentics-cli/src/neuralgentics/merge.py`.
 *
 * Deep merge with user-preservation semantics: the user's existing
 * `opencode.json` is the base, the shipped config is the overlay, and the
 * algorithm only ever ADDS missing entries — it never removes, overwrites
 * existing dicts, or touches the `provider` block.
 *
 * Rules (mirrors §4.1 of the design doc):
 *   1. `plugin` array → union (dedup, case-sensitive).
 *   2. `instructions` array → union (dedup).
 *   3. `provider` → preserved entirely from the user.
 *   4. `mcp` / `lsp` / `formatter` → add shipped keys missing in user.
 *   5. Top-level scalars (`$schema`, `autoupdate`, `tool_output`,
 *      `compaction`, `small_model`) → add from shipped if missing.
 */

/** The plugin entry added to the `plugin` array. */
export const PLUGIN_REFERENCE = "@veedubin/neuralgentics";

/** The instructions entry added to the `instructions` array. */
export const INSTRUCTIONS_REFERENCE = "AGENTS.md";

/** Top-level scalar keys added from the shipped config when missing. */
const TOP_LEVEL_SCALARS = [
  "$schema",
  "autoupdate",
  "tool_output",
  "compaction",
  "small_model",
] as const;

/** Dict-valued sections merged key-by-key (add new keys only). */
const DICT_SECTIONS = ["mcp", "lsp", "formatter"] as const;

/** Error thrown when an `opencode.json` document fails to parse. */
export class OpenCodeJsonInvalid extends Error {
  readonly exitCode = 3;
  readonly remediation = "Fix the JSON syntax error manually, then re-run.";
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeJsonInvalid";
  }
}

/** A JSON object (loose typing for merge internals). */
type JsonObj = Record<string, unknown>;

/**
 * Parse an `opencode.json` document. Wraps `JSON.parse` and re-raises parse
 * errors as `OpenCodeJsonInvalid` (exit code 3).
 */
export function parseOpencodeJson(text: string): JsonObj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OpenCodeJsonInvalid(`opencode.json is not valid JSON: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new OpenCodeJsonInvalid(
      `opencode.json must be a JSON object, got ${got}`,
    );
  }
  return parsed as JsonObj;
}

/**
 * Canonical serialization for stable on-disk diffs. `JSON.stringify` with
 * 2-space indent + sorted keys + trailing newline.
 */
export function serializeOpencodeJson(obj: JsonObj): string {
  return JSON.stringify(sortKeys(obj), null, 2) + "\n";
}

/** Recursively sort object keys for stable output (mirrors `sort_keys=True`). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const obj = value as JsonObj;
  const out: JsonObj = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

/**
 * Case-sensitive, order-preserving union of two arrays. User entries come
 * first (in their original order), followed by any shipped entries not
 * already present. Duplicates are dropped.
 */
function unionArrays(user: unknown[] | undefined, shipped: unknown[] | undefined): unknown[] {
  const result: unknown[] = [];
  const seen = new Set<unknown>();
  for (const source of [user, shipped]) {
    if (!source) continue;
    for (const item of source) {
      // Hashable membership check: primitives dedup naturally; objects/arrays
      // fall back to reference identity (rare in opencode.json arrays, which
      // are normally strings).
      if (typeof item === "object" && item !== null) {
        if (!result.some((r) => r === item)) {
          result.push(item);
        }
      } else if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result;
}

/** Deep clone via structuredClone (Node 20+). */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Merge a user `opencode.json` with the shipped config. Returns a NEW object;
 * the inputs are never mutated.
 */
export function mergeOpencodeJson(userJson: JsonObj, shippedJson: JsonObj): JsonObj {
  const result: JsonObj = deepClone(userJson);

  // 1 & 2 — array sections.
  result["plugin"] = unionArrays(
    userJson["plugin"] as unknown[] | undefined,
    shippedJson["plugin"] as unknown[] | undefined,
  );
  result["instructions"] = unionArrays(
    userJson["instructions"] as unknown[] | undefined,
    shippedJson["instructions"] as unknown[] | undefined,
  );

  // 3 — provider: PRESERVE user's entirely when present. When the user has
  // no provider block, add the shipped one verbatim.
  if (!("provider" in result) && "provider" in shippedJson) {
    result["provider"] = deepClone(shippedJson["provider"]);
  }

  // 4 — dict sections: add shipped keys missing in user.
  for (const section of DICT_SECTIONS) {
    const shippedSection = shippedJson[section];
    if (shippedSection === null || typeof shippedSection !== "object" || Array.isArray(shippedSection)) {
      continue;
    }
    const shippedObj = shippedSection as JsonObj;
    const resultSection = (result[section] as JsonObj | undefined) ?? {};
    if (!(section in result)) {
      result[section] = resultSection;
    }
    for (const [key, value] of Object.entries(shippedObj)) {
      if (!(key in resultSection)) {
        resultSection[key] = deepClone(value);
      }
    }
    if (section in result) {
      (result as JsonObj)[section] = resultSection;
    }
  }

  // 5 — top-level scalars.
  for (const key of TOP_LEVEL_SCALARS) {
    if (!(key in result) && key in shippedJson) {
      result[key] = deepClone(shippedJson[key]);
    }
  }

  return result;
}

/**
 * Like `mergeOpencodeJson` but also returns a list of human-readable change
 * descriptions. The list is empty when nothing changed (idempotent re-run).
 */
export function mergeOpencodeJsonWithDiff(
  userJson: JsonObj,
  shippedJson: JsonObj,
): { merged: JsonObj; changes: string[] } {
  const merged = mergeOpencodeJson(userJson, shippedJson);
  const changes: string[] = [];

  // Plugin additions.
  const userPlugin = (userJson["plugin"] as unknown[] | undefined) ?? [];
  const shippedPlugin = (shippedJson["plugin"] as unknown[] | undefined) ?? [];
  for (const item of shippedPlugin) {
    if (!userPlugin.includes(item)) {
      changes.push(`Added ${JSON.stringify(item)} to plugin array`);
    }
  }

  // Instructions additions.
  const userInstr = (userJson["instructions"] as unknown[] | undefined) ?? [];
  const shippedInstr = (shippedJson["instructions"] as unknown[] | undefined) ?? [];
  for (const item of shippedInstr) {
    if (!userInstr.includes(item)) {
      changes.push(`Added ${JSON.stringify(item)} to instructions array`);
    }
  }

  // Dict-section additions.
  const sectionLabels: Record<string, string> = {
    mcp: "MCP server",
    lsp: "LSP server",
    formatter: "formatter",
  };
  for (const [section, label] of Object.entries(sectionLabels)) {
    const shippedSection = shippedJson[section];
    if (shippedSection === null || typeof shippedSection !== "object" || Array.isArray(shippedSection)) {
      continue;
    }
    const shippedObj = shippedSection as JsonObj;
    const userSection = userJson[section];
    const userObj =
      userSection !== null && typeof userSection === "object" && !Array.isArray(userSection)
        ? (userSection as JsonObj)
        : {};
    for (const key of Object.keys(shippedObj)) {
      if (!(key in userObj)) {
        changes.push(`Added ${label} ${JSON.stringify(key)}`);
      }
    }
  }

  // Top-level scalar additions.
  for (const key of TOP_LEVEL_SCALARS) {
    if (!(key in userJson) && key in shippedJson) {
      changes.push(`Set ${key}`);
    }
  }

  return { merged, changes };
}

/** Pretty-print a change list (one `+ ` line per change). */
export function formatDiffForDisplay(changes: string[]): string {
  return changes.map((c) => `  + ${c}`).join("\n");
}