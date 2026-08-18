/**
 * Unit tests — client ui/markdown/render.ts
 *
 * `marked` lexes; we map tokens to styled segments. Tests assert on the
 * segment list (no Ink tree). Unclosed fences must not throw.
 *
 * Category checklist:
 * - Normal: heading, bold, list, fenced code
 * - Boundary: unclosed fence mid-stream renders as a plain paragraph
 * - Error: NO_COLOR strips SGR from the ANSI serialization
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderMarkdownToAnsi,
  renderMarkdownToSegments,
} from "../../../../packages/client/src/ui/markdown/render.js";

describe("renderMarkdownToSegments", () => {
  it("renders a heading as a bold heading segment (normal)", () => {
    const segments = renderMarkdownToSegments("# Hello");
    const joined = segments.map((segment) => segment.text).join("");
    expect(joined).toContain("Hello");
    expect(segments.some((segment) => segment.heading && segment.bold)).toBe(
      true,
    );
  });

  it("renders **bold** as a bold segment (normal)", () => {
    const segments = renderMarkdownToSegments("say **please** now");
    expect(segments.some((segment) => segment.bold && segment.text.includes("please"))).toBe(
      true,
    );
  });

  it("renders a list with a bullet marker (normal)", () => {
    const joined = renderMarkdownToSegments("- alpha\n- beta")
      .map((segment) => segment.text)
      .join("");
    expect(joined).toContain("alpha");
    expect(joined).toContain("beta");
    expect(joined).toMatch(/[•*-]/);
  });

  it("renders a closed fence as a code block (normal)", () => {
    const segments = renderMarkdownToSegments("```js\nconst x = 1\n```");
    const joined = segments.map((segment) => segment.text).join("");
    expect(joined).toContain("const x = 1");
    expect(segments.some((segment) => segment.code)).toBe(true);
  });

  it("renders an unclosed fence as a plain paragraph without throwing (boundary)", () => {
    expect(() =>
      renderMarkdownToSegments("```js\nconst x = 1"),
    ).not.toThrow();
    const joined = renderMarkdownToSegments("```js\nconst x = 1")
      .map((segment) => segment.text)
      .join("");
    expect(joined).toContain("const x = 1");
  });
});

describe("renderMarkdownToAnsi — NO_COLOR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits no SGR color sequences when NO_COLOR is set (error / env)", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", undefined);
    const ansi = renderMarkdownToAnsi("# Hello **world**");
    expect(ansi).toContain("Hello");
    expect(ansi).not.toMatch(/\x1b\[[0-9;]*m/);
  });
});
