/**
 * Builds bounded memory headers from preferences and patterns for LLM context.
 *
 * @remarks
 * Implements the {@link IContextBuilder} interface used by {@link SubagentOrchestrator.runTask}.
 * Constructs intelligent context headers that inject relevant user preferences,
 * project patterns, and task-specific fixes into LLM prompts.
 *
 * **Header Structure:**
 * 1. **[Prior session]** — Codebase snapshot and recent task summaries
 * 2. **[User preferences]** — Rules matched to current task keywords
 * 3. **[Known fixes]** — Task-type-specific fixes and workarounds
 * 4. **[Project context]** — Markdown patterns with smart truncation
 *
 * **Token Budgeting:**
 * - Reserves 20% of model context window for memory header
 * - Greedily fills budget: preferences first, then fixes, then patterns
 * - Smart truncation for large patterns (removes 16 chars at a time)
 * - Caches model context windows to avoid repeated Ollama queries
 *
 * @example
 * ```ts
 * const builder = new ContextBuilder({
 *   prefs: preferenceStore,
 *   ollama: ollamaClient,
 *   config: configManager,
 *   session: sessionManager
 * });
 *
 * const header = await builder.build("Refactor login component in React");
 * // Returns formatted string with user preferences, fixes, and patterns
 * ```
 */

// ===== FILESYSTEM IMPORTS =====
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== ORCHESTRATION INTERFACE IMPORTS =====
import type {
  IConfigManager,
  IContextBuilder,
  IOllamaAdminClient,
  IPreferenceStore,
  ISessionManager,
} from "../../orchestration/interfaces.js";

// ===== TYPE IMPORTS =====
import type { PatternFile } from "../types.js";

// ===== CONTEXT BUILDING IMPORTS =====
import { loadLanguageHints } from "./languageHints.js";
import { DEFAULT_CONTEXT_WINDOW, TASK_TYPE_WORDS } from "./contextConstants.js";
import {
  approxTokens,
  extractKeywords,
  resolveContextLength,
  sortRules,
} from "./contextHelpers.js";

export class ContextBuilder implements IContextBuilder {
  /**
   * Preference store for retrieving user rules and preferences.
   * Provides access to persisted user-specific configuration and learned patterns.
   */
  private readonly preferenceStore: IPreferenceStore;

  /**
   * Ollama client for querying model metadata and context windows.
   * Used to determine token limits for different LLM models.
   */
  private readonly ollamaClient: IOllamaAdminClient;

  /**
   * Configuration manager for accessing subsubagent model settings.
   * Provides the active subsubagent model and configuration parameters.
   */
  private readonly configManager: IConfigManager;

  /**
   * Root directory for the project/workspace operations.
   * Used as base path for loading patterns and language hints.
   */
  private readonly rootDirectory: string;

  /**
   * Optional session manager for including session history in context.
   * If provided, adds prior session context to memory headers.
   */
  private readonly sessionManager?: ISessionManager;

  /**
   * Fraction of the model context window reserved for memory header (default 20%).
   * The remaining 80% is reserved for the actual task response.
   * Example: 4096 token context → 819 tokens for memory header.
   */
  private readonly maxContextBudget = 0.2;

  /**
   * Cache mapping model tags to their context window sizes in tokens.
   * Avoids repeated Ollama API calls for the same model.
   * Key: model tag (e.g., "llama2"), Value: context window in tokens.
   */
  private readonly contextWindowCache = new Map<string, number>();

  /**
   * Initializes the context builder with required service dependencies.
   *
   * @param dependencies - Services for rules, model metadata, and configuration
   * @param dependencies.prefs - Preference store for user rules
   * @param dependencies.ollama - Ollama client for model metadata
   * @param dependencies.config - Configuration manager for model settings
   * @param dependencies.rootDir - Optional root directory (defaults to cwd)
   * @param dependencies.session - Optional session manager for context history
   */
  constructor(
    readonly dependencies: {
      prefs: IPreferenceStore;
      ollama: IOllamaAdminClient;
      config: IConfigManager;
      rootDir?: string;
      session?: ISessionManager;
    },
  ) {
    this.preferenceStore = dependencies.prefs;
    this.ollamaClient = dependencies.ollama;
    this.configManager = dependencies.config;
    this.rootDirectory = dependencies.rootDir ?? process.cwd();
    this.sessionManager = dependencies.session;
  }

  /**
   * Invalidates cached context window sizes.
   *
   * @param modelTag - Optional model tag to invalidate. Omit to clear entire cache.
   *
   * @remarks
   * When called without argument, clears all cached context windows so the next
   * `build()` call re-queries Ollama for all models. Useful after switching subsubagent models.
   *
   * When called with a model tag, only that model's cache entry is removed,
   * allowing selective invalidation if model context changes.
   */
  clearContextWindowCache = (modelTag?: string): void => {
    if (modelTag === undefined) {
      this.contextWindowCache.clear();
      return;
    }
    this.contextWindowCache.delete(modelTag);
  };

