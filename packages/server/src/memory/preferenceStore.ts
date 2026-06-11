/**
 * <Summary>
 * What it does:
 *   Persists user preference rules as JSON under user-data/preferences.json with
 *   atomic renames, deduplication on add, and optional advisor-driven consolidate.
 *
 * How it fits in the system:
 *   Implements IPreferenceStore for ContextBuilder, PatternExtractor, and memory routes.
 *
 * Dependencies:
 *   - node:fs/promises, node:path, node:crypto — filesystem and ids.
 *   - ../orchestration/interfaces.js — contracts and rule types.
 *   - IOllamaClient, IConfigManager — consolidate only.
 *
 * Dependants:
 *   - ContextBuilder, PatternExtractor.
 * </Summary>
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  IConfigManager,
  IOllamaClient,
  IPreferenceStore,
  NewPreferenceRule,
  PreferenceConfidence,
  PreferenceRule,
  PreferenceSource,
} from "../orchestration/interfaces.js";
import type { Message } from "../orchestration/types.js";

/**
 * <Summary>
 * What it does:
 *   Default file path for storing user preference rules relative to the project root.
 *
 * How it fits in the system:
 *   Used by the PreferenceStore constructor to determine where to persist rules.
 *   The file is stored under user-data/ to keep user-generated data separate from source code.
 *
 * Dependants:
 *   - PreferenceStore constructor — uses this to build the absolute file path.
 * </Summary>
 */
const DEFAULT_FILE = "user-data/preferences.json";

/**
 * <Summary>
 * What it does:
 *   Jaccard similarity threshold for detecting duplicate preference rules.
 *
 * How it fits in the system:
 *   When adding a new rule, the store checks if an existing rule has similarity >= 0.8.
 *   If so, the new rule is merged into the existing one instead of creating a duplicate.
 *
 * Dependants:
 *   - add — uses this threshold to decide whether to merge or create a new rule.
 * </Summary>
 */
const SIMILARITY_THRESHOLD = 0.8;

/**
 * <Summary>
 * What it does:
 *   Minimum number of rules required before consolidation is triggered.
 *
 * How it fits in the system:
 *   Consolidation uses an AI advisor to merge duplicate rules, which is expensive.
 *   This threshold ensures consolidation only runs when there are enough rules to benefit.
 *
 * Dependants:
 *   - consolidate — checks this threshold before attempting consolidation.
 * </Summary>
 */
const CONSOLIDATE_MIN_RULES = 20;

/**
 * <Summary>
 * What it does:
 *   Set of common English stop words to ignore during text tokenization.
 *
 * How it fits in the system:
 *   Used by the tokenise function to filter out noise words that don't contribute
 *   to meaningful similarity comparisons (e.g., "the", "and", "for").
 *
 * Dependants:
 *   - tokenise — filters out these words when extracting meaningful tokens.
 * </Summary>
 */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "has",
  "was",
  "were",
  "are",
  "you",
  "your",
  "into",
  "about",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "would",
  "could",
  "should",
  "their",
  "there",
  "then",
  "than",
  "them",
  "also",
  "using",
  "use",
  "used",
  "need",
  "just",
  "like",
  "make",
  "made",
  "each",
  "some",
  "such",
  "very",
  "more",
  "most",
  "other",
  "only",
  "over",
  "after",
  "before",
  "between",
  "under",
  "again",
  "here",
  "how",
  "why",
  "who",
  "can",
  "not",
  "but",
  "all",
  "any",
  "our",
  "out",
  "off",
  "its",
  "always",
  "never",
]);

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
 *
 * Dependants:
 *   - load — parses JSON into this type.
 *   - save — serializes this type to JSON.
 *   - normaliseFile — validates and normalizes to this type.
 * </Summary>
 */
type PreferencesFile = {
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
 *
 * Dependants:
 *   - higherConfidence — compares confidence levels using these ranks.
 * </Summary>
 */
const CONFIDENCE_RANK: Record<PreferenceConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * <Summary>
 * What it does:
 *   Creates a directory (and any missing parents) if it doesn't exist.
 *
 * How it does it (step by step):
 *   1. Call fs.mkdir with recursive option to create directory and parents.
 *
 * Parameters:
 *   @param {string} dir — Directory path to create.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when directory exists.
 *
 * Dependants:
 *   - save — ensures target directory exists before writing.
 * </Summary>
 */
const ensureDir = async (dir: string): Promise<void> => {
  // Step 1: Create directory with recursive option (creates parent directories if needed)
  await fs.mkdir(dir, { recursive: true });
};

/**
 * <Summary>
 * What it does:
 *   Tokenizes text into meaningful words for similarity comparison.
 *
 * How it does it (step by step):
 *   1. Convert text to lowercase for case-insensitive comparison.
 *   2. Split on non-alphanumeric characters to extract words.
 *   3. Filter out short words (< 3 chars) and stop words.
 *   4. Return as Set for efficient lookup and deduplication.
 *
 * Parameters:
 *   @param {string} text — Input text to tokenize.
 *
 * Returns:
 *   @returns {Set<string>} — Set of meaningful word tokens.
 *
 * Dependants:
 *   - textSimilarity — uses tokenized sets for comparison.
 * </Summary>
 */
const tokenise = (text: string): Set<string> => {
  // Step 1: Convert text to lowercase for case-insensitive comparison
  // Step 2: Split on non-alphanumeric characters to extract words
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/g)
    // Step 3: Filter out short words (< 3 chars) and stop words
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  // Step 4: Return as Set for efficient lookup and deduplication
  return new Set(words);
};

