/**
 * <Summary>
 * What it does:
 *   Type definitions and parsing functions for preference rules.
 *
 * How it fits in the system:
 *   Provides type definitions for the on-disk file format and functions
 *   to normalize and validate preference rule objects.
 * </Summary>
 */

import type {
  PreferenceConfidence,
  PreferenceRule,
  PreferenceSource,
} from "../../orchestration/interfaces.js";

/**
 * <Summary>
 * What it does:
 *   Type definition for the on-disk preferences file structure.
 *
 * How it fits in the system:
 *   The file is stored as JSON with a version field for future compatibility
 *   and a rules array containing all PreferenceRule objects.
 *
 * Fields:
 *   version — File format version (currently 1).
 *   rules — Array of preference rules to persist.
 * </Summary>
 */
export type PreferencesFile = {
  version: 1;
  rules: PreferenceRule[];
};

/**
 * <Summary>
 * What it does:
 *   Maps confidence levels to numeric ranks for comparison.
 *
 * How it fits in the system:
 *   Used by higherConfidence to determine which of two confidence levels is higher.
 *   The numeric ranks allow simple comparison: higher rank = higher confidence.
 * </Summary>
 */
const CONFIDENCE_RANK: Record<PreferenceConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * @async is not needed - this is a synchronous function
 * <Summary>
 * What it does:
 *   Normalizes untrusted confidence value to valid PreferenceConfidence type.
 *
 * How it does it (step by step):
 *   1. Check if value matches one of the valid confidence levels.
 *   2. If valid, return it unchanged.
 *   3. Otherwise, default to 'medium' for safety.
 *
 * Parameters:
 *   @param raw - Untrusted value from advisor or file.
 *
 * Returns:
 *   @returns One of 'high'|'medium'|'low'.
 * </Summary>
 */
export const parseConfidence = (raw: unknown): PreferenceConfidence => {
  // Step 1: Check if value matches one of the valid confidence levels
  // We use strict equality to ensure type safety - only exact string matches are accepted
  if (raw === "high" || raw === "medium" || raw === "low") {
    // Step 2: If valid, return it unchanged (TypeScript knows this is safe)
    return raw;
  }
  // Step 3: Otherwise, default to 'medium' for safety
  // 'medium' is a safe default when we can't determine the intended confidence level
  return "medium";
};

/**
 * <Summary>
 * What it does:
 *   Normalizes untrusted source value to valid PreferenceSource type.
 *
 * How it does it (step by step):
 *   1. Check if value matches one of the valid source types.
 *   2. If valid, return it unchanged.
 *   3. Otherwise, default to 'explicit' for safety.
 *
 * Parameters:
 *   @param raw - Untrusted value from advisor or file.
 *
 * Returns:
 *   @returns One of 'explicit'|'outcome'|'fix'|'style'.
 * </Summary>
 */
export const parseSource = (raw: unknown): PreferenceSource => {
  // Step 1: Check if value matches one of the valid source types
  // Source indicates where the rule came from:
  // - 'explicit': manually set by user
  // - 'outcome': learned from task outcome via advisor
  // - 'fix': learned from escalation guidance
  // - 'style': learned from user edits
  if (
    raw === "explicit" ||
    raw === "outcome" ||
    raw === "fix" ||
    raw === "style"
  ) {
    // Step 2: If valid, return it unchanged (TypeScript knows this is safe)
    return raw;
  }
  // Step 3: Otherwise, default to 'explicit' for safety
  // 'explicit' is a safe default as it represents user-intended rules
  return "explicit";
};

/**
 * <Summary>
 * What it does:
 *   Validates and normalizes an untrusted rule object into a PreferenceRule.
 *
 * How it does it (step by step):
 *   1. Check if input is an object (reject primitives and null).
 *   2. Extract and type-check each field with safe defaults.
 *   3. Handle backward compatibility for createdAt field.
 *   4. Reject rules with missing required fields (id, text, timestamp).
 *   5. Return normalized PreferenceRule or null if invalid.
 *
 * Parameters:
 *   @param unknownRule - Untrusted rule object from file or advisor.
 *
 * Returns:
 *   @returns Normalized rule or null if invalid.
 * </Summary>
 */
