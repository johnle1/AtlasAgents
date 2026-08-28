/**
 * Unit tests — client ui/bridge/allowlist.ts
 *
 * Session-only allowlist: "Always allow" rules auto-approve matching
 * future requests this session. planReview is never allowlisted.
 *
 * Category checklist:
 * - Normal: runSkip pattern match, keepUndo path match
 * - Boundary: prefix match for commands; planReview never matches
 * - Error: empty rule / unknown request type does not match
 */

import { describe, expect, it } from "vitest";
import {
  SessionAllowlist,
  ruleFromRequest,
} from "../../../../packages/client/src/ui/bridge/allowlist.js";

describe("SessionAllowlist", () => {
  it("matches a later runSkip with the same command pattern (normal)", () => {
    const allowlist = new SessionAllowlist();
    allowlist.add({ type: "runSkip", pattern: "rm -rf build" });
    expect(
      allowlist.matches({ type: "runSkip", command: "rm -rf build" }),
    ).toBe(true);
  });

  it("matches a keepUndo request on the same path (normal)", () => {
    const allowlist = new SessionAllowlist();
    allowlist.add({ type: "keepUndo", path: "src/a.ts" });
    expect(
      allowlist.matches({ type: "keepUndo", contextLabel: "src/a.ts" }),
    ).toBe(true);
  });

  it("matches a runSkip prefix (boundary — same classified pattern)", () => {
    const allowlist = new SessionAllowlist();
    allowlist.add({ type: "runSkip", pattern: "npm test" });
    expect(
      allowlist.matches({ type: "runSkip", command: "npm test --watch" }),
    ).toBe(true);
  });

  it("never matches planReview even if a rule is added (boundary)", () => {
    const allowlist = new SessionAllowlist();
    allowlist.add({ type: "runSkip", pattern: "rm" });
    expect(
      allowlist.matches({
        type: "planReview",
        task: "x",
        stepCount: 1,
        agentCount: 1,
        execution: "sequential",
        modeLabel: null,
      }),
    ).toBe(false);
  });

  it("does not match a different command (error)", () => {
    const allowlist = new SessionAllowlist();
    allowlist.add({ type: "runSkip", pattern: "ls" });
    expect(allowlist.matches({ type: "runSkip", command: "rm -rf /" })).toBe(
      false,
    );
  });

  it("does not treat a same-prefix word as a prefix match (error — word boundary)", () => {
    const allowlist = new SessionAllowlist();
    allowlist.add({ type: "runSkip", pattern: "npm test" });
    expect(
      allowlist.matches({ type: "runSkip", command: "npm testing" }),
    ).toBe(false);
  });

  it("matches regardless of case and repeated whitespace (boundary — normalization)", () => {
    const allowlist = new SessionAllowlist();
    allowlist.add({ type: "runSkip", pattern: "npm   test" });
    expect(
      allowlist.matches({ type: "runSkip", command: "NPM TEST --watch" }),
    ).toBe(true);
  });
});

describe("ruleFromRequest", () => {
  it("builds a runSkip rule from a command (normal)", () => {
    expect(ruleFromRequest({ type: "runSkip", command: "ls -la" })).toEqual({
      type: "runSkip",
      pattern: "ls -la",
    });
  });

  it("builds a keepUndo rule from a contextLabel (normal)", () => {
    expect(
      ruleFromRequest({ type: "keepUndo", contextLabel: "src/a.ts" }),
    ).toEqual({ type: "keepUndo", path: "src/a.ts" });
  });

  it("returns null for planReview (boundary)", () => {
    expect(
      ruleFromRequest({
        type: "planReview",
        task: "x",
        stepCount: 1,
        agentCount: 1,
        execution: "sequential",
        modeLabel: null,
      }),
    ).toBeNull();
  });
});
