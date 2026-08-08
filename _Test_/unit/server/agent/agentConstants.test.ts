/**
 * Unit tests — server orchestration/agent/agentConstants.ts
 */

import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_EXPLORE_CALLS,
  MAX_AGENT_LOOPS,
  MAX_AGENT_SEARCH_CALLS,
  MAX_AGENT_TOTAL_ITERATIONS,
  type SubagentPlanHooks,
} from "../../../../packages/server/src/orchestration/agent/agentConstants.js";

describe("agentConstants", () => {
  it("exports MAX_AGENT_LOOPS as 3", () => {
    expect(MAX_AGENT_LOOPS).toBe(3);
  });

  it("exports MAX_AGENT_SEARCH_CALLS as 4", () => {
    expect(MAX_AGENT_SEARCH_CALLS).toBe(4);
  });

  it("exports MAX_AGENT_EXPLORE_CALLS as 1", () => {
    expect(MAX_AGENT_EXPLORE_CALLS).toBe(1);
  });

  it("exports MAX_AGENT_TOTAL_ITERATIONS as explore + search + verification budget", () => {
    expect(MAX_AGENT_TOTAL_ITERATIONS).toBe(
      MAX_AGENT_EXPLORE_CALLS + MAX_AGENT_SEARCH_CALLS + MAX_AGENT_LOOPS,
    );
  });

  it("SubagentPlanHooks accepts optional search and explore hooks", () => {
    const hooks: SubagentPlanHooks = {
      searchTools: [],
      callSearchTool: async () => ({ isError: false, data: "ok" }),
      exploreCodebase: async () => ({ snapshot: "Structure:\n.\n" }),
    };
    expect(hooks.callSearchTool).toBeDefined();
    expect(hooks.exploreCodebase).toBeDefined();
  });
});
