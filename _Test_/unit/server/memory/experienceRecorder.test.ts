/**
 * Unit tests — memory/experience/experienceRecorder.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExperienceRecorder } from "../../../../packages/server/src/memory/experience/experienceRecorder.js";
import {
  emptyCommandPlan,
  type OrchestrationOutcome,
} from "../../../../packages/server/src/orchestration/types.js";

const successOutcome = (): OrchestrationOutcome => ({
  ok: true,
  plan: {
    subtasks: [],
    risks: [],
    commandPlan: emptyCommandPlan(),
    execution: "sequential",
    agentCount: 0,
  },
  results: [],
});

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ExperienceRecorder", () => {
  it("records activity and persists on finish", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-exp-"));
    tempRoots.push(root);
    const extract = vi.fn();
    const append = vi.fn();
    const recorder = new ExperienceRecorder({
      rootDir: root,
      patternExtractor: { extract },
      sessionManager: { append },
    });

    const taskId = "task-abc";
    await recorder.start(taskId, "Do work");
    recorder.logRead(taskId, "src/index.ts");
    recorder.logCommand(taskId, "npm test", { stdout: "ok", stderr: "", exitCode: 0 });

    await recorder.finish(taskId, successOutcome());

    const experiencesDir = path.join(root, "user-data", "experiences");
    const files = await fs.readdir(experiencesDir);
    expect(files.some((f) => f.endsWith(`${taskId}.json`))).toBe(true);
    expect(extract).toHaveBeenCalled();
    expect(append).toHaveBeenCalled();
  });
});
