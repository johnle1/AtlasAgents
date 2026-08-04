/**
 * Unit tests — server memory/pattern/patternExtractor.ts
 *
 * `extract()` is fire-and-forget (returns void, runs `run()` in the
 * background) — rather than reaching into the private `run` method, these
 * tests await a promise that resolves inside the fake `prefs.addMany`, which
 * exercises the real public entry point end to end.
 *
 * Category checklist:
 * - Normal: rules from all three sources (agent/fix/style) land in one addMany() call
 * - Boundary: failed task with no escalations short-circuits before any write
 * - Error: malformed agent JSON degrades to fix/style rules only, still batched once
 */

import { describe, expect, it } from "vitest";
import { PatternExtractor } from "../../../../packages/server/src/memory/pattern/patternExtractor.js";
import type {
  IConfigManager,
  IOllamaClient,
  IPreferenceStore,
  NewPreferenceRule,
} from "../../../../packages/server/src/orchestration/interfaces.js";
import type { ExperienceRecord } from "../../../../packages/server/src/memory/types.js";

const fakeConfig = (): IConfigManager =>
  ({
    getAgentModel: async () => "test-agent",
    getAgentTemperature: async () => 0,
    getKeepAlive: async () => "30m",
  }) as unknown as IConfigManager;

/** Fake prefs.addMany that resolves `promise` with the exact batch it received, and refuses add(). */
const makeCapturingPrefs = (): {
  prefs: IPreferenceStore;
  received: Promise<NewPreferenceRule[]>;
  callCount: () => number;
} => {
  let callCount = 0;
  let resolveReceived: (rules: NewPreferenceRule[]) => void;
  const received = new Promise<NewPreferenceRule[]>((resolve) => {
    resolveReceived = resolve;
  });
  const prefs = {
    addMany: async (rules: NewPreferenceRule[]) => {
      callCount += 1;
      resolveReceived(rules);
      return rules.map((rule, index) => ({
        ...rule,
        id: `id-${index}`,
        timestamp: new Date().toISOString(),
        timesApplied: 0,
      }));
    },
    add: async () => {
      throw new Error("prefs.add() should not be called directly — expected batched addMany()");
    },
  } as unknown as IPreferenceStore;
  return { prefs, received, callCount: () => callCount };
};

const baseRecord = (overrides: Partial<ExperienceRecord> = {}): ExperienceRecord => ({
  taskId: "task-1",
  task: "Refactor the auth module",
  startTime: Date.now(),
  filesRead: [],
  filesWritten: [],
  commandsRun: [],
  escalations: [],
  userEdits: [],
  outcome: "success",
  duration: 1000,
  sessionSummary: null,
  ...overrides,
});

describe("PatternExtractor.extract", () => {
  it("batches rules from all three sources (agent, fix, style) into a single addMany() call", async () => {
    const { prefs, received, callCount } = makeCapturingPrefs();
    const ollama = {
      chat: async () =>
        JSON.stringify([
          { text: "Agent-derived rule", topics: ["auth"], scope: "all", confidence: "high" },
        ]),
    } as unknown as IOllamaClient;

    const extractor = new PatternExtractor({ ollama, config: fakeConfig(), prefs });

    extractor.extract(
      baseRecord({
        escalations: [
          { reason: "Type error in auth.ts", guidance: "Cast to unknown first", timestamp: new Date().toISOString() },
        ],
        userEdits: [
          {
            path: "src/auth.ts",
            before: "const x = 1;",
            after: "const x: number = 1;",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );

    const rules = await received;
    expect(callCount()).toBe(1);
    expect(rules).toHaveLength(3);
    expect(rules.map((r) => r.source).sort()).toEqual(["fix", "outcome", "style"]);
  });

  it("still batches exactly once when the agent response is malformed JSON (degrades to fix/style only)", async () => {
    const { prefs, received, callCount } = makeCapturingPrefs();
    const ollama = {
      chat: async () => "this is not json",
    } as unknown as IOllamaClient;

    const extractor = new PatternExtractor({ ollama, config: fakeConfig(), prefs });

    extractor.extract(
      baseRecord({
        outcome: "partial",
        escalations: [
          { reason: "Build failed", guidance: "Run npm install first", timestamp: new Date().toISOString() },
        ],
      }),
    );

    const rules = await received;
    expect(callCount()).toBe(1);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe("fix");
    expect(rules[0]?.text).toContain("Build failed");
  });

  it("performs no writes for a failed task with no escalations", async () => {
    const { prefs, callCount } = makeCapturingPrefs();
    const ollama = {
      chat: async () => {
        throw new Error("should never be called — early exit before this point");
      },
    } as unknown as IOllamaClient;

    const extractor = new PatternExtractor({ ollama, config: fakeConfig(), prefs });
    extractor.extract(baseRecord({ outcome: "failure", escalations: [] }));

    // No synchronization hook is available for a path that deliberately does
    // nothing — a short real delay lets the fire-and-forget run() settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callCount()).toBe(0);
  });
});
