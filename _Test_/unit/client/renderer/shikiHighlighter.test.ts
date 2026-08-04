/**
 * Unit tests — packages/client/src/diff/shikiHighlighter.ts
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  highlightLine,
  initShiki,
} from "../../../../packages/client/src/diff/shikiHighlighter.js";

describe("shikiHighlighter", () => {
  beforeAll(async () => {
    await initShiki();
  }, 60_000);

  it("initShiki completes without throwing", async () => {
    await expect(initShiki()).resolves.toBeUndefined();
  });

  it("highlightLine returns ANSI without trailing newlines", async () => {
    const out = await highlightLine(
      "const x = 1;",
      "typescript",
      "dark-plus",
    );
    expect(out.endsWith("\n")).toBe(false);
    expect(out.length).toBeGreaterThan(0);
  });

  it("highlightLine falls back to plain text on bad language", async () => {
    const code = "not really code";
    const out = await highlightLine(code, "not-a-real-lang-xyz", "dark-plus");
    expect(out).toBe(code);
  });
});
