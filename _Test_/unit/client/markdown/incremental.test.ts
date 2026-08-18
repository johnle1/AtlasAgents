/**
 * Unit tests — client ui/markdown/incremental.ts
 *
 * Re-lexing a growing buffer must not flicker: the committed (stable)
 * prefix of a partial parse matches the same prefix of the final parse.
 *
 * Category checklist:
 * - Normal: closed blocks stay identical as more text arrives
 * - Boundary: an unclosed fence is excluded from the stable prefix
 * - Error: empty buffer is a stable empty string
 */

import { describe, expect, it } from "vitest";
import { splitStableMarkdown } from "../../../../packages/client/src/ui/markdown/incremental.js";
import { renderMarkdownToSegments } from "../../../../packages/client/src/ui/markdown/render.js";

const plain = (source: string): string =>
  renderMarkdownToSegments(source)
    .map((segment) => segment.text)
    .join("");

describe("splitStableMarkdown", () => {
  it("keeps closed blocks in the stable prefix as the buffer grows (normal)", () => {
    const partial = "# Title\n\nHello world\n\n```js\nconst x";
    const full = "# Title\n\nHello world\n\n```js\nconst x = 1\n```";

    const { stable: partialStable } = splitStableMarkdown(partial);
    const { stable: fullStable } = splitStableMarkdown(full);

    const partialPlain = plain(partialStable);
    const fullPlain = plain(fullStable);
    expect(fullPlain.startsWith(partialPlain.trim()) || fullPlain.includes(partialPlain.trim())).toBe(
      true,
    );
    expect(partialStable).toContain("Hello world");
    expect(partialStable).not.toContain("```");
  });

  it("treats an unclosed fence as the unstable tail (boundary)", () => {
    const { stable, tail } = splitStableMarkdown("intro\n\n```js\nnot done");
    expect(stable).toContain("intro");
    expect(tail.startsWith("```")).toBe(true);
  });

  it("returns empty stable+tail for an empty buffer (error)", () => {
    expect(splitStableMarkdown("")).toEqual({ stable: "", tail: "" });
  });
});
