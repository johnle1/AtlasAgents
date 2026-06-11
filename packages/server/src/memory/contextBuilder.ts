/**
 * <Summary>
 * What it does:
 *   Builds a bounded plain-English memory header from preference rules and
 *   markdown pattern files for injection ahead of advisor system prompts.
 *
 * How it fits in the system:
 *   Implements IContextBuilder for AdvisorOrchestrator.runTask.
 *
 * Dependencies:
 *   - node:fs/promises, node:path — pattern directory reads.
 *   - ../orchestration/interfaces.js — IPreferenceStore, IConfigManager, IOllamaAdminClient.
 *   - ../ollama/types.js — ModelInfo for context_length extraction.
 *   - ./languageHints.js — user-data/language-hints.json loader.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask.
 * </Summary>
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ModelInfo } from "../ollama/types.js";
import type {
  IConfigManager,
  IContextBuilder,
  IOllamaAdminClient,
  IPreferenceStore,
  LanguageHint,
  PreferenceRule,
} from "../orchestration/interfaces.js";
import { loadLanguageHints } from "./languageHints.js";

// Fallback context window size (tokens) when Ollama does not return context_length.
// Used by resolveContextLength() as the last resort if model metadata is missing or incomplete.
// In normal operation, getContextWindow() queries Ollama.showModel() and dynamically caches the actual value.
const DEFAULT_CONTEXT_WINDOW = 128_000;

const HIGHLIGHT_WORDS = new Set([
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
  "his",
  "her",
  "she",
  "him",
  "they",
  "them",
  "too",
  "per",
  "via",
]);

const TASK_TYPE_WORDS = new Set([
  "refactor",
  "fix",
  "add",
  "test",
  "debug",
  "implement",
  "migrate",
  "update",
  "remove",
  "delete",
  "create",
  "build",
  "review",
  "optimize",
  "document",
  "explain",
]);

/**
 * <Summary>
 * What it does:
 *   Approximates token count from raw string length for budgeting.
 *
 * How it does it (step by step):
 *   1. Check if input text is empty to handle edge case efficiently.
 *   2. Calculate estimated tokens using simplified character-to-token ratio.
 *   3. Round up the result to ensure conservative budget estimates.
 *
 * Parameters:
 *   @param {string} inputText — Text content to measure and estimate tokens for.
 *
 * Returns:
 *   @returns {number} — Estimated token count (>= 0).
 *
 * Note:
 *   Uses 1 token per 4 characters as a co mmon LLM tokenizer approximation.
 *   This is a rough estimate and may vary by actual tokenizer implementation.
 *
 * Dependants:
 *   - ContextBuilder.build — for calculating context budget consumption.
 * </Summary>
 */
const approxTokens = (inputText: string): number => {
  // Step 1: Check if input text is empty
  // Empty strings require 0 tokens; return early to avoid unnecessary calculation
  if (inputText.length === 0) {
    return 0;
  }

  // Step 2: Estimate tokens using simplified character-to-token ratio
  // Most LLM tokenizers approximate 1 token per 4 characters
  // This is a rough but reasonable heuristic for budget planning
  const estimatedTokens = inputText.length / 4;

  // Step 3: Round up the result to ensure conservative budget estimates
  // Math.ceil() ensures we never underestimate token cost when budgeting
  // Example: "hello" = 5 chars / 4 = 1.25 tokens → rounded to 2 tokens
  return Math.ceil(estimatedTokens);
};

/**
 * <Summary>
 * What it does:
 *   Tokenises a task string into a deduped lowercase keyword set with language
 *   and task-type tags when detected.
 *
 * How it does it (step by step):
 *   1. Convert task text to lowercase for case-insensitive matching.
 *   2. Split into word tokens using regex (preserving programming symbols).
 *   3. Create output Set to accumulate unique keywords (auto-deduplicates).
 *   4. Filter and add general keywords (skip short words and filler words).
 *   5. Match language/framework hints and add their tags.
 *   6. Match task type words and add them to the set.
 *   7. Return the deduplicated set of all keywords found.
 *
 * Parameters:
 *   @param {string} taskText — Raw user task (may have mixed case, punctuation).
 *   @param {LanguageHint[]} languageHints — Rows from user-data/language-hints.json.
 *
 * Returns:
 *   @returns {Set<string>} — Keywords for overlap scoring against preference rules.
 *
 * Dependants:
 *   - ContextBuilder.build — to filter and match preference rules.
 * </Summary>
 */