  /**
   * Gets the model's context window size with caching.
   *
   * @param modelTag - Ollama model tag (e.g., "llama2", "gemma3:27b")
   * @returns Context window size in tokens (always positive)
   *
   * @remarks
   * First call queries Ollama (~100-500ms), subsequent calls use cached value (microseconds).
   * Caching prevents expensive repeated queries for the same model.
   * Falls back to DEFAULT_CONTEXT_WINDOW if query fails or metadata incomplete.
   * Cache can be invalidated via `clearContextWindowCache()`.
   */
  private getContextWindow = async (modelTag: string): Promise<number> => {
    if (this.contextWindowCache.has(modelTag)) {
      return this.contextWindowCache.get(modelTag)!;
    }

    let ollamaModelMetadata;
    try {
      ollamaModelMetadata = await this.ollamaClient.showModel(modelTag);
    } catch {
      this.contextWindowCache.set(modelTag, DEFAULT_CONTEXT_WINDOW);
      return DEFAULT_CONTEXT_WINDOW;
    }

    const resolvedContextWindow = resolveContextLength(ollamaModelMetadata);
    this.contextWindowCache.set(modelTag, resolvedContextWindow);
    return resolvedContextWindow;
  };

  /**
   * Builds a context header from preferences, fixes, and patterns.
   *
   * @param taskText - Original user task description
   * @param subagentModelOverride - Optional model override (default: configured subsubagent model)
   * @returns Header text with preferences, fixes, and patterns; empty string if nothing fits
   *
   * @remarks
   * Constructs a bounded memory header by:
   * 1. Reserving 20% of model context window for the header
   * 2. Loading preferences, patterns, and language hints
   * 3. Extracting task keywords (language and task-type aware)
   * 4. Matching relevant rules and fixes by keywords
   * 5. Greedily filling token budget: preferences → fixes → patterns
   * 6. Formatting four sections: [Prior session], [User preferences], [Known fixes], [Project context]
   *
   * Token budgeting is greedy: highest-value content (most-used rules) is prioritized.
   * Large patterns are smart-truncated (16 chars at a time) to fit within budget.
   *
   * Token Budget Strategy:
   *   - Greedy first-fit allocation: prioritizes high-value (frequently-used) rules
   *   - Tracks used rule IDs to prevent duplication across sections
   *   - Smart pattern truncation: removes 16 chars at a time until fits
   *   - Preserves readability: only truncates if content is >20% useful
   * </Summary>
   */
  build = async (
    taskText: string,
    subagentModelOverride?: string,
  ): Promise<string> => {
    // ===== STEP 1: Setup & Budget Calculation =====
    // Step 1a: Use task subsubagent model when provided, else server config
    const subagentModelTag =
      subagentModelOverride?.trim() ||
      (await this.configManager.getSubagentModel());

    // Step 1b: Query Ollama for this model's context window (cached)
    // Example: llama2 → 4096 tokens
    const totalContextTokens = await this.getContextWindow(subagentModelTag);

    // Step 1c: Reserve 20% of context for memory header (80% stays for response)
    // Example: 4096 tokens total → 819 token budget for memory header
    const maxHeaderTokenBudget = Math.floor(
      totalContextTokens * this.maxContextBudget,
    );

    // ===== STEP 2: Load All Required Data =====
    // Step 2a: Load all saved preference rules from store
    const allPreferenceRules = await this.preferenceStore.getAll();

    // Step 2b: Load markdown pattern files from user-data/patterns directory
    // Returns array of { name, body } pairs
    const patternFiles = await this.loadPatterns();

    // Step 2c: Load language hints for keyword matching
    // Maps language names to their tags (TypeScript → typescript, etc.)
    const languageHints = await loadLanguageHints(this.rootDirectory);

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

    // ===== STEP 10: Format Header Sections =====
    const headerSections: string[] = [];

    // Includes codebase exploration snapshot and per-task summaries from current.md.
    if (this.sessionManager) {
      const sessionText = (await this.sessionManager.read()).trim();
      if (sessionText.length > 0) {
        const sessionBlock = `[Prior session]\n${sessionText}`;
        const sessionCost = approxTokens(`${sessionBlock}\n\n`);
        if (tokensUsedSoFar + sessionCost <= maxHeaderTokenBudget) {
          headerSections.push(sessionBlock);
          tokensUsedSoFar += sessionCost;
        }
      }
    }

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
   * Loads markdown pattern files from the patterns directory.
   *
   * @returns Array of pattern files with name and body, or empty array if directory not found
   * @throws Filesystem errors other than ENOENT (directory missing)
   *
   * @remarks
   * Reads all `*.md` files from `user-data/patterns/` (case-insensitive).
   * Returns empty array if directory doesn't exist (graceful fallback for new setups).
   * Re-throws permission errors and other serious I/O errors to surface problems.
   *
   * Each pattern file becomes a separate context section entry with smart truncation
   * to fit within the token budget.
   */
  private loadPatterns = async (): Promise<PatternFile[]> => {
    const patternDirectoryPath = path.join(
      this.rootDirectory,
      "user-data",
      "patterns",
    );

    let directoryEntries: string[] = [];
    try {
      directoryEntries = await fs.readdir(patternDirectoryPath);
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        return [];
      }
      throw err;
    }

    // Filter to markdown files only (case-insensitive)
    const markdownFilenames = directoryEntries.filter((markdownFilename) =>
      markdownFilename.toLowerCase().endsWith(".md"),
    );

    const loadedPatternFiles: PatternFile[] = [];
    for (const markdownFilename of markdownFilenames) {
      const absoluteFilePath = path.join(
        patternDirectoryPath,
        markdownFilename,
      );
      const fileContent = await fs.readFile(absoluteFilePath, "utf-8");
      loadedPatternFiles.push({ name: markdownFilename, body: fileContent });
    }

    return loadedPatternFiles;
  };
}