/**
 * <Summary>
 * What it does:
 *   Calculates Jaccard similarity between two text strings using token sets.
 *
 * How it does it (step by step):
 *   1. Tokenize both texts into sets of meaningful words.
 *   2. Handle edge cases for empty sets (both empty = identical, one empty = no similarity).
 *   3. Count intersection (tokens present in both sets).
 *   4. Calculate union size (unique tokens across both sets).
 *   5. Return Jaccard index (intersection / union).
 *
 * Parameters:
 *   @param {string} a — First text string.
 *   @param {string} b — Second text string.
 *
 * Returns:
 *   @returns {number} — Jaccard similarity (0-1, where 1 = identical).
 *
 * Dependants:
 *   - add — detects duplicate rules for merging.
 * </Summary>
 */
const textSimilarity = (textA: string, textB: string): number => {
  // Step 1: Tokenize both texts into sets of meaningful words
  const setA = tokenise(textA);
  const setB = tokenise(textB);
  // Step 2: Handle edge cases for empty sets
  // Both empty = considered identical (both have no content)
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  // One empty = no similarity (one has content, other doesn't)
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  // Step 3: Count intersection (tokens present in both sets)
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) {
      intersection += 1;
    }
  }
  // Step 4: Calculate union size (unique tokens across both sets)
  const union = setA.size + setB.size - intersection;
  // Step 5: Return Jaccard index (intersection / union)
  return union === 0 ? 0 : intersection / union;
};

/**
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
 *   @param {unknown} raw — Untrusted value from advisor or file.
 *
 * Returns:
 *   @returns {PreferenceConfidence} — One of 'high'|'medium'|'low'.
 *
 * Dependants:
 *   - normaliseRule — validates confidence field.
 * </Summary>
 */
