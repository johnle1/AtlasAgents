/**
 * Preference rules and pattern storage for learning agent behavior from user feedback.
 *
 * @remarks
 * Captures user preferences (coding style, language choice, patterns) extracted from
 * successful tasks, user edits, and explicit direction. These rules are ranked by
 * confidence and applied as context hints during task planning and execution.
 */

/**
 * Confidence level for a learned or explicit preference rule.
 *
 * @remarks
 * - `high` — User-facing explicit preference or proven by repeated successful outcomes
 * - `medium` — Learned from user fixes or edits with moderate consistency
 * - `low` — Inferred from single outcome or needs validation
 */
export type PreferenceConfidence = "high" | "medium" | "low";

/**
 * Provenance of a preference rule (where it came from).
 *
 * @remarks
 * - `explicit` — Directly entered by the user (highest trust)
 * - `outcome` — Extracted from successful task completions
 * - `fix` — Learned from user corrections or edits to agent output
 * - `style` — Pattern extracted from code style in user edits
 */
export type PreferenceSource = "explicit" | "outcome" | "fix" | "style";

/**
 * One substring match that adds a topic tag when found in the task text.
 *
 * @remarks
 * Used by extractKeywords in contextBuilder.ts.
 * Produced by user-data/language-hints.json or packaged default-data copy.
 */
export interface LanguageHint {
  /** Lowercase-friendly substring to search for in the task text. */
  needle: string;

  /** Topic tag stored on preference rules and used for overlap filtering. */
  tag: string;
}

/**
 * A persisted user preference rule.
 *
 * @remarks
 * Represents one learnable or explicit user preference that guides agent behavior.
 * Rules are ranked by confidence and times applied, and matched to tasks by topic overlap.
 *
 * @example
 * ```ts
 * {
 *   id: "pref-abc123",
 *   text: "Always use async/await, never return Promises directly",
 *   topics: ["javascript", "async"],
 *   scope: "javascript",
 *   confidence: "high",
 *   source: "explicit",
 *   timestamp: "2024-01-15T10:30:00Z",
 *   timesApplied: 12
 * }
 * ```
 */
export interface PreferenceRule {
  /** Stable unique identifier for this rule. */
  id: string;

  /** Human-readable text describing the preference (e.g., `"Use Tailwind CSS over Bootstrap"`). */
  text: string;

  /** Topic tags for matching against task keywords (e.g., `["styling", "frontend"]`). */
  topics: string[];

  /** Language or domain scope (e.g., `"all"`, `"javascript"`, `"python"`, `"react"`). */
  scope: string;

  /** How much to trust this rule (`"high"`, `"medium"`, or `"low"`). */
  confidence: PreferenceConfidence;

  /** Origin of the rule (`"explicit"` from user, `"outcome"` from success, `"fix"` from edits, `"style"` from patterns). */
  source: PreferenceSource;

  /** ISO-8601 timestamp of creation or last update. */
  timestamp: string;

  /** Count of how many times this rule has been applied (higher = more useful). */
  timesApplied: number;
}

/**
 * Input shape for PreferenceStore.add before id and timestamp are assigned.
 */
export type NewPreferenceRule = Omit<
  PreferenceRule,
  "id" | "timestamp" | "timesApplied"
> &
  Partial<Pick<PreferenceRule, "timestamp" | "timesApplied">>;

/**
 * Persistent storage for user preference rules and learned patterns.
 *
 * @remarks
 * Manages file-backed rule storage with deduplication, topic-based retrieval,
 * and consolidation. Rules are matched to tasks by topic overlap and ranked by
 * confidence and application frequency.
 *
 * **Primary consumers:**
 * - **ContextBuilder** — queries rules matching task keywords.
 * - **Router memory endpoints** — CRUD operations for user rule management.
 * - **ExperienceRecorder** — adds learned rules from completed tasks.
 *
 * @example
 * ```ts
 * const store = createPreferenceStore();
 * await store.add({
 *   text: "Use TypeScript strict mode",
 *   topics: ["typescript"],
 *   scope: "typescript",
 *   confidence: "high",
 *   source: "explicit"
 * });
 * const rules = await store.getForTask(["typescript", "react"]);
 * ```
 */
export interface IPreferenceStore {
  /**
   * Returns all stored preference rules.
   *
   * @remarks
   * Returns an empty array if the storage file doesn't exist yet.
   * Rules are returned in stable storage order (typically sorted by creation).
   *
   * @returns Array of all preference rules.
   *
   * @example
   * ```ts
   * const allRules = await store.getAll();
   * console.log(`Loaded ${allRules.length} preference rules`);
   * ```
   */
  getAll(): Promise<PreferenceRule[]>;

