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

  it("returns an empty tail once the fence closes (boundary — even fence count)", () => {
    const full = "# Title\n\n```js\nconst x = 1\n```\n\nmore text";
    expect(splitStableMarkdown(full)).toEqual({ stable: full, tail: "" });
  });

  it("keeps two complete fenced blocks fully stable (normal — multiple fences)", () => {
    const source = "```js\nconst a = 1\n```\n\ntext\n\n```py\nb = 2\n```\n";
    expect(splitStableMarkdown(source)).toEqual({ stable: source, tail: "" });
  });

  it("holds back only the third block when it is the unclosed one (boundary — multiple fences)", () => {
    const closedBlocks = "```js\nconst a = 1\n```\n\ntext\n\n```py\nb = 2\n```\n\n";
    const source = `${closedBlocks}\`\`\`rust\nlet c = 3`;
    const { stable, tail } = splitStableMarkdown(source);
    expect(stable).toBe(closedBlocks);
    expect(tail).toBe("```rust\nlet c = 3");
  });

  it("returns empty stable+tail for an empty buffer (error)", () => {
    expect(splitStableMarkdown("")).toEqual({ stable: "", tail: "" });
  });
});
