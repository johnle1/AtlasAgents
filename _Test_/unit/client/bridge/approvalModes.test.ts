/**
 * Unit tests — client ui/bridge/allowlist.ts approval-mode model (WS-A).
 *
 * Five modes exist; Shift+Tab cycles only the safe three. `auto` and
 * `bypass` are reachable solely via `/set approval`. Labels are what the
 * footer shows.
 *
 * Category checklist:
 * - Normal: 3-cycle idle; labels for every mode
 * - Boundary: plan skipped while busy; auto/bypass never enter the cycle
 * - Error: unknown / bypass input is not persistable
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
  it("cycles default → accept_edits → plan → default when idle", () => {
    expect(cycleApprovalMode("default", false)).toBe("accept_edits");
    expect(cycleApprovalMode("accept_edits", false)).toBe("plan");
    expect(cycleApprovalMode("plan", false)).toBe("default");
  });
});

describe("cycleApprovalMode (boundary)", () => {
  it("skips plan while busy, cycling accept_edits → default", () => {
    expect(cycleApprovalMode("accept_edits", true)).toBe("default");
  });

  it("never lands on auto or bypass from any cycle start", () => {
    const starts = ["default", "accept_edits", "plan", "auto", "bypass"] as const;
    for (const start of starts) {
      const idle = cycleApprovalMode(start, false);
      const busy = cycleApprovalMode(start, true);
      expect(idle).not.toBe("auto");
      expect(idle).not.toBe("bypass");
      expect(busy).not.toBe("auto");
      expect(busy).not.toBe("bypass");
      expect(busy).not.toBe("plan");
    }
  });

  it("returns default when cycling out of auto or bypass", () => {
    expect(cycleApprovalMode("auto", false)).toBe("default");
    expect(cycleApprovalMode("bypass", false)).toBe("default");
  });
});

describe("formatApprovalModeLabel", () => {
  it("maps wire tokens to footer labels with icons (normal)", () => {
    expect(formatApprovalModeLabel("default")).toBe("default");
    expect(formatApprovalModeLabel("accept_edits")).toBe("⏵ Accept Edits");
    expect(formatApprovalModeLabel("plan")).toBe("⏸ Plan");
    expect(formatApprovalModeLabel("auto")).toBe("⏵⏵ Auto");
    expect(formatApprovalModeLabel("bypass")).toBe("⚠ BYPASS");
  });
});

describe("approvalModeDisplay", () => {
  it("attaches footer colors and bypass bold (normal)", () => {
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
      color: "#A78BFA",
    });
    expect(approvalModeDisplay("bypass")).toEqual({
      label: "⚠ BYPASS",
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
    expect(parseApprovalMode("bypass")).toBe("bypass");
  });

  it("returns null for unknown input (error)", () => {
    expect(parseApprovalMode("nope")).toBeNull();
    expect(parseApprovalMode("")).toBeNull();
  });
});

describe("parsePersistedApprovalMode", () => {
  it("keeps persistable modes and migrates auto_edit (normal)", () => {
    expect(parsePersistedApprovalMode("auto")).toBe("auto");
    expect(parsePersistedApprovalMode("accept_edits")).toBe("accept_edits");
    expect(parsePersistedApprovalMode("auto_edit")).toBe("accept_edits");
    expect(parsePersistedApprovalMode("plan")).toBe("plan");
  });

  it("rejects bypass and unknown values (error)", () => {
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
