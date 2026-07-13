/**
 * Unit tests — server orchestration/advisor/advisorConstants.ts
 */

import { describe, expect, it } from "vitest";
import {
  MAX_ADVISOR_EXPLORE_CALLS,
  MAX_ADVISOR_LOOPS,
  MAX_ADVISOR_SEARCH_CALLS,
  MAX_ADVISOR_TOTAL_ITERATIONS,
  type AdvisorPlanHooks,
} from "../../packages/server/src/orchestration/advisor/advisorConstants.js";

describe("advisorConstants", () => {
  it("exports MAX_ADVISOR_LOOPS as 3", () => {
    expect(MAX_ADVISOR_LOOPS).toBe(3);
  });

  it("exports MAX_ADVISOR_SEARCH_CALLS as 4", () => {
    expect(MAX_ADVISOR_SEARCH_CALLS).toBe(4);
  });

  it("exports MAX_ADVISOR_EXPLORE_CALLS as 1", () => {
    expect(MAX_ADVISOR_EXPLORE_CALLS).toBe(1);
  });

  it("exports MAX_ADVISOR_TOTAL_ITERATIONS as explore + search + verification budget", () => {
    expect(MAX_ADVISOR_TOTAL_ITERATIONS).toBe(
      MAX_ADVISOR_EXPLORE_CALLS + MAX_ADVISOR_SEARCH_CALLS + MAX_ADVISOR_LOOPS,
    );
  });

  it("AdvisorPlanHooks accepts optional search and explore hooks", () => {
    const hooks: AdvisorPlanHooks = {
      searchTools: [],
      callSearchTool: async () => ({ isError: false, data: "ok" }),
      exploreCodebase: async () => ({ snapshot: "Structure:\n.\n" }),
    };
    expect(hooks.callSearchTool).toBeDefined();
    expect(hooks.exploreCodebase).toBeDefined();
  });
});
