/**
 * Unit tests — sandbox backend capability probes.
 *
 * Category checklist:
 * - Normal: isBinaryOnPath finds a binary guaranteed to exist (node itself)
 * - Error: isBinaryOnPath returns false for a binary that cannot exist
 */

import { describe, expect, it } from "vitest";
import { isBinaryOnPath } from "../../../../packages/client/src/fileProxy/sandbox/capability.js";

describe("isBinaryOnPath", () => {
  it("returns true for a binary that is definitely on PATH in this test run (normal)", () => {
    // The test runner itself is running under node, so it must be resolvable.
    expect(isBinaryOnPath("node")).toBe(true);
  });

  it("returns false for a binary name that cannot exist (error)", () => {
    expect(isBinaryOnPath("atlas-definitely-not-a-real-binary-xyz")).toBe(
      false,
    );
  });
});
