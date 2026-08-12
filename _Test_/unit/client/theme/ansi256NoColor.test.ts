/**
 * Unit tests — theme/ansi256.ts under NO_COLOR
 *
 * Category checklist:
 * - Normal: fg/bg return "" when NO_COLOR is set
 * - Boundary: empty NO_COLOR does not disable
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { bg, fg } from "../../../../packages/client/src/theme/ansi256.js";

describe("fg / bg under NO_COLOR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty strings when NO_COLOR is set (normal)", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(fg("#58a6ff")).toBe("");
    expect(bg("#003300")).toBe("");
  });

  it("still emits color when NO_COLOR is an empty string (boundary)", () => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("COLORTERM", "");
    vi.stubEnv("TERM", "dumb");
    expect(fg("#58a6ff").length).toBeGreaterThan(0);
    expect(bg("#003300").length).toBeGreaterThan(0);
  });
});
