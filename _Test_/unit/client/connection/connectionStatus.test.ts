/**
 * Unit tests — connectionStatus helpers.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../packages/client/src/config/index", () => ({
  loadConfig: () => ({ showSpinner: true }),
}));

vi.mock("../../../../packages/client/src/ui/terminalEnv.js", () => ({
  inTmux: () => false,
  isScreenReaderLikely: () => false,
  colorDisabled: () => false,
  colorForced: () => false,
  supportsOsc9Notifications: () => false,
}));

import {
  formatConnectionStatusLabel,
  getConnectionStatusPollMs,
  resolveConnectionStatusVisual,
} from "../../../../packages/client/src/ui/connectionStatus.js";

describe("formatConnectionStatusLabel", () => {
  it.each([
    ["Connected", "Connected"],
    ["Connecting", "Connecting"],
    ["Reconnecting", "Reconnecting"],
    ["Disconnected", "Disconnection"],
  ] as const)("%s → %s", (status, label) => {
    expect(formatConnectionStatusLabel(status)).toBe(label);
  });
});

describe("resolveConnectionStatusVisual", () => {
  it("marks Connected as green and static", () => {
    expect(resolveConnectionStatusVisual("Connected", 0)).toEqual({
      glyph: "●",
      color: "green",
      animate: false,
    });
  });

  it("marks Disconnected as red and static", () => {
    expect(resolveConnectionStatusVisual("Disconnected", 0)).toEqual({
      glyph: "●",
      color: "red",
      animate: false,
    });
  });

  it("animates Connecting/Reconnecting with a working frame", () => {
    const visual = resolveConnectionStatusVisual("Connecting", 0);
    expect(visual.color).toBe("yellow");
    expect(visual.animate).toBe(true);
    expect(visual.glyph.length).toBeGreaterThan(0);
  });
});

describe("getConnectionStatusPollMs", () => {
  it("returns a positive interval", () => {
    expect(getConnectionStatusPollMs()).toBeGreaterThan(0);
  });
});
