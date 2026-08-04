/**
 * Unit tests — packages/client/src/ui/terminalEnv.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inTmux,
  isScreenReaderLikely,
} from "../../../../packages/client/src/ui/terminalEnv.js";

describe("inTmux", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true when TMUX is a non-empty string", () => {
    vi.stubEnv("TMUX", "/tmp/tmux-0/default,123,0");
    expect(inTmux()).toBe(true);
  });

  it("is false when TMUX is missing or empty", () => {
    vi.stubEnv("TMUX", "");
    expect(inTmux()).toBe(false);
    vi.stubEnv("TMUX", undefined);
    expect(inTmux()).toBe(false);
  });
});

describe("isScreenReaderLikely", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true for TERM=dumb", () => {
    vi.stubEnv("TERM", "dumb");
    vi.stubEnv("CI", undefined);
    expect(isScreenReaderLikely()).toBe(true);
  });

  it("is true when CI=true", () => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("CI", "true");
    expect(isScreenReaderLikely()).toBe(true);
  });

  it("is false for normal interactive terminals", () => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("CI", undefined);
    expect(isScreenReaderLikely()).toBe(false);
  });
});
