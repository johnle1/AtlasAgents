/**
 * <Summary>
 * What it does:
 *   Builds a bounded plain-English memory header from preference rules and
 *   markdown pattern files for injection ahead of advisor system prompts.
 *
 * How it fits in the system:
 *   Implements IContextBuilder for AdvisorOrchestrator.runTask.
 *   Constructs context-aware memory headers that provide relevant project
 *   information, user preferences, and known fixes to improve agent performance.
 *   Uses token budgeting to ensure headers fit within model context windows.
 * </Summary>
 */

// ===== FILESYSTEM IMPORTS =====
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== OLLAMA TYPE IMPORTS =====
import type { ModelInfo } from "../../ollama/types.js";

// ===== ORCHESTRATION INTERFACE IMPORTS =====
import type {
  IConfigManager,
  IContextBuilder,
  IOllamaAdminClient,
  IPreferenceStore,
  ISessionManager,
  LanguageHint,
  PreferenceRule,
} from "../../orchestration/interfaces.js";

// ===== CONTEXT BUILDING IMPORTS =====
import { loadLanguageHints } from "./languageHints.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  HIGHLIGHT_WORDS,
  TASK_TYPE_WORDS,
} from "./contextConstants.js";
import {
  approxTokens,
  extractKeywords,
  resolveContextLength,
  sortRules,
} from "./contextHelpers.js";

// ===== LOCAL TYPE DEFINITIONS =====
/**
 * Represents a markdown pattern file loaded from the patterns directory.
 * Contains the filename and the file content for inclusion in context headers.
 */
type PatternFile = { name: string; body: string };

/**
 * <Summary>
 * What it does:
 *   Builds context-aware memory headers for LLM prompts using preference rules,
 *   project patterns, and session history within token budget constraints.
 *
 * How it fits in the system:
 *   Implements IContextBuilder interface for the orchestration layer. Provides
 *   intelligent context construction that:
 *   - Extracts relevant preferences based on task keywords
 *   - Includes project-specific patterns from markdown files
 *   - Respects model context window limits with smart token budgeting
 *   - Caches model context windows to avoid repeated API calls
 *   - Supports model-specific context optimization
 * </Summary>
 */
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
   * Configuration manager for accessing advisor model settings.
   * Provides the active advisor model and configuration parameters.
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
   * <Summary>
   * What it does:
   *   Initializes ContextBuilder with required service dependencies.
   *
   * How it does it (step by step):
   *   1. Extract dependencies from the deps object.
   *   2. Store preference store for rule retrieval.
   *   3. Store Ollama client for model metadata queries.
   *   4. Store config manager for advisor model access.
   *   5. Set root directory with fallback to current working directory.
   *   6. Store optional session manager for session history.
   *
   * Parameters:
   *   @param dependencies - Collaborators for rules, model metadata, and active advisor model.
   * </Summary>
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
    // Step 1: Extract and store preference store
    this.preferenceStore = dependencies.prefs;

    // Step 2: Extract and store Ollama client
    this.ollamaClient = dependencies.ollama;

    // Step 3: Extract and store config manager
    this.configManager = dependencies.config;

    // Step 4: Set root directory with fallback to current working directory
    this.rootDirectory = dependencies.rootDir ?? process.cwd();

    // Step 5: Store optional session manager
    this.sessionManager = dependencies.session;
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
   *   @param modelTag - Ollama model tag (e.g., "llama2", "neural-chat") from IConfigManager.getAdvisorModel.
   *
   * Returns:
   *   @returns Context length in tokens (always positive).
   *
   * Performance Note:
   *   - First call: async (queries Ollama), ~100-500ms depending on network
   *   - Subsequent calls: sync cached lookup, microseconds
   *   - Cache invalidated by clearContextWindowCache() when needed
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
    let ollamaModelMetadata;
    try {
      ollamaModelMetadata = await this.ollamaClient.showModel(modelTag);
    } catch {
      this.contextWindowCache.set(modelTag, DEFAULT_CONTEXT_WINDOW);
      return DEFAULT_CONTEXT_WINDOW;
    }

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
   *   @param taskText - Original user task string.
   *
   * Returns:
   *   @returns Header text or empty string when nothing fits.
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
    advisorModelOverride?: string,
  ): Promise<string> => {
    // ===== STEP 1: Setup & Budget Calculation =====
    // Step 1a: Use task advisor model when provided, else server config
    const advisorModelTag =
      advisorModelOverride?.trim() ||
      (await this.configManager.getAdvisorModel());

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
   *   @returns File name and UTF-8 body pairs.
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
   *   @returns File name and UTF-8 body pairs.
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
   * </Summary>
   */
  private loadPatterns = async (): Promise<PatternFile[]> => {
    // Step 1: Construct absolute path to patterns directory from rootDirectory
    // path.join() ensures correct path separators for the OS (/ on Unix, \ on Windows)
    // Example: /Users/john/project + "user-data" + "patterns"
    //          → /Users/john/project/user-data/patterns
    const patternDirectoryPath = path.join(
      this.rootDirectory,
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
