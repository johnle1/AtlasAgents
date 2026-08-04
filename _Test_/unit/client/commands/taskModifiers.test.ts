/**
 * Unit tests — packages/client/src/utils/taskModifiers.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  countTriggers,
  formatModeNotice,
  parseTaskModifiers,
} from "../../../../packages/client/src/utils/taskModifiers.js";

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: vi.fn(() => ({ subagentCap: 3 })),
}));

describe("countTriggers", () => {
  it("counts zero when no trigger words", () => {
    expect(countTriggers("fix bug")).toBe(0);
  });

  it("counts a single whole-word trigger", () => {
    expect(countTriggers("fix bug ::focus")).toBe(1);
  });

  it("counts multiple triggers", () => {
    expect(countTriggers("::focus ::collab")).toBe(2);
  });

  it("does not count triggers embedded in other tokens", () => {
    expect(countTriggers("test::focushere")).toBe(0);
  });
});

describe("parseTaskModifiers", () => {
  it("extracts ::focus and cleans text", () => {
    const m = parseTaskModifiers("deploy app ::focus");
    expect(m.triggerFound).toBe("::focus");
    expect(m.maxSubagents).toBe(1);
    expect(m.modeLabel).toBe("focus mode");
    expect(m.clean).toBe("deploy app");
  });

  it("extracts ::collab", () => {
    const m = parseTaskModifiers("work ::collab");
    expect(m.maxSubagents).toBe(2);
    expect(m.modeLabel).toBe("collab mode");
  });

  it("extracts ::max", () => {
    const m = parseTaskModifiers("scale ::max");
    expect(m.maxSubagents).toBe("max");
    expect(m.modeLabel).toBe("max mode");
  });

  it("uses config subagentCap when no trigger", () => {
    const m = parseTaskModifiers("plain task");
    expect(m.triggerFound).toBeNull();
    expect(m.modeLabel).toBeNull();
    expect(m.maxSubagents).toBe(3);
    expect(m.clean).toBe("plain task");
  });
});

describe("formatModeNotice", () => {
  it("returns null when no mode label", () => {
    expect(
      formatModeNotice({
        maxSubagents: 3,
        modeLabel: null,
        clean: "x",
        triggerFound: null,
      }),
    ).toBeNull();
  });

  it("formats focus mode", () => {
    expect(
      formatModeNotice(parseTaskModifiers("x ::focus")),
    ).toBe("◎ focus mode — 1 agent");
  });

  it("formats collab mode", () => {
    expect(
      formatModeNotice(parseTaskModifiers("x ::collab")),
    ).toBe("◎ collab mode — 2 agents");
  });

  it("formats max mode without cap", () => {
    expect(
      formatModeNotice(parseTaskModifiers("x ::max")),
    ).toBe("◎ max mode — no agent cap");
  });
});
