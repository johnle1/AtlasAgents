/**
 * Manages persistent preference rules for user and learned patterns.
 *
 * @remarks
 * Implements {@link IPreferenceStore} to persist and retrieve preference rules
 * that guide subagent behavior and context construction.
 *
 * **Storage:**
 * - Rules persisted to `user-data/preferences.json` (atomic writes)
 * - Atomic write-to-temp-then-rename pattern prevents corruption
 * - Graceful handling of missing or corrupted files
 *
 * **Deduplication:**
 * - Text similarity ≥ 0.8 triggers merge instead of add
 * - Merged rules increment `timesApplied` counter
 * - Confidence updated to higher of the two
 *
 * **Consolidation (Weekly):**
 * - Subsubagent model merges duplicate rules when count ≥ 20
 * - Removes redundant entries and resolves conflicts
 * - Scheduled by `scheduleConsolidation` every 7 days
 * - Can be triggered manually via `/consolidate` command
 *
 * **Rule Lifecycle:**
 * 1. Created by {@link PatternExtractor.run} (agent, fix, or style rules)
 * 2. Injected into context headers by {@link ContextBuilder}
 * 3. Marked as applied when used (via `markApplied`)
 * 4. Periodically consolidated to remove duplicates
 *
 * @see {@link PreferenceRule} for rule structure
 * @see {@link ContextBuilder} for how rules are used
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  IConfigManager,
  IOllamaClient,
  IPreferenceStore,
  NewPreferenceRule,
  PreferenceRule,
} from "../../orchestration/interfaces.js";
import type { Message } from "../../orchestration/types.js";
import type { PreferencesFile } from "../types.js";
import {
  DEFAULT_FILE,
  SIMILARITY_THRESHOLD,
  CONSOLIDATE_MIN_RULES,
} from "./preferenceConstants.js";
import { textSimilarity, extractJsonArray } from "./preferenceHelpers.js";
import { logger } from "../../logger.js";
import { atomicWriteJson } from "../../utils/atomicWriteJson.js";
import {
  normaliseRule,
  normaliseFile,
  higherConfidence,
} from "./preferenceParsers.js";

export class PreferenceStore implements IPreferenceStore {
  private readonly absPath: string;
  private readonly ollama?: IOllamaClient;
  private readonly config?: IConfigManager;

  /**
   * Initializes the preference store with file path and optional agent dependencies.
   *
   * @param rootDir - Optional base directory (defaults to process.cwd())
   * @param deps - Optional agent (Ollama) and config manager for consolidation
   */
  constructor(
    readonly rootDir?: string,
    readonly deps?: { ollama?: IOllamaClient; config?: IConfigManager },
  ) {
    const base = rootDir ?? process.cwd();
    this.absPath = path.join(base, DEFAULT_FILE);
    this.ollama = deps?.ollama;
    this.config = deps?.config;
  }

  /**
   * Returns all stored preference rules.
   *
   * @returns Array of all rules (empty if file missing or empty)
   * @remarks Returns empty array if preferences file doesn't exist yet (graceful startup).
   */
  getAll = async (): Promise<PreferenceRule[]> => {
    const preferencesFile = await this.load();
    return preferencesFile.rules;
  };

  /**
   * Returns rules matching task keywords, sorted by usage frequency.
   *
   * @param taskKeywords - Keywords to match against rule topics (case-insensitive)
   * @returns Rules with matching topics, sorted by timesApplied descending
   *
   * @remarks
   * Performs case-insensitive topic matching. Rules are sorted by usage frequency
   * so most-proven rules appear first for inclusion in context headers.
   */
  getForTask = async (
    taskKeywords: Iterable<string>,
  ): Promise<PreferenceRule[]> => {
    const keywordSet = new Set(
      [...taskKeywords].map((keyword) => keyword.toLowerCase()),
    );
    const allRules = await this.getAll();
    const matchedRules = allRules.filter((rule: PreferenceRule) =>
      rule.topics.some((topic) => keywordSet.has(topic.toLowerCase())),
    );
    return [...matchedRules].sort(
      (ruleA, ruleB) => ruleB.timesApplied - ruleA.timesApplied,
    );
  };

  /**
   * Adds a new rule or merges with existing similar rule.
   *
   * @param rule - Rule to add (text, topics, confidence, source, optional timestamp/timesApplied)
   * @returns The added rule or merged existing rule
   * @throws If the preferences file cannot be read or written
   *
   * @remarks
   * **Deduplication:** Text similarity ≥ 0.8 triggers merge instead of add.
   * Merged rules: increment `timesApplied`, update confidence to higher value,
   * update timestamp and metadata.
   *
   * **New rule:** Assigned UUID and current timestamp if not provided.
   * Topics and scope are sanitized (trimmed, empty entries removed).
   */
  add = async (rule: NewPreferenceRule): Promise<PreferenceRule> => {
    try {
      const preferencesFile = await this.load();
      const sanitizedText = rule.text.trim();
      const sanitizedTopics = rule.topics
        .map((topic) => topic.trim())
        .filter((topic) => topic.length > 0);

      // Check for similar existing rule (text similarity >= 0.8)
      for (const existingRule of preferencesFile.rules as PreferenceRule[]) {
        if (textSimilarity(sanitizedText, existingRule.text) >= SIMILARITY_THRESHOLD) {
          // Merge: update usage counter and metadata
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
          await this.save(preferencesFile);
          return existingRule;
        }
      }

      // No similar rule found; create new one
      const newRule: PreferenceRule = {
        id: randomUUID(),
        text: sanitizedText,
        topics: sanitizedTopics,
        scope: rule.scope.length > 0 ? rule.scope : "all",
        confidence: rule.confidence,
        source: rule.source,
        timestamp: rule.timestamp ?? new Date().toISOString(),
        timesApplied: rule.timesApplied ?? 0,
      };
      preferencesFile.rules.push(newRule);
      await this.save(preferencesFile);
      return newRule;
    } catch (error) {
      logger.error({ error }, "PreferenceStore.add failed");
      throw error;
    }
  };

  /**
   * Updates specified fields on a rule by ID.
   *
   * @param ruleId - ID of the rule to update
   * @param newRule - Partial rule object with fields to update
   * @returns Updated rule or null if rule not found
   * @throws If the preferences file cannot be read or written
   *
   * @remarks
   * Performs shallow merge of `newRule` fields into existing rule.
   * Timestamp always updated to current time. ID is preserved.
   */
  update = async (
    ruleId: string,
    newRule: Partial<PreferenceRule>,
  ): Promise<PreferenceRule | null> => {
    try {
      const preferencesFile = await this.load();
      const ruleIndex = preferencesFile.rules.findIndex((rule) => rule.id === ruleId);
      if (ruleIndex === -1) {
        return null;
      }
      const mergedRule: PreferenceRule = {
        ...preferencesFile.rules[ruleIndex],
        ...newRule,
        id: ruleId,
        timestamp: new Date().toISOString(),
      };
      preferencesFile.rules[ruleIndex] = mergedRule;
      await this.save(preferencesFile);
      return mergedRule;
    } catch (error) {
      logger.error({ error, ruleId }, "PreferenceStore.update failed");
      throw error;
    }
  };

  /**
   * Removes all rules whose topics contain the specified topic.
   *
   * @param topic - Topic string to match (case-insensitive)
   * @returns Number of rules deleted
   * @throws If the preferences file cannot be read or written
   *
   * @remarks
   * Performs case-insensitive matching on topic array. Only persists if
   * at least one rule was removed. Returns count of removed rules.
   */
  deleteByTopic = async (topic: string): Promise<number> => {
    try {
      const preferencesFile = await this.load();
      const topicToMatch = topic.toLowerCase();
      const initialRuleCount = preferencesFile.rules.length;
      preferencesFile.rules = preferencesFile.rules.filter(
        (rule: PreferenceRule) =>
          !rule.topics.some(
            (ruleTopic) => ruleTopic.toLowerCase() === topicToMatch,
          ),
      );
      const removedCount = initialRuleCount - preferencesFile.rules.length;
      if (removedCount > 0) {
        await this.save(preferencesFile);
      }
      return removedCount;
    } catch (error) {
      logger.error({ error, topic }, "PreferenceStore.deleteByTopic failed");
      throw error;
    }
  };

  /**
   * Merges duplicate rules using subsubagent model when count ≥ 20.
   *
   * @returns Resolves after consolidation attempt (no-op if below threshold or dependencies missing)
   * @throws If agent or config manager not provided in constructor, or if the
   *   agent/disk calls fail
   *
   * @remarks
   * **Process:**
   * 1. Requires both `ollama` and `config` dependencies (throws if missing)
   * 2. Skips if rule count < 20 (CONSOLIDATE_MIN_RULES)
   * 3. Sends rules to subsubagent model with consolidation prompt
   * 4. Extracts JSON array from response (handles markdown fences)
   * 5. Validates each consolidated rule and assigns new UUIDs/timestamps
   * 6. Persists consolidated rules back to disk
   *
   * Logs warning and silently returns on JSON parse/validation errors — a bad
   * subagent response should not crash the scheduler. Other failures (agent
   * unreachable, disk write failure) are logged and re-thrown.
   */
  consolidate = async (): Promise<void> => {
    if (!this.ollama || !this.config) {
      throw new Error(
        "PreferenceStore.consolidate requires ollama and config in constructor deps",
      );
    }

    try {
      const preferencesFile = await this.load();
      if (preferencesFile.rules.length < CONSOLIDATE_MIN_RULES) {
        return;
      }

      const model = await this.config.getSubagentModel();
      const temperature = await this.config.getAgentTemperature();
      const rulesJson = JSON.stringify(preferencesFile.rules, null, 2);
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

      const rawAgentResponse = await this.ollama.chat(model, messages, {
        temperature,
      });

      let parsedRules: unknown;
      try {
        parsedRules = JSON.parse(extractJsonArray(rawAgentResponse)) as unknown;
      } catch {
        // Malformed subagent output is expected occasionally; skip this run rather than throw.
        logger.warn({}, "PreferenceStore consolidate: invalid JSON from agent");
        return;
      }

      if (!Array.isArray(parsedRules)) {
        return;
      }

      const consolidatedRules: PreferenceRule[] = [];
      for (const consolidatedRuleItem of parsedRules as unknown[]) {
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

      await this.save({ version: 1, rules: consolidatedRules });
    } catch (error) {
      logger.error({ error }, "PreferenceStore.consolidate failed");
      throw error;
    }
  };

  /**
   * Removes one rule by ID.
   *
   * @param id - ID of the rule to remove
   * @returns True if rule was found and removed, false if not found
   * @throws If the preferences file cannot be read or written
   */
  remove = async (id: string): Promise<boolean> => {
    try {
      const preferencesFile = await this.load();
      const initialRuleCount = preferencesFile.rules.length;
      preferencesFile.rules = preferencesFile.rules.filter(
        (rule: PreferenceRule) => rule.id !== id,
      );
      if (preferencesFile.rules.length === initialRuleCount) {
        return false;
      }
      await this.save(preferencesFile);
      return true;
    } catch (error) {
      logger.error({ error, id }, "PreferenceStore.remove failed");
      throw error;
    }
  };

  /**
   * Deletes all rules from storage.
   *
   * @returns Resolves after all rules are deleted
   * @throws If the preferences file cannot be written
   */
  clear = async (): Promise<void> => {
    try {
      await this.save({ version: 1, rules: [] });
    } catch (error) {
      logger.error({ error }, "PreferenceStore.clear failed");
      throw error;
    }
  };

  /**
   * Increments timesApplied counter for a rule by ID.
   *
   * @param id - ID of the rule to mark as applied
   * @returns Resolves after update attempt (no-op if rule not found)
   * @throws If the preferences file cannot be read or written
   *
   * @remarks
   * Increments the usage counter by 1, allowing ContextBuilder to prioritize
   * proven rules in context headers. No-op if rule ID not found.
   */
  markApplied = async (id: string): Promise<void> => {
    try {
      const preferencesFile = await this.load();
      const ruleToIncrement = preferencesFile.rules.find(
        (rule: PreferenceRule) => rule.id === id,
      );
      if (!ruleToIncrement) {
        return;
      }
      ruleToIncrement.timesApplied += 1;
      await this.save(preferencesFile);
    } catch (error) {
      logger.error({ error, id }, "PreferenceStore.markApplied failed");
      throw error;
    }
  };

  /**
   * Loads preferences file from disk with graceful error handling.
   *
   * @returns Normalized preferences file (empty if missing or corrupted)
   *
   * @remarks
   * **Error handling:**
   * - Missing file (ENOENT): Returns empty file — expected on first start
   * - Parse errors: Returns empty file — corrupted JSON handled gracefully
   * - Other I/O errors: Re-throws to surface real problems
   *
   * Validates structure via `normaliseFile()` before returning.
   */
  private load = async (): Promise<PreferencesFile> => {
    let rawFileContents = "";
    try {
      rawFileContents = await fs.readFile(this.absPath, "utf-8");
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException).code;
      // File not found on first start — graceful fallback
      if (errorCode === "ENOENT") {
        return { version: 1, rules: [] };
      }
      throw err;
    }

    let parsedFile: unknown;
    try {
      parsedFile = JSON.parse(rawFileContents) as unknown;
    } catch {
      // Corrupted JSON — return empty file rather than crashing
      return { version: 1, rules: [] };
    }
    return normaliseFile(parsedFile);
  };

  /**
   * Persists preferences file to disk using atomic write pattern.
   *
   * @param preferencesFile - The preferences file to persist
   * @returns Resolves after atomic write completes
   *
   * @remarks
   * Uses temp-file-then-rename pattern for atomicity: readers see either
   * the complete old file or the complete new file, never partial writes.
   * See `atomicWriteJson()` for implementation details.
   */
  private save = async (preferencesFile: PreferencesFile): Promise<void> => {
    await atomicWriteJson(this.absPath, preferencesFile, "preferences");
  };
}
