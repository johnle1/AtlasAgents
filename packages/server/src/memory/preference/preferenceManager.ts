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
 * - A resident `Map<id, PreferenceRule>` is the source of truth once loaded;
 *   disk is read once (lazily, on first access) and rewritten on every
 *   mutation, not read on every call. All server-side callers share one
 *   {@link PreferenceStore} instance for the process lifetime (see
 *   `container/serviceFactory.ts`), so the cache is safe and long-lived.
 * - All mutating methods run inside a {@link Mutex} (the same pattern used by
 *   `ConfigManager`) to serialize the load-modify-save cycle. Without it,
 *   concurrent tasks calling `add()` through the same singleton could lose
 *   an update across an `await` boundary.
 *
 * **Deduplication:**
 * - Text similarity ≥ 0.8 triggers merge instead of add
 * - Merged rules increment `timesApplied` counter
 * - Confidence updated to higher of the two
 * - An inverted token index (`token -> rule ids`) plus a cheap length-bound
 *   pre-filter narrows the similarity search to candidates that share at
 *   least one token and could plausibly clear the threshold, instead of
 *   comparing the new rule against every stored rule.
 *
 * **Consolidation (Weekly):**
 * - Agent model merges duplicate rules when count ≥ 20
 * - Removes redundant entries and resolves conflicts
 * - Scheduled by `scheduleConsolidation` every 7 days
 * - Can be triggered manually via `/consolidate` command
 *
 * **Rule Lifecycle:**
 * 1. Created by {@link PatternExtractor.run} (agent, fix, or style rules) —
 *    batched via `addMany` so one finished task costs one write, not N
 * 2. Injected into context headers by {@link ContextBuilder}
 * 3. Marked as applied when used (via `markApplied`/`markManyApplied`)
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
import {
  extractJsonArray,
  jaccardFromTokenSets,
  passesLengthFilter,
  tokenise,
} from "./preferenceHelpers.js";
import { logger } from "../../utils/logger.js";
import { atomicWriteJson } from "../../utils/atomicWriteJson.js";
import {
  normaliseRule,
  normaliseFile,
  higherConfidence,
} from "./preferenceParsers.js";
import { Mutex } from "../../config/mutex.js";
import { createLazyValue } from "../../utils/lazyValue.js";

/**
 * Returns a shallow, safely-mutable copy of a rule (including a fresh
 * `topics` array) so callers can't corrupt the resident cache by mutating a
 * value returned from `getAll`/`getForTask`/`add`.
 */
const cloneRule = (rule: PreferenceRule): PreferenceRule => ({
  ...rule,
  topics: [...rule.topics],
});

export class PreferenceStore implements IPreferenceStore {
  private readonly absPath: string;
  private readonly ollama?: IOllamaClient;
  private readonly config?: IConfigManager;

  /** Serializes every load-modify-save cycle across concurrent callers. */
  private readonly mutex = new Mutex();

  /**
   * Resident rule store, keyed by id. `null` until the first load completes;
   * insertion order is preserved (JS `Map` iteration order), matching the
   * "stable storage order" the interface documents for `getAll()`.
   */
  private rulesById: Map<string, PreferenceRule> | null = null;

  /**
   * Initial load from disk, memoized so concurrent early callers await the
   * same read.
   *
   * @remarks
   * {@link createLazyValue} clears the in-flight promise when the read
   * rejects, so a transient I/O error (`EACCES`, `EIO`, `EMFILE`) on
   * `preferences.json` fails only the calls that were waiting on it — the
   * next call retries rather than replaying the cached rejection forever.
   */
  private readonly load = createLazyValue<void>(() => this.loadFromDisk());

  /** Cached token set per rule id, used by the similarity search and kept in sync on every mutation. */
  private readonly tokensById = new Map<string, Set<string>>();

  /** Inverted index: token -> ids of rules whose text contains that token. */
  private readonly tokenPostings = new Map<string, Set<string>>();

  /** Ids of rules whose text tokenizes to an empty set (e.g. all stop words) — tracked separately since they contribute no postings entries. */
  private readonly emptyTokenRuleIds = new Set<string>();

  /** Topic index (lowercased) -> ids of rules tagged with that topic. Powers `getForTask` and ContextBuilder's rule matching. */
  private readonly topicIndex = new Map<string, Set<string>>();

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
   *   Served from the resident cache after the first call — no disk I/O.
   */
  getAll = async (): Promise<PreferenceRule[]> => {
    await this.ensureLoaded();
    return [...this.rulesById!.values()].map(cloneRule);
  };

