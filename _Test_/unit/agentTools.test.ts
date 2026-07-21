/**
 * Unit tests — server orchestration/agent/agentTools.ts
 */

import { describe, expect, it } from "vitest";
import { AGENT_PLAN_TOOL_SCHEMA } from "../../packages/server/src/orchestration/agent/agentThink.js";
import {
  AGENT_EXPLORATION_RULES,
  AGENT_RETRIEVAL_RULES,
  EXPLORE_CODEBASE_TOOL,
  EXPLORE_CODEBASE_TOOL_NAME,
  hasAgentSearchTools,
  isAgentPrePlanToolName,
  isAgentSearchToolName,
  isExploreCodebaseTool,
  isSubmitPlanTool,
  PROPOSE_PLAN_TOOL,
  SUBMIT_PLAN_TOOL,
  SUBMIT_PLAN_TOOL_NAME,
} from "../../packages/server/src/orchestration/agent/agentTools.js";
import type { ToolSchema } from "../../packages/server/src/orchestration/tools/types.js";

const tokensaveTool = (name: string): ToolSchema => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [] },
  },
});

describe("hasAgentSearchTools", () => {
  it("returns false for empty array", () => {
    expect(hasAgentSearchTools([])).toBe(false);
  });

  it("returns true when all tools are tokensave_*", () => {
    expect(
      hasAgentSearchTools([
        tokensaveTool("tokensave_search"),
        tokensaveTool("tokensave_context"),
      ]),
    ).toBe(true);
  });

  it("returns false when no tokensave_* tools", () => {
    expect(hasAgentSearchTools([tokensaveTool("read_file")])).toBe(false);
  });

  it("returns true for mixed arrays containing tokensave_*", () => {
    expect(
      hasAgentSearchTools([
        tokensaveTool("read_file"),
        tokensaveTool("tokensave_search"),
      ]),
    ).toBe(true);
  });
});

describe("AGENT_RETRIEVAL_RULES", () => {
  const expectedTools = [
    "tokensave_search",
    "tokensave_context",
    "tokensave_callers",
    "tokensave_impact",
    "tokensave_callees",
    "tokensave_status",
  ];

  for (const tool of expectedTools) {
    it(`mentions ${tool}`, () => {
      expect(AGENT_RETRIEVAL_RULES).toContain(tool);
    });
  }

  it("mentions submit_plan guidance", () => {
    expect(AGENT_RETRIEVAL_RULES).toContain("submit_plan");
  });
});

describe("AGENT_EXPLORATION_RULES", () => {
  it("mentions explore_codebase and EXPLORATION", () => {
    expect(AGENT_EXPLORATION_RULES).toContain("explore_codebase");
    expect(AGENT_EXPLORATION_RULES).toContain("EXPLORATION");
  });
});

describe("explore codebase tool helpers", () => {
  it("identifies explore_codebase tool name", () => {
    expect(isExploreCodebaseTool(EXPLORE_CODEBASE_TOOL_NAME)).toBe(true);
    expect(isExploreCodebaseTool("tokensave_search")).toBe(false);
  });

  it("identifies tokensave search tool names", () => {
    expect(isAgentSearchToolName("tokensave_search")).toBe(true);
    expect(isAgentSearchToolName("explore_codebase")).toBe(false);
  });

  it("identifies submit_plan tool name", () => {
    expect(isSubmitPlanTool(SUBMIT_PLAN_TOOL_NAME)).toBe(true);
    expect(isSubmitPlanTool("explore_codebase")).toBe(false);
  });

  it("groups pre-plan tools", () => {
    expect(isAgentPrePlanToolName("explore_codebase")).toBe(true);
    expect(isAgentPrePlanToolName("tokensave_context")).toBe(true);
    expect(isAgentPrePlanToolName("submit_plan")).toBe(false);
  });
});

describe("EXPLORE_CODEBASE_TOOL", () => {
  it("requires a reason argument", () => {
    expect(EXPLORE_CODEBASE_TOOL.function.name).toBe("explore_codebase");
    expect(EXPLORE_CODEBASE_TOOL.function.parameters.required).toEqual([
      "reason",
    ]);
  });
});

describe("SUBMIT_PLAN_TOOL / AGENT_PLAN_TOOL_SCHEMA", () => {
  it("exports submit_plan schema from agentThink", () => {
    expect(AGENT_PLAN_TOOL_SCHEMA.function.name).toBe("submit_plan");
    expect(SUBMIT_PLAN_TOOL.function.name).toBe("submit_plan");
  });

  it("PROPOSE_PLAN_TOOL aliases SUBMIT_PLAN_TOOL", () => {
    expect(PROPOSE_PLAN_TOOL).toBe(SUBMIT_PLAN_TOOL);
  });

  it("requires subtasks, execution, agentCount, and risks", () => {
    expect(SUBMIT_PLAN_TOOL.function.parameters.required).toEqual([
      "subtasks",
      "execution",
      "agentCount",
      "risks",
    ]);
  });

  it("allows parallel, sequential, and mixed execution", () => {
    const execution = SUBMIT_PLAN_TOOL.function.parameters.properties
      .execution as { enum: string[] };
    expect(execution.enum).toEqual(["parallel", "sequential", "mixed"]);
  });

  it("requires id, text, dependsOn, agentId, and agentLabel on subtask items", () => {
    const items = SUBMIT_PLAN_TOOL.function.parameters.properties
      .subtasks as { items: { required: string[] } };
    expect(items.items.required).toEqual([
      "id",
      "text",
      "dependsOn",
      "agentId",
      "agentLabel",
    ]);
  });
});
