/**
 * Unit tests — packages/server/src/orchestration/thinkStream.ts (createThinkTagScanner)
 *
 * Covers the incremental think-tag extraction algorithm: partial tags split
 * across chunk boundaries (the core correctness risk), multi-block streams,
 * unclosed tags, case-insensitivity, multiple tag names, and an exact
 * character-by-character reconstruction to prove no text is lost or
 * duplicated across arbitrary chunk boundaries.
 */

import { describe, expect, it } from "vitest";
import { createThinkTagScanner } from "../../../../packages/server/src/orchestration/thinkStream.js";

describe("createThinkTagScanner", () => {
  it("returns the inner text for a tag fully contained in one chunk", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    expect(scanner.push("<agent-think>hello</agent-think>")).toBe("hello");
    expect(scanner.flush()).toBe("");
  });

  it("drops text outside any think tag", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    expect(
      scanner.push("preamble <agent-think>inner</agent-think> trailer"),
    ).toBe("inner");
    expect(scanner.flush()).toBe("");
  });

  it("holds back a partial open tag split across chunks, then emits once closed", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    expect(scanner.push("<age")).toBe("");
    expect(scanner.push("nt-think>hello")).toBe("hello");
    expect(scanner.push(" world</agent-think>")).toBe(" world");
    expect(scanner.flush()).toBe("");
  });

  it("holds back a partial close tag split across chunks", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    expect(scanner.push("<agent-think>hello</agent-th")).toBe("hello");
    expect(scanner.push("ink>ignored")).toBe("");
    expect(scanner.flush()).toBe("");
  });

  it("concatenates multiple sequential blocks in one stream", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    let out = "";
    out += scanner.push("<agent-think>first</agent-think>");
    out += scanner.push(" between blocks ");
    out += scanner.push("<agent-think>second</agent-think>");
    expect(out).toBe("firstsecond");
  });

  it("emits inner text as it arrives even when the tag is never closed", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    expect(scanner.push("<agent-think>only ")).toBe("only ");
    expect(scanner.push("half of it")).toBe("half of it");
    // Nothing left buffered — flush() has nothing new to add.
    expect(scanner.flush()).toBe("");
  });

  it("flush surfaces buffered inner text still pending when the stream is cut mid-tag", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    // A close tag that's ambiguous until more input arrives: withhold the
    // tail that could still become "</agent-think>".
    scanner.push("<agent-think>reasoning</agent-th");
    // Turn ends here (model was truncated) — the held-back "</agent-th"
    // was never actually a complete close tag, so it's still inner text.
    expect(scanner.flush()).toBe("</agent-th");
  });

  it("flush returns empty when nothing is open", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    scanner.push("<agent-think>done</agent-think>");
    expect(scanner.flush()).toBe("");
  });

  it("matches tags case-insensitively", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    expect(scanner.push("<AGENT-THINK>hello</Agent-Think>")).toBe("hello");
  });

  it("recognizes multiple tag names passed to one scanner", () => {
    const scanner = createThinkTagScanner(["agent-think", "redacted_thinking"]);
    expect(scanner.push("<redacted_thinking>a</redacted_thinking>")).toBe("a");
    expect(scanner.push("<agent-think>b</agent-think>")).toBe("b");
  });

  it("releases a lone '<' that never resolves into a tag, once disproven by later text", () => {
    const scanner = createThinkTagScanner(["agent-think"]);
    // "<" alone could still be the start of "<agent-think>" — held back.
    expect(scanner.push("hi <")).toBe("");
    // Enough more text arrives to prove it wasn't: released (and, since
    // we're still outside any tag, discarded rather than emitted).
    expect(scanner.push(" there was no tag here")).toBe("");
    expect(scanner.flush()).toBe("");
  });

  it("reconstructs the exact inner text when fed one character at a time", () => {
    const document =
      "noise before <agent-think>line one\nline two, a longer line of reasoning</agent-think> noise after " +
      "<agent-think>second block</agent-think> trailing noise";
    const scanner = createThinkTagScanner(["agent-think"]);
    let out = "";
    for (const character of document) {
      out += scanner.push(character);
    }
    out += scanner.flush();
    expect(out).toBe(
      "line one\nline two, a longer line of reasoningsecond block",
    );
  });
});
