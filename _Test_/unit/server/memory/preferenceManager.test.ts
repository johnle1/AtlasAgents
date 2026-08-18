/**
 * Unit tests — server memory/preference/preferenceManager.ts
 *
 * Category checklist:
 * - Normal: add/merge, addMany batching, getForTask topic matching, markApplied,
 *   markManyApplied, remove, deleteByTopic, clear, consolidate
 * - Boundary: empty addMany, dissimilar text near the 0.8 threshold, unknown ids
 * - Error: consolidate without deps throws, corrupted file on disk recovers empty
 *
 * Rule text fixtures deliberately use a bank of distinct, non-stopword filler
 * words (see WORDS below) rather than natural sentences — the real tokenizer
 * drops words under 3 chars and a real stop-word list (see
 * preferenceConstants.STOP_WORDS), so short natural phrases like "Rule A" /
 * "Rule B" collapse to the same single token ({"rule"}) and merge by
 * accident. Controlling the token sets directly keeps similarity assertions
 * exact and independent of tokenizer internals changing later.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PreferenceStore } from "../../../../packages/server/src/memory/preference/preferenceManager.js";
import { logger } from "../../../../packages/server/src/utils/logger.js";
import type {
  IConfigManager,
  IOllamaClient,
  NewPreferenceRule,
} from "../../../../packages/server/src/orchestration/interfaces.js";

// None of these are 3-letter-or-shorter and none appear in
// preferenceConstants.STOP_WORDS — safe, predictable tokens.
const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliett", "kilo", "lima", "mike", "november", "oscar", "papa",
  "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
  "xray", "yankee", "zulu",
];

const tempRoots: string[] = [];

const makeStore = async (
  deps?: { ollama?: IOllamaClient; config?: IConfigManager },
): Promise<{ store: PreferenceStore; root: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-prefs-"));
  tempRoots.push(root);
  return { store: new PreferenceStore(root, deps), root };
};

const baseRule = (overrides: Partial<NewPreferenceRule> = {}): NewPreferenceRule => ({
  text: `Rule about ${WORDS[0]} configuration`,
  topics: ["typescript"],
  scope: "typescript",
  confidence: "medium",
  source: "explicit",
  ...overrides,
});

/** A rule whose text is dominated by `word`, distinct enough from other `distinctRule` outputs to never accidentally merge (pairwise Jaccard ~0.5, well under the 0.8 threshold). */
const distinctRule = (word: string, overrides: Partial<NewPreferenceRule> = {}): NewPreferenceRule =>
  baseRule({ text: `Rule about ${word} configuration`, ...overrides });

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("PreferenceStore.add", () => {
  it("creates a new rule with a generated id and timestamp", async () => {
    const { store } = await makeStore();
    const rule = await store.add(baseRule());
    expect(rule.id.length).toBeGreaterThan(0);
    expect(rule.timestamp.length).toBeGreaterThan(0);
    expect(rule.timesApplied).toBe(0);
  });

  it("merges a near-duplicate rule (Jaccard >= 0.8) instead of adding a second one", async () => {
    const { store } = await makeStore();
    // 10 shared tokens vs 9 shared + 1 differing => J = 9/11 ≈ 0.818 >= 0.8
    const textA = WORDS.slice(0, 10).join(" ");
    const textB = `${WORDS.slice(0, 9).join(" ")} kilo`;

    const first = await store.add(baseRule({ text: textA }));
    const second = await store.add(baseRule({ text: textB, confidence: "high" }));

    expect(second.id).toBe(first.id);
    expect(second.timesApplied).toBe(1);
    expect(second.confidence).toBe("high"); // upgraded to the higher of the two
    expect((await store.getAll())).toHaveLength(1);
  });

  it("does not merge rules with only partial token overlap (Jaccard 0.6)", async () => {
    const { store } = await makeStore();
    // 3 shared tokens vs 1 differing each => J = 3/5 = 0.6, safely under 0.8
    const textA = `${WORDS.slice(0, 3).join(" ")} india`;
    const textB = `${WORDS.slice(0, 3).join(" ")} juliett`;

    await store.add(baseRule({ text: textA }));
    await store.add(baseRule({ text: textB }));

    expect((await store.getAll())).toHaveLength(2);
  });

  it("defaults scope to 'all' when given an empty scope", async () => {
    const { store } = await makeStore();
    const rule = await store.add(baseRule({ scope: "" }));
    expect(rule.scope).toBe("all");
  });

  it("returned rules are safe to mutate without corrupting the resident cache", async () => {
    const { store } = await makeStore();
    const rule = await store.add(baseRule());
    rule.topics.push("corrupted");
    rule.text = "mutated";

    const reloaded = await store.getAll();
    expect(reloaded[0]?.text).toBe(baseRule().text);
    expect(reloaded[0]?.topics).toEqual(["typescript"]);
  });

  it("serializes concurrent add() calls so no merge is lost across an await boundary", async () => {
    // This is the pre-existing race the mutex is meant to close: every
    // mutator used to do an unguarded load -> mutate -> save, so two
    // concurrent add() calls sharing the same singleton could both read the
    // same "before" state and one write could clobber the other. Firing N
    // concurrent adds of mutually-similar text and expecting exactly one
    // surviving rule with timesApplied = N-1 only holds if the mutex
    // actually serializes them.
    const { store } = await makeStore();
    const text = WORDS.slice(0, 10).join(" ");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.add(baseRule({ text }))),
    );

    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.timesApplied).toBe(9); // 1 insert + 9 merges, none lost
    expect(new Set(results.map((r) => r.id)).size).toBe(1); // every caller resolved to the same rule
  });
});

