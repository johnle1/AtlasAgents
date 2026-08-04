/**
 * Unit tests — buildEditAnchorHint.
 */

import { describe, expect, it } from "vitest";
import { buildEditAnchorHint } from "../../../../packages/server/src/workspace/execution/editFileHelpers.js";

describe("buildEditAnchorHint", () => {
  it("returns empty string for short anchors", () => {
    expect(buildEditAnchorHint("content", "ab")).toBe("");
  });

  it("returns nearby lines when a similar needle matches", () => {
    const hint = buildEditAnchorHint(
      "function greet() {\n  console.log('hi');\n}\nfunction farewell() {",
      "console.log('hello')",
    );
    expect(hint).toContain("Nearby lines:");
    expect(hint).toContain("console.log");
  });

  it("falls back to file start when nothing matches", () => {
    const hint = buildEditAnchorHint("line1\nline2\nline3", "xyz123notfound");
    expect(hint).toContain("File starts with:");
    expect(hint).toContain("line1");
  });
});
