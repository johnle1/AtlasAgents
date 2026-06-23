/**
 * <Summary>
 * What it does:
 *   Interfaces and types for preference rule storage and management.
 *
 * How it fits in the system:
 *   Defines the contract for storing, retrieving, and managing user preference rules.
 * </Summary>
 */

/** Confidence level for a learned or explicit preference rule. */
export type PreferenceConfidence = "high" | "medium" | "low";

/** Provenance of a preference rule. */
export type PreferenceSource = "explicit" | "outcome" | "fix" | "style";

/**
 * <Summary>
 * What it does:
 *   One substring match that adds a topic tag when found in the task text.
 *
 * Used by:
 *   - extractKeywords in contextBuilder.ts.
 *
 * Produced by:
 *   - user-data/language-hints.json or packaged default-data copy.
 * </Summary>
 */
export interface LanguageHint {
  /** Lowercase-friendly substring to search for in the task text. */
  needle: string;

  /** Topic tag stored on preference rules and used for overlap filtering. */
  tag: string;
}

/**
 * <Summary>
 * What it does:
 *   One persisted user preference rule used by ContextBuilder and memory routes.
 *
 * Used by:
 *   - IPreferenceStore.getAll — returns rule rows.
 *
 * Produced by:
 *   - PreferenceStore.add — creates new ids and timestamps.
 * </Summary>
 */
export interface PreferenceRule {
  /** Stable unique id for this rule. */
  id: string;

  /** Human-readable rule text. */
  text: string;

  /** Topic tags for overlap filtering against task keywords. */
  topics: string[];

  /** Language or domain scope (e.g. "all", "javascript", "python"). */
  scope: string;

  /** How strongly to weight this rule. */
  confidence: PreferenceConfidence;

  /** Where the rule came from (explicit user vs learned). */
  source: PreferenceSource;

  /** ISO-8601 last update or creation time. */
  timestamp: string;

  /** How often this rule was applied (higher sorts first). */
  timesApplied: number;
}

/**
 * <Summary>
 * What it does:
 *   Input shape for PreferenceStore.add before id and timestamp are assigned.
 * </Summary>
 */
export type NewPreferenceRule = Omit<
  PreferenceRule,
  "id" | "timestamp" | "timesApplied"
> &
  Partial<Pick<PreferenceRule, "timestamp" | "timesApplied">>;

/**
 * <Summary>
 * What it does:
 *   File-backed preference storage for long-lived user rules.
 *
 * Used by:
 *   - ContextBuilder — reads all rules at task start.
 *   - Future memory command handlers — mutate rules.
 *
 * Produced by:
 *   - packages/server/src/memory/preferenceStore.ts.
 * </Summary>
 */
export interface IPreferenceStore {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns every stored preference rule (empty array when file missing).
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns All rules in stable storage order.
   * </Summary>
   */
  getAll(): Promise<PreferenceRule[]>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Adds or merges a rule (dedup by text similarity >= 0.8).
   *
   * Parameters:
   *   @param rule - Rule fields without id/timesApplied (timestamp optional).
   *
   * Returns:
   *   @returns Persisted or merged row.
   * </Summary>
   */
  add(rule: NewPreferenceRule): Promise<PreferenceRule>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns rules whose topics overlap task keywords, sorted by timesApplied desc.
   *
   * Parameters:
   *   @param taskKeywords - Keyword set from task text.
   *
   * Returns:
   *   @returns Matching rules.
   * </Summary>
   */
  getForTask(taskKeywords: Iterable<string>): Promise<PreferenceRule[]>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Replaces fields on one rule by id.
   *
   * Parameters:
   *   @param ruleId - Rule id.
   *   @param newRule - Fields to merge.
   *
   * Returns:
   *   @returns Updated row or null if id missing.
   * </Summary>
   */
  update(
    ruleId: string,
    newRule: Partial<PreferenceRule>,
  ): Promise<PreferenceRule | null>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Removes all rules whose topics array contains the given topic.
   *
   * Parameters:
   *   @param topic - Topic tag to remove.
   *
   * Returns:
   *   @returns Count of rules removed.
   * </Summary>
   */
  deleteByTopic(topic: string): Promise<number>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Merges duplicate rules via advisor model when rule count >= 20.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns Completes after optional rewrite.
   *
   * @throws {Error} — When Ollama/config deps were not injected at construction.
   * </Summary>
   */
  consolidate(): Promise<void>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Removes one rule by id when present.
   *
   * Parameters:
   *   @param id - Rule id to delete.
   *
   * Returns:
   *   @returns True when a row was removed.
   * </Summary>
   */
  remove(id: string): Promise<boolean>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes all rules from storage.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns Completes after atomic write.
   * </Summary>
   */
  clear(): Promise<void>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Increments timesApplied for one rule (no-op when id missing).
   *
   * Parameters:
   *   @param id - Rule id to bump.
   *
   * Returns:
   *   @returns Completes after persistence.
   * </Summary>
   */
  markApplied(id: string): Promise<void>;
}
