/**
 * Unit tests — server orchestration/tools/promptText.ts
 */

import { describe, expect, it } from "vitest";
import { readFileTool } from "../../../../packages/server/src/orchestration/tools/readFileHandler.js";
import {
  buildLegacyToolBlock,
  schemaToPromptLine,
  TOOL_END,
  TOOL_START,
} from "../../../../packages/server/src/orchestration/tools/promptText.js";

describe("schemaToPromptLine", () => {
  it("renders required fields with description hints", () => {
    const line = schemaToPromptLine(readFileTool.schema);
    expect(line).toBe(
      '- read_file: {"tool":"read_file","path":"<Relative path from workspace root>"}',
    );
  });

  it("marks optional fields with a trailing question mark in the hint", () => {
    const line = schemaToPromptLine({
      type: "function",
      function: {
        name: "demo_tool",
        description: "demo",
        parameters: {
          type: "object",
          properties: {
            requiredField: { type: "string", description: "must have" },
            optionalField: { type: "string" },
          },
          required: ["requiredField"],
        },
      },
    });
    expect(line).toContain('"requiredField":"<must have>"');
    expect(line).toContain('"optionalField":"...?"');
  });
});

describe("buildLegacyToolBlock", () => {
  it("includes format rules, tool lines, and worked examples", () => {
    const block = buildLegacyToolBlock([readFileTool.schema]);
    expect(block).toContain("[TOOL FORMAT]");
    expect(block).toContain(`${TOOL_START}{"tool":"<name>", ...fields...}${TOOL_END}`);
    expect(block).toContain(schemaToPromptLine(readFileTool.schema));
    expect(block).toContain("Example write_file");
    expect(block).toContain("Example edit_file");
    expect(block).toContain(TOOL_START);
    expect(block).toContain(TOOL_END);
  });
});
