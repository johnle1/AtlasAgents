/**
 * Unit tests — shellRunner.ts timeout behavior
 */

import * as os from "node:os";
import { describe, expect, it } from "vitest";
import {
  formatShellTimeoutMessage,
  runShell,
  SHELL_TIMEOUT_MARKER,
} from "../../../../packages/client/src/fileProxy/shellRunner.js";

// `sleep`/`false` are POSIX-only; `node -e` runs identically under
// /bin/sh and cmd.exe since runShell always has node itself on PATH.
const SLEEP_5S = 'node -e "setTimeout(function(){}, 5000)"';

describe("runShell — timeout handling", () => {
  it("appends a timeout marker to stderr when the command exceeds timeoutMs", async () => {
    const timeoutMs = 50;
    const result = await runShell(SLEEP_5S, os.tmpdir(), timeoutMs);

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

describe("runShell — sandbox wrapping", () => {
  it("spawns the sandbox provider's argv instead of the bare shell when policy is supplied", async () => {
    let capturedCwd: string | undefined;
    const sandbox = {
      id: "test-sandbox",
      executionShell: "/bin/sh",
      denialPattern: /never-matches/,
      wrapCommand: (command: string, ctx: { cwd: string }) => {
        capturedCwd = ctx.cwd;
        // Re-exec through the host shell so the fake "sandbox" is actually
        // runnable on Windows (no /bin/sh) and POSIX alike.
        return process.platform === "win32"
          ? { argv: ["cmd.exe", "/d", "/s", "/v:on", "/c", command] }
          : { argv: ["/bin/sh", "-c", command] };
      },
    };
    const policy = { writeRoots: [os.tmpdir()], readDenies: [], network: "allow" as const };

    const result = await runShell(
      "echo wrapped",
      os.tmpdir(),
      5_000,
      undefined,
      { sandbox, policy },
    );

    expect(result.stdout.trim()).toBe("wrapped");
    expect(capturedCwd).toBe(os.tmpdir());
  });

  it("falls back to the bare shell when a sandbox is supplied without a policy", async () => {
    const wrapCommand = () => ({ argv: ["/bin/sh", "-c", "echo should-not-run"] });
    const sandbox = { id: "test-sandbox", executionShell: "/bin/sh", denialPattern: /x/, wrapCommand };

    // No `policy` — shellRunner requires both together, so this must behave
    // exactly like no sandbox at all rather than crashing on a missing policy.
    const result = await runShell("echo ok", os.tmpdir(), 5_000, undefined, {
      sandbox,
    });

    expect(result.stdout.trim()).toBe("ok");
  });
});

describe("runShell — environment scrubbing", () => {
  it("does not leak a credential-shaped env var from the parent process into the child", async () => {
    const original = process.env.MY_TEST_API_TOKEN;
    process.env.MY_TEST_API_TOKEN = "should-not-leak";
    try {
      const result = await runShell(
        'node -e "console.log(process.env.MY_TEST_API_TOKEN || \'\')"',
        os.tmpdir(),
        5_000,
      );
      expect(result.stdout.trim()).toBe("");
    } finally {
      if (original === undefined) {
        delete process.env.MY_TEST_API_TOKEN;
      } else {
        process.env.MY_TEST_API_TOKEN = original;
      }
    }
  });

  it("still passes through PATH so the shell can find ordinary binaries", async () => {
    const result = await runShell("echo ok", os.tmpdir(), 5_000);
    expect(result.exitCode).toBe(0);
  });
});
