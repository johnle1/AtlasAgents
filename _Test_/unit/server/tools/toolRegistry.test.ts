/**
 * Unit tests — orchestration/tools/registry.ts
 */

import { describe, expect, it } from "vitest";
import type { Agent } from "../../../../packages/server/src/orchestration/agent/agent.js";
import {
  createToolRegistry,
  createAgentTurnToolRegistry,
  getToolHandlerMap,
  getToolSchemaByName,
  getToolSchemas,
} from "../../../../packages/server/src/orchestration/tools/registry.js";
import type { ToolSchema } from "../../../../packages/server/src/orchestration/tools/types.js";

const extraTool = (name: string): ToolSchema => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [] },
  },
});

describe("createToolRegistry", () => {
  it("includes standard tools plus escalate, finish, and token-save handlers", () => {
    const registry = createToolRegistry({} as Agent, [
      extraTool("tokensave_search"),
    ]);
    const names = getToolSchemas(registry).map((s) => s.function.name);

    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("run_command");
    expect(names).toContain("escalate");
    expect(names).toContain("finish");
    expect(names).toContain("tokensave_search");
  });
});

describe("getToolHandlerMap", () => {
  it("indexes handlers by schema function name", () => {
    const registry = createToolRegistry({} as Agent);
    const map = getToolHandlerMap(registry);

    expect(map.get("finish")?.schema.function.name).toBe("finish");
    expect(map.size).toBe(registry.length);
  });
});

describe("getToolSchemaByName", () => {
  it("returns the matching schema or undefined", () => {
    const registry = createToolRegistry({} as Agent);

    expect(getToolSchemaByName(registry, "read_file")?.function.name).toBe(
      "read_file",
    );
    expect(getToolSchemaByName(registry, "missing_tool")).toBeUndefined();
  });
});

describe("ToolHandler.readOnly", () => {
  it("read_file is marked read-only — this is what lets agentTurn.ts's runToolCalls batch consecutive reads concurrently (normal)", () => {
    const registry = createAgentTurnToolRegistry();
    const readFile = getToolHandlerMap(registry).get("read_file");
    expect(readFile?.readOnly).toBe(true);
  });

  it("every mutating or control-flow built-in tool is NOT marked read-only — regression guard against accidentally letting a write batch concurrently (error/negative case)", () => {
    const registry = createAgentTurnToolRegistry();
    const map = getToolHandlerMap(registry);

    for (const name of [
      "write_file",
      "edit_file",
      "run_command",
      "update_plan",
      "run_steps_parallel",
      "finish",
    ]) {
      expect(map.get(name)?.readOnly).not.toBe(true);
    }
  });
});
