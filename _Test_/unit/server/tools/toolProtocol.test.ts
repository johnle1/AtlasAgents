/**
 * Unit tests — server orchestration/toolProtocol.ts
 */

import { describe, expect, it } from "vitest";
import { finishTool } from "../../../../packages/server/src/orchestration/tools/finishHandler.js";
import { readFileTool } from "../../../../packages/server/src/orchestration/tools/readFileHandler.js";
import { writeFileTool } from "../../../../packages/server/src/orchestration/tools/writeFileHandler.js";
import {
  extractToolFromText,
  parseAgentToolCall,
  parseAllToolCalls,
  stripMarkdownFence,
  stripMarkdownFencesFromText,
  stripThinking,
  THINKING_TAG_CLOSE,
  THINKING_TAG_OPEN,
} from "../../../../packages/server/src/orchestration/toolProtocol.js";

const registry = [readFileTool, finishTool, writeFileTool];

describe("stripThinking", () => {
  it("removes thinking blocks and trims the remainder", () => {
    const text = [
      `${THINKING_TAG_OPEN}`,
      "know: test",
      `${THINKING_TAG_CLOSE}`,
      "",
      "<<TOOL>>{}<<END>>",
    ].join("\n");
    expect(stripThinking(text)).toBe("<<TOOL>>{}<<END>>");
  });
});

describe("stripMarkdownFencesFromText", () => {
  it("drops lines that start with markdown fence markers", () => {
    const input = "line one\n```tsx\n```\nline two";
    expect(stripMarkdownFencesFromText(input)).toBe("line one\nline two");
  });
});

describe("stripMarkdownFence", () => {
  it("unwraps a complete fenced string", () => {
    const fenced = "```ts\nhello\nworld\n```";
    expect(stripMarkdownFence(fenced)).toBe("hello\nworld");
  });

  it("unwraps opening fence only when no closing fence in body", () => {
    const openOnly = "```json\n{\"a\":1}";
    expect(stripMarkdownFence(openOnly)).toBe("{\"a\":1}");
  });

  it("returns value unchanged when no fence is present", () => {
    expect(stripMarkdownFence("plain text")).toBe("plain text");
  });
});

describe("parseAgentToolCall", () => {
  it("parses valid JSON tool calls", () => {
    const raw = JSON.stringify({ tool: "read_file", path: "src/App.tsx" });
    expect(parseAgentToolCall(raw, registry)).toEqual({
      name: "read_file",
      args: { path: "src/App.tsx" },
    });
  });

  it("returns null for unknown tools or missing required fields", () => {
    expect(parseAgentToolCall('{"tool":"nope","path":"x"}', registry)).toBeNull();
    expect(parseAgentToolCall('{"tool":"read_file"}', registry)).toBeNull();
  });

  it("recovers malformed JSON with literal newlines in content fields", () => {
    const broken =
      '{"tool":"write_file","path":"src/App.tsx","content":"export const x = 1;\nexport const y = 2;"}';
    const parsed = parseAgentToolCall(broken, registry);
    expect(parsed?.name).toBe("write_file");
    expect(parsed?.args.path).toBe("src/App.tsx");
    expect(parsed?.args.content).toContain("export const y = 2;");
  });
});

describe("parseAllToolCalls", () => {
  it("parses every <<TOOL>> block and flags malformed blocks", () => {
    const readCall = JSON.stringify({ tool: "read_file", path: "a.ts" });
    const text = [
      `<<TOOL>>${readCall}<<END>>`,
      '<<TOOL>>{"tool":"read_file"}<<END>>',
      `<<TOOL>>${readCall}<<END>>`,
    ].join("\n");

    const result = parseAllToolCalls(text, registry);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]?.name).toBe("read_file");
    expect(result.hadMalformedBlock).toBe(true);
  });
});

describe("extractToolFromText", () => {
  it("returns the first successfully parsed tool call", () => {
    const first = JSON.stringify({ tool: "read_file", path: "first.ts" });
    const second = JSON.stringify({ tool: "read_file", path: "second.ts" });
    const text = `<<TOOL>>${first}<<END>>\n<<TOOL>>${second}<<END>>`;
    expect(extractToolFromText(text, registry)).toEqual({
      name: "read_file",
      args: { path: "first.ts" },
    });
  });

  it("returns null when no valid tool calls exist", () => {
    expect(extractToolFromText("no tools here", registry)).toBeNull();
  });
});

describe("finishTool schema", () => {
  it("invites markdown formatting in the summary description", () => {
    const summary = finishTool.schema.function.parameters.properties.summary as {
      description?: string;
    };
    expect(summary.description).toContain("Markdown welcome");
  });
});