describe("PreferenceStore.update", () => {
  it("merges partial fields, updates the timestamp, and preserves the id and untouched fields", async () => {
    const { store } = await makeStore();
    const rule = await store.add(distinctRule("alpha"));
    // toISOString() has millisecond resolution — without a gap, add() and
    // update() can land in the same millisecond and produce identical
    // strings, which would make the "timestamp changed" assertion flaky.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await store.update(rule.id, { confidence: "high" });

    expect(updated?.id).toBe(rule.id);
    expect(updated?.confidence).toBe("high");
    expect(updated?.text).toBe(rule.text);
    expect(updated?.timestamp).not.toBe(rule.timestamp);
  });

  it("returns null for an unknown id and does not throw", async () => {
    const { store } = await makeStore();
    expect(await store.update("does-not-exist", { confidence: "high" })).toBeNull();
  });

  it("re-indexes topics so the rule is findable by its new topic and not the old one", async () => {
    const { store } = await makeStore();
    const rule = await store.add(distinctRule("alpha", { topics: ["react"] }));

    await store.update(rule.id, { topics: ["vue"] });

    expect((await store.getForTask(["react"]))).toHaveLength(0);
    expect((await store.getForTask(["vue"]))).toHaveLength(1);
  });

  it("re-indexes similarity tokens when text changes, so old-text duplicates stop merging and new-text duplicates start", async () => {
    const { store } = await makeStore();
    const oldText = WORDS.slice(0, 10).join(" "); // alpha..juliett
    const newText = WORDS.slice(10, 20).join(" "); // kilo..tango
    const rule = await store.add(baseRule({ text: oldText }));

    await store.update(rule.id, { text: newText });

    // Near-duplicate of the NEW text should merge into the updated rule.
    const nearNew = `${WORDS.slice(10, 19).join(" ")} zulu`; // 9/11 shared with newText
    const mergedIntoUpdated = await store.add(baseRule({ text: nearNew }));
    expect(mergedIntoUpdated.id).toBe(rule.id);

    // Near-duplicate of the OLD text must NOT merge — a stale token index
    // would still find it similar to the (no-longer-current) old tokens.
    const nearOld = `${WORDS.slice(0, 9).join(" ")} yankee`; // shares nothing with newText
    const separateRule = await store.add(baseRule({ text: nearOld }));
    expect(separateRule.id).not.toBe(rule.id);
  });
});

