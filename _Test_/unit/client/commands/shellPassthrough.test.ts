/**
 * Unit tests — client commands/shellPassthrough.ts
 *
 * `!command` runs locally via an injected `runShell`. It never talks to the
 * agent and never prompts for approval — the user typed it on their own
 * prompt line. A `"dangerous"` classification only adds an informational
 * warning line; it never blocks execution.
 *
 * Category checklist:
 * - Normal: parseBang extracts the command; stdout becomes a history entry
 * - Boundary: `!` alone yields a usage hint; timeout surfaces in stderr
 * - Error: non-zero exit is a warning
 */

import { describe, expect, it, vi } from "vitest";
import {
  handleBang,
  parseBang,
} from "../../../../packages/client/src/commands/shellPassthrough.js";
import { SHELL_TIMEOUT_MARKER } from "../../../../packages/client/src/fileProxy/shellRunner.js";

describe("parseBang", () => {
  it("returns the command after ! (normal)", () => {
    expect(parseBang("!ls -la")).toBe("ls -la");
  });

  it("returns an empty string for ! alone (boundary)", () => {
    expect(parseBang("!")).toBe("");
    expect(parseBang("!   ")).toBe("");
  });

  it("returns null when the line is not a bang command (error)", () => {
    expect(parseBang("ls")).toBeNull();
    expect(parseBang("/help")).toBeNull();
  });
});

describe("handleBang", () => {
  it("formats stdout as a history entry (normal)", async () => {
    const runShell = vi.fn(async () => ({
      stdout: "hi\n",
      stderr: "",
      exitCode: 0,
    }));
    const entries = await handleBang({
      command: "echo hi",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand: () => "safe",
    });
    expect(runShell).toHaveBeenCalledWith("echo hi", "/tmp", 5_000);
    expect(entries.some((entry) => entry.text.includes("hi"))).toBe(true);
  });

  it("strips a trailing CRLF from stdout/stderr (boundary — Windows cmd.exe line endings)", async () => {
    const runShell = vi.fn(async () => ({
      stdout: "hi\r\n",
      stderr: "warn\r\n",
      exitCode: 1,
    }));
    const entries = await handleBang({
      command: "echo hi",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand: () => "safe",
    });
    expect(entries[0]).toEqual({
      kind: "text",
      text: "hi",
      variant: "secondary",
    });
    expect(entries[1]).toEqual({
      kind: "text",
      text: "warn",
      variant: "warning",
    });
  });

  it("returns a usage hint when the command is empty (boundary)", async () => {
    const runShell = vi.fn();
    const entries = await handleBang({
      command: "",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand: () => "safe",
    });
    expect(runShell).not.toHaveBeenCalled();
    expect(entries[0]?.text).toMatch(/Usage: !/i);
  });

  it("surfaces a timeout marker from stderr (boundary)", async () => {
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: `${SHELL_TIMEOUT_MARKER} Command exceeded 50ms and was killed.`,
      exitCode: -1,
    }));
    const entries = await handleBang({
      command: "sleep 5",
      runShell,
      cwd: "/tmp",
      timeoutMs: 50,
      classifyCommand: () => "safe",
    });
    expect(entries.some((entry) => entry.text.includes(SHELL_TIMEOUT_MARKER))).toBe(
      true,
    );
    expect(entries.some((entry) => entry.variant === "warning")).toBe(true);
  });

  it("marks a non-zero exit as a warning (error)", async () => {
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    }));
    const entries = await handleBang({
      command: "false",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand: () => "safe",
    });
    expect(entries.some((entry) => entry.variant === "warning")).toBe(true);
    expect(entries.some((entry) => /exit 1/.test(entry.text))).toBe(true);
  });

  it("runs a dangerous command without prompting, prefixed with a warning line (normal)", async () => {
    const runShell = vi.fn(async () => ({
      stdout: "removed\n",
      stderr: "",
      exitCode: 0,
    }));
    const classifyCommand = vi.fn(() => "dangerous" as const);
    const entries = await handleBang({
      command: "rm -rf build",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand,
    });
    expect(runShell).toHaveBeenCalledWith("rm -rf build", "/tmp", 5_000);
    expect(entries[0]).toEqual({
      kind: "text",
      text: "⚠ Dangerous command.",
      variant: "warning",
    });
    expect(entries.some((entry) => entry.text.includes("removed"))).toBe(true);
  });

  it("reports '(no output)' when stdout/stderr are empty and exit is 0 (boundary)", async () => {
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const entries = await handleBang({
      command: "touch file.txt",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand: () => "safe",
    });
    expect(entries).toEqual([
      { kind: "text", text: "(no output)", variant: "secondary" },
    ]);
  });

  it("still reports '(no output)' for a dangerous no-output command, after the warning (boundary)", async () => {
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const entries = await handleBang({
      command: "rm -f leftover.tmp",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand: () => "dangerous",
    });
    expect(entries).toEqual([
      { kind: "text", text: "⚠ Dangerous command.", variant: "warning" },
      { kind: "text", text: "(no output)", variant: "secondary" },
    ]);
  });
});
