/**
 * Unit tests — fileProxy/sandbox (provider contract, resolveSandbox, denial).
 *
 * Category checklist:
 * - Normal: darwin + seatbelt available returns seatbelt provider
 * - Boundary: linux / win32 / darwin-without-binary return null; memoized
 * - Error: detectSandboxDenial ignores exit 0 and ordinary non-zero exits
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  detectSandboxDenial,
  resetSandboxCache,
  resolveSandbox,
} from "../../../../packages/client/src/fileProxy/sandbox/index.js";
import type { SandboxProvider } from "../../../../packages/client/src/fileProxy/sandbox/types.js";

afterEach(() => {
  resetSandboxCache();
});

describe("resolveSandbox", () => {
  it("returns the seatbelt provider on darwin when the binary exists (normal)", () => {
    const provider = resolveSandbox({
      platform: "darwin",
      seatbeltAvailable: true,
    });
    expect(provider?.id).toBe("seatbelt");
    const wrapped = provider?.wrapCommand("ls", { cwd: "/tmp" });
    expect(wrapped?.argv[0]).toBe("sandbox-exec");
    expect(wrapped?.argv).toContain("-p");
    expect(wrapped?.argv).toContain("/bin/sh");
    expect(wrapped?.argv).toContain("-c");
    expect(wrapped?.argv).toContain("ls");
  });

  it("returns null on linux and win32 (boundary)", () => {
    expect(resolveSandbox({ platform: "linux" })).toBeNull();
    expect(resolveSandbox({ platform: "win32" })).toBeNull();
  });

  it("returns null on darwin when sandbox-exec is missing (boundary)", () => {
    expect(
      resolveSandbox({ platform: "darwin", seatbeltAvailable: false }),
    ).toBeNull();
  });

  it("memoizes the no-argument production path (boundary)", () => {
    const first = resolveSandbox();
    const second = resolveSandbox();
    expect(first).toBe(second);
  });
});

describe("detectSandboxDenial", () => {
  const provider: SandboxProvider = {
    id: "test",
    wrapCommand: (command) => ({ argv: ["/bin/sh", "-c", command] }),
    denialPattern: /sandbox deny|Operation not permitted/i,
  };

  it("matches sandbox deny and Operation not permitted (normal)", () => {
    expect(
      detectSandboxDenial(provider, {
        exitCode: 1,
        stderr: "sandbox deny file-write*",
      }),
    ).toBe(true);
    expect(
      detectSandboxDenial(provider, {
        exitCode: 1,
        stderr: "Operation not permitted",
      }),
    ).toBe(true);
  });

  it("ignores ordinary non-zero exits (error)", () => {
    expect(
      detectSandboxDenial(provider, {
        exitCode: 1,
        stderr: "npm ERR! missing script",
      }),
    ).toBe(false);
  });

  it("ignores exit 0 even if stderr matches (boundary)", () => {
    expect(
      detectSandboxDenial(provider, {
        exitCode: 0,
        stderr: "sandbox deny (warning)",
      }),
    ).toBe(false);
  });
});
