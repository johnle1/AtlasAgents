/**
 * Unit tests — fileProxy pathUtils.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertInsideRoot,
  isInsideRoot,
  requireNonEmptyPath,
  resolveAbsolutePath,
} from "../../../../packages/client/src/fileProxy/pathUtils.js";

describe("isInsideRoot", () => {
  it("returns true for a nested path (normal)", () => {
    expect(isInsideRoot("/proj", "/proj/src/a.ts")).toBe(true);
  });

  it("returns true when candidate equals the root (boundary)", () => {
    expect(isInsideRoot("/proj", "/proj")).toBe(true);
  });

  it("returns false for a path outside the root (error)", () => {
    expect(isInsideRoot("/proj", "/tmp/outside-atlas.ts")).toBe(false);
  });
});

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

describe("symlink escape (real filesystem)", () => {
  // path.relative()-only confinement is symlink-blind: a symlink whose own
  // path string sits under workspaceRoot can still point anywhere on disk.
  // These use real fs entries (not string fixtures) so the realpath
  // resolution in isInsideRoot/assertInsideRoot is actually exercised.
  let testRoot: string;
  let workspaceRoot: string;
  let outsideDir: string;
  let existingOutsideFile: string;

  beforeAll(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-symlink-test-"));
    workspaceRoot = path.join(testRoot, "workspace");
    outsideDir = path.join(testRoot, "outside");
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(outsideDir);
    existingOutsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(existingOutsideFile, "outside contents");
    fs.symlinkSync(outsideDir, path.join(workspaceRoot, "escape"));
  });

  afterAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("rejects a path through a symlink to an existing file outside the root", () => {
    const viaSymlink = path.join(workspaceRoot, "escape", "secret.txt");
    // The naive path.relative() check would see this as workspaceRoot/escape/secret.txt
    // (a descendant string) and wrongly allow it.
    expect(isInsideRoot(workspaceRoot, viaSymlink)).toBe(false);
    expect(() => assertInsideRoot(workspaceRoot, viaSymlink)).toThrow(
      /escapes workspace root/i,
    );
  });

  it("rejects a path through a symlink to a not-yet-existing file outside the root", () => {
    // The target file doesn't exist yet (e.g. a `file.write` create) — the
    // closest-existing-ancestor fallback must still dereference the symlink.
    const viaSymlink = path.join(workspaceRoot, "escape", "new-file.txt");
    expect(isInsideRoot(workspaceRoot, viaSymlink)).toBe(false);
  });

  it("still allows a real nested path under the root", () => {
    const real = path.join(workspaceRoot, "src", "a.ts");
    expect(isInsideRoot(workspaceRoot, real)).toBe(true);
  });
});