const parseConfidence = (raw: unknown): PreferenceConfidence => {
  // Step 1: Check if value matches one of the valid confidence levels
  if (raw === "high" || raw === "medium" || raw === "low") {
    // Step 2: If valid, return it unchanged
    return raw;
  }
  // Step 3: Otherwise, default to 'medium' for safety
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
 *   @param {unknown} raw — Untrusted value from advisor or file.
 *
 * Returns:
 *   @returns {PreferenceSource} — One of 'explicit'|'outcome'|'fix'|'style'.
 *
 * Dependants:
 *   - normaliseRule — validates source field.
 * </Summary>
 */
const parseSource = (raw: unknown): PreferenceSource => {
  // Step 1: Check if value matches one of the valid source types
  if (
    raw === "explicit" ||
    raw === "outcome" ||
    raw === "fix" ||
    raw === "style"
  ) {
    // Step 2: If valid, return it unchanged
    return raw;
  }
  // Step 3: Otherwise, default to 'explicit' for safety
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
 *   @param {unknown} unknownRule — Untrusted rule object from file or advisor.
 *
 * Returns:
 *   @returns {PreferenceRule | null} — Normalized rule or null if invalid.
 *
 * Dependants:
 *   - normaliseFile — validates each rule in the file.
 *   - consolidate — validates advisor-returned rules.
 * </Summary>
 */
const normaliseRule = (unknownRule: unknown): PreferenceRule | null => {
  // Step 1: Check if input is an object (reject primitives and null)
  if (typeof unknownRule !== "object" || unknownRule === null) {
    return null;
  }
  // Step 2: Extract and type-check each field with safe defaults
  const ruleObj = unknownRule as Record<string, unknown>;
  const id = typeof ruleObj.id === "string" ? ruleObj.id : "";
  const text = typeof ruleObj.text === "string" ? ruleObj.text : "";
  const topics = Array.isArray(ruleObj.topics)
    ? ruleObj.topics.filter((t): t is string => typeof t === "string")
    : [];
  const scope =
    typeof ruleObj.scope === "string" && ruleObj.scope.length > 0
      ? ruleObj.scope
      : "all";
  const confidence = parseConfidence(ruleObj.confidence);
  const source = parseSource(ruleObj.source);
  // Step 3: Handle backward compatibility for createdAt field
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

  // Step 4: Reject rules with missing required fields (id, text, timestamp)
  if (id.length === 0 || text.length === 0 || timestamp.length === 0) {
    return null;
  }

  // Step 5: Return normalized PreferenceRule
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
 *   @param {unknown} raw — Untrusted file object from disk.
 *
 * Returns:
 *   @returns {PreferencesFile} — Normalized file with valid rules.
 *
 * Dependants:
 *   - load — validates loaded file before returning.
 * </Summary>
 */
const normaliseFile = (raw: unknown): PreferencesFile => {
  // Step 1: Check if input is an object with a 'rules' array
  if (
    typeof raw === "object" &&
    raw !== null &&
    "rules" in raw &&
    Array.isArray((raw as { rules: unknown }).rules)
  ) {
    // Step 2: Normalize each rule via normaliseRule
    // Step 3: Filter out any invalid rules (null results)
    const rules = (raw as { rules: unknown[] }).rules
      .map(normaliseRule)
      .filter((r): r is PreferenceRule => r !== null);
    return { version: 1, rules };
  }
  // Step 4: Return empty file if input is invalid
  return { version: 1, rules: [] };
};

/**
 * <Summary>
 * What it does:
 *   Extracts a JSON array string from a raw advisor/LLM response.
 *
 * How it does it (step by step):
 *   1. Trim surrounding whitespace from the raw response.
 *   2. Attempt to capture a fenced code block (```json or ```).
 *   3. If fenced block found, use its inner contents; otherwise use trimmed text.
 *   4. Find the first '[' and last ']' in the body.
 *   5. If both brackets exist and end > start, return the substring.
 *   6. Otherwise, return the full body for caller to handle.
 *
 * Parameters:
 *   @param {string} raw — Raw text returned by the advisor/LLM.
 *
 * Returns:
 *   @returns {string} — Extracted JSON array text (or original body if not found).
 *
 * Dependants:
 *   - consolidate — parses advisor response.
 * </Summary>
 */
const extractJsonArray = (raw: string): string => {
  // Step 1: Trim surrounding whitespace from the raw response
  const trimmed = raw.trim();
  // Step 2: Attempt to capture a fenced code block (```json or ```)
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(trimmed);
  // Step 3: If fenced block found, use its inner contents; otherwise use trimmed text
  const body = fence ? fence[1].trim() : trimmed;
  // Step 4: Find the first '[' and last ']' in the body
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  // Step 5: If both brackets exist and end > start, return the substring
  if (start !== -1 && end !== -1 && end > start) {
    return body.slice(start, end + 1);
  }
  // Step 6: Otherwise, return the full body for caller to handle
  return body;
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
 *   @param {PreferenceConfidence} a — First confidence level.
 *   @param {PreferenceConfidence} b — Second confidence level.
 *
 * Returns:
 *   @returns {PreferenceConfidence} — The higher confidence level.
 *
 * Dependants:
 *   - add — merges confidence when updating similar rules.
 * </Summary>
 */
const higherConfidence = (
  a: PreferenceConfidence,
  b: PreferenceConfidence,
): PreferenceConfidence => {
  // Step 1: Compare confidence ranks using CONFIDENCE_RANK mapping
  // Step 2: Return the confidence with the higher rank
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
};

/**
 * <Summary>
 * What it does:
 *   Persists user preference rules as JSON with atomic renames, deduplication, and optional consolidation.
 *
 * How it fits in the system:
 *   Implements IPreferenceStore for ContextBuilder, PatternExtractor, and memory routes.
 *
 * Dependencies:
 *   - node:fs/promises, node:path, node:crypto — filesystem and ids.
 *   - ../orchestration/interfaces.js — contracts and rule types.
 *   - IOllamaClient, IConfigManager — consolidate only.
 *
 * Dependants:
 *   - ContextBuilder, PatternExtractor.
 * </Summary>
 */
export class PreferenceStore implements IPreferenceStore {
  private readonly absPath: string;
  private readonly ollama?: IOllamaClient;
  private readonly config?: IConfigManager;

  /**
   * <Summary>
   * What it does:
   *   Initializes the store with a file path and optional advisor dependencies.
   *
   * How it does it (step by step):
   *   1. Use provided rootDir or default to process.cwd().
   *   2. Join with DEFAULT_FILE to get absolute path.
   *   3. Store optional ollama and config dependencies for consolidation.
   *
   * Parameters:
   *   @param {string} [rootDir] — Base directory for preferences file.
   *   @param {{ ollama?: IOllamaClient; config?: IConfigManager }} [deps] — Optional advisor dependencies.
   *
   * Dependants:
   *   - Instantiation by ContextBuilder, PatternExtractor, memory routes.
   * </Summary>
   */
  constructor(
    rootDir?: string,
    deps?: { ollama?: IOllamaClient; config?: IConfigManager },
  ) {
    // Step 1: Use provided rootDir or default to process.cwd()
    const base = rootDir ?? process.cwd();
    // Step 2: Join with DEFAULT_FILE to get absolute path
    this.absPath = path.join(base, DEFAULT_FILE);
    // Step 3: Store optional ollama and config dependencies for consolidation
    this.ollama = deps?.ollama;
    this.config = deps?.config;
  }

  /**
   * <Summary>
   * What it does:
   *   Returns every stored preference rule (empty array when file missing).
   *
   * How it does it (step by step):
   *   1. Load the preferences file from disk.
   *   2. Return the rules array (empty if file doesn't exist).
   *
   * Returns:
   *   @returns {Promise<PreferenceRule[]>} — Array of all stored rules.
   *
   * Dependencies:
   *   - load — reads the preferences file from disk.
   *
   * Dependants:
   *   - ContextBuilder.build — loads all rules to filter for task relevance.
   * </Summary>
   */
  getAll = async (): Promise<PreferenceRule[]> => {
    // Step 1: Load the preferences file from disk
    const preferencesFile = await this.load();
    // Step 2: Return the rules array (empty if file doesn't exist)
    return preferencesFile.rules;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns rules whose topics overlap task keywords, sorted by timesApplied descending.
   *
   * How it does it (step by step):
   *   1. Convert task keywords to a Set for efficient lookup (case-insensitive).
   *   2. Load all rules from storage via getAll().
   *   3. Filter rules where any topic matches any keyword (case-insensitive).
   *   4. Sort matching rules by timesApplied descending (most-used first).
   *   5. Return the sorted array of relevant rules.
   *
   * Parameters:
   *   @param {Iterable<string>} taskKeywords — Keywords to match against rule topics.
   *
   * Returns:
   *   @returns {Promise<PreferenceRule[]>} — Sorted array of relevant rules by usage frequency.
   *
   * Dependencies:
   *   - getAll — loads all rules from storage.
   *
   * Dependants:
   *   - ContextBuilder.build — retrieves relevant preferences for task context.
   * </Summary>
   */
  getForTask = async (
    taskKeywords: Iterable<string>,
  ): Promise<PreferenceRule[]> => {
    // Step 1: Convert task keywords to a Set for efficient lookup (case-insensitive)
    const keywordSet = new Set(
      [...taskKeywords].map((keyword) => keyword.toLowerCase()),
    );
    // Step 2: Load all rules from storage
    const allRules = await this.getAll();
    // Step 3: Filter rules where any topic matches any keyword (case-insensitive)
    const matchedRules = allRules.filter((rule) =>
      rule.topics.some((topic) => keywordSet.has(topic.toLowerCase())),
    );
    // Step 4: Sort matching rules by timesApplied descending (most-used first)
    // Step 5: Return the sorted array of relevant rules
    return [...matchedRules].sort(
      (ruleA, ruleB) => ruleB.timesApplied - ruleA.timesApplied,
    );
  };

  /**
   * <Summary>
   * What it does:
   *   Adds or merges a rule (dedup by text similarity >= 0.8).
   *
   * How it does it (step by step):
   *   1. Load the preferences file from disk.
   *   2. Trim and sanitize the rule text and topics.
   *   3. Iterate through existing rules to check for similarity.
   *   4. If similar rule found (similarity >= 0.8):
   *      a. Increment timesApplied counter.
   *      b. Update confidence to the higher of the two.
   *      c. Update timestamp to current time.
   *      d. Update topics and scope if provided.
   *      e. Update source.
   *      f. Persist and return the merged rule.
   *   5. If no similar rule found:
   *      a. Generate new UUID for the rule.
   *      b. Create new PreferenceRule with provided fields.
   *      c. Use provided timestamp or current time.
   *      d. Use provided timesApplied or default to 0.
   *      e. Add to rules array.
   *      f. Persist and return the new rule.
   *
   * Parameters:
   *   @param {NewPreferenceRule} rule — Rule to add or merge.
   *
   * Returns:
   *   @returns {Promise<PreferenceRule>} — The added or merged rule.
   *
   * Dependencies:
   *   - load — reads the preferences file.
   *   - save — persists the updated file.
   *   - textSimilarity — detects duplicate rules.
   *   - higherConfidence — merges confidence levels.
   *   - SIMILARITY_THRESHOLD — threshold for deduplication.
   *
   * Dependants:
   *   - PatternExtractor — saves learned rules from task experiences.
   *   - Memory routes — allows manual rule creation/updates.
   * </Summary>
   */
  add = async (rule: NewPreferenceRule): Promise<PreferenceRule> => {
    // Step 1: Load the preferences file from disk
    const preferencesFile = await this.load();
    // Step 2: Trim and sanitize the rule text and topics
    const sanitizedText = rule.text.trim();
    const sanitizedTopics = rule.topics
      .map((topic) => topic.trim())
      .filter((topic) => topic.length > 0);

    // Step 3: Iterate through existing rules to check for similarity
    for (
      let ruleIndex = 0;
      ruleIndex < preferencesFile.rules.length;
      ruleIndex++
    ) {
      const existingRule = preferencesFile.rules[ruleIndex];
      if (
        textSimilarity(sanitizedText, existingRule.text) >= SIMILARITY_THRESHOLD
      ) {
        // Step 4a: Merge: increment usage and update metadata
        existingRule.timesApplied += 1;
        existingRule.confidence = higherConfidence(
          rule.confidence,
          existingRule.confidence,
        );
        existingRule.timestamp = new Date().toISOString();
        if (sanitizedTopics.length > 0) {
          existingRule.topics = sanitizedTopics;
        }
        if (rule.scope.length > 0) {
          existingRule.scope = rule.scope;
        }
        existingRule.source = rule.source;
        // Step 4f: Persist and return the merged rule
        await this.save(preferencesFile);
        return existingRule;
      }
    }

    // Step 5: No similar rule found, create new rule
    // Step 5a: Generate new UUID for the rule
    // Step 5b: Create new PreferenceRule with provided fields
    const newRule: PreferenceRule = {
      id: randomUUID(),
      text: sanitizedText,
      topics: sanitizedTopics,
      scope: rule.scope.length > 0 ? rule.scope : "all",
      confidence: rule.confidence,
      source: rule.source,
      // Step 5c: Use provided timestamp or current time
      timestamp: rule.timestamp ?? new Date().toISOString(),
      // Step 5d: Use provided timesApplied or default to 0
      timesApplied: rule.timesApplied ?? 0,
    };
    // Step 5e: Add to rules array
    preferencesFile.rules.push(newRule);
    // Step 5f: Persist and return the new rule
    await this.save(preferencesFile);
    return newRule;
  };

  /**
   * <Summary>
   * What it does:
   *   Replaces fields on one rule by id.
   *
   * How it does it (step by step):
   *   1. Load the preferences file from disk.
   *   2. Find the rule index by matching id.
   *   3. If not found, return null.
   *   4. If found, merge newRule fields into existing rule (shallow merge).
   *   5. Update timestamp to current time.
   *   6. Persist the updated rules array to disk.
   *   7. Return the updated rule.
   *
   * Parameters:
   *   @param {string} ruleId — ID of the rule to update.
   *   @param {Partial<PreferenceRule>} newRule — Partial rule object with fields to update.
   *
   * Returns:
   *   @returns {Promise<PreferenceRule | null>} — Updated rule or null if not found.
   *
   * Dependencies:
   *   - load — reads the preferences file.
   *   - save — persists the updated file.
   *
   * Dependants:
   *   - Future memory routes — allows manual rule updates.
   * </Summary>
   */
  update = async (
    ruleId: string,
    newRule: Partial<PreferenceRule>,
  ): Promise<PreferenceRule | null> => {
    // Step 1: Load the preferences file from disk
    const preferencesFile = await this.load();
    // Step 2: Find the rule index by matching id
    const ruleIndex = preferencesFile.rules.findIndex(
      (rule) => rule.id === ruleId,
    );
    // Step 3: If not found, return null
    if (ruleIndex === -1) {
      return null;
    }
    // Step 4: If found, merge newRule fields into existing rule (shallow merge)
    const mergedRule: PreferenceRule = {
      ...preferencesFile.rules[ruleIndex],
      ...newRule,
      id: ruleId,
      // Step 5: Update timestamp to current time
      timestamp: new Date().toISOString(),
    };
    preferencesFile.rules[ruleIndex] = mergedRule;
    // Step 6: Persist the updated rules array to disk
    await this.save(preferencesFile);
    // Step 7: Return the updated rule
    return mergedRule;
  };

  /**
   * <Summary>
   * What it does:
   *   Removes all rules whose topics array contains the given topic.
   *
   * How it does it (step by step):
   *   1. Load the preferences file from disk.
   *   2. Normalize topic to lowercase for case-insensitive matching.
   *   3. Record initial rule count.
   *   4. Filter out rules where the topics array includes the specified topic.
   *   5. Calculate how many rules were removed.
   *   6. If any rules were removed, persist the filtered rules array to disk.
   *   7. Return the count of removed rules.
   *
   * Parameters:
   *   @param {string} topic — Topic string to match against rule topics.
   *
   * Returns:
   *   @returns {Promise<number>} — Number of rules deleted.
   *
   * Dependencies:
   *   - load — reads the preferences file.
   *   - save — persists the updated file.
   *
   * Dependants:
   *   - Future memory routes — allows manual rule deletion by topic.
   * </Summary>
   */
  deleteByTopic = async (topic: string): Promise<number> => {
    // Step 1: Load the preferences file from disk
    const preferencesFile = await this.load();
    // Step 2: Normalize topic to lowercase for case-insensitive matching
    const topicToMatch = topic.toLowerCase();
    // Step 3: Record initial rule count
    const initialRuleCount = preferencesFile.rules.length;
    // Step 4: Filter out rules where the topics array includes the specified topic
    preferencesFile.rules = preferencesFile.rules.filter(
      (rule) =>
        !rule.topics.some(
          (ruleTopic) => ruleTopic.toLowerCase() === topicToMatch,
        ),
    );
    // Step 5: Calculate how many rules were removed
    const removedCount = initialRuleCount - preferencesFile.rules.length;
    // Step 6: If any rules were removed, persist the filtered rules array to disk
    if (removedCount > 0) {
      await this.save(preferencesFile);
    }
    // Step 7: Return the count of removed rules
    return removedCount;
  };

  /**
   * <Summary>
   * What it does:
   *   Merges duplicate rules via advisor model when rule count >= 20.
   *
   * How it does it (step by step):
   *   1. Check if ollama and config dependencies are available; throw error if not.
   *   2. Load the preferences file from disk via load().
   *   3. Check if total rule count is >= 20 (CONSOLIDATE_MIN_RULES threshold).
   *   4. If below threshold, return immediately (no work needed).
   *   5. Get advisor model and temperature from config via configManager.
   *   6. Serialize rules to JSON for the advisor prompt.
   *   7. Build messages for advisor: system prompt + rules JSON.
   *   8. Query advisor model via ollamaClient.chat() to consolidate rules.
   *   9. Extract JSON array from advisor response via extractJsonArray() (handles markdown fences).
   *   10. Parse the consolidated rules via JSON.parse().
   *   11. Validate each rule via normaliseRule() and assign new UUIDs and timestamps.
   *   12. Persist the consolidated rules array to disk via save().
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves after consolidation attempt.
   *
   * Dependencies:
   *   - load — reads the preferences file.
   *   - save — persists the consolidated rules.
   *   - IOllamaClient — queries advisor model for consolidation.
   *   - IConfigManager — gets advisor model and temperature.
   *   - extractJsonArray — parses advisor response.
   *   - normaliseRule — validates consolidated rules.
   *   - CONSOLIDATE_MIN_RULES — threshold for consolidation.
   *
   * Dependants:
   *   - Future memory routes — triggers consolidation when rule count is high.
   * </Summary>
   */
  consolidate = async (): Promise<void> => {
    // Step 1: Check if ollama and config dependencies are available
    if (!this.ollama || !this.config) {
      throw new Error(
        "PreferenceStore.consolidate requires ollama and config in constructor deps",
      );
    }
    // Step 2: Load the preferences file from disk
    const preferencesFile = await this.load();
    // Step 3: Check if total rule count is >= 20 (consolidation threshold)
    if (preferencesFile.rules.length < CONSOLIDATE_MIN_RULES) {
      return;
    }

    // Step 5: Get advisor model and temperature from config
    const model = await this.config.getAdvisorModel();
    const temperature = await this.config.getAdvisorTemperature();
    // Step 6: Serialize rules to JSON for the advisor prompt
    const rulesJson = JSON.stringify(preferencesFile.rules, null, 2);
    // Step 7: Build messages for advisor: system prompt + rules JSON
    const messages: Message[] = [
      {
        role: "system",
        content:
          'You merge duplicate preference rules, resolve conflicts, and remove redundant entries. Output ONLY a JSON array of rule objects. Each object must have: text (string), topics (string[]), scope (string), confidence ("high"|"medium"|"low"), source (string). No markdown, no commentary.',
      },
      {
        role: "user",
        content: `Consolidate these rules into a clean non-redundant list:\n${rulesJson}`,
      },
    ];

    // Step 8: Query advisor model to consolidate rules
    const rawAdvisorResponse = await this.ollama.chat(model, messages, {
      temperature,
    });
    let parsedRules: unknown;
    try {
      // Step 9: Extract JSON array from advisor response (handles markdown fences)
      // Step 10: Parse the consolidated rules
      parsedRules = JSON.parse(extractJsonArray(rawAdvisorResponse)) as unknown;
    } catch {
      console.error("[PreferenceStore] consolidate: invalid JSON from advisor");
      return;
    }

    if (!Array.isArray(parsedRules)) {
      return;
    }

    // Step 11: Validate each rule and assign new UUIDs and timestamps
    const consolidatedRules: PreferenceRule[] = [];
    for (const consolidatedRuleItem of parsedRules) {
      const normalizedRule = normaliseRule(consolidatedRuleItem);
      if (!normalizedRule) {
        continue;
      }
      consolidatedRules.push({
        ...normalizedRule,
        id: normalizedRule.id.length > 0 ? normalizedRule.id : randomUUID(),
        timestamp: new Date().toISOString(),
      });
    }

    if (consolidatedRules.length === 0) {
      return;
    }

    // Step 12: Persist the consolidated rules array to disk
    await this.save({ version: 1, rules: consolidatedRules });
  };

  /**
   * <Summary>
   * What it does:
   *   Removes one rule by id when present.
   *
   * How it does it (step by step):
   *   1. Load the preferences file from disk.
   *   2. Record initial rule count.
   *   3. Filter out the rule with matching id.
   *   4. Check if a rule was actually removed (compare array lengths).
   *   5. If a rule was removed, persist the filtered rules array to disk.
   *   6. Return true if a rule was removed, false otherwise.
   *
   * Parameters:
   *   @param {string} id — ID of the rule to remove.
   *
   * Returns:
   *   @returns {Promise<boolean>} — True if rule was removed, false if not found.
   *
   * Dependencies:
   *   - load — reads the preferences file.
   *   - save — persists the updated file.
   *
   * Dependants:
   *   - Future memory routes — allows manual rule deletion.
   * </Summary>
   */
  remove = async (id: string): Promise<boolean> => {
    // Step 1: Load the preferences file from disk
    const preferencesFile = await this.load();
    // Step 2: Record initial rule count
    const initialRuleCount = preferencesFile.rules.length;
    // Step 3: Filter out the rule with matching id
    preferencesFile.rules = preferencesFile.rules.filter(
      (rule) => rule.id !== id,
    );
    // Step 4: Check if a rule was actually removed (compare array lengths)
    if (preferencesFile.rules.length === initialRuleCount) {
      return false;
    }
    // Step 5: If a rule was removed, persist the filtered rules array to disk
    await this.save(preferencesFile);
    // Step 6: Return true if a rule was removed, false otherwise
    return true;
  };

  /**
   * <Summary>
   * What it does:
   *   Deletes all rules from storage.
   *
   * How it does it (step by step):
   *   1. Replace the rules array with an empty array.
   *   2. Persist the empty array to disk (atomic write).
   *   3. Return after write completes.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves after empty file is persisted.
   *
   * Dependencies:
   *   - save — persists the empty file.
   *
   * Dependants:
   *   - Future memory routes — allows manual store reset.
   * </Summary>
   */
  clear = async (): Promise<void> => {
    // Step 1: Replace the rules array with an empty array
    // Step 2: Persist the empty array to disk (atomic write)
    // Step 3: Return after write completes
    await this.save({ version: 1, rules: [] });
  };

  /**
   * <Summary>
   * What it does:
   *   Increments timesApplied for one rule (no-op when id missing).
   *
   * How it does it (step by step):
   *   1. Load the preferences file from disk.
   *   2. Find the rule with matching id.
   *   3. If not found, return immediately (no-op).
   *   4. If found, increment the timesApplied counter by 1.
   *   5. Persist the updated rules array to disk.
   *   6. Return after write completes.
   *
   * Parameters:
   *   @param {string} id — ID of the rule to mark as applied.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves after update attempt.
   *
   * Dependencies:
   *   - load — reads the preferences file.
   *   - save — persists the updated file.
   *
   * Dependants:
   *   - Future ContextBuilder — tracks rule application.
   * </Summary>
   */
  markApplied = async (id: string): Promise<void> => {
    // Step 1: Load the preferences file from disk
    const preferencesFile = await this.load();
    // Step 2: Find the rule with matching id
    const ruleToIncrement = preferencesFile.rules.find(
      (rule) => rule.id === id,
    );
    // Step 3: If not found, return immediately (no-op)
    if (!ruleToIncrement) {
      return;
    }
    // Step 4: If found, increment the timesApplied counter by 1
    ruleToIncrement.timesApplied += 1;
    // Step 5: Persist the updated rules array to disk
    await this.save(preferencesFile);
    // Step 6: Return after write completes
  };

  /**
   * <Summary>
   * What it does:
   *   Loads the preferences file from disk with error handling.
   *
   * How it does it (step by step):
   *   1. Try to read the preferences file from disk using fs.readFile().
   *   2. If file doesn't exist (ENOENT), return empty file (graceful handling).
   *   3. If other error occurs, re-throw to surface the issue.
   *   4. Parse the JSON content using JSON.parse().
   *   5. If JSON is invalid, return empty file (graceful handling).
   *   6. Normalize the file structure via normaliseFile() to ensure valid PreferenceRule objects.
   *   7. Return the normalized PreferencesFile.
   *
   * Returns:
   *   @returns {Promise<PreferencesFile>} — Normalized preferences file with valid rules.
   *
   * Dependencies:
   *   - normaliseFile — validates the file structure.
   *   - node:fs/promises — filesystem operations.
   *
   * Dependants:
   *   - getAll, getForTask, add, update, deleteByTopic, consolidate, remove, clear, markApplied — all read the file.
   * </Summary>
   */
  private load = async (): Promise<PreferencesFile> => {
    let rawFileContents = "";
    try {
      // Step 1: Try to read the preferences file from disk
      rawFileContents = await fs.readFile(this.absPath, "utf-8");
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException).code;
      // Step 2: If file doesn't exist (ENOENT), return empty file (graceful handling)
      if (errorCode === "ENOENT") {
        return { version: 1, rules: [] };
      }
      // Step 3: If other error occurs, re-throw to surface the issue
      throw err;
    }

    let parsedFile: unknown;
    try {
      // Step 4: Parse the JSON content
      parsedFile = JSON.parse(rawFileContents) as unknown;
    } catch {
      // Step 5: If JSON is invalid, return empty file (graceful handling)
      return { version: 1, rules: [] };
    }
    // Step 6: Normalize the file structure to ensure valid PreferenceRule objects
    // Step 7: Return the normalized PreferencesFile
    return normaliseFile(parsedFile);
  };

  /**
   * <Summary>
   * What it does:
   *   Persists the preferences file to disk using atomic write pattern.
   *
   * How it does it (step by step):
   *   1. Extract the directory path from the preferences file path using path.dirname().
   *   2. Ensure the directory exists via ensureDir() (mkdir -p semantics).
   *   3. Generate a unique UUID for the temporary file name using randomUUID().
   *   4. Create a temporary file path in the same directory using path.join().
   *   5. Serialize the preferences file to pretty-printed JSON using JSON.stringify().
   *   6. Add a trailing newline to the JSON string.
   *   7. Write the JSON to the temporary file using fs.writeFile().
   *   8. Atomically rename the temp file to the final destination using fs.rename().
   *      (On POSIX systems, rename() is atomic - readers see either old or complete new file).
   *   9. This guarantees no reader ever sees a partially-written preferences file.
   *
   * Parameters:
   *   @param {PreferencesFile} file — The preferences file object to persist.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves after atomic write completes.
   *
   * Dependencies:
   *   - ensureDir — creates directory if needed.
   *   - node:fs/promises — filesystem operations.
   *   - node:crypto — generates unique temp file names.
   *
   * Dependants:
   *   - add, update, deleteByTopic, consolidate, remove, clear, markApplied — all persist changes.
   * </Summary>
   */
  private save = async (preferencesFile: PreferencesFile): Promise<void> => {
    // Step 1: Extract the directory path from the preferences file path
    const directoryPath = path.dirname(this.absPath);
    // Step 2: Ensure the directory exists (mkdir -p semantics)
    await ensureDir(directoryPath);
    // Step 3: Generate a unique UUID for the temporary file name
    const tempFileUuid = randomUUID();
    // Step 4: Create a temporary file path in the same directory
    const tempFilePath = path.join(
      directoryPath,
      `.preferences-${tempFileUuid}.tmp`,
    );
    // Step 5: Serialize the preferences file to pretty-printed JSON
    const jsonString = JSON.stringify(preferencesFile, null, 2);
    // Step 6: Add a trailing newline to the JSON string
    const jsonPayloadWithNewline = `${jsonString}\n`;
    // Step 7: Write the JSON to the temporary file
    await fs.writeFile(tempFilePath, jsonPayloadWithNewline, "utf-8");
    // Step 8: Atomically rename the temp file to the final destination
    // Step 9: This guarantees no reader ever sees a partially-written preferences file
    await fs.rename(tempFilePath, this.absPath);
  };
}
