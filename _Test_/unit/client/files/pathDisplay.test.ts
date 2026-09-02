/**
 * Unit tests — packages/client/src/utils/pathDisplay.ts
 */

import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPromptLabel,
  formatDisplayPath,
  formatHumanError,
  truncatePathMiddle,
} from "../../../../packages/client/src/utils/pathDisplay.js";

const home = os.homedir();

describe("formatDisplayPath", () => {
  it("abbreviates paths under home with ~", () => {
    const nested = path.join(home, "Documents", "file.txt");
    expect(formatDisplayPath(nested)).toBe(
      path.join("~", "Documents", "file.txt"),
    );
  });

  it("returns ~ for home directory itself", () => {
    expect(formatDisplayPath(home)).toBe("~");
  });

  it("leaves paths outside home unchanged (resolved)", () => {
    const outside = path.resolve(os.tmpdir(), "atlas-outside-test");
    if (outside.startsWith(home + path.sep)) {
      return; // skip on unusual homedir layouts
    }
    expect(formatDisplayPath(outside)).toBe(outside);
  });
});

describe("truncatePathMiddle", () => {
  it("returns short paths unchanged", () => {
    expect(truncatePathMiddle("~/short.txt", 20)).toBe("~/short.txt");
  });

  it("truncates long paths with ellipsis in the middle", () => {
    const long = "~/very/long/path/to/some/deep/file.txt";
    const out = truncatePathMiddle(long, 20);
    expect(out.length).toBe(20);
    expect(out).toContain("…");
  });
});

describe("buildPromptLabel", () => {
  it("returns fixed prompt regardless of cwd", () => {
    expect(buildPromptLabel("/any/cwd")).toBe("> ");
  });
});

describe("formatHumanError", () => {
  it("maps ENOENT with tilde path", () => {
    const file = path.join(home, "missing.txt");
    const msg = formatHumanError("read", file, { code: "ENOENT" });
    expect(msg).toBe(
      `Cannot read ${path.join("~", "missing.txt")} — file or directory does not exist.`,
    );
  });

  it("maps EACCES and EPERM", () => {
    const err = { code: "EACCES" };
    expect(formatHumanError("write", "/x", err)).toMatch(/permission denied/);
    expect(formatHumanError("write", "/x", { code: "EPERM" })).toMatch(
      /permission denied/,
    );
  });

  it("maps EISDIR and ENOTDIR", () => {
    expect(formatHumanError("read", "/x", { code: "EISDIR" })).toMatch(
      /path is a directory/,
    );
    expect(formatHumanError("read", "/x", { code: "ENOTDIR" })).toMatch(
      /not a directory/,
    );
  });

  it("falls back to error message for unknown codes", () => {
    expect(
      formatHumanError("read", "/x", new Error("disk full")),
    ).toBe("Cannot read /x — disk full");
  });
});
