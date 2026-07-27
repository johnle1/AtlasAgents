/**
 * Unit tests — shellRunner.ts timeout behavior
 */

import * as os from "node:os";
import { describe, expect, it } from "vitest";
import {
  formatShellTimeoutMessage,
  runShell,
  SHELL_TIMEOUT_MARKER,
} from "../../../packages/client/src/fileProxy/shellRunner.js";

describe("runShell — timeout handling", () => {
  it("appends a timeout marker to stderr when the command exceeds timeoutMs", async () => {
    const timeoutMs = 50;
    const result = await runShell("sleep 5", os.tmpdir(), timeoutMs);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain(SHELL_TIMEOUT_MARKER);
    expect(result.stderr).toContain(formatShellTimeoutMessage(timeoutMs));
  });

  it("does not append a timeout marker when the command finishes in time", async () => {
    const result = await runShell("echo ok", os.tmpdir(), 5_000);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(SHELL_TIMEOUT_MARKER);
    expect(result.stdout.trim()).toBe("ok");
  });
});
