/**
 * Unit tests — fileProxy/pathUtils.ts
 */

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  assertInsideRoot,
  requireNonEmptyPath,
  resolveAbsolutePath,
} from "../../../../packages/client/src/fileProxy/pathUtils.js";

const root = path.resolve("/tmp/loopy-workspace-test-root");

describe("assertInsideRoot", () => {
  it("allows paths under the workspace root", () => {
    expect(() =>
      assertInsideRoot(root, path.join(root, "src", "a.ts")),
    ).not.toThrow();
  });

  it("rejects paths that escape the root", () => {
    expect(() => assertInsideRoot(root, "/etc/passwd")).toThrow(
      "Path escapes workspace root",
    );
  });
});

describe("requireNonEmptyPath", () => {
  it("trims and returns non-empty paths", () => {
    expect(requireNonEmptyPath("  foo  ")).toBe("foo");
  });

  it("throws for empty values with field name", () => {
    expect(() => requireNonEmptyPath("  ", "pattern")).toThrow(
      "pattern is required",
    );
  });
});

describe("resolveAbsolutePath", () => {
  it("resolves relative paths against cwd inside root", () => {
    const cwd = path.join(root, "src");
    const abs = resolveAbsolutePath(root, cwd, "util.ts");
    expect(abs).toBe(path.join(cwd, "util.ts"));
  });

  it("rejects absolute relativePath input", () => {
    expect(() =>
      resolveAbsolutePath(root, root, "/etc/passwd"),
    ).toThrow("Absolute paths are not allowed");
  });
});
