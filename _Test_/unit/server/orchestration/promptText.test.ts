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
      '- read_file (Read the full content of a file from the workspace.): {"tool":"read_file","path":"<Relative path from workspace root>"}',
    );
  });

  it("includes the tool's own description in parentheses — the main signal for an MCP tool with a terse name", () => {
    const line = schemaToPromptLine({
      type: "function",
      function: {
        name: "mcp__github__create_issue",
        description: "Creates a new issue in a GitHub repository.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    });
    expect(line).toBe(
      '- mcp__github__create_issue (Creates a new issue in a GitHub repository.): {"tool":"mcp__github__create_issue",}',
    );
  });

  it("omits the parenthetical entirely when description is empty", () => {
    const line = schemaToPromptLine({
      type: "function",
      function: {
        name: "no_description_tool",
        description: "",
        parameters: { type: "object", properties: {}, required: [] },
      },
    });
    expect(line).toBe('- no_description_tool: {"tool":"no_description_tool",}');
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