describe("PreferenceStore.addMany", () => {
  it("persists every rule from a batch and returns one result per input, same order", async () => {
    const { store } = await makeStore();

    const rules = await store.addMany([
      distinctRule("alpha"),
      distinctRule("bravo"),
      distinctRule("charlie"),
    ]);

    expect(rules.map((r) => r.text)).toEqual([
      distinctRule("alpha").text,
      distinctRule("bravo").text,
      distinctRule("charlie").text,
    ]);
    expect((await store.getAll())).toHaveLength(3);
  });

  it("applies the same merge-or-insert semantics as individual add() calls", async () => {
    const { store } = await makeStore();
    const textA = WORDS.slice(0, 10).join(" ");
    const textB = `${WORDS.slice(0, 9).join(" ")} kilo`; // J ≈ 0.818, merges with textA
    await store.add(baseRule({ text: textA }));

    await store.addMany([
      baseRule({ text: textB, confidence: "high" }),
      distinctRule("zulu"), // unrelated, stays separate
    ]);

    const all = await store.getAll();
    expect(all).toHaveLength(2); // merged into the first, inserted the second
    const merged = all.find((r) => r.text === textA);
    expect(merged?.timesApplied).toBe(1);
    expect(merged?.confidence).toBe("high");
  });

  it("performs no I/O and returns an empty array for an empty batch", async () => {
    const { store, root } = await makeStore();
    const result = await store.addMany([]);
    expect(result).toEqual([]);
    // No write means no file at all — addMany([]) must short-circuit before ensureLoaded/persist.
    expect(fsSync.existsSync(path.join(root, "user-data", "preferences.json"))).toBe(false);
  });
});

describe("PreferenceStore.getForTask", () => {
  it("returns rules whose topics overlap the given keywords, sorted by usage", async () => {
    const { store } = await makeStore();
    const low = await store.add(distinctRule("alpha", { topics: ["react"] }));
    const high = await store.add(distinctRule("bravo", { topics: ["react", "testing"] }));
    await store.markManyApplied([high.id, high.id, high.id, low.id]);

    const matched = await store.getForTask(["react"]);
    expect(matched.map((r) => r.id)).toEqual([high.id, low.id]);
  });

  it("is case-insensitive and returns nothing for unmatched keywords", async () => {
    const { store } = await makeStore();
    await store.add(distinctRule("alpha", { topics: ["React"] }));

    expect((await store.getForTask(["react"]))).toHaveLength(1);
    expect((await store.getForTask(["vue"]))).toHaveLength(0);
  });
});

describe("PreferenceStore.markApplied / markManyApplied", () => {
  it("increments timesApplied for a single rule", async () => {
    const { store } = await makeStore();
    const rule = await store.add(baseRule());
    await store.markApplied(rule.id);
    const [reloaded] = await store.getAll();
    expect(reloaded?.timesApplied).toBe(1);
  });

  it("increments timesApplied for a batch, skipping unknown ids", async () => {
    const { store } = await makeStore();
    const a = await store.add(distinctRule("alpha"));
    const b = await store.add(distinctRule("bravo"));

    await store.markManyApplied([a.id, b.id, "does-not-exist"]);

    const all = await store.getAll();
    expect(all.find((r) => r.id === a.id)?.timesApplied).toBe(1);
    expect(all.find((r) => r.id === b.id)?.timesApplied).toBe(1);
  });

  it("is a no-op for an empty id list", async () => {
    const { store } = await makeStore();
    const rule = await store.add(baseRule());
    await store.markManyApplied([]);
    const [reloaded] = await store.getAll();
    expect(reloaded?.timesApplied).toBe(0);
    expect(reloaded?.id).toBe(rule.id);
  });
});

