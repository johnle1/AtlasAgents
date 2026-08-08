/**
 * Unit tests — server memory/experience/experienceHelpers.ts
 */

import { describe, expect, it } from "vitest";
import {
  deriveOutcome,
  hasActivity,
} from "../../../../packages/server/src/memory/experience/experienceHelpers.js";
import type { ExperienceRecord } from "../../../../packages/server/src/memory/types.js";
import {
  emptyCommandPlan,
  type OrchestrationOutcome,
} from "../../../../packages/server/src/orchestration/types.js";

const emptyRecord = (): ExperienceRecord => ({
  taskId: "task-1",
  task: "do work",
  startTime: 0,
  filesRead: [],
  filesWritten: [],
  commandsRun: [],
  escalations: [],
  userEdits: [],
  outcome: null,
  duration: null,
  sessionSummary: null,
});

const outcome = (ok: boolean): OrchestrationOutcome => ({
  ok,
  plan: {
    subtasks: [],
    risks: [],
    commandPlan: emptyCommandPlan(),
    execution: "sequential",
    agentCount: 0,
  },
  results: [],
});

describe("hasActivity", () => {
  it("returns false when every log array is empty", () => {
    expect(hasActivity(emptyRecord())).toBe(false);
  });

  it("returns true when any activity category has entries", () => {
    expect(
      hasActivity({
        ...emptyRecord(),
        filesRead: [{ path: "/a.ts", timestamp: "2025-01-01T00:00:00Z" }],
      }),
    ).toBe(true);
    expect(
      hasActivity({
        ...emptyRecord(),
        commandsRun: [
          {
            command: "npm test",
            stdout: "",
            stderr: "",
            exitCode: 0,
            timestamp: "2025-01-01T00:00:00Z",
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("deriveOutcome", () => {
  it('returns "success" when orchestration succeeded', () => {
    expect(deriveOutcome(outcome(true), emptyRecord())).toBe("success");
  });

  it('returns "partial" when orchestration failed but activity was logged', () => {
    const record = {
      ...emptyRecord(),
      filesWritten: [
        {
          path: "/b.ts",
          diff: "+x",
          timestamp: "2025-01-01T00:00:00Z",
        },
      ],
    };
    expect(deriveOutcome(outcome(false), record)).toBe("partial");
  });

  it('returns "failure" when orchestration failed with no activity', () => {
    expect(deriveOutcome(outcome(false), emptyRecord())).toBe("failure");
  });
});
