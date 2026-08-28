/**
 * Integration tests — `!` shell passthrough against the real `runShell`.
 *
 * Real modules: handleBang, runShell, Node child_process.
 * Mocks: none at the process boundary (temp dir is the sandbox).
 *
 * Category checklist:
 * - Happy path: `echo hi` captures stdout
 * - Failure: `false` yields a warning entry
 * - System edge: a long command is killed by timeout
 */

import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { handleBang } from "../../../packages/client/src/commands/shellPassthrough.js";
import {
  runShell,
  SHELL_TIMEOUT_MARKER,
} from "../../../packages/client/src/fileProxy/shellRunner.js";

const cwd = os.tmpdir();

// `false`/`sleep` are POSIX-only; `node -e` runs identically under /bin/sh
// and cmd.exe since runShell always has node itself on PATH.
const EXIT_1 = 'node -e "process.exit(1)"';
const SLEEP_5S = 'node -e "setTimeout(function(){}, 5000)"';

describe("shellPassthroughFlow — real runShell", () => {
  it("captures stdout from echo (happy path)", async () => {
    const entries = await handleBang({
      command: "echo hi",
      runShell,
      cwd,
      timeoutMs: 5_000,
      classifyCommand: () => "safe",
      requestApproval: async () => true,
    });
    const body = entries.map((entry) => entry.text).join("\n");
    expect(body).toMatch(/hi/);
  });

  it("yields a warning entry for a failing command (failure)", async () => {
    const entries = await handleBang({
      command: EXIT_1,
      runShell,
      cwd,
      timeoutMs: 5_000,
      classifyCommand: () => "safe",
      requestApproval: async () => true,
    });
    expect(entries.some((entry) => entry.variant === "warning")).toBe(true);
  });

  it("kills a long command at the timeout (system edge)", async () => {
    const entries = await handleBang({
      command: SLEEP_5S,
      runShell,
      cwd,
      timeoutMs: 80,
      classifyCommand: () => "safe",
      requestApproval: async () => true,
    });
    const body = entries.map((entry) => entry.text).join("\n");
    expect(body).toContain(SHELL_TIMEOUT_MARKER);
  });
});
