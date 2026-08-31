/**
 * Unit tests — client ui/bridge/allowlist.ts approval-mode model (WS-A).
 *
 * Four modes exist; Shift+Tab cycles all of them — it is the only way to
 * change mode, there is no slash command. `auto` (full bypass, renamed
 * from the old `bypass`) is session-only and is never persisted. Labels
 * are what the footer shows.
 *
 * Category checklist:
 * - Normal: 4-cycle idle; labels for every mode
 * - Boundary: plan skipped while busy, auto is not
 * - Error: unknown input is not persistable; auto is not persistable
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  cycleApprovalMode,
  formatApprovalModeLabel,
  approvalModeDisplay,
  getApprovalMode,
  parseApprovalMode,
  parsePersistedApprovalMode,
  setSessionApprovalMode,
} from "../../../../packages/client/src/ui/bridge/allowlist.js";

afterEach(() => {
  setSessionApprovalMode("default");
});

describe("cycleApprovalMode (normal)", () => {
  it("cycles default → accept_edits → plan → auto → default when idle", () => {
    expect(cycleApprovalMode("default", false)).toBe("accept_edits");
    expect(cycleApprovalMode("accept_edits", false)).toBe("plan");
    expect(cycleApprovalMode("plan", false)).toBe("auto");
    expect(cycleApprovalMode("auto", false)).toBe("default");
  });
});

describe("cycleApprovalMode (boundary)", () => {
  it("skips plan while busy, cycling accept_edits → default", () => {
    expect(cycleApprovalMode("accept_edits", true)).toBe("default");
  });

  it("does not skip auto while busy — useful for un-sticking a stuck prompt", () => {
    expect(cycleApprovalMode("plan", true)).toBe("auto");
  });

  it("still cycles auto → default while busy (no special-casing beyond plan)", () => {
    expect(cycleApprovalMode("auto", true)).toBe("default");
  });
});

describe("formatApprovalModeLabel", () => {
  it("maps wire tokens to footer labels with icons (normal)", () => {
    expect(formatApprovalModeLabel("default")).toBe("default");
    expect(formatApprovalModeLabel("accept_edits")).toBe("⏵ Accept Edits");
    expect(formatApprovalModeLabel("plan")).toBe("⏸ Plan");
    expect(formatApprovalModeLabel("auto")).toBe("⏵⏵ Auto");
  });
});

describe("approvalModeDisplay", () => {
  it("attaches footer colors and auto's bold warning styling (normal)", () => {
    expect(approvalModeDisplay("plan")).toEqual({
      label: "⏸ Plan",
      color: "#60A5FA",
    });
    expect(approvalModeDisplay("accept_edits")).toEqual({
      label: "⏵ Accept Edits",
      color: "#FB923C",
    });
    expect(approvalModeDisplay("auto")).toEqual({
      label: "⏵⏵ Auto",
      color: "#FF5555",
      bold: true,
    });
    expect(approvalModeDisplay("default")).toEqual({ label: "default" });
  });
});

describe("parseApprovalMode", () => {
  it("accepts hyphen and underscore forms (normal)", () => {
    expect(parseApprovalMode("accept-edits")).toBe("accept_edits");
    expect(parseApprovalMode("accept_edits")).toBe("accept_edits");
    expect(parseApprovalMode("auto_edit")).toBe("accept_edits");
    expect(parseApprovalMode("AUTO")).toBe("auto");
  });

  it("returns null for unknown input, including the removed bypass alias (error)", () => {
    expect(parseApprovalMode("nope")).toBeNull();
    expect(parseApprovalMode("")).toBeNull();
    expect(parseApprovalMode("bypass")).toBeNull();
  });
});

describe("parsePersistedApprovalMode", () => {
  it("keeps persistable modes and migrates auto_edit (normal)", () => {
    expect(parsePersistedApprovalMode("accept_edits")).toBe("accept_edits");
    expect(parsePersistedApprovalMode("auto_edit")).toBe("accept_edits");
    expect(parsePersistedApprovalMode("plan")).toBe("plan");
    expect(parsePersistedApprovalMode("default")).toBe("default");
  });

  it("rejects auto and unknown values (error)", () => {
    expect(parsePersistedApprovalMode("auto")).toBe("default");
    expect(parsePersistedApprovalMode("bypass")).toBe("default");
    expect(parsePersistedApprovalMode("nope")).toBe("default");
    expect(parsePersistedApprovalMode(undefined)).toBe("default");
  });
});

describe("setSessionApprovalMode", () => {
  it("round-trips the session singleton (normal)", () => {
    setSessionApprovalMode("auto");
    expect(getApprovalMode()).toBe("auto");
  });
});
