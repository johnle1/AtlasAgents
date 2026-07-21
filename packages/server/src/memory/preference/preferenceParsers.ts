/**
 * Parsing and validation functions for preference rules.
 *
 * @remarks
 * Provides functions to normalize and validate untrusted rule objects from disk,
 * subagent responses, or user input. Handles backward compatibility (createdAt → timestamp),
 * type coercion with safe defaults, and file structure validation.
 *
 * Used by {@link PreferenceManager} and {@link ContextBuilder} to ensure
 * rules are well-formed before storage or context injection.
 */

import type {
  PreferenceConfidence,
  PreferenceRule,
  PreferenceSource,
} from "../../orchestration/interfaces.js";
import type { PreferencesFile } from "../types.js";

/**
 * Maps confidence levels to numeric ranks for comparison.
 *
 * @remarks
 * Used by {@link higherConfidence} to determine which confidence level is higher.
 * Higher rank = higher confidence.
 */
const CONFIDENCE_RANK: Record<PreferenceConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Normalizes untrusted confidence value to valid PreferenceConfidence type.
 *
 * @param raw - Untrusted value from subagent response or file
 * @returns One of 'high', 'medium', 'low' (defaults to 'medium')
 *
 * @remarks
 * Type-checks against valid confidence levels. Returns safe default ('medium')
 * if value is invalid, missing, or wrong type. Never throws.
 *
 * @example
 * ```ts
 * parseConfidence("high")     // "high"
 * parseConfidence("INVALID")  // "medium"
 * parseConfidence(null)       // "medium"
 * ```
 */
export const parseConfidence = (raw: unknown): PreferenceConfidence => {
  if (raw === "high" || raw === "medium" || raw === "low") {
    return raw;
  }
  // Safe default when value is invalid or missing
  return "medium";
};

/**
 * Normalizes untrusted source value to valid PreferenceSource type.
 *
 * @param raw - Untrusted value from subagent response or file
 * @returns One of 'explicit', 'outcome', 'fix', 'style' (defaults to 'explicit')
 *
 * @remarks
 * **Valid sources:**
 * - `explicit` — manually set by user (safe default)
 * - `outcome` — learned from task outcome
 * - `fix` — learned from escalation guidance
 * - `style` — learned from user edits
 *
 * Type-checks against valid sources. Returns 'explicit' (user-intended rules)
 * if value is invalid or missing. Never throws.
 */
export const parseSource = (raw: unknown): PreferenceSource => {
  if (
    raw === "explicit" ||
    raw === "outcome" ||
    raw === "fix" ||
    raw === "style"
  ) {
    return raw;
  }
  // Safe default: user-intended rules
  return "explicit";
};

/**
 * Validates and normalizes an untrusted rule object into a PreferenceRule.
 *
 * @param unknownRule - Untrusted rule object from file or subagent response
 * @returns Normalized PreferenceRule or null if required fields missing or invalid
 *
 * @remarks
 * **Type coercion & validation:**
 * - Required: id, text, timestamp (non-empty strings)
 * - Optional: topics (string array), scope (string, default "all")
 * - Confidence/source validated via {@link parseConfidence} and {@link parseSource}
 * - timesApplied must be finite, non-negative number
 *
 * **Backward compatibility:** Accepts `createdAt` (old format) if `timestamp` absent.
 *
 * Returns null without throwing on validation failure. Safe defaults are applied
 * to fields; only missing required fields cause rejection.
 *
 * @example
 * ```ts
 * normaliseRule({
 *   id: "abc", text: "Use TypeScript", timestamp: "2025-01-01T00:00:00Z",
 *   topics: ["typescript"], confidence: "high"
 * })
 * // Returns well-formed PreferenceRule
 *
 * normaliseRule({ text: "Missing required id" })
 * // null (missing id)
 * ```
 */
