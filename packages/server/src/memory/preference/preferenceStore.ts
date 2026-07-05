/**
 * <Summary>
 * What it does:
 *   Persists user preference rules as JSON under user-data/preferences.json with
 *   atomic renames, deduplication on add, and optional advisor-driven consolidate.
 *
 * How it fits in the system:
 *   Implements IPreferenceStore for ContextBuilder, PatternExtractor, and memory routes.
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
  PreferenceRule,
} from "../../orchestration/interfaces.js";
import type { Message } from "../../orchestration/types.js";
import {
  DEFAULT_FILE,
  SIMILARITY_THRESHOLD,
  CONSOLIDATE_MIN_RULES,
} from "./preferenceConstants.js";
import { textSimilarity, extractJsonArray } from "./preferenceHelpers.js";
import {
  PreferencesFile,
  normaliseRule,
  normaliseFile,
  higherConfidence,
} from "./preferenceParsers.js";

/**
 * <Summary>
 * What it does:
 *   Creates a directory (and any missing parents) if it doesn't exist.
 *
 * How it does it (step by step):
 *   1. Call fs.mkdir with recursive option to create directory and parents.
 *
 * Parameters:
 *   @param dir - Directory path to create.
 *
 * Returns:
 *   @returns Resolves when directory exists.
 * </Summary>
 */
const ensureDir = async (dir: string): Promise<void> => {
  // Step 1: Create directory with recursive option (creates parent directories if needed)
  await fs.mkdir(dir, { recursive: true });
};

/**
 * <Summary>
 * What it does:
 *   Persists user preference rules as JSON with atomic renames, deduplication, and optional consolidation.
 *
 * How it fits in the system:
 *   Implements IPreferenceStore for ContextBuilder, PatternExtractor, and memory routes.
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
   * </Summary>
   */
  constructor(
    readonly rootDir?: string,
    readonly deps?: { ollama?: IOllamaClient; config?: IConfigManager },
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
   *   @returns Array of all stored rules.
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
   *   @param taskKeywords - Keywords to match against rule topics.
   *
   * Returns:
   *   @returns Sorted array of relevant rules by usage frequency.
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
      rule.topics.some((topic: string) => keywordSet.has(topic.toLowerCase())),
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
   *   @param rule - Rule to add or merge.
   *
   * Returns:
   *   @returns The added or merged rule.
   * </Summary>
   */
  add = async (rule: NewPreferenceRule): Promise<PreferenceRule> => {
    // Step 1: Load the preferences file from disk
    const preferencesFile = await this.load();
    // Step 2: Trim and sanitize the rule text and topics
    const sanitizedText = rule.text.trim();
    const sanitizedTopics = rule.topics
      .map((topic: string) => topic.trim())
      .filter((topic: string) => topic.length > 0);

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
   *   @param ruleId - ID of the rule to update.
   *   @param newRule - Partial rule object with fields to update.
   *
   * Returns:
   *   @returns Updated rule or null if not found.
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
   *   @param topic - Topic string to match against rule topics.
   *
   * Returns:
   *   @returns Number of rules deleted.
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
   *   @returns Resolves after consolidation attempt.
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
   *   @param id - ID of the rule to remove.
   *
   * Returns:
   *   @returns True if rule was removed, false if not found.
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
   *   @returns Resolves after empty file is persisted.
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
   *   @param id - ID of the rule to mark as applied.
   *
   * Returns:
   *   @returns Resolves after update attempt.
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
   *   @returns Normalized preferences file with valid rules.
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
   *   @param file - The preferences file object to persist.
   *
   * Returns:
   *   @returns Resolves after atomic write completes.
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
