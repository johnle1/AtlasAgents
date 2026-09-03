/**
 * Unit tests — client commands/effortOptionColors.ts
 *
 * Ensures the `/effort` option-bar palette stays aligned with shared effort levels.
 */

import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS } from "../../../../packages/shared/src/config/effortLevels.js";
import { EFFORT_OPTION_COLORS } from "../../../../packages/client/src/commands/effortOptionColors.js";

describe("EFFORT_OPTION_COLORS", () => {
  it("matches EFFORT_LEVELS length and cool-to-hot palette order", () => {
    expect(EFFORT_OPTION_COLORS).toEqual([
      "#00D9FF",
      "#39FF14",
      "#FBBF24",
      "#FB923C",
      "#A855F7",
    ]);
    expect(EFFORT_OPTION_COLORS.length).toBe(EFFORT_LEVELS.length);
  });
});
