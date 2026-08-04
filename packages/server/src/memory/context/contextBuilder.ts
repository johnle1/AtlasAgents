/**
 * Builds bounded memory headers from preferences and patterns for LLM context.
 *
 * @remarks
 * Implements the {@link IContextBuilder} interface used by {@link AgentOrchestrator.runTask}.
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
 * - Greedily fills budget by value density: preferences first, then fixes,
 *   then patterns, skipping over (not stopping at) rules that don't fit so
 *   smaller lower-priority rules later in the list still get a chance
 * - Smart truncation for large patterns (line-boundary cut, computed
 *   directly from the token budget — see {@link truncateToTokenBudget})
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
  LanguageHint,
  PreferenceRule,
} from "../../orchestration/interfaces.js";

// ===== TYPE IMPORTS =====
import type { PatternFile } from "../types.js";

// ===== CONTEXT BUILDING IMPORTS =====
import { LANGUAGE_HINTS_FILENAME, loadLanguageHints } from "./languageHints.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  TASK_TYPE_WORDS,
} from "./contextConstants.js";
import {
  approxTokens,
  extractKeywords,
  sortRules,
  truncateToTokenBudget,
} from "./contextHelpers.js";
import { ContextWindowResolver } from "../../ollama/contextWindow.js";
import { logger } from "../../utils/logger.js";

export class ContextBuilder implements IContextBuilder {
  /**
   * Preference store for retrieving user rules and preferences.
   * Provides access to persisted user-specific configuration and learned patterns.
   */
  private readonly preferenceStore: IPreferenceStore;

  /**
   * Configuration manager for accessing agent model settings.
   * Provides the active agent model and configuration parameters.
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
   * Resolves each model's effective runtime context window (`num_ctx`),
   * caching the expensive `showModel()` lookup per tag. The single source of
   * truth for both the wire value sent to Ollama and the number this class
   * budgets a fraction of — see {@link ContextWindowResolver} for why those
   * must never be computed separately.
   */
  private readonly contextWindowResolver: ContextWindowResolver;

  /**
   * Per-file cache of pattern markdown content, keyed by filename, gated on
   * mtime. Unlike skills or preferences (app-synced, invalidated on write),
   * `user-data/patterns/*.md` files are hand-edited by the user with no
   * corresponding write-path hook in this server — mtime comparison is the
   * only available invalidation signal, so a stat-per-file is paid every
   * `build()` call but a `readFile` only for files that actually changed.
   */
  private readonly patternFileCache = new Map<string, { mtimeMs: number; body: string }>();

  /**
   * Cache of parsed `user-data/language-hints.json`, gated on the file's
   * mtime for the same reason as {@link patternFileCache} — it's a
   * user-editable file with no write-path hook to invalidate from.
   */
  private languageHintsCache: { mtimeMs: number; hints: LanguageHint[] } | null = null;

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
    this.configManager = dependencies.config;
    this.rootDirectory = dependencies.rootDir ?? process.cwd();
    this.sessionManager = dependencies.session;
    this.contextWindowResolver = new ContextWindowResolver({
      ollama: dependencies.ollama,
      config: dependencies.config,
    });
  }

  /**
   * Invalidates cached context window sizes.
   *
   * @param modelTag - Optional model tag to invalidate. Omit to clear entire cache.
   *
   * @remarks
   * When called without argument, clears all cached context windows so the next
   * `build()` call re-queries Ollama for all models. Useful after switching agent models.
   *
   * When called with a model tag, only that model's cache entry is removed,
   * allowing selective invalidation if model context changes.
   */
  clearContextWindowCache = (modelTag?: string): void => {
    this.contextWindowResolver.clearCache(modelTag);
  };

  /**
   * Resolves a model's effective runtime context window (`num_ctx`).
   *
   * @param modelTag - Ollama model tag (e.g., "llama2", "gemma3:27b")
   * @returns The `num_ctx` to use for this model — see {@link ContextWindowResolver}.
   *
   * @remarks
   * Exposed so callers constructing an Ollama request for this same model
   * (e.g. the orchestrator, before running the agent) can send the identical
   * `num_ctx` this class budgets the memory header against. Delegates to the
   * shared {@link ContextWindowResolver}, so the value and its caching are
   * identical to what `build()` uses internally.
   */
  resolveNumCtx = async (modelTag: string): Promise<number> => {
    return this.contextWindowResolver.resolve(modelTag);
  };

  /**
   * Clears the cached, parsed `language-hints.json`, forcing the next
   * `build()`/`detectStack()` call to re-stat (and, if changed, re-read) it.
   *
   * @remarks
   * Not wired to any automatic invalidation event — provided for symmetry
   * with {@link clearContextWindowCache} and for tests. In normal operation
   * the mtime check inside {@link loadLanguageHintsCached} already detects
   * hand-edits to the file without needing this to be called.
   */
  clearLanguageHintsCache = (): void => {
    this.languageHintsCache = null;
  };

  /**
   * Clears the cached pattern file bodies, forcing the next `build()` to
   * re-stat every file in `user-data/patterns/`.
   *
   * @remarks
   * See {@link clearLanguageHintsCache} — provided for symmetry/tests; the
   * per-file mtime check already detects hand-edits without this being called.
   */
  clearPatternCache = (): void => {
    this.patternFileCache.clear();
  };

  /**
   * Loads and parses `user-data/language-hints.json`, reusing the cached
   * result when the file's mtime hasn't changed since the last load.
   *
   * @returns Parsed language hints (empty array if the file is missing).
   *
   * @remarks
   * Delegates the actual read+parse to {@link loadLanguageHints} (unchanged
   * logic) — this only adds a `stat`-gate in front of it, mirroring the
   * `contextWindowCache` pattern above but keyed on file mtime instead of a
   * model tag, since there's no explicit "hints changed" event to invalidate on.
   */
  private loadLanguageHintsCached = async (): Promise<LanguageHint[]> => {
    const filePath = path.join(this.rootDirectory, "user-data", LANGUAGE_HINTS_FILENAME);

    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        this.languageHintsCache = null;
        return [];
      }
      throw err;
    }

    if (this.languageHintsCache && this.languageHintsCache.mtimeMs === mtimeMs) {
      return this.languageHintsCache.hints;
    }

    const hints = await loadLanguageHints(this.rootDirectory);
    this.languageHintsCache = { mtimeMs, hints };
    return hints;
  };

  /**
   * Detects a single dominant language/framework stack from task text, for
   * passing to `SkillManager.selectForTask`'s `detectedStack` hint.
   *
   * @param taskText - Original user task description.
   * @returns The first matching language hint's tag (e.g. `"python"`), or
   *   `undefined` if no hint's needle appears in the task text.
   *
   * @remarks
   * Reuses the same cached `language-hints.json` that keyword extraction
   * already loads for `build()`, rather than introducing a second detection
   * mechanism. First match wins — hint file order acts as priority when the
   * task text could plausibly match more than one stack.
   */
  detectStack = async (taskText: string): Promise<string | undefined> => {
    const languageHints = await this.loadLanguageHintsCached();
    const lowerTaskText = taskText.toLowerCase();
    for (const hint of languageHints) {
      if (lowerTaskText.includes(hint.needle.toLowerCase())) {
        return hint.tag;
      }
    }
    return undefined;
  };

  /**
   * Builds a context header from preferences, fixes, and patterns.
   *
   * @param taskText - Original user task description
   * @param agentModelOverride - Optional model override (default: configured agent model)
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
   * Token budgeting is greedy: highest-density content (usage per token spent)
   * is prioritized, but a rule that doesn't fit is skipped rather than
   * ending the round, so smaller lower-priority rules later in the sorted
   * list still get a chance at leftover budget.
   * Large patterns are smart-truncated (single line-boundary cut, computed
   * directly from the budget) to fit within budget.
   *
   * Token Budget Strategy:
   *   - Greedy allocation by value density (usage per token), skipping
   *     rules that don't fit rather than stopping at the first miss
   *   - Tracks used rule IDs to prevent duplication across sections
   *   - Smart pattern truncation: one direct cut to the token budget,
   *     backed off to the nearest line boundary
   *   - Preserves readability: only truncates if content is >20% useful
   * </Summary>
   */
  build = async (
    taskText: string,
    agentModelOverride?: string,
    agentProviderOverride?: string,
  ): Promise<string> => {
    // ===== STEP 1: Setup & Budget Calculation =====
    // Step 1a: Use task agent model when provided, else server config
    const agentModelTag =
      agentModelOverride?.trim() ||
      (await this.configManager.getAgentModel());

    // Step 1b: Size the budget against this model's real context window.
    //
    // `num_ctx` is an Ollama runtime knob and only means something for a role
    // actually on the "ollama" provider — the same guard `orchestratorPipeline`
    // applies before sending it on the wire. Asking `resolveNumCtx` about an
    // OpenAI-compatible tag queries the *local* Ollama for a model it has
    // never pulled: the `/api/show` throws, the resolver falls back to
    // OLLAMA_DEFAULT_NUM_CTX (4096), and the header budget silently collapses
    // to ~819 tokens for a model whose window is typically 128k. That
    // fallback is deliberately uncached, so it also paid a failing round-trip
    // on every build. Non-Ollama providers expose no trained context length
    // at all (`SingleModelAdmin.showModel` returns name + capabilities only),
    // so DEFAULT_CONTEXT_WINDOW is the same assumption `resolveContextLength`
    // already makes for a model with no metadata.
    const agentProviderName =
      agentProviderOverride?.trim() ||
      (await this.configManager.getAgentProvider());
    const totalContextTokens =
      agentProviderName === "ollama"
        ? await this.resolveNumCtx(agentModelTag)
        : DEFAULT_CONTEXT_WINDOW;

    // Step 1c: Reserve configured fraction of context for memory header
    // (remainder stays for response). Read fresh from config on every call
    // (not cached) so `/set maxContextBudget` takes effect immediately.
    const configuredMaxContextBudget = await this.configManager.getMaxContextBudget();
    const maxHeaderTokenBudget = Math.floor(
      totalContextTokens * configuredMaxContextBudget,
    );

    // ===== STEP 2: Load All Required Data =====
    // Step 2a: Load all saved preference rules from store
    const allPreferenceRules = await this.preferenceStore.getAll();

    // Step 2b: Load markdown pattern files from user-data/patterns directory
    // Returns array of { name, body } pairs
    const patternFiles = await this.loadPatterns();

    // Step 2c: Load language hints for keyword matching (mtime-cached — see
    // loadLanguageHintsCached; re-parses only when the file actually changed)
    // Maps language names to their tags (TypeScript → typescript, etc.)
    const languageHints = await this.loadLanguageHintsCached();

    // ===== STEP 3: Extract Task Keywords =====
    // Step 3a: Parse task text into language and task-type aware keywords
    // Example: "Refactor login React component" → { refactor, login, react, component }
    const taskKeywords = extractKeywords(taskText, languageHints);

    // ===== STEP 4-5: Identify Relevant Rules (Single Pass) =====
    // Step 4a: Task-type keywords, needed before the pass below since fix-rule
    // membership depends on it.
    // Example: task keywords = { refactor, login, react } → task types = { refactor }
    const taskTypeSet = new Set(
      [...taskKeywords].filter((keyword) => TASK_TYPE_WORDS.has(keyword)),
    );

    // Step 4b: Partition every rule into up to three groups in one pass,
    // instead of three separate O(R) filter() calls over allPreferenceRules
    // (each re-lowercasing every rule's topics independently). A rule's
    // scope is checked once and gates membership in all three groups: a
    // rule scoped to a specific language/domain (e.g. "python") only
    // applies when the task text itself matched that scope as a keyword
    // (via extractKeywords' language-hint tags); "all" always applies. This
    // is what stops a Python style rule from being injected into a
    // TypeScript task — previously `scope` was persisted but never read
    // here at all.
    const primaryMatchedRules: PreferenceRule[] = [];
    const universalRules: PreferenceRule[] = [];
    const taskTypeFixRules: PreferenceRule[] = [];

    for (const preferenceRule of allPreferenceRules) {
      const scopeApplies =
        preferenceRule.scope === "all" ||
        taskKeywords.has(preferenceRule.scope.toLowerCase());
      if (!scopeApplies) {
        continue;
      }

      const topicsLower = preferenceRule.topics.map((topic) => topic.toLowerCase());

      // Example: rules tagged ["react", "refactor"] match this task
      if (topicsLower.some((topic) => taskKeywords.has(topic))) {
        primaryMatchedRules.push(preferenceRule);
      }
      // Fallback rules with no tags at all, e.g. "Always include tests"
      if (preferenceRule.topics.length === 0) {
        universalRules.push(preferenceRule);
      }
      // Example: rules tagged ["refactor"] → "known fixes for refactoring"
      if (topicsLower.some((topic) => taskTypeSet.has(topic))) {
        taskTypeFixRules.push(preferenceRule);
      }
    }

    // Step 4c: Use primary rules if found, else use universal, else empty
    // Fallback strategy ensures we always try to include SOMETHING relevant
    const selectedPreferenceRules =
      primaryMatchedRules.length > 0
        ? primaryMatchedRules
        : universalRules.length > 0
          ? universalRules
          : [];

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

      // Step 7c: Check if this rule fits within remaining budget.
      // Continue rather than break: sortedPreferenceRules is sorted by
      // value density, but a later, smaller rule can still fit in leftover
      // budget even if this one didn't.
      if (tokensUsedSoFar + tokenCostForLine > maxHeaderTokenBudget) {
        continue;
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

      // Step 8d: Check if fits in remaining budget. Continue, not break —
      // same reasoning as Step 7c: a smaller rule later in the sorted list
      // may still fit even if this one doesn't.
      if (tokensUsedSoFar + tokenCostForFixRule > maxHeaderTokenBudget) {
        continue;
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

      // Step 9f-g: Smart truncation — cut to the largest prefix (backed off
      // to a line boundary) that fits header + body within the remaining
      // budget. O(1) arithmetic via the exact inverse of approxTokens,
      // instead of trimming 16 characters at a time in a loop.
      const truncatedBody = truncateToTokenBudget(
        patternFile.body,
        patternHeader,
        remainingTokenBudget,
      );

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

    // Step 10e: Mark every rule that actually made it into the header as
    // applied, in one batched write — this is what makes `timesApplied`
    // (and therefore sortRules' density ranking) mean something over time.
    // Previously nothing in the codebase called markApplied in production,
    // so this counter never moved. Best-effort: a failure here shouldn't
    // fail the whole build() call just because bookkeeping couldn't persist.
    if (usedRuleIdsAlready.size > 0) {
      try {
        await this.preferenceStore.markManyApplied([...usedRuleIdsAlready]);
      } catch (error) {
        logger.error({ error }, "ContextBuilder: markManyApplied failed");
      }
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
   * Loads markdown pattern files from the patterns directory, reusing cached
   * bodies for files whose mtime hasn't changed since the last load.
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
   *
   * **Caching:** still `stat`s every file on every call (there's no cheaper
   * way to detect a hand-edit without a filesystem watcher), but only
   * `readFile`s ones whose `mtimeMs` changed since the last call — on a
   * quiet patterns directory this turns "read every pattern file every
   * task" into "stat every pattern file every task, read only changed
   * ones." Cache entries for files removed from disk are dropped so the
   * cache can't grow unboundedly across churn.
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
        this.patternFileCache.clear();
        return [];
      }
      throw err;
    }

    // Filter to markdown files only (case-insensitive)
    const markdownFilenames = directoryEntries.filter((markdownFilename) =>
      markdownFilename.toLowerCase().endsWith(".md"),
    );

    // Drop cache entries for files no longer present, so a deleted-then-
    // recreated-with-different-content file can never be served stale, and
    // the cache doesn't grow unboundedly across pattern-file churn.
    const currentFilenames = new Set(markdownFilenames);
    for (const cachedFilename of this.patternFileCache.keys()) {
      if (!currentFilenames.has(cachedFilename)) {
        this.patternFileCache.delete(cachedFilename);
      }
    }

    const loadedPatternFiles: PatternFile[] = [];
    for (const markdownFilename of markdownFilenames) {
      const absoluteFilePath = path.join(
        patternDirectoryPath,
        markdownFilename,
      );
      const mtimeMs = (await fs.stat(absoluteFilePath)).mtimeMs;
      const cached = this.patternFileCache.get(markdownFilename);

      if (cached && cached.mtimeMs === mtimeMs) {
        loadedPatternFiles.push({ name: markdownFilename, body: cached.body });
        continue;
      }

      const fileContent = await fs.readFile(absoluteFilePath, "utf-8");
      this.patternFileCache.set(markdownFilename, { mtimeMs, body: fileContent });
      loadedPatternFiles.push({ name: markdownFilename, body: fileContent });
    }

    return loadedPatternFiles;
  };
}