export const normaliseRule = (unknownRule: unknown): PreferenceRule | null => {
  if (typeof unknownRule !== "object" || unknownRule === null) {
    return null;
  }

  const ruleObj = unknownRule as Record<string, unknown>;

  // Extract required and optional fields with type coercion
  const id = typeof ruleObj.id === "string" ? ruleObj.id : "";
  const text = typeof ruleObj.text === "string" ? ruleObj.text : "";
  const topics = Array.isArray(ruleObj.topics)
    ? ruleObj.topics.filter(
        (topicItem): topicItem is string => typeof topicItem === "string",
      )
    : [];
  const scope =
    typeof ruleObj.scope === "string" && ruleObj.scope.length > 0
      ? ruleObj.scope
      : "all";
  const confidence = parseConfidence(ruleObj.confidence);
  const source = parseSource(ruleObj.source);

  // Support both 'timestamp' (new) and 'createdAt' (old) fields for backward compatibility
  const timestamp =
    typeof ruleObj.timestamp === "string"
      ? ruleObj.timestamp
      : typeof ruleObj.createdAt === "string"
        ? ruleObj.createdAt
        : "";

  const timesApplied =
    typeof ruleObj.timesApplied === "number" &&
    Number.isFinite(ruleObj.timesApplied)
      ? Math.max(0, Math.floor(ruleObj.timesApplied))
      : 0;

  // Reject if required fields are missing
  if (id.length === 0 || text.length === 0 || timestamp.length === 0) {
    return null;
  }

  return {
    id,
    text,
    topics,
    scope,
    confidence,
    source,
    timestamp,
    timesApplied,
  };
};

/**
 * Validates and normalizes the entire preferences file structure.
 *
 * @param raw - Untrusted file object from disk
 * @returns Normalized PreferencesFile with valid rules (empty if invalid)
 *
 * @remarks
 * **Structure validation:**
 * - Checks if input is an object with a 'rules' array
 * - Maps each rule through {@link normaliseRule}
 * - Filters out invalid rules (those that normalize to null)
 * - Returns empty file (no crash) if structure is wrong
 *
 * Safe graceful degradation: malformed files → empty file instead of throwing.
 * Used by {@link PreferenceManager.load} to restore preferences from disk.
 *
 * @example
 * ```ts
 * normaliseFile({ version: 1, rules: [{ id: "a", text: "rule", timestamp: "..." }] })
 * // { version: 1, rules: [PreferenceRule, ...] }
 *
 * normaliseFile({ invalid: "structure" })
 * // { version: 1, rules: [] }
 * ```
 */
export const normaliseFile = (raw: unknown): PreferencesFile => {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "rules" in raw &&
    Array.isArray((raw as { rules: unknown }).rules)
  ) {
    // Normalize each rule and filter out invalid ones
    const rules = (raw as { rules: unknown[] }).rules
      .map(normaliseRule)
      .filter((rule): rule is PreferenceRule => rule !== null);
    return { version: 1, rules };
  }
  // Invalid structure → return empty file gracefully
  return { version: 1, rules: [] };
};

/**
 * Returns the higher of two confidence levels.
 *
 * @param confidenceA - First confidence level
 * @param confidenceB - Second confidence level
 * @returns The higher confidence level (high > medium > low)
 *
 * @remarks
 * **Ranking:** high (2) > medium (1) > low (0).
 * On tie, returns `confidenceA` (arbitrary but consistent).
 *
 * Used by {@link PreferenceManager.add} when merging similar rules
 * to keep the highest confidence.
 *
 * @example
 * ```ts
 * higherConfidence("low", "high")     // "high"
 * higherConfidence("medium", "medium") // "medium"
 * higherConfidence("high", "medium")   // "high"
 * ```
 */
export const higherConfidence = (
  confidenceA: PreferenceConfidence,
  confidenceB: PreferenceConfidence,
): PreferenceConfidence => {
  return CONFIDENCE_RANK[confidenceA] >= CONFIDENCE_RANK[confidenceB]
    ? confidenceA
    : confidenceB;
};
