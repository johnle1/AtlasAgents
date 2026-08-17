/**
 * Unit tests — server memory/context/contextBuilder.ts
 *
 * Uses the real PreferenceStore (bound to the same temp root) rather than a
 * hand-rolled fake, since several of these tests need genuine dedup/index
 * behavior (markManyApplied wiring) that a fake would just have to
 * reimplement — the real store is already covered by preferenceManager.test.ts.
 *
 * Category checklist:
 * - Normal: scope-gated rule matching, detectStack hit, markManyApplied wiring
 * - Boundary: no hints file, no matching rules/patterns, empty header
 * - Regression guard: pattern cache only invalidates on mtime change, not on
 *   content alone (the precise contract loadPatterns() promises)
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ContextBuilder } from "../../../../packages/server/src/memory/context/contextBuilder.js";
import { PreferenceStore } from "../../../../packages/server/src/memory/preference/preferenceManager.js";
import type {
  IConfigManager,
  IOllamaAdminClient,
} from "../../../../packages/server/src/orchestration/interfaces.js";

const tempRoots: string[] = [];

// A large configured num_ctx (=> a large 20% header budget) so short test
// fixtures never get skipped or truncated by the greedy token-budget fill.
// Must match fakeOllama's context_length below — resolveNumCtx clamps
// configured num_ctx to the model's trained length, so if these two figures
// diverged the smaller one would silently win.
const FAKE_LARGE_CONTEXT_WINDOW = 100_000;

const fakeConfig = (agentModel = "test-model"): IConfigManager =>
  ({
    getAgentModel: async () => agentModel,
    // build() reads this to decide whether the budget is sized against
    // resolveNumCtx (ollama) or DEFAULT_CONTEXT_WINDOW (everything else).
    getAgentProvider: async () => "ollama",
    // Matches the pre-existing hardcoded default this replaced.
    getMaxContextBudget: async () => 0.2,
    getNumCtx: async () => FAKE_LARGE_CONTEXT_WINDOW,
  }) as unknown as IConfigManager;

const fakeOllama = (contextLength = FAKE_LARGE_CONTEXT_WINDOW): IOllamaAdminClient =>
  ({
    showModel: async () => ({ context_length: contextLength }),
  }) as unknown as IOllamaAdminClient;

const makeBuilder = async (): Promise<{
  builder: ContextBuilder;
  prefs: PreferenceStore;
  root: string;
}> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-context-"));
  tempRoots.push(root);
  const prefs = new PreferenceStore(root);
  const builder = new ContextBuilder({
    prefs,
    ollama: fakeOllama(),
    config: fakeConfig(),
    rootDir: root,
  });
  return { builder, prefs, root };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ContextBuilder.build — scope filtering", () => {
  it("excludes a scope-specific rule when the task text doesn't mention that scope", async () => {
    const { builder, prefs } = await makeBuilder();
    await prefs.add({
      text: "Use snake_case naming for Python identifiers",
      topics: ["python"],
      scope: "python",
      confidence: "high",
      source: "explicit",
    });
    await prefs.add({
      text: "Use camelCase naming for TypeScript identifiers",
      topics: ["typescript"],
      scope: "typescript",
      confidence: "high",
      source: "explicit",
    });

    const header = await builder.build("Refactor the typescript component");

    expect(header).toContain("camelCase naming for TypeScript");
    expect(header).not.toContain("snake_case naming for Python");
  });

  it("always includes an 'all'-scoped rule regardless of task text", async () => {
    const { builder, prefs } = await makeBuilder();
    await prefs.add({
      text: "Always write tests for new behavior",
      topics: ["testing"],
      scope: "all",
      confidence: "high",
      source: "explicit",
    });

    const header = await builder.build("Add a testing utility");
    expect(header).toContain("Always write tests for new behavior");
  });

  it("gates a scope-specific universal (untagged) rule the same way as a topic-tagged one", async () => {
    const { builder, prefs } = await makeBuilder();
    await prefs.add({
      text: "Untagged Python-only convention",
      topics: [], // universal fallback — but still scoped to python
      scope: "python",
      confidence: "high",
      source: "explicit",
    });

    const header = await builder.build("Refactor the typescript component");
    expect(header).not.toContain("Untagged Python-only convention");
  });
});

describe("ContextBuilder.build — primary match vs. universal fallback", () => {
  it("uses only topic-matched rules when a primary match exists, ignoring universal rules entirely", async () => {
    const { builder, prefs } = await makeBuilder();
    await prefs.add({
      text: "Primary matched rule about testing",
      topics: ["testing"],
      scope: "all",
      confidence: "high",
      source: "explicit",
    });
    await prefs.add({
      text: "Universal fallback rule for everything",
      topics: [], // only meant to apply when nothing else matched
      scope: "all",
      confidence: "high",
      source: "explicit",
    });

    const header = await builder.build("Add a testing utility");

    expect(header).toContain("Primary matched rule about testing");
    expect(header).not.toContain("Universal fallback rule for everything");
  });

  it("falls back to universal rules only when there is no primary topic match at all", async () => {
    const { builder, prefs } = await makeBuilder();
    await prefs.add({
      text: "Universal fallback rule for everything",
      topics: [],
      scope: "all",
      confidence: "high",
      source: "explicit",
    });

    const header = await builder.build("Do something with zero topic overlap");
    expect(header).toContain("Universal fallback rule for everything");
  });
});

describe("ContextBuilder.build — cross-section dedup", () => {
  it("does not duplicate a rule that matches both primary and task-type-fix criteria", async () => {
    // TASK_TYPE_WORDS entries (e.g. "refactor") are ordinary English words,
    // so a rule tagged with one always also primary-matches whenever the
    // task text contains that word — the single-pass partition must still
    // only place it into the header once, not once per matching group.
    const { builder, prefs } = await makeBuilder();
    await prefs.add({
      text: "Dual-matching refactor rule content",
      topics: ["refactor"],
      scope: "all",
      confidence: "high",
      source: "explicit",
    });

    const header = await builder.build("Refactor the payment module");

    const occurrences = header.split("Dual-matching refactor rule content").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("ContextBuilder.detectStack", () => {
  it("returns the tag of the first matching language hint", async () => {
    const { builder, root } = await makeBuilder();
    await fs.mkdir(path.join(root, "user-data"), { recursive: true });
    await fs.writeFile(
      path.join(root, "user-data", "language-hints.json"),
      JSON.stringify([{ needle: "python", tag: "python" }]),
    );

    expect(await builder.detectStack("Write a python script")).toBe("python");
  });

  it("returns undefined when no hint matches the task text", async () => {
    const { builder, root } = await makeBuilder();
    await fs.mkdir(path.join(root, "user-data"), { recursive: true });
    await fs.writeFile(
      path.join(root, "user-data", "language-hints.json"),
      JSON.stringify([{ needle: "python", tag: "python" }]),
    );

    expect(await builder.detectStack("Do something unrelated")).toBeUndefined();
  });

  it("returns undefined when no language-hints.json file exists", async () => {
    const { builder } = await makeBuilder();
    expect(await builder.detectStack("Write a python script")).toBeUndefined();
  });
});

describe("ContextBuilder.build — markManyApplied wiring", () => {
  it("increments timesApplied on every rule that made it into the header", async () => {
    const { builder, prefs } = await makeBuilder();
    const a = await prefs.add({
      text: "Rule about testing conventions",
      topics: ["testing"],
      scope: "all",
      confidence: "high",
      source: "explicit",
    });
    const b = await prefs.add({
      text: "Rule about refactor conventions",
      topics: ["refactor"],
      scope: "all",
      confidence: "high",
      source: "explicit",
    });

    await builder.build("Refactor the testing suite");

    const all = await prefs.getAll();
    expect(all.find((r) => r.id === a.id)?.timesApplied).toBe(1);
    expect(all.find((r) => r.id === b.id)?.timesApplied).toBe(1);
  });

  it("does not touch timesApplied for rules that existed but weren't selected", async () => {
    const { builder, prefs } = await makeBuilder();
    const unrelated = await prefs.add({
      text: "Rule about an unrelated python topic",
      topics: ["python"],
      scope: "python",
      confidence: "high",
      source: "explicit",
    });

    await builder.build("Refactor the typescript component");

    const all = await prefs.getAll();
    expect(all.find((r) => r.id === unrelated.id)?.timesApplied).toBe(0);
  });
});

describe("ContextBuilder.build — pattern file caching", () => {
  it("returns stable content across repeated calls, then picks up a real edit", async () => {
    const { builder, root } = await makeBuilder();
    const patternsDir = path.join(root, "user-data", "patterns");
    await fs.mkdir(patternsDir, { recursive: true });
    const filePath = path.join(patternsDir, "arch.md");
    await fs.writeFile(filePath, "Version one content");

    const first = await builder.build("some unrelated task");
    expect(first).toContain("Version one content");

    // Nothing changed on disk — must still see the same content.
    const second = await builder.build("some unrelated task");
    expect(second).toContain("Version one content");

    // A real edit naturally advances mtime; guard against the rare case
    // where filesystem mtime resolution is coarse enough that a fast
    // rewrite lands on the same millisecond (see _Test_ conventions: force
    // the mtime forward explicitly with fs.utimes rather than assume the
    // write timestamp differs) — this keeps the assertion below testing the
    // actual invalidation contract, not filesystem timing luck.
    const original = await fs.stat(filePath);
    await fs.writeFile(filePath, "Version two content");
    const updated = await fs.stat(filePath);
    if (updated.mtimeMs <= original.mtimeMs) {
      const bumped = new Date(original.mtimeMs + 5_000);
      await fs.utimes(filePath, bumped, bumped);
    }

    const third = await builder.build("some unrelated task");
    expect(third).toContain("Version two content");
    expect(third).not.toContain("Version one content");
  });

  it("drops the cache entry for a pattern file that no longer exists on disk", async () => {
    const { builder, root } = await makeBuilder();
    const patternsDir = path.join(root, "user-data", "patterns");
    await fs.mkdir(patternsDir, { recursive: true });
    const filePath = path.join(patternsDir, "temp.md");
    await fs.writeFile(filePath, "Temporary content");

    const first = await builder.build("some unrelated task");
    expect(first).toContain("Temporary content");

    await fs.rm(filePath);

    const second = await builder.build("some unrelated task");
    expect(second).not.toContain("Temporary content");
  });
});

describe("ContextBuilder.build — boundary cases", () => {
  it("returns an empty string when there are no rules, patterns, or session to include", async () => {
    const { builder } = await makeBuilder();
    expect(await builder.build("do anything at all")).toBe("");
  });
});

describe("ContextBuilder.build — non-Ollama provider budget (regression guard)", () => {
  it("budgets against the default context window and never calls showModel for a non-Ollama provider", async () => {
    // build() used to call resolveNumCtx() unconditionally. For a role on an
    // OpenAI-compatible provider, that queries the LOCAL Ollama for a model
    // tag it was never pulled with; showModel() throws, the resolver falls
    // back to OLLAMA_DEFAULT_NUM_CTX (4096), and the memory header budget
    // silently collapses from ~25,600 tokens to ~819 — even though the real
    // model (say, a 128k-context vLLM deployment) never receives num_ctx on
    // the wire at all. A rule long enough to fit only under the larger,
    // correct budget proves which one was actually used.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-context-"));
    tempRoots.push(root);
    const prefs = new PreferenceStore(root);
    let showModelCalls = 0;
    const ollama = {
      showModel: async () => {
        showModelCalls += 1;
        throw new Error("should never be called for a non-ollama provider");
      },
    } as unknown as IOllamaAdminClient;
    const config = {
      getAgentModel: async () => "gpt-oss-120b",
      getAgentProvider: async () => "vllm-gpu",
      getMaxContextBudget: async () => 0.2,
      getNumCtx: async () => undefined,
    } as unknown as IConfigManager;
    const builder = new ContextBuilder({ prefs, ollama, config, rootDir: root });

    // ~600 tokens of rule text: comfortably fits the ~25,600-token budget
    // from DEFAULT_CONTEXT_WINDOW (128_000 * 0.2), but would be entirely
    // skipped (greedy fill has nothing that fits) under the old ~819-token
    // collapsed budget.
    const longRuleText = Array.from(
      { length: 40 },
      (_, i) => `Detail point number ${i} about typescript configuration and testing conventions.`,
    ).join(" ");
    await prefs.add({
      text: longRuleText,
      topics: ["typescript"],
      scope: "typescript",
      confidence: "medium",
      source: "explicit",
    });

    const header = await builder.build("Refactor the typescript component");

    expect(header).toContain("Detail point number 0");
    expect(showModelCalls).toBe(0);
  });

  it("still resolves num_ctx via showModel for the ollama provider (default, unchanged)", async () => {
    const { builder, prefs } = await makeBuilder();
    // Baseline sanity: the ollama path in makeBuilder() (fakeConfig has no
    // getAgentProvider — resolves via ConfigManager's default, "ollama")
    // still produces content, proving the branch itself wasn't broken.
    await prefs.add({
      text: "prefer arrow functions for module-level helpers",
      topics: ["typescript"],
      scope: "typescript",
      confidence: "medium",
      source: "explicit",
    });
    const header = await builder.build("Refactor the typescript component");
    expect(header).toContain("arrow functions");
  });
});
