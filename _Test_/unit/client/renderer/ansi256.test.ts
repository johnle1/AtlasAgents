/**
 * Unit tests — packages/client/src/theme/ansi256.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bg,
  fg,
  hexToAnsi256,
  hexToAnsi256Bg,
  hexToTrueColor,
  hexToTrueColorBg,
  supportsTrueColor,
} from "../../../../packages/client/src/theme/ansi256.js";

describe("supportsTrueColor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects COLORTERM truecolor and 24bit", () => {
    vi.stubEnv("COLORTERM", "truecolor");
    expect(supportsTrueColor()).toBe(true);
    vi.stubEnv("COLORTERM", "24bit");
    expect(supportsTrueColor()).toBe(true);
  });

  it("detects TERM with direct or truecolor", () => {
    vi.stubEnv("COLORTERM", "");
    vi.stubEnv("TERM", "xterm-direct");
    expect(supportsTrueColor()).toBe(true);
    vi.stubEnv("TERM", "foo-truecolor-bar");
    expect(supportsTrueColor()).toBe(true);
  });

  it("returns false for plain terminals", () => {
    vi.stubEnv("COLORTERM", "");
    vi.stubEnv("TERM", "dumb");
    expect(supportsTrueColor()).toBe(false);
  });
});

describe("hexToTrueColor", () => {
  it("builds 24-bit foreground CSI", () => {
    expect(hexToTrueColor("#FF5733")).toBe("\x1b[38;2;255;87;51m");
    expect(hexToTrueColor("112233")).toBe("\x1b[38;2;17;34;51m");
  });
});

describe("hexToTrueColorBg", () => {
  it("builds 24-bit background CSI", () => {
    expect(hexToTrueColorBg("#112233")).toBe("\x1b[48;2;17;34;51m");
  });
});

describe("hexToAnsi256", () => {
  it("builds 256-color foreground CSI", () => {
    expect(hexToAnsi256("#FF5733")).toMatch(/^\x1b\[38;5;\d+m$/);
  });

  it("picks gray ramp for neutral colors", () => {
    const seq = hexToAnsi256("#808080");
    expect(seq).toMatch(/^\x1b\[38;5;(23[2-9]|24\d|25[0-5])m$/);
  });
});

describe("hexToAnsi256Bg", () => {
  it("builds 256-color background CSI", () => {
    expect(hexToAnsi256Bg("#003300")).toMatch(/^\x1b\[48;5;\d+m$/);
  });
});

describe("fg / bg", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses truecolor when supported", () => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("COLORTERM", "truecolor");
    expect(fg("#FF5733")).toBe(hexToTrueColor("#FF5733"));
    expect(bg("#112233")).toBe(hexToTrueColorBg("#112233"));
  });

  it("uses 256-color when truecolor is unavailable", () => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("COLORTERM", "");
    vi.stubEnv("TERM", "dumb");
    expect(fg("#FF5733")).toBe(hexToAnsi256("#FF5733"));
    expect(bg("#112233")).toBe(hexToAnsi256Bg("#112233"));
  });
});
