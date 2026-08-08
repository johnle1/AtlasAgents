/**
 * Unit tests — recoverToolCallFromThink (think-block read-only tool recovery)
 *
 * @remarks
 * Covers the rescue path for a model that names a read-only tool in its
 * `action:` line but never emits the actual tool call — including the
 * reported failure shape where the action line is bare (`action: read_file`)
 * and the real target only appears in a `need:`/`risk:` sentence.
 */

import { describe, expect, it } from "vitest";
import { recoverToolCallFromThink } from "../../../../packages/server/src/orchestration/toolProtocol.js";

describe("recoverToolCallFromThink", () => {
  it("recovers an explicit target on the action line", () => {
    expect(
      recoverToolCallFromThink("action: read_file package.json\nrisk: none"),
    ).toEqual({ name: "read_file", args: { path: "package.json" } });
  });

  it("recovers a backtick-quoted target on the action line", () => {
    expect(
      recoverToolCallFromThink(
        "action: read_file `src/App.tsx`\nrisk: none",
      ),
    ).toEqual({ name: "read_file", args: { path: "src/App.tsx" } });
  });

  it("recovers a target from the risk line when the action line is bare (reported-bug regression)", () => {
    const think = [
      "know: nothing yet",
      "need: to see the component before editing",
      "action: read_file",
      "risk: I need to see the content of src/App.tsx before adding the clock.",
    ].join("\n");

    expect(recoverToolCallFromThink(think)).toEqual({
      name: "read_file",
      args: { path: "src/App.tsx" },
    });
  });

  it("strips backticks around a target embedded in prose", () => {
    const think = [
      "action: read_file",
      "risk: I need to check `src/App.tsx` before proceeding.",
    ].join("\n");

    expect(recoverToolCallFromThink(think)).toEqual({
      name: "read_file",
      args: { path: "src/App.tsx" },
    });
  });

  it("never synthesizes write_file, edit_file, or run_command", () => {
    expect(
      recoverToolCallFromThink("action: write_file src/App.tsx\nrisk: none"),
    ).toBeNull();
    expect(
      recoverToolCallFromThink("action: edit_file src/App.tsx\nrisk: none"),
    ).toBeNull();
    expect(
      recoverToolCallFromThink("action: run_command npm test\nrisk: none"),
    ).toBeNull();
  });

  it("returns null for action: finish (owned by recoverFinishFromThink)", () => {
    expect(recoverToolCallFromThink("action: finish\nrisk: none")).toBeNull();
  });

  it("returns null when two distinct paths make the target ambiguous", () => {
    const think = [
      "action: read_file",
      "risk: check package.json or src/App.tsx first, not sure which.",
    ].join("\n");

    expect(recoverToolCallFromThink(think)).toBeNull();
  });

  it("returns null for pure prose with no path-like token", () => {
    const think = [
      "action: read_file",
      "risk: I need to see the content of the app first.",
    ].join("\n");

    expect(recoverToolCallFromThink(think)).toBeNull();
  });

  it("rejects absolute paths and directory traversal", () => {
    expect(
      recoverToolCallFromThink("action: read_file /etc/passwd\nrisk: none"),
    ).toBeNull();
    expect(
      recoverToolCallFromThink("action: read_file ../../.env\nrisk: none"),
    ).toBeNull();
  });

  it("terminates the action line at the field boundary (does not read the next field's path)", () => {
    const think = "action: read_file src/A.tsx\nverify: compare with src/B.tsx";
    expect(recoverToolCallFromThink(think)).toEqual({
      name: "read_file",
      args: { path: "src/A.tsx" },
    });
  });

  it("returns null for an unrecognized tool name", () => {
    expect(
      recoverToolCallFromThink("action: explore_codebase src/\nrisk: none"),
    ).toBeNull();
  });
});
