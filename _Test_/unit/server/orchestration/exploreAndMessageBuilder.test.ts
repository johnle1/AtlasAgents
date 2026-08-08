/**
 * Unit tests — orchestration/exploreCodebase.ts and subagentMessageBuilder.ts
 */

import { describe, expect, it, vi } from "vitest";
import { exploreCodebase } from "../../../../packages/server/src/orchestration/exploreCodebase.js";
import type { WorkspaceManager } from "../../../../packages/server/src/workspace/manager/workspaceManager.js";
import { buildAgentMessages } from "../../../../packages/server/src/orchestration/subagent/subagentMessageBuilder.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";

describe("exploreCodebase", () => {
  it("emits progress and returns a structure snapshot", async () => {
    const workspace = {
      listStructure: vi.fn().mockResolvedValue("  src/\n  package.json"),
    } as unknown as WorkspaceManager;
    const emit = vi.fn();

    const result = await exploreCodebase(workspace, emit, new AbortController().signal);

    expect(emit).toHaveBeenCalledWith({ kind: "token", text: "  ● ListDir(.)\n" });
    expect(workspace.listStructure).toHaveBeenCalledWith(2);
    expect(result.snapshot).toContain("Structure:");
    expect(result.snapshot).toContain("src/");
  });
});

describe("buildAgentMessages", () => {
  it("returns system and user messages with the subtask", () => {
    const messages = buildAgentMessages(
      "Fix the failing test",
      "",
      "",
      emptyCommandPlan(),
      true,
      [],
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toBe("Fix the failing test");
    expect(messages[0]?.content.length).toBeGreaterThan(0);
  });
});