  /**
   * Returns rules matching task keywords, sorted by usage frequency.
   *
   * @param taskKeywords - Keywords to match against rule topics (case-insensitive)
   * @returns Rules with matching topics, sorted by timesApplied descending
   *
   * @remarks
   * Performs case-insensitive topic matching via the resident topic index
   * (O(keywords + matches) instead of scanning every rule). Rules are sorted
   * by usage frequency so most-proven rules appear first for inclusion in
   * context headers.
   */
  getForTask = async (
    taskKeywords: Iterable<string>,
  ): Promise<PreferenceRule[]> => {
    await this.ensureLoaded();
    const matchedIds = new Set<string>();
    for (const keyword of taskKeywords) {
      const ids = this.topicIndex.get(keyword.toLowerCase());
      if (ids) {
        for (const id of ids) {
          matchedIds.add(id);
        }
      }
    }

    const matchedRules: PreferenceRule[] = [];
    for (const id of matchedIds) {
      const rule = this.rulesById!.get(id);
      if (rule) {
        matchedRules.push(cloneRule(rule));
      }
    }

    return matchedRules.sort(
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
    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        const result = await this.persistMutation(() =>
          this.upsertRuleLocked(rule),
        );
        return cloneRule(result);
      } catch (error) {
        logger.error({ error }, "PreferenceStore.add failed");
        throw error;
      }
    });
  };

  /**
   * Adds or merges multiple rules as a single persisted batch.
   *
   * @param rules - Rules to add or merge, in order.
   * @returns Persisted rules (added or merged-into), one per input, same order.
   * @throws If the preferences file cannot be read or written
   *
   * @remarks
   * Same merge-or-insert semantics as {@link add}, applied to every rule
   * in-memory, followed by exactly one disk write for the whole batch —
   * an empty array performs no I/O at all.
   */
  addMany = async (rules: NewPreferenceRule[]): Promise<PreferenceRule[]> => {
    if (rules.length === 0) {
      return [];
    }
    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        return await this.persistMutation(() =>
          rules.map((rule) => cloneRule(this.upsertRuleLocked(rule))),
        );
      } catch (error) {
        logger.error(
          { error, count: rules.length },
          "PreferenceStore.addMany failed",
        );
        throw error;
      }
    });
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
    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        const existing = this.rulesById!.get(ruleId);
        if (!existing) {
          return null;
        }

        const mergedRule = await this.persistMutation((): PreferenceRule => {
          const nextRule: PreferenceRule = {
            ...existing,
            ...newRule,
            id: ruleId,
            timestamp: new Date().toISOString(),
          };

          const topicsChanged =
            newRule.topics !== undefined &&
            newRule.topics.join("\u0000") !== existing.topics.join("\u0000");
          const textChanged =
            newRule.text !== undefined && newRule.text !== existing.text;

          if (topicsChanged) {
            this.deindexTopics(existing);
          }
          if (textChanged) {
            this.deindexTokens(existing);
          }

          this.rulesById!.set(ruleId, nextRule);

          if (textChanged) {
            this.indexTokens(nextRule);
          }
          if (topicsChanged) {
            this.indexTopics(nextRule);
          }

          return nextRule;
        });
        return cloneRule(mergedRule);
      } catch (error) {
        logger.error({ error, ruleId }, "PreferenceStore.update failed");
        throw error;
      }
    });
  };

  /**
   * Removes all rules whose topics contain the specified topic.
   *
   * @param topic - Topic string to match (case-insensitive)
   * @returns Number of rules deleted
   * @throws If the preferences file cannot be read or written
   *
   * @remarks
   * Performs case-insensitive matching via the topic index. Only persists if
   * at least one rule was removed. Returns count of removed rules.
   */
  deleteByTopic = async (topic: string): Promise<number> => {
    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        const key = topic.toLowerCase();
        const matchedIds = this.topicIndex.get(key);
        if (!matchedIds || matchedIds.size === 0) {
          return 0;
        }

        // Copy before iterating — deindexRule mutates the same set via topicIndex.
        const idsToRemove = [...matchedIds];

        return await this.persistMutation(() => {
          let removedCount = 0;
          for (const id of idsToRemove) {
            const rule = this.rulesById!.get(id);
            if (rule) {
              this.deindexRule(rule);
              this.rulesById!.delete(id);
              removedCount += 1;
            }
          }
          return removedCount;
        });
      } catch (error) {
        logger.error({ error, topic }, "PreferenceStore.deleteByTopic failed");
        throw error;
      }
    });
  };

  /**
   * Merges duplicate rules using agent model when count ≥ 20.
   *
   * @returns Resolves after consolidation attempt (no-op if below threshold or dependencies missing)
   * @throws If agent or config manager not provided in constructor, or if the
   *   agent/disk calls fail
   *
   * @remarks
   * **Process:**
   * 1. Requires both `ollama` and `config` dependencies (throws if missing)
   * 2. Skips if rule count < 20 (CONSOLIDATE_MIN_RULES)
   * 3. Sends rules to agent model with consolidation prompt
   * 4. Extracts JSON array from response (handles markdown fences)
   * 5. Validates each consolidated rule and assigns new UUIDs/timestamps
   * 6. Replaces the resident cache and rebuilds indices, then persists to disk
   *
   * Logs warning and silently returns on JSON parse/validation errors — a bad
   * agent response should not crash the scheduler. Other failures (agent
   * unreachable, disk write failure) are logged and re-thrown. Runs inside
   * the same mutex as every other mutation, so a task's `add()` calls can no
   * longer interleave with a consolidation rewrite.
   */
  consolidate = async (): Promise<void> => {
    if (!this.ollama || !this.config) {
      throw new Error(
        "PreferenceStore.consolidate requires ollama and config in constructor deps",
      );
    }

    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        if (this.rulesById!.size < CONSOLIDATE_MIN_RULES) {
          return;
        }

        const model = await this.config!.getAgentModel();
        const temperature = await this.config!.getAgentTemperature();
        const rulesJson = JSON.stringify(
          [...this.rulesById!.values()],
          null,
          2,
        );
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

        const rawAgentResponse = await this.ollama!.chat(model, messages, {
          temperature,
        });

        let parsedRules: unknown;
        try {
          parsedRules = JSON.parse(
            extractJsonArray(rawAgentResponse),
          ) as unknown;
        } catch {
          // Malformed agent output is expected occasionally; skip this run rather than throw.
          logger.warn(
            {},
            "PreferenceStore consolidate: invalid JSON from agent",
          );
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

        await this.persistMutation(() => {
          this.replaceAllLocked(consolidatedRules);
        });
      } catch (error) {
        logger.error({ error }, "PreferenceStore.consolidate failed");
        throw error;
      }
    });
  };

  /**
   * Removes one rule by ID.
   *
   * @param id - ID of the rule to remove
   * @returns True if rule was found and removed, false if not found
   * @throws If the preferences file cannot be read or written
   */
  remove = async (id: string): Promise<boolean> => {
    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        const existing = this.rulesById!.get(id);
        if (!existing) {
          return false;
        }
        await this.persistMutation(() => {
          this.deindexRule(existing);
          this.rulesById!.delete(id);
        });
        return true;
      } catch (error) {
        logger.error({ error, id }, "PreferenceStore.remove failed");
        throw error;
      }
    });
  };

  /**
   * Deletes all rules from storage.
   *
   * @remarks
   * Waits for any in-flight initial load before clearing, the same as every
   * other mutator. Skipping that step let a load started by a concurrent
   * `getAll`/`getForTask` — which call `ensureLoaded()` outside the mutex —
   * resolve *after* the clear and repopulate the resident cache, so the next
   * `add()` would persist the supposedly-deleted rules straight back to disk.
   *
   * @returns Resolves after all rules are deleted
   * @throws If the preferences file cannot be written
   */
  clear = async (): Promise<void> => {
    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        await this.persistMutation(() => {
          this.replaceAllLocked([]);
        });
      } catch (error) {
        logger.error({ error }, "PreferenceStore.clear failed");
        throw error;
      }
    });
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
   * proven rules in context headers. No-op if rule ID not found. Prefer
   * {@link markManyApplied} when marking several rules from one event, to
   * avoid one disk write per rule.
   */
  markApplied = async (id: string): Promise<void> => {
    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        const rule = this.rulesById!.get(id);
        if (!rule) {
          return;
        }
        await this.persistMutation(() => {
          rule.timesApplied += 1;
        });
      } catch (error) {
        logger.error({ error, id }, "PreferenceStore.markApplied failed");
        throw error;
      }
    });
  };

  /**
   * Increments `timesApplied` for multiple rules as a single persisted batch.
   *
   * @param ids - Rule IDs to increment.
   * @returns Resolves after the batch update (no-op, no write, if no ids match).
   * @throws If the preferences file cannot be read or written
   */
  markManyApplied = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) {
      return;
    }
    return this.mutex.run(async () => {
      try {
        await this.ensureLoaded();
        const rulesToMark = ids
          .map((id) => this.rulesById!.get(id))
          .filter((rule): rule is PreferenceRule => rule !== undefined);
        if (rulesToMark.length > 0) {
          await this.persistMutation(() => {
            for (const rule of rulesToMark) {
              rule.timesApplied += 1;
            }
          });
        }
      } catch (error) {
        logger.error(
          { error, count: ids.length },
          "PreferenceStore.markManyApplied failed",
        );
        throw error;
      }
    });
  };

  // ===== INTERNAL: load/persist =====

  /**
   * Ensures the resident cache is populated, loading from disk at most once.
   *
   * @remarks
   * Memoizes the in-flight load so concurrent early callers (before the
   * first load resolves) await the same read instead of triggering N reads.
   */
  private ensureLoaded = async (): Promise<void> => {
    if (this.rulesById !== null) {
      return;
    }
    await this.load.get();
  };

  private loadFromDisk = async (): Promise<void> => {
    const file = await this.readFile();
    this.replaceAllLocked(file.rules);
  };

  /**
   * Replaces the entire resident cache and rebuilds every index from scratch.
   * Caller is responsible for persisting afterward.
   */
  private replaceAllLocked = (rules: PreferenceRule[]): void => {
    this.rulesById = new Map(rules.map((rule) => [rule.id, rule]));
    this.tokensById.clear();
    this.tokenPostings.clear();
    this.emptyTokenRuleIds.clear();
    this.topicIndex.clear();
    for (const rule of this.rulesById.values()) {
      this.indexRule(rule);
    }
  };

  /**
   * Runs a synchronous in-memory mutation and persists it, restoring the
   * exact pre-mutation state if the write fails.
   *
   * @remarks
   * Every mutator's shape is: check preconditions, mutate `rulesById` and
   * its indexes, then persist. Without this, a disk-write failure (a full
   * disk, a permission change mid-run) correctly rejected the caller's
   * promise, but left the mutation sitting in the resident cache regardless
   * — the next unrelated successful mutation's `persistLocked()` would
   * flush it to disk anyway, silently completing a write the caller was
   * told had failed. Callers must have already called `ensureLoaded()`.
   *
   * @param mutate - Performs the in-memory mutation and returns whatever
   *   the caller needs back. Must be synchronous: every mutation this class
   *   makes already is, and requiring it here means there's no `await`
   *   window between the snapshot and the mutation for a concurrent reader
   *   to observe a half-applied state (moot anyway, since every caller
   *   holds the mutex, but worth keeping true).
   * @returns Whatever `mutate` returned, once persistence has succeeded.
   */
  private persistMutation = async <T>(mutate: () => T): Promise<T> => {
    const snapshot = [...this.rulesById!.values()].map(cloneRule);
    const result = mutate();
    try {
      await this.persistLocked();
    } catch (error) {
      this.replaceAllLocked(snapshot);
      throw error;
    }
    return result;
  };

  /** Writes the current resident cache to disk. */
  private persistLocked = async (): Promise<void> => {
    const file: PreferencesFile = {
      version: 1,
      rules: [...this.rulesById!.values()],
    };
    await atomicWriteJson(this.absPath, file, "preferences");
  };

  /**
   * Reads and normalizes the preferences file from disk, tolerating a
   * missing or corrupted file (both resolve to an empty file rather than throwing).
   */
  private readFile = async (): Promise<PreferencesFile> => {
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
      // Corrupted JSON — recover with an empty file rather than crashing,
      // but log it: silently discarding every learned rule with no trace
      // is a bad enough surprise (interrupted write despite the atomic
      // write scheme, manual editing gone wrong) that it's worth a record,
      // even though recovery itself doesn't need one.
      logger.warn(
        { path: this.absPath },
        "Preferences file is corrupted JSON — starting fresh",
      );
      return { version: 1, rules: [] };
    }
    return normaliseFile(parsedFile);
  };

  // ===== INTERNAL: indexing =====

  private indexTokens = (rule: PreferenceRule): void => {
    const tokens = tokenise(rule.text);
    this.tokensById.set(rule.id, tokens);
    if (tokens.size === 0) {
      this.emptyTokenRuleIds.add(rule.id);
      return;
    }
    for (const token of tokens) {
      let postings = this.tokenPostings.get(token);
      if (!postings) {
        postings = new Set();
        this.tokenPostings.set(token, postings);
      }
      postings.add(rule.id);
    }
  };

  private deindexTokens = (rule: PreferenceRule): void => {
    const tokens = this.tokensById.get(rule.id);
    if (!tokens) {
      return;
    }
    for (const token of tokens) {
      const postings = this.tokenPostings.get(token);
      if (postings) {
        postings.delete(rule.id);
        if (postings.size === 0) {
          this.tokenPostings.delete(token);
        }
      }
    }
    this.emptyTokenRuleIds.delete(rule.id);
    this.tokensById.delete(rule.id);
  };

  private indexTopics = (rule: PreferenceRule): void => {
    for (const topic of rule.topics) {
      const key = topic.toLowerCase();
      let ids = this.topicIndex.get(key);
      if (!ids) {
        ids = new Set();
        this.topicIndex.set(key, ids);
      }
      ids.add(rule.id);
    }
  };

  private deindexTopics = (rule: PreferenceRule): void => {
    for (const topic of rule.topics) {
      const key = topic.toLowerCase();
      const ids = this.topicIndex.get(key);
      if (ids) {
        ids.delete(rule.id);
        if (ids.size === 0) {
          this.topicIndex.delete(key);
        }
      }
    }
  };

  private indexRule = (rule: PreferenceRule): void => {
    this.indexTokens(rule);
    this.indexTopics(rule);
  };

  private deindexRule = (rule: PreferenceRule): void => {
    this.deindexTokens(rule);
    this.deindexTopics(rule);
  };

  /**
   * Finds an existing rule whose text is similar enough to merge into,
   * using the inverted token index instead of scanning every stored rule.
   *
   * @remarks
   * Candidates are gathered as the union of postings for each of the new
   * rule's tokens (rules sharing at least one token), then narrowed by an
   * O(1) length-bound check ({@link passesLengthFilter}) before paying for
   * an exact Jaccard comparison. A rule that shares zero tokens with the
   * new text can never reach the 0.8 threshold, so it's never considered —
   * identical decision to the original full scan, just without visiting
   * every rule to reach it.
   *
   * Preserves the original edge case: two rules that both tokenize to the
   * empty set (e.g. all stop words) are still treated as maximally similar.
   */
  private findSimilarLocked = (text: string): PreferenceRule | null => {
    const newTokens = tokenise(text);

    if (newTokens.size === 0) {
      for (const id of this.emptyTokenRuleIds) {
        const rule = this.rulesById!.get(id);
        if (rule) {
          return rule;
        }
      }
      return null;
    }

    const candidateIds = new Set<string>();
    for (const token of newTokens) {
      const postings = this.tokenPostings.get(token);
      if (postings) {
        for (const id of postings) {
          candidateIds.add(id);
        }
      }
    }

    for (const id of candidateIds) {
      const existingTokens = this.tokensById.get(id);
      if (!existingTokens) {
        continue;
      }
      if (
        !passesLengthFilter(
          existingTokens.size,
          newTokens.size,
          SIMILARITY_THRESHOLD,
        )
      ) {
        continue;
      }
      if (
        jaccardFromTokenSets(newTokens, existingTokens) >= SIMILARITY_THRESHOLD
      ) {
        return this.rulesById!.get(id) ?? null;
      }
    }

    return null;
  };

  /**
   * Merges `rule` into an existing similar rule or inserts it as new,
   * updating indices in either case. Caller holds the mutex and persists afterward.
   */
  private upsertRuleLocked = (rule: NewPreferenceRule): PreferenceRule => {
    const sanitizedText = rule.text.trim();
    const sanitizedTopics = rule.topics
      .map((topic) => topic.trim())
      .filter((topic) => topic.length > 0);

    const similar = this.findSimilarLocked(sanitizedText);
    if (similar) {
      similar.timesApplied += 1;
      similar.confidence = higherConfidence(
        rule.confidence,
        similar.confidence,
      );
      similar.timestamp = new Date().toISOString();
      if (sanitizedTopics.length > 0) {
        this.deindexTopics(similar);
        similar.topics = sanitizedTopics;
        this.indexTopics(similar);
      }
      if (rule.scope.length > 0) {
        similar.scope = rule.scope;
      }
      similar.source = rule.source;
      return similar;
    }

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
    this.rulesById!.set(newRule.id, newRule);
    this.indexRule(newRule);
    return newRule;
  };
}
