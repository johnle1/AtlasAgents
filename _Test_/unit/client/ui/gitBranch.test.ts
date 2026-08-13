/**
 * Unit tests — client ui/footer/gitBranch.ts
 *
 * Pure parser over `git rev-parse --abbrev-ref HEAD` stdout. The runner is
 * injected so unit tests never spawn a process.
 *
 * Category checklist:
 * - Normal: a branch name is returned
 * - Boundary: detached HEAD / empty stdout → null
 * - Error: runner throw → null
 */

import { describe, expect, it } from "vitest";
import {
  parseGitBranch,
  readGitBranch,
} from "../../../../packages/client/src/ui/footer/gitBranch.js";

describe("parseGitBranch", () => {
  it("returns a trimmed branch name (normal)", () => {
    expect(parseGitBranch("main\n")).toBe("main");
  });

  it("returns null for detached HEAD (boundary)", () => {
    expect(parseGitBranch("HEAD\n")).toBeNull();
  });

  it("returns null for empty stdout (boundary)", () => {
    expect(parseGitBranch("   ")).toBeNull();
  });
});

describe("readGitBranch", () => {
  it("passes cwd to git -C and returns the parsed name (normal)", () => {
    const run = (cmd: string, args: string[]): string | null => {
      expect(cmd).toBe("git");
      expect(args).toEqual(["-C", "/tmp/proj", "rev-parse", "--abbrev-ref", "HEAD"]);
      return "feature/x\n";
    };
    expect(readGitBranch("/tmp/proj", run)).toBe("feature/x");
  });

  it("returns null when the runner throws (error)", () => {
    const run = (): string | null => {
      throw new Error("not a git repo");
    };
    expect(readGitBranch("/tmp/proj", run)).toBeNull();
  });
});
