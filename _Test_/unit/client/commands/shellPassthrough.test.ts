/**
 * Unit tests — client commands/shellPassthrough.ts
 *
 * `!command` runs locally via an injected `runShell`. It never talks to the
 * agent. Approval follows the same classifier as `command.run`.
 *
 * Category checklist:
 * - Normal: parseBang extracts the command; stdout becomes a history entry
 * - Boundary: `!` alone yields a usage hint; timeout surfaces in stderr
 * - Error: non-zero exit is a warning; declined approval does not run the shell
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
      requestApproval: vi.fn(async () => true),
    });
    expect(runShell).toHaveBeenCalledWith("echo hi", "/tmp", 5_000);
    expect(entries.some((entry) => entry.text.includes("hi"))).toBe(true);
  });

  it("returns a usage hint when the command is empty (boundary)", async () => {
    const runShell = vi.fn();
    const entries = await handleBang({
      command: "",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand: () => "safe",
      requestApproval: vi.fn(),
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
      requestApproval: vi.fn(async () => true),
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
      requestApproval: vi.fn(async () => true),
    });
    expect(entries.some((entry) => entry.variant === "warning")).toBe(true);
    expect(entries.some((entry) => /exit 1/.test(entry.text))).toBe(true);
  });

  it("does not run the shell when approval is declined (error)", async () => {
    const runShell = vi.fn();
    const entries = await handleBang({
      command: "rm -rf build",
      runShell,
      cwd: "/tmp",
      timeoutMs: 5_000,
      classifyCommand: () => "dangerous",
      requestApproval: vi.fn(async () => false),
    });
    expect(runShell).not.toHaveBeenCalled();
    expect(entries.some((entry) => /skip/i.test(entry.text))).toBe(true);
  });
});