  /**
   * Adds a new preference rule or merges it with an existing similar rule.
   *
   * @remarks
   * Checks for similar existing rules using Levenshtein similarity (threshold 0.8).
   * If a match is found, merges topics and updates confidence/source rather than
   * creating a duplicate. If the rule is new, assigns a unique ID and timestamp.
   * All changes are persisted immediately.
   *
   * @param rule - Rule fields (omit `id` and `timesApplied`; `timestamp` is auto-assigned if omitted).
   * @returns The persisted rule with all fields (id, timestamp, timesApplied) assigned.
   *
   * @example
   * ```ts
   * const rule = await store.add({
   *   text: "Always use const, never let or var",
   *   topics: ["javascript"],
   *   scope: "javascript",
   *   confidence: "high",
   *   source: "explicit"
   * });
   * console.log(`Added rule ${rule.id}`);
   * ```
   */
  add(rule: NewPreferenceRule): Promise<PreferenceRule>;

  /**
   * Retrieves rules whose topics overlap the given keywords, ranked by frequency.
   *
   * @remarks
   * Used during context building to inject relevant preferences into the agent's
   * system prompt. Results are sorted by `timesApplied` descending (most useful first).
   *
   * @param taskKeywords - Keywords extracted from the task text (e.g., `["typescript", "react"]`).
   * @returns Matching rules sorted by `timesApplied` descending (empty if no matches).
   *
   * @example
   * ```ts
   * const keywords = ["frontend", "react"];
   * const relevant = await store.getForTask(keywords);
   * Returns rules tagged with "frontend" or "react"
   * ```
   */
  getForTask(taskKeywords: Iterable<string>): Promise<PreferenceRule[]>;

  /**
   * Updates one rule by ID with partial fields.
   *
   * @remarks
   * Only specified fields are updated; omitted fields retain their current value.
   * Persists immediately and updates the timestamp if provided. Returns `null` if
   * the rule ID is not found.
   *
   * @param ruleId - ID of the rule to update.
   * @param newRule - Fields to merge/replace.
   * @returns Updated rule with all fields, or `null` if not found.
   *
   * @example
   * ```ts
   * const updated = await store.update("pref-123", { confidence: "high" });
   * if (updated) console.log("Updated confidence");
   * ```
   */
  update(
    ruleId: string,
    newRule: Partial<PreferenceRule>,
  ): Promise<PreferenceRule | null>;

  /**
   * Deletes all rules tagged with a given topic.
   *
   * @remarks
   * Bulk delete by topic — useful for removing domain-specific rules
   * when a language or framework is no longer in use.
   *
   * @param topic - Topic tag to remove (e.g., `"python"`).
   * @returns Count of rules deleted.
   *
   * @example
   * ```ts
   * const deleted = await store.deleteByTopic("deprecated-framework");
   * console.log(`Removed ${deleted} rules`);
   * ```
   */
  deleteByTopic(topic: string): Promise<number>;

  /**
   * Consolidates duplicate rules using the language model for similarity detection.
   *
   * @remarks
   * Called when rule count exceeds ~20 to reduce redundancy. Uses the configured
   * model to identify semantically similar rules and merge them. This is a best-effort
   * cleanup — exact behavior depends on model capability.
   *
   * @throws When the Ollama client or config manager was not injected at construction.
   *
   * @example
   * ```ts
   * const count = await store.getAll();
   * if (count.length >= 20) {
   *   await store.consolidate();
   * }
   * ```
   */
  consolidate(): Promise<void>;

  /**
   * Deletes one rule by ID.
   *
   * @remarks
   * Idempotent — calling with a non-existent ID simply returns `false`.
   * Changes are persisted immediately.
   *
   * @param id - Rule ID to delete.
   * @returns `true` if a rule was removed; `false` if ID not found.
   *
   * @example
   * ```ts
   * const wasRemoved = await store.remove("pref-abc123");
   * ```
   */
  remove(id: string): Promise<boolean>;

  /**
   * Deletes all stored preference rules.
   *
   * @remarks
   * Irreversible bulk delete. Use with caution. Completes after atomic write.
   *
   * @example
   * ```ts
   * await store.clear();
   * const remaining = await store.getAll(); // empty array
   * ```
   */
  clear(): Promise<void>;

  /**
   * Increments the `timesApplied` counter for a rule.
   *
   * @remarks
   * Called when a rule is used during task planning or execution to track
   * how often it's applied (used for ranking). No-op if the rule ID is not found.
   *
   * @param id - Rule ID to update.
   *
   * @example
   * ```ts
   * await store.markApplied("pref-abc123");
   * Rule is now ranked higher for future task planning
   * ```
   */
  markApplied(id: string): Promise<void>;
}
