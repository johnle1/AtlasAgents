/**
 * Unit tests — recoverFinishFromThink (think-block finish recovery)
 */

import { describe, expect, it } from "vitest";
import { recoverFinishFromThink } from "../../../../packages/server/src/orchestration/toolProtocol.js";

describe("recoverFinishFromThink", () => {
  it("returns null when action is not finish", () => {
    expect(
      recoverFinishFromThink("action: read_file package.json\nrisk: none"),
    ).toBeNull();
  });

  it("recovers bare action: finish using know as summary fallback", () => {
    const think = [
      "know: package.json has no test runner",
      "need: conclude the subtask",
      "action: finish",
      "risk: none",
      "verify: N/A",
      "purpose: none",
      "exits: yes",
    ].join("\n");

    expect(recoverFinishFromThink(think)).toEqual({
      name: "finish",
      args: { summary: "package.json has no test runner" },
    });
  });

  it("recovers finish args with invented <|\"|> delimiters", () => {
    const think = [
      "know: I have analyzed package.json",
      "need: To formally conclude the subtask by calling `finish`.",
      'action: finish{keyFindings:[<|"|>No explicit test runner dependencies (e.g., jest, vitest) were found in package.json.<|"|>,<|"|>Dependencies are listed under \'dependencies\' and \'devDependencies\'.<|"|>],summary:<|"|>Analyzed package.json. The file',
      "contains standard React/Vite setup dependencies but does not list an explicit test runner dependency or a dedicated test script.<|\"|>}",
      "risk: None, this is the final step for this request.",
      "verify: N/A (calling finish).",
      "purpose: none",
      "exits: yes",
    ].join("\n");

    expect(recoverFinishFromThink(think)).toEqual({
      name: "finish",
      args: {
        summary:
          "Analyzed package.json. The file\ncontains standard React/Vite setup dependencies but does not list an explicit test runner dependency or a dedicated test script.",
        keyFindings: [
          "No explicit test runner dependencies (e.g., jest, vitest) were found in package.json.",
          "Dependencies are listed under 'dependencies' and 'devDependencies'.",
        ],
      },
    });
  });

  it("recovers finish with valid JSON object args", () => {
    const think =
      'action: finish({"summary":"Done reading package.json","keyFindings":["no vitest"]})\nrisk: none';

    expect(recoverFinishFromThink(think)).toEqual({
      name: "finish",
      args: {
        summary: "Done reading package.json",
        keyFindings: ["no vitest"],
      },
    });
  });
});