const extractKeywords = (
  taskText: string,
  languageHints: LanguageHint[],
): Set<string> => {
  // Step 1: Convert task text to lowercase for case-insensitive matching
  // Allows "TypeScript", "typescript", "TYPESCRIPT" to all match the same rules
  // Example: "Refactor TypeScript+React code" → "refactor typescript+react code"
  const lowercaseTaskText = taskText.toLowerCase();

  // Step 2: Split into word tokens using regex pattern
  // Pattern /[^a-z0-9+#]+/g means "split on anything NOT in [a-z0-9+#]"
  // This preserves programming symbols: C++, C#, TypeScript+React
  // Removes punctuation and whitespace as delimiters
  // Example: "Refactor TypeScript+React code" → ["refactor", "typescript+react", "code"]
  const wordTokens = lowercaseTaskText.split(/[^a-z0-9+#]+/g);

  // Step 3: Create output Set to accumulate unique keywords
  // Set automatically deduplicates; if "test" appears twice, stored only once
  // This prevents bias from keywords that appear multiple times
  const extractedKeywords = new Set<string>();

  // Step 4a: Filter and add general keywords from word tokens
  for (const word of wordTokens) {
    // Step 4a-i: Skip very short words (noise filtering)
    // Words < 3 characters like "a", "to", "is" are too generic
    // They don't help identify task type or programming language
    if (word.length < 3) {
      continue;
    }

    // Step 4a-ii: Skip common filler words
    // HIGHLIGHT_WORDS contains: "the", "and", "for", "with", "is", "are", etc.
    // These grammatical words don't indicate task type or domain
    if (HIGHLIGHT_WORDS.has(word)) {
      continue;
    }

    // Step 4a-iii: Add the meaningful keyword to the set
    // Example keywords: "refactor", "typescript", "react", "component", "login"
    extractedKeywords.add(word);
  }

  // Step 5: Match language/framework hints and add their tags
  // LanguageHints are from user-data/language-hints.json
  // Each hint: { needle: "typescript", tag: "typescript" } or { needle: "c++", tag: "cpp" }
  for (const { needle, tag } of languageHints) {
    // Step 5a: Check if the hint's search term appears anywhere in the task
    // Example: if hint.needle = "typescript", check if lowercaseTaskText contains "typescript"
    if (lowercaseTaskText.includes(needle.toLowerCase())) {
      // Step 5b: Add the topic tag to allow rule matching
      // Tags are usually the language/framework name in lowercase
      // This enables rules tagged with "typescript" to match this task
      extractedKeywords.add(tag);
    }
  }

  // Step 6: Match task type words and add them to the set
  // TASK_TYPE_WORDS contains: "refactor", "fix", "add", "test", "debug", "implement", etc.
  for (const taskTypeWord of TASK_TYPE_WORDS) {
    // Step 6a: Check if task type word appears anywhere in the task text
    // These indicate the kind of work being requested
    if (lowercaseTaskText.includes(taskTypeWord)) {
      // Step 6b: Add the task type word
      // This enables rules tagged with "refactor" to match refactoring tasks
      extractedKeywords.add(taskTypeWord);
    }
  }

  // Step 7: Return the deduplicated set of all keywords found
  // This set is used in ContextBuilder.build() to find matching preference rules
  // Example: { "refactor", "login", "component", "typescript", "react" }
  return extractedKeywords;
};

/**
 * <Summary>
 * What it does:
 *   Resolves context window tokens from Ollama model metadata with a fallback chain.
 *
 * How it does it (step by step):
 *   1. Check for top-level context_length property (most direct case).
 *   2. Validate it's a positive finite number.
 *   3. If top-level found, convert to integer and return immediately.
 *   4. Fallback: Search nested model_info object for *context_length keys.
 *   5. Verify model_info exists and is an object.
 *   6. Iterate through all properties looking for keys ending with "context_length".
 *   7. If nested context_length found, convert to integer and return.
 *   8. Final fallback: Return DEFAULT_CONTEXT_WINDOW (128k) when nothing available.
 *
 * Parameters:
 *   @param {ModelInfo} ollamaModelInfo — Parsed /api/show response from Ollama.
 *
 * Returns:
 *   @returns {number} — Context length in tokens (always positive).
 *
 * Dependants:
 *   - ContextBuilder.getContextWindow — used to determine token budget.
 * </Summary>
 */
const resolveContextLength = (ollamaModelInfo: ModelInfo): number => {
  // Step 1-2: Try to extract context_length from top-level of response
  // This is the most direct/common case from Ollama API
  // Validate three conditions:
  //   - typeof ollamaModelInfo.context_length === "number" (is it a number type?)
  //   - Number.isFinite(ollamaModelInfo.context_length) (not NaN or Infinity?)
  //   - ollamaModelInfo.context_length > 0 (is it a positive value?)
  if (
    typeof ollamaModelInfo.context_length === "number" &&
    Number.isFinite(ollamaModelInfo.context_length) &&
    ollamaModelInfo.context_length > 0
  ) {
    // Step 3: If top-level found, convert to integer and return immediately
    // Math.floor() removes any decimal places (e.g., 8192.5 → 8192)
    // Return early to avoid unnecessary nested searches
    return Math.floor(ollamaModelInfo.context_length);
  }

  // Step 4-5: Fallback to nested model_info object
  // Some Ollama models store metadata nested inside a model_info property
  // Example: { model_info: { "llama2.context_length": 4096 } }
  const nestedModelInfo = ollamaModelInfo.model_info;

  // Step 5: Verify model_info exists and is an object
  // Check both existence (truthy) and type (must be object)
  // This prevents errors when trying to iterate non-objects
  if (nestedModelInfo && typeof nestedModelInfo === "object") {
    // Step 6: Iterate through all properties of nested model_info
    // Object.entries() returns [[key, value], [key, value], ...]
    // This allows us to search all properties for context_length patterns
    for (const [propertyKey, propertyValue] of Object.entries(
      nestedModelInfo,
    )) {
      // Step 6a: Check if property key ends with "context_length"
      // This matches: "context_length", "llama2.context_length", "model.context_length", etc.
      // Flexible matching handles different Ollama model formats
      // Step 6b: Validate the value is a positive finite number (same checks as top-level)
      if (
        propertyKey.endsWith("context_length") &&
        typeof propertyValue === "number" &&
        Number.isFinite(propertyValue) &&
        propertyValue > 0
      ) {
        // Step 7: If nested context_length found, convert to integer and return
        // Math.floor() ensures consistent integer result
        return Math.floor(propertyValue);
      }
    }
  }

  // Step 8: Final fallback when nothing found in response
  // Return hardcoded 128k tokens if all extraction attempts failed
  // This ensures the system always has SOME budget instead of crashing
  // 128k is a conservative estimate for most modern LLMs
  // Used as default when Ollama model metadata is missing or incomplete
  return DEFAULT_CONTEXT_WINDOW;
};

/**
 * <Summary>
 * What it does:
 *   Sorts preference rules by popularity (usage frequency) then creation time.
 *
 * How it does it (step by step):
 *   1. Create shallow copy of input array to avoid mutation.
 *   2. Compare rules pairwise using sort comparator function.
 *   3. Primary sort: rules with higher timesApplied come first (descending order).
 *   4. Tiebreaker: if usage counts are equal, sort by timestamp ascending (older first).
 *   5. Return new sorted array with original unchanged.
 *
 * Parameters:
 *   @param {PreferenceRule[]} rules — Unsorted preference rules to prioritize.
 *
 * Returns:
 *   @returns {PreferenceRule[]} — New sorted array (original unmodified).
 *
 * Note:
 *   Stable sort by creation date ensures predictable ordering when frequencies match.
 *   Most-used rules appear first; within same usage level, older rules come first.
 *
 * Dependants:
 *   - ContextBuilder.build — uses to prioritize which rules fit in token budget.
 * </Summary>
 */
const sortRules = (rules: PreferenceRule[]): PreferenceRule[] => {
  // Step 1: Create shallow copy of input array
  // [...rules] spreads all elements into a new array reference
  // Calling .sort() on the copy prevents mutating the original input parameter
  // Example: sortRules([rule1, rule2]) returns new array; original unaffected
  return [...rules].sort((ruleA, ruleB) => {
    // Step 2: Compare usage frequency (timesApplied count)
    // Check if the two rules have different usage counts before falling back to date
    if (ruleB.timesApplied !== ruleA.timesApplied) {
      // Step 3: Primary sort by usage frequency descending (higher count = higher priority)
      // Calculation: ruleB.timesApplied - ruleA.timesApplied
      // Positive result: ruleB sorts before ruleA (ruleB used more often, more proven)
      // Negative result: ruleA sorts before ruleB (ruleA used more often, more proven)
      // Example: ruleB=5 uses, ruleA=2 uses → return 3 (positive, ruleB comes first)
      // Example: ruleB=1 use,  ruleA=4 uses → return -3 (negative, ruleA comes first)
      // This ensures most-frequently-applied rules get included in the context first
      return ruleB.timesApplied - ruleA.timesApplied;
    }

    // Step 4: Tiebreaker: sort by creation time ascending (older rules first)
    // Only reaches here if both rules have identical timesApplied counts
    // localeCompare() performs lexicographic (date-string) comparison
    // Returns: -1 (ruleA earlier), 0 (equal), or 1 (ruleA later)
    // Example: ruleA.timestamp="2025-01-01", ruleB.timestamp="2025-01-05"
    //          "2025-01-01".localeCompare("2025-01-05") = -1 (ruleA sorts first)
    // This ensures FIFO-like ordering as tiebreaker for reproducible results
    return ruleA.timestamp.localeCompare(ruleB.timestamp);
  });
};

type PatternFile = { name: string; body: string };

export class ContextBuilder implements IContextBuilder {
  private readonly prefs: IPreferenceStore;

  private readonly ollama: IOllamaAdminClient;

  private readonly config: IConfigManager;

  private readonly rootDir: string;

  /** Fraction of the model context window reserved for memory header (default 20%). */
  private readonly maxContextBudget = 0.2;

  private readonly contextWindowCache = new Map<string, number>();

  /**
   * @param {{ prefs: IPreferenceStore; ollama: IOllamaAdminClient; config: IConfigManager; rootDir?: string }} deps — Collaborators for rules, model metadata, and active advisor model.
   */
  constructor(deps: {
    prefs: IPreferenceStore;
    ollama: IOllamaAdminClient;
    config: IConfigManager;
    rootDir?: string;
  }) {
    this.prefs = deps.prefs;
    this.ollama = deps.ollama;
    this.config = deps.config;
    this.rootDir = deps.rootDir ?? process.cwd();
  }

  /**
   * <Summary>
   * What it does:
   *   Invalidates cached context window sizes so the next build() re-queries Ollama.
   *
   * How it does it (step by step):
   *   1. Check if model parameter is provided or omitted (clear mode).
   *   2a. If model is omitted (undefined), clear the entire cache map.
   *   2b. If model is provided, delete only that specific model's cached entry.
   *
   * Parameters:
   *   @param {string} [modelTag] — Optional Ollama model tag to invalidate; omit to clear all.
   *
   * Returns:
   *   void — mutates internal contextWindowCache map only.
   *
   * Example Scenarios:
   *   - clearContextWindowCache() → clears all cached windows (e.g., after /set advisor)
   *   - clearContextWindowCache("llama2") → removes only llama2's entry; others remain cached
   *   - Useful when model context changes or advisor model switches
   *
   * Dependants:
   *   - Future ConfigManager.setAdvisorModel or memory routes.
   * </Summary>
   */
  clearContextWindowCache = (modelTag?: string): void => {
    // Step 1: Check if model parameter is provided
    // If modelTag is undefined, we're in "clear all" mode
    if (modelTag === undefined) {
      // Step 2a: Clear entire cache when no specific model provided
      // this.contextWindowCache.clear() removes all cached entries
      // Next call to getContextWindow will re-query Ollama for any model
      // Example: After switching advisor models, clears stale cached values
      this.contextWindowCache.clear();
      return;
    }

    // Step 2b: Delete only the specified model's cached entry
    // When modelTag is provided, selectively remove just that model's window
    // Other models' cached values remain available
    // Example: If llama2 context changed, clear just its cache entry
    this.contextWindowCache.delete(modelTag);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns the advisor model's context window in tokens with caching to avoid repeated Ollama queries.
   *
   * How it does it (step by step):
   *   1. Check if the model's context window is already cached locally.
   *   2. If cached, return the stored value immediately (fast path).
   *   3. If not cached, query Ollama API via /api/show endpoint for model metadata.
   *   4. Extract context window tokens from the response using resolveContextLength.
   *   5. Store the extracted window size in cache for future calls.
   *   6. Return the resolved context window to caller.
   *
   * Parameters:
   *   @param {string} modelTag — Ollama model tag (e.g., "llama2", "neural-chat") from IConfigManager.getAdvisorModel.
   *
   * Returns:
   *   @returns {Promise<number>} — Context length in tokens (always positive).
   *
   * Performance Note:
   *   - First call: async (queries Ollama), ~100-500ms depending on network
   *   - Subsequent calls: sync cached lookup, microseconds
   *   - Cache invalidated by clearContextWindowCache() when needed
   *
   * Dependencies:
   *   - IOllamaAdminClient.showModel — queries /api/show when not cached.
   *   - resolveContextLength — extracts window from metadata response.
   *
   * Dependants:
   *   - ContextBuilder.build — to calculate token budget for memory header.
   * </Summary>
   */
  private getContextWindow = async (modelTag: string): Promise<number> => {
    // Step 1: Check if the model's context window is already cached locally
    // contextWindowCache is a Map<string, number> storing model → window entries
    // Fast lookup prevents unnecessary Ollama queries for same model
    if (this.contextWindowCache.has(modelTag)) {
      // Step 2: If cached, return the stored value immediately (fast path)
      // Non-null assertion (!) is safe because we just checked .has()
      // Example: getContextWindow("llama2") when llama2:8192 already cached → return 8192 instantly
      return this.contextWindowCache.get(modelTag)!;
    }

    // Step 3: If not cached, query Ollama API for model metadata
    // this.ollama.showModel(modelTag) makes HTTP GET /api/show?name=modelTag
    // Returns full ModelInfo object with context_length and other metadata
    // Example: showModel("llama2") → { context_length: 4096, model_info: { ... } }
    const ollamaModelMetadata = await this.ollama.showModel(modelTag);

    // Step 4: Extract context window tokens from the response
    // resolveContextLength implements fallback chain (top-level → nested → 128k default)
    // Always returns a positive number; never throws
    // Example: resolveContextLength({ context_length: 4096 }) → 4096
    const resolvedContextWindow = resolveContextLength(ollamaModelMetadata);

    // Step 5: Store the extracted window size in cache for future calls
    // contextWindowCache.set(modelTag, window) avoids re-querying for this model
    // Subsequent calls will hit the fast path (Step 2)
    // Example: cache now contains { "llama2": 4096 }
    this.contextWindowCache.set(modelTag, resolvedContextWindow);

    // Step 6: Return the resolved context window to caller
    // ContextBuilder.build() uses this to calculate token budget
    // Example: ContextBuilder.build() → gets 4096 tokens total → 20% = 819 token budget
    return resolvedContextWindow;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Loads rules and pattern markdown, filters by task keywords, sorts, budgets
   *   estimated tokens, and returns a three-section English header string.
   *
   * How it does it (step by step):
   *   1. Determine token budget as 20% of active advisor model's context window.
   *   2. Load all data: preference rules, pattern files, language hints.
   *   3. Extract keywords (language and task-type aware) from task text.
   *   4. Identify relevant rules: task-matched rules, or universal fallback.
   *   5. Identify task-type-specific fix rules.
   *   6. Sort all rule candidates by usage frequency then creation date.
   *   7. Greedily fill token budget: add preference rules first (with tracking).
   *   8. Add fix rules second (skip already-used rules).
   *   9. Add project pattern files third (with smart truncation if needed).
   *   10. Format three sections: [User preferences], [Known fixes], [Project context].
   *   11. Return formatted header or empty string if nothing fits.
   *
   * Parameters:
   *   @param {string} taskText — Original user task string.
   *
   * Returns:
   *   @returns {Promise<string>} — Header text or empty string when nothing fits.
   *
   * Token Budget Strategy:
   *   - Greedy first-fit allocation: prioritizes high-value (frequently-used) rules
   *   - Tracks used rule IDs to prevent duplication across sections
   *   - Smart pattern truncation: removes 16 chars at a time until fits
   *   - Preserves readability: only truncates if content is >20% useful
   *
   * Dependencies:
   *   - IPreferenceStore.getAll — persisted rules.
   *   - IConfigManager.getAdvisorModel, IOllamaAdminClient.showModel — dynamic context budget.
   *   - fs.readdir / fs.readFile — pattern files.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask.
   * </Summary>
   */
  build = async (taskText: string): Promise<string> => {
    // ===== STEP 1: Setup & Budget Calculation =====
    // Step 1a: Get active advisor model name from config
    const advisorModelTag = await this.config.getAdvisorModel();

    // Step 1b: Query Ollama for this model's context window (cached)
    // Example: llama2 → 4096 tokens
    const totalContextTokens = await this.getContextWindow(advisorModelTag);

    // Step 1c: Reserve 20% of context for memory header (80% stays for response)
    // Example: 4096 tokens total → 819 token budget for memory header
    const maxHeaderTokenBudget = Math.floor(
      totalContextTokens * this.maxContextBudget,
    );

    // ===== STEP 2: Load All Required Data =====
    // Step 2a: Load all saved preference rules from store
    const allPreferenceRules = await this.prefs.getAll();

    // Step 2b: Load markdown pattern files from user-data/patterns directory
    // Returns array of { name, body } pairs
    const patternFiles = await this.loadPatterns();

    // Step 2c: Load language hints for keyword matching
    // Maps language names to their tags (TypeScript → typescript, etc.)
    const languageHints = await loadLanguageHints(this.rootDir);

    // ===== STEP 3: Extract Task Keywords =====
    // Step 3a: Parse task text into language and task-type aware keywords
    // Example: "Refactor login React component" → { refactor, login, react, component }
    const taskKeywords = extractKeywords(taskText, languageHints);

    // ===== STEP 4: Identify Relevant Rules (Two-Level Strategy) =====
    // Step 4a: Find rules tagged with task keywords (best match)
    // Example: rules tagged ["react", "refactor"] match this task
    const primaryMatchedRules = allPreferenceRules.filter((preferenceRule) =>
      preferenceRule.topics.some((ruleTopic) =>
        taskKeywords.has(ruleTopic.toLowerCase()),
      ),
    );

    // Step 4b: Find universal rules (no tags, always applicable)
    // These are fallback rules like "Always include tests"
    const universalRules = allPreferenceRules.filter(
      (preferenceRule) => preferenceRule.topics.length === 0,
    );

    // Step 4c: Use primary rules if found, else use universal, else empty
    // Fallback strategy ensures we always try to include SOMETHING relevant
    const selectedPreferenceRules =
      primaryMatchedRules.length > 0
        ? primaryMatchedRules
        : universalRules.length > 0
          ? universalRules
          : [];

    // ===== STEP 5: Identify Task-Type-Specific Fixes =====
    // Step 5a: Extract only task-type keywords from all keywords
    // Example: task keywords = { refactor, login, react } → task types = { refactor }
    const taskTypeKeywordsOnly = [...taskKeywords].filter((keyword) =>
      TASK_TYPE_WORDS.has(keyword),
    );

    // Step 5b: Create set for fast lookup of task types
    const taskTypeSet = new Set(taskTypeKeywordsOnly);

    // Step 5c: Find all rules tagged with task types
    // Example: rules tagged ["refactor"] → "known fixes for refactoring"
    const taskTypeFixRules = allPreferenceRules.filter((preferenceRule) =>
      preferenceRule.topics.some((ruleTopic) =>
        taskTypeSet.has(ruleTopic.toLowerCase()),
      ),
    );

    // ===== STEP 6: Sort Rule Candidates by Value =====
    // Step 6a: Sort preference rules (most-used first, then oldest first)
    const sortedPreferenceRules = sortRules(selectedPreferenceRules);

    // Step 6b: Sort fix rules (most-used first, then oldest first)
    const sortedFixRules = sortRules(taskTypeFixRules);

    // ===== STEP 7-9: Greedy Token Budget Filling =====
    // Initialize state tracking
    let tokensUsedSoFar = 0;
    const usedRuleIdsAlready = new Set<string>();

    // ===== ROUND 1: Preference Rules =====
    // Step 7: Add preference rules greedily until budget exhausted
    const preferenceRuleLines: string[] = [];

    for (const preferenceRule of sortedPreferenceRules) {
      // Step 7a: Format rule as bullet point
      const ruleLine = `- ${preferenceRule.text}`;

      // Step 7b: Estimate tokens needed for this line (includes newline)
      const tokenCostForLine = approxTokens(`${ruleLine}\n`);

      // Step 7c: Check if this rule fits within remaining budget
      // If budget exhausted, stop adding rules
      if (tokensUsedSoFar + tokenCostForLine > maxHeaderTokenBudget) {
        // Budget exhausted; skip remaining rules
        break;
      }

      // Step 7d: Rule fits! Add to output and update tracking
      tokensUsedSoFar += tokenCostForLine;
      preferenceRuleLines.push(ruleLine);
      usedRuleIdsAlready.add(preferenceRule.id);
    }

    // ===== ROUND 2: Fix Rules =====
    // Step 8: Add task-type-specific fix rules (skip duplicates)
    const fixRuleLines: string[] = [];

    for (const fixRule of sortedFixRules) {
      // Step 8a: Skip if this rule already added in preference round
      // Prevents "Use TypeScript" from appearing twice
      if (usedRuleIdsAlready.has(fixRule.id)) {
        continue;
      }

      // Step 8b: Format rule as bullet point
      const fixRuleLine = `- ${fixRule.text}`;

      // Step 8c: Estimate token cost
      const tokenCostForFixRule = approxTokens(`${fixRuleLine}\n`);

      // Step 8d: Check if fits in remaining budget
      if (tokensUsedSoFar + tokenCostForFixRule > maxHeaderTokenBudget) {
        // Budget exhausted
        break;
      }

      // Step 8e: Rule fits! Add to output and update tracking
      tokensUsedSoFar += tokenCostForFixRule;
      fixRuleLines.push(fixRuleLine);
      usedRuleIdsAlready.add(fixRule.id);
    }

    // ===== ROUND 3: Pattern Files =====
    // Step 9: Add markdown pattern files with smart truncation
    const projectContextBlocks: string[] = [];

    for (const patternFile of patternFiles) {
      // Step 9a: Construct pattern block with filename header
      const patternHeader = `- ${patternFile.name}\n`;
      const fullPatternBlock = `${patternHeader}${patternFile.body}`;
      const fullPatternTokenCost = approxTokens(`${fullPatternBlock}\n\n`);

      // Step 9b: If complete pattern fits, add it whole
      if (tokensUsedSoFar + fullPatternTokenCost <= maxHeaderTokenBudget) {
        projectContextBlocks.push(fullPatternBlock.trimEnd());
        tokensUsedSoFar += fullPatternTokenCost;
        continue;
      }

      // Step 9c: Pattern too large; check if worth truncating
      // Minimum threshold: only truncate if >20% of pattern will fit
      const minimumKeepThreshold = 0.2;
      if (fullPatternTokenCost === 0) {
        // Empty pattern (shouldn't happen)
        continue;
      }

      // Step 9d: Calculate remaining budget
      const remainingTokenBudget = maxHeaderTokenBudget - tokensUsedSoFar;

      // Step 9e: Check if remaining budget is worth spending on truncation
      // Only truncate if we can fit at least 20% of the pattern
      if (remainingTokenBudget < fullPatternTokenCost * minimumKeepThreshold) {
        // Too little budget; skip this pattern
        continue;
      }

      // Step 9f: Smart truncation: calculate how much body text fits
      const headerTokenCost = approxTokens(patternHeader);
      const bodyTokenBudget = Math.max(
        0,
        remainingTokenBudget - headerTokenCost,
      );

      // Step 9g: Iteratively trim pattern body until it fits
      // Removes 16 chars at a time (conservative)
      let truncatedBody = patternFile.body;
      while (
        truncatedBody.length > 0 &&
        approxTokens(`${patternHeader}${truncatedBody}`) > remainingTokenBudget
      ) {
        // Remove 16 chars from end and try again
        truncatedBody = truncatedBody.slice(
          0,
          Math.max(0, truncatedBody.length - 16),
        );
      }

      // Step 9h: Skip if truncation left nothing meaningful
      if (truncatedBody.trim().length === 0) {
        continue;
      }

      // Step 9i: Add truncated pattern with marker
      const truncatedPatternBlock =
        `${patternHeader}${truncatedBody}`.trimEnd();
      projectContextBlocks.push(
        `${truncatedPatternBlock}\n[truncated to fit context budget]`,
      );
      tokensUsedSoFar = maxHeaderTokenBudget; // Mark budget as exhausted
      break; // Can only fit one truncated pattern
    }

    // ===== STEP 10: Format Three-Section Header =====
    // Step 10a: Build sections array
    const headerSections: string[] = [];

    // Step 10b: Add [User preferences] section if any rules found
    if (preferenceRuleLines.length > 0) {
      headerSections.push(
        `[User preferences]\n${preferenceRuleLines.join("\n")}`,
      );
    }

    // Step 10c: Add [Known fixes] section if any task-type fixes found
    if (fixRuleLines.length > 0) {
      headerSections.push(
        `[Known fixes for this task type]\n${fixRuleLines.join("\n")}`,
      );
    }

    // Step 10d: Add [Project context] section if any patterns found
    if (projectContextBlocks.length > 0) {
      headerSections.push(
        `[Project context]\n${projectContextBlocks.join("\n\n")}`,
      );
    }

    // ===== STEP 11: Return Formatted Header =====
    // Step 11a: Return empty string if no sections generated
    if (headerSections.length === 0) {
      return "";
    }

    // Step 11b: Join sections with double newlines and add trailing newline
    // Example output:
    //   [User preferences]
    //   - Use TypeScript strict mode
    //
    //   [Project context]
    //   - Architecture
    //     ...
    return `${headerSections.join("\n\n")}\n`;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Reads every *.md file from user-data/patterns directory relative to rootDir.
   *
   * How it does it (step by step):
   *   1. Construct absolute path to patterns directory from rootDir.
   *   2. Attempt to read directory entries with defensive error handling.
   *   3. If directory not found (ENOENT), return empty array (graceful fallback).
   *   4. If other error occurs, re-throw to propagate unexpected failures.
   *   5. Filter directory entries to only markdown (.md) files.
   *   6. For each markdown file: construct absolute path and read UTF-8 content.
   *   7. Accumulate results as { name, body } objects in output array.
   *   8. Return array of pattern files or empty array if directory missing.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<PatternFile[]>} — File name and UTF-8 body pairs.
   *
   * Dependants:
   *   - ContextBuilder.build.
   * </Summary>
   */
  /**
   * @async
   * <Summary>
   * What it does:
   *   Reads every *.md file from user-data/patterns directory relative to rootDir.
   *
   * How it does it (step by step):
   *   1. Construct absolute path to patterns directory from rootDir.
   *   2. Attempt to read directory entries with defensive error handling.
   *   3. If directory not found (ENOENT), return empty array (graceful fallback).
   *   4. If other error occurs, re-throw to propagate unexpected failures.
   *   5. Filter directory entries to only markdown (.md) files.
   *   6. For each markdown file: construct absolute path and read UTF-8 content.
   *   7. Accumulate results as { name, body } objects in output array.
   *   8. Return array of pattern files or empty array if directory missing.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<PatternFile[]>} — File name and UTF-8 body pairs.
   *
   * Error Handling Strategy:
   *   - ENOENT (directory missing): Expected case when patterns not yet created. Returns []
   *     to allow system to work without errors. User can create directory later.
   *   - Other errors (permission denied, I/O error): Re-thrown immediately to surface
   *     serious problems that prevent system functioning.
   *
   * Example Paths:
   *   - this.rootDir = "/Users/john/project"
   *   - patternDirectoryPath = "/Users/john/project/user-data/patterns"
   *   - markdownFilename = "architecture.md"
   *   - absoluteFilePath = "/Users/john/project/user-data/patterns/architecture.md"
   *   - Return: [{ name: "architecture.md", body: "# Architecture...\n..." }]
   *
   * Dependants:
   *   - ContextBuilder.build — to populate [Project context] section of memory header.
   * </Summary>
   */
  private loadPatterns = async (): Promise<PatternFile[]> => {
    // Step 1: Construct absolute path to patterns directory from rootDir
    // path.join() ensures correct path separators for the OS (/ on Unix, \ on Windows)
    // Example: /Users/john/project + "user-data" + "patterns"
    //          → /Users/john/project/user-data/patterns
    const patternDirectoryPath = path.join(
      this.rootDir,
      "user-data",
      "patterns",
    );

    // Step 2a: Attempt to read directory entries with defensive error handling
    // fs.readdir() lists all files and folders in the directory
    // Example return: ["architecture.md", "api-design.md", "testing.md", ".gitkeep"]
    let directoryEntries: string[] = [];
    try {
      directoryEntries = await fs.readdir(patternDirectoryPath);
    } catch (err) {
      // Step 3: If directory not found (ENOENT), return empty array (graceful fallback)
      // ENOENT error code means "Error NO ENTry"—directory or file doesn't exist
      // This is expected when user hasn't created patterns directory yet
      // Returning [] allows build() to continue without patterns (less optimal but functional)
      const errorCode = (err as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        // Directory not found; gracefully return empty array
        // User can create user-data/patterns directory later and it will be picked up
        return [];
      }

      // Step 4: If other error occurs, re-throw to propagate unexpected failures
      // Other error codes (EACCES=permission denied, EIO=I/O error, etc.) are serious
      // These should surface immediately rather than fail silently
      // Example: If /user-data/patterns exists but isn't readable, we want to know
      throw err;
    }

    // Step 5: Filter directory entries to only markdown (.md) files
    // Ignores non-markdown files (config files, node_modules, .DS_Store, etc.)
    // Uses .toLowerCase() to handle "Architecture.MD" and "NOTES.MD" case-insensitively
    // Example: ["architecture.md", "api-design.md", ".gitkeep"]
    //          → ["architecture.md", "api-design.md"]
    const markdownFilenames = directoryEntries.filter((markdownFilename) =>
      markdownFilename.toLowerCase().endsWith(".md"),
    );

    // Step 6a: For each markdown file: construct absolute path and read UTF-8 content
    // Create output array to accumulate all loaded pattern files
    const loadedPatternFiles: PatternFile[] = [];

    // Step 6b: Loop through each markdown filename and load its content
    for (const markdownFilename of markdownFilenames) {
      // Step 6c: Construct absolute file path by joining directory with filename
      // Example: /Users/john/project/user-data/patterns + architecture.md
      //          → /Users/john/project/user-data/patterns/architecture.md
      const absoluteFilePath = path.join(
        patternDirectoryPath,
        markdownFilename,
      );

      // Step 6d: Read file content as UTF-8 string
      // fs.readFile returns Buffer; "utf-8" encoding converts to string automatically
      // Throws if file cannot be read (permission denied, deleted between readdir and here, etc.)
      const fileContent = await fs.readFile(absoluteFilePath, "utf-8");

      // Step 7: Accumulate results as { name, body } objects in output array
      // Push new PatternFile object with original filename and loaded content
      // Example: { name: "architecture.md", body: "# Architecture\n\nSystem overview..." }
      loadedPatternFiles.push({ name: markdownFilename, body: fileContent });
    }

    // Step 8: Return array of pattern files or empty array if directory missing
    // Return value is used by build() to populate [Project context] section
    // Example return: [
    //   { name: "architecture.md", body: "# Architecture\n..." },
    //   { name: "api-design.md", body: "# API Design\n..." }
    // ]
    return loadedPatternFiles;
  };
}
