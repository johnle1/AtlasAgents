/**
 * Unit tests — packages/client/src/utils/progressBar.ts
 */

import { describe, expect, it } from "vitest";
import { renderProgressBar } from "../../../../packages/client/src/utils/progressBar.js";

describe("renderProgressBar", () => {
  it("fills proportionally to ratio (normal)", () => {
    expect(renderProgressBar(0.5, 10)).toBe("█████░░░░░");
  });

  it("renders fully empty at ratio 0 (boundary)", () => {
    expect(renderProgressBar(0, 10)).toBe("░".repeat(10));
  });

  it("renders fully filled at ratio 1 (boundary)", () => {
    expect(renderProgressBar(1, 10)).toBe("█".repeat(10));
  });

  it("clamps ratios above 1 instead of throwing (boundary — defensive clamp)", () => {
    expect(() => renderProgressBar(1.5, 10)).not.toThrow();
    expect(renderProgressBar(1.5, 10)).toBe("█".repeat(10));
  });

  it("clamps negative ratios instead of throwing (boundary — defensive clamp)", () => {
    expect(() => renderProgressBar(-0.5, 10)).not.toThrow();
    expect(renderProgressBar(-0.5, 10)).toBe("░".repeat(10));
  });
});