describe("PreferenceStore.remove / deleteByTopic / clear", () => {
  it("removes a rule by id", async () => {
    const { store } = await makeStore();
    const rule = await store.add(baseRule());
    expect(await store.remove(rule.id)).toBe(true);
    expect(await store.remove(rule.id)).toBe(false); // idempotent
    expect((await store.getAll())).toHaveLength(0);
  });

  it("deletes every rule tagged with a topic, case-insensitively, leaving others intact", async () => {
    const { store } = await makeStore();
    await store.add(distinctRule("alpha", { topics: ["Python"] }));
    await store.add(distinctRule("bravo", { topics: ["python", "testing"] }));
    await store.add(distinctRule("charlie", { topics: ["typescript"] }));

    const removed = await store.deleteByTopic("python");
    expect(removed).toBe(2);
    const remaining = await store.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.topics).toEqual(["typescript"]);
  });

  it("clear() empties the store", async () => {
    const { store } = await makeStore();
    await store.add(baseRule());
    await store.clear();
    expect((await store.getAll())).toHaveLength(0);
  });

  it("rolls back an in-memory mutation when persisting it fails, so a later successful write doesn't resurrect it (regression guard)", async () => {
    // add()/update()/remove()/etc. all mutated rulesById and its indexes
    // BEFORE calling persistLocked(). If that write failed (a full disk, a
    // permission change mid-run), the rejection correctly propagated to the
    // caller, but the mutation stayed cached anyway — the next unrelated
    // successful mutation's own persistLocked() would flush the whole
    // resident cache to disk, silently completing a write the caller had
    // just been told failed.
    const { store, root } = await makeStore();
    const first = await store.add(distinctRule("alpha"));

    // Force the next persist to fail deterministically, regardless of which
    // user runs the test: replace the directory preferences.json lives in
    // with a plain file, so atomicWriteJson's own
    // fs.mkdir(directory, {recursive:true}) throws ENOTDIR — a structural
    // conflict, not a permission check that root could bypass.
    const dataDir = path.join(root, "user-data");
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.writeFile(dataDir, "not a directory");

    await expect(store.add(distinctRule("bravo"))).rejects.toThrow();

    // Restore so state can be inspected without the blocker interfering.
    await fs.rm(dataDir, { force: true });

    // The rejected add() must not have left "bravo" in the resident cache.
    expect((await store.getAll()).map((r) => r.text)).toEqual([first.text]);

    const second = await store.add(distinctRule("charlie"));
    expect((await store.getAll()).map((r) => r.text).sort()).toEqual(
      [first.text, second.text].sort(),
    );
  });
});

describe("PreferenceStore.consolidate", () => {
  it("throws when ollama/config were not provided", async () => {
    const { store } = await makeStore();
    await expect(store.consolidate()).rejects.toThrow();
  });

  it("is a no-op below the consolidation threshold", async () => {
    let chatCallCount = 0;
    const ollama = {
      chat: async () => {
        chatCallCount += 1;
        return "[]";
      },
    } as unknown as IOllamaClient;
    const config = {
      getAgentModel: async () => "test-agent",
      getAgentTemperature: async () => 0,
    } as unknown as IConfigManager;

    const { store } = await makeStore({ ollama, config });
    await store.add(baseRule());
    await store.consolidate();

    expect(chatCallCount).toBe(0);
  });

  it("replaces the rule set with the agent's consolidated rules once at/above the threshold", async () => {
    // NOTE: normaliseRule (preferenceParsers.ts) rejects any rule missing a
    // non-empty id/timestamp — pre-existing behavior, unchanged here — even
    // though the consolidation prompt only asks the agent for
    // {text, topics, scope, confidence, source}. A real LLM response that
    // follows that prompt literally would therefore get silently dropped by
    // consolidate(); id/timestamp are included below so this test reflects
    // what actually persists rather than what the prompt asks for.
    const ollama = {
      chat: async () =>
        JSON.stringify([
          {
            id: "consolidated-1",
            text: "Consolidated rule",
            topics: ["typescript"],
            scope: "all",
            confidence: "high",
            source: "explicit",
            timestamp: new Date().toISOString(),
          },
        ]),
    } as unknown as IOllamaClient;
    const config = {
      getAgentModel: async () => "test-agent",
      getAgentTemperature: async () => 0,
    } as unknown as IConfigManager;

    const { store } = await makeStore({ ollama, config });
    for (let i = 0; i < 20; i += 1) {
      // Each rule dominated by its own distinct word => no accidental merges.
      await store.add(distinctRule(`${WORDS[i % WORDS.length]}${i}`));
    }
    expect((await store.getAll())).toHaveLength(20);

    await store.consolidate();

    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("Consolidated rule");
  });
});

