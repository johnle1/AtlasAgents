/**
 * Unit tests — fileProxy pathUtils.
 */

import { describe, expect, it } from "vitest";
import {
  assertInsideRoot,
  requireNonEmptyPath,
  resolveAbsolutePath,
} from "../../../../packages/client/src/fileProxy/pathUtils.js";

describe("assertInsideRoot", () => {
  it("allows paths under the root", () => {
    expect(() => assertInsideRoot("/proj", "/proj/src/a.ts")).not.toThrow();
  });

  it("rejects paths that escape the root", () => {
    expect(() => assertInsideRoot("/proj", "/etc/passwd")).toThrow(
      /escapes workspace root/i,
    );
  });
});

describe("requireNonEmptyPath", () => {
  it("trims and returns non-empty values", () => {
    expect(requireNonEmptyPath("  src/a.ts  ")).toBe("src/a.ts");
  });

  it("throws for empty values", () => {
    expect(() => requireNonEmptyPath("  ", "pattern")).toThrow(
      "pattern is required",
    );
  });
});

describe("resolveAbsolutePath", () => {
  it("joins relative paths under the cwd and root", () => {
    const abs = resolveAbsolutePath("/proj", "/proj/src", "a.ts");
    expect(abs).toContain("a.ts");
  });

  it("rejects absolute relativePath inputs", () => {
    expect(() =>
      resolveAbsolutePath("/proj", "/proj", "/etc/passwd"),
    ).toThrow();
  });
});
