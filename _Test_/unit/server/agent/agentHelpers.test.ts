import { describe, expect, it } from "vitest";
import {
  contextHasWorkspaceStructure,
  summarizeWorkspaceStackHint,
} from "../../../../packages/server/src/orchestration/agent/agentHelpers.js";

describe("contextHasWorkspaceStructure", () => {
  it("returns true when Structure snapshot is present", () => {
    expect(
      contextHasWorkspaceStructure("[Prior session]\nStructure:\npackages/\n"),
    ).toBe(true);
  });

  it("returns false when no structure block exists", () => {
    expect(contextHasWorkspaceStructure("[User preferences]\n- use vitest")).toBe(
      false,
    );
  });
});

describe("summarizeWorkspaceStackHint", () => {
  it("returns a short hint for Node/TypeScript monorepos", () => {
    const hint = summarizeWorkspaceStackHint(
      "Structure:\npackage.json\ntsconfig.json\npackages/client/\n_Test_/\n",
    );
    expect(hint).toContain("Node.js");
    expect(hint).toContain("TypeScript");
  });

  it("detects Python projects", () => {
    const hint = summarizeWorkspaceStackHint(
      "Structure:\npyproject.toml\ntests/\nconftest.py\n",
    );
    expect(hint).toContain("Python");
    expect(hint).toContain("pytest");
  });

  it("detects Go projects", () => {
    const hint = summarizeWorkspaceStackHint(
      "Structure:\ngo.mod\ncmd/\ninternal/\nfoo_test.go\n",
    );
    expect(hint).toContain("Go");
    expect(hint).toContain("go test");
  });

  it("returns fallback when structure exists but stack is unclear", () => {
    const hint = summarizeWorkspaceStackHint("Structure:\nREADME.md\nsrc/\n");
    expect(hint).toContain("Structure snapshot present");
  });

  it("returns null when no structure snapshot exists", () => {
    expect(summarizeWorkspaceStackHint("[User preferences]\n- foo")).toBeNull();
  });
});