describe("PreferenceStore disk persistence", () => {
  it("survives a fresh instance reading rules written by a previous one", async () => {
    const { store, root } = await makeStore();
    await store.add(baseRule());

    const reopened = new PreferenceStore(root);
    expect((await reopened.getAll())).toHaveLength(1);
  });

  it("starts empty when the preferences file doesn't exist yet", async () => {
    const { store } = await makeStore();
    expect((await store.getAll())).toEqual([]);
  });

  it("recovers to an empty store when the file on disk is corrupted JSON, and logs it (regression guard)", async () => {
    // Recovering silently is right — a corrupted preferences.json shouldn't
    // crash startup — but discarding every learned rule with literally no
    // trace was its own surprise waiting to happen (an interrupted write
    // despite the atomic-write scheme, or manual editing gone wrong).
    const { store, root } = await makeStore();
    const filePath = path.join(root, "user-data", "preferences.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, "{ not valid json");

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect((await store.getAll())).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: filePath }),
      expect.stringContaining("corrupted"),
    );
    warnSpy.mockRestore();
  });

  it("retries after a transient (non-ENOENT) read failure instead of caching the rejection forever (error)", async () => {
    // readFile() only treats ENOENT as "missing file" and rethrows anything
    // else. Putting a directory where preferences.json is expected makes the
    // first read fail with a real EISDIR, mirroring an EACCES/EIO the caller
    // can't control — the failure this guards against, not a bug it can fix.
    const { store, root } = await makeStore();
    const filePath = path.join(root, "user-data", "preferences.json");
    await fs.mkdir(filePath, { recursive: true });

    await expect(store.getAll()).rejects.toThrow();

    // Clear the transient condition — the same recovery a retried process
    // would see once the underlying I/O error goes away.
    await fs.rmdir(filePath);

    // Before the fix, ensureLoaded() cached the rejected load promise
    // forever, so every call after the first failure kept throwing the same
    // stale error even once the file was readable again.
    expect(await store.getAll()).toEqual([]);
    const rule = await store.add(baseRule());
    expect((await store.getAll()).map((r) => r.id)).toEqual([rule.id]);
  });

  it("clear() waits for an in-flight initial load instead of racing it (regression guard)", async () => {
    // Every other mutator starts with `await this.ensureLoaded()` inside the
    // mutex; clear() used to skip straight to replaceAllLocked([]). A load
    // kicked off by a concurrent read (getAll/getForTask call ensureLoaded()
    // outside the mutex) could then resolve *after* the clear and
    // repopulate the cache with the pre-clear rules — which the next
    // mutation would persist right back to disk.
    const { store, root } = await makeStore();
    await store.add(baseRule());

    // Fresh instance so its first read is a real disk load, not already
    // served from a resident cache.
    const second = new PreferenceStore(root);
    const readDuringClear = second.getAll();
    await second.clear();

    await readDuringClear;
    expect(await second.getAll()).toEqual([]);

    // The rules must not have been written back to disk by the race either.
    const third = new PreferenceStore(root);
    expect(await third.getAll()).toEqual([]);
  });
});
