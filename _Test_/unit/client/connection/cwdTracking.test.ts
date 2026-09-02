/**
 * Unit tests — cwdTracking helpers for persisting agent shell directory changes.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CWD_MARKER,
  canonicalizeTrackedCwd,
  extractCwdFromOutput,
  isWindowsShell,
  trackedCwdsEqual,
  wrapCommandForCwdTracking,
} from "../../../../packages/client/src/fileProxy/cwdTracking.js";
import { runShell } from "../../../../packages/client/src/fileProxy/shellRunner.js";

describe("isWindowsShell", () => {
  it("matches process.platform win32", () => {
    expect(isWindowsShell()).toBe(process.platform === "win32");
  });
});

describe("extractCwdFromOutput", () => {
  it("returns stdout unchanged when marker is missing", () => {
    const stdout = "hello\nworld";
    expect(extractCwdFromOutput(stdout)).toEqual({ cleanedStdout: stdout });
  });

  it("strips marker and returns newCwd from the last occurrence", () => {
    const rawCwd = "/tmp/project";
    const stdout = `before output${CWD_MARKER}${rawCwd}`;
    expect(extractCwdFromOutput(stdout)).toEqual({
      cleanedStdout: "before output",
      newCwd: canonicalizeTrackedCwd(rawCwd),
    });
  });

  it("uses the last marker when output contains nested noise", () => {
    const rawCwd = "/correct/path";
    const stdout = `noise ${CWD_MARKER}/wrong${CWD_MARKER}${rawCwd}`;
    expect(extractCwdFromOutput(stdout)).toEqual({
      cleanedStdout: `noise ${CWD_MARKER}/wrong`,
      newCwd: canonicalizeTrackedCwd(rawCwd),
    });
  });

  it("returns cleaned stdout without newCwd when marker has no path", () => {
    const stdout = `output${CWD_MARKER}`;
    expect(extractCwdFromOutput(stdout)).toEqual({ cleanedStdout: "output" });
  });

  it("strips trailing newlines from Windows echo output", () => {
    const stdout = `output${CWD_MARKER}C:\\Users\\dev\\project\r\n`;
    expect(extractCwdFromOutput(stdout)).toEqual({
      cleanedStdout: "output",
      newCwd: canonicalizeTrackedCwd("C:\\Users\\dev\\project"),
    });
  });
});

describe("trackedCwdsEqual", () => {
  it("treats paths as equal when only separators differ on Unix", () => {
    expect(trackedCwdsEqual("/tmp/foo/bar", "/tmp/foo/bar")).toBe(true);
  });

  it("canonicalizes relative segments before comparing", () => {
    const base = path.resolve(os.tmpdir(), "atlas-cwd-equal-test");
    expect(trackedCwdsEqual(path.join(base, "app"), path.join(base, "app", "."))).toBe(
      true,
    );
  });
});

const describeUnix =
  process.platform === "win32" ? describe.skip : describe;

describeUnix("wrapCommandForCwdTracking — Unix shell integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-cwd-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const runTracked = async (command: string) => {
    const wrapped = wrapCommandForCwdTracking(command, false);
    const result = await runShell(wrapped, tempDir);
    const { cleanedStdout, newCwd } = extractCwdFromOutput(result.stdout);
    return {
      ...result,
      stdout: cleanedStdout,
      newCwd: newCwd ? canonicalizeTrackedCwd(newCwd) : undefined,
    };
  };

  it("plain cd foo updates newCwd to the child directory", async () => {
    const fooDir = path.join(tempDir, "foo");
    await fs.mkdir(fooDir);

    const result = await runTracked("cd foo");

    expect(result.exitCode).toBe(0);
    expect(trackedCwdsEqual(result.newCwd ?? "", fooDir)).toBe(true);
  });

  it("mkdir app && cd app updates newCwd to the new project directory", async () => {
    const result = await runTracked("mkdir app && cd app");

    expect(result.exitCode).toBe(0);
    expect(trackedCwdsEqual(result.newCwd ?? "", path.join(tempDir, "app"))).toBe(
      true,
    );
  });

  it("preserves non-zero exit code while still reporting cwd", async () => {
    const result = await runTracked("cd does-not-exist");

    expect(result.exitCode).not.toBe(0);
    expect(trackedCwdsEqual(result.newCwd ?? "", tempDir)).toBe(true);
    expect(result.stdout).not.toContain(CWD_MARKER);
  });
});

describe("wrapCommandForCwdTracking — Windows wrapper shape", () => {
  it("includes the cwd marker and delayed expansion for cmd.exe", () => {
    const wrapped = wrapCommandForCwdTracking("cd my-app", true);
    expect(wrapped).toContain("enabledelayedexpansion");
    expect(wrapped).toContain(CWD_MARKER);
    expect(wrapped).toContain("!cd!");
    expect(wrapped).toContain("!__atlas_status!");
    expect(wrapped).not.toContain("endlocal");
  });

  it("parses Windows-style echoed cwd the same way as Unix", () => {
    const stdout = `some output${CWD_MARKER}C:\\Users\\dev\\my-app`;
    expect(extractCwdFromOutput(stdout)).toEqual({
      cleanedStdout: "some output",
      newCwd: canonicalizeTrackedCwd("C:\\Users\\dev\\my-app"),
    });
  });
});

const describeWindows =
  process.platform === "win32" ? describe : describe.skip;

describeWindows("wrapCommandForCwdTracking — Windows shell integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-cwd-win-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const runTracked = async (command: string) => {
    const wrapped = wrapCommandForCwdTracking(command, true);
    const result = await runShell(wrapped, tempDir);
    const { cleanedStdout, newCwd } = extractCwdFromOutput(result.stdout);
    return {
      ...result,
      stdout: cleanedStdout,
      newCwd: newCwd ? canonicalizeTrackedCwd(newCwd) : undefined,
    };
  };

  it("cd into a child directory updates newCwd on Windows", async () => {
    const childDir = path.join(tempDir, "my-app");
    await fs.mkdir(childDir);

    const result = await runTracked("cd my-app");

    expect(result.exitCode).toBe(0);
    expect(trackedCwdsEqual(result.newCwd ?? "", childDir)).toBe(true);
  });

  it("preserves non-zero exit code on failed cd", async () => {
    const result = await runTracked("cd missing-dir");

    expect(result.exitCode).not.toBe(0);
    expect(trackedCwdsEqual(result.newCwd ?? "", tempDir)).toBe(true);
  });
});