export const normaliseRule = (unknownRule: unknown): PreferenceRule | null => {
  // Step 1: Check if input is an object (reject primitives and null)
  // This is a safety check to prevent runtime errors when accessing properties
  if (typeof unknownRule !== "object" || unknownRule === null) {
    return null;
  }

  // Step 2: Extract and type-check each field with safe defaults
  // We cast to Record<string, unknown> to allow property access while maintaining type safety
  const ruleObj = unknownRule as Record<string, unknown>;

  // Required field: unique identifier for the rule
  const id = typeof ruleObj.id === "string" ? ruleObj.id : "";

  // Required field: human-readable rule text
  const text = typeof ruleObj.text === "string" ? ruleObj.text : "";

  // Optional field: array of topic strings for categorization
  // We filter to ensure only strings are included in the array
  const topics = Array.isArray(ruleObj.topics)
    ? ruleObj.topics.filter(
        (topicItem): topicItem is string => typeof topicItem === "string",
      )
    : [];

  // Optional field: scope for where the rule applies (e.g., "typescript", "python", "all")
  // Default to "all" if missing or empty
  const scope =
    typeof ruleObj.scope === "string" && ruleObj.scope.length > 0
      ? ruleObj.scope
      : "all";

  // Optional field: confidence level with validation via parseConfidence
  const confidence = parseConfidence(ruleObj.confidence);

  // Optional field: source with validation via parseSource
  const source = parseSource(ruleObj.source);

  // Step 3: Handle backward compatibility for createdAt field
  // Older versions used 'createdAt', newer versions use 'timestamp'
  // We check both to support migration from old format
  const timestamp =
    typeof ruleObj.timestamp === "string"
      ? ruleObj.timestamp
      : typeof ruleObj.createdAt === "string"
        ? ruleObj.createdAt
        : "";

  // Optional field: times the rule has been applied
  // Must be a finite number and non-negative; defaults to 0
  const timesApplied =
    typeof ruleObj.timesApplied === "number" &&
    Number.isFinite(ruleObj.timesApplied)
      ? Math.max(0, Math.floor(ruleObj.timesApplied))
      : 0;

  // Step 4: Reject rules with missing required fields (id, text, timestamp)
  // These three fields are essential for rule uniqueness and tracking
  if (id.length === 0 || text.length === 0 || timestamp.length === 0) {
    return null;
  }

  // Step 5: Return normalized PreferenceRule with all fields validated
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
 * <Summary>
 * What it does:
 *   Validates and normalizes the entire preferences file structure.
 *
 * How it does it (step by step):
 *   1. Check if input is an object with a 'rules' array.
 *   2. Normalize each rule via normaliseRule.
 *   3. Filter out any invalid rules (null results).
 *   4. Return normalized file or empty file if input is invalid.
 *
 * Parameters:
 *   @param raw - Untrusted file object from disk.
 *
 * Returns:
 *   @returns Normalized file with valid rules.
 * </Summary>
 */
export const normaliseFile = (raw: unknown): PreferencesFile => {
  // Step 1: Check if input is an object with a 'rules' array
  // This validates the basic structure before processing individual rules
  if (
    typeof raw === "object" &&
    raw !== null &&
    "rules" in raw &&
    Array.isArray((raw as { rules: unknown }).rules)
  ) {
    // Step 2: Normalize each rule via normaliseRule
    // This validates each individual rule and converts it to the proper format
    // Step 3: Filter out any invalid rules (null results)
    // normaliseRule returns null for invalid rules, so we filter those out
    const rules = (raw as { rules: unknown[] }).rules
      .map(normaliseRule)
      .filter((rule): rule is PreferenceRule => rule !== null);
    return { version: 1, rules };
  }
  // Step 4: Return empty file if input is invalid
  // If the structure is completely wrong, we return a valid empty file rather than crashing
  return { version: 1, rules: [] };
};

/**
 * <Summary>
 * What it does:
 *   Returns the higher of two confidence levels based on rank.
 *
 * How it does it (step by step):
 *   1. Compare confidence ranks using CONFIDENCE_RANK mapping.
 *   2. Return the confidence with the higher rank.
 *
 * Parameters:
 *   @param confidenceA - First confidence level.
 *   @param confidenceB - Second confidence level.
 *
 * Returns:
 *   @returns The higher confidence level.
 * </Summary>
 */
export const higherConfidence = (
  confidenceA: PreferenceConfidence,
  confidenceB: PreferenceConfidence,
): PreferenceConfidence => {
  // Step 1: Compare confidence ranks using CONFIDENCE_RANK mapping
  // CONFIDENCE_RANK maps: low=0, medium=1, high=2
  // Step 2: Return the confidence with the higher rank
  // If ranks are equal, we return confidenceA (arbitrary but consistent)
  return CONFIDENCE_RANK[confidenceA] >= CONFIDENCE_RANK[confidenceB]
    ? confidenceA
    : confidenceB;
};
