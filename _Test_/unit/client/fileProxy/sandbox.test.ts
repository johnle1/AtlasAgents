/**
 * Unit tests — fileProxy/sandbox (provider resolution across platforms/modes, denial).
 *
 * Category checklist:
 * - Normal: darwin + seatbelt available, linux + bubblewrap available
 * - Boundary: platform without an OS-native backend falls back to a
 *   container runtime when one is installed (incl. Windows, which has no
 *   OS-native backend at all); "container" mode forces containers even
 *   when a native backend exists; "off" disables entirely; memoization
 * - Error: no backend and no container runtime resolves to null; detectSandboxDenial
 *   ignores exit 0 and ordinary non-zero exits
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

describe("resolveSandbox — OS-native backends", () => {
  it("returns the seatbelt provider on darwin when the binary exists (normal)", () => {
    const provider = resolveSandbox({
      platform: "darwin",
      seatbeltAvailable: true,
    });
    expect(provider?.id).toBe("seatbelt");
    const wrapped = provider?.wrapCommand("ls", {
      cwd: "/tmp",
      policy: { writeRoots: ["/tmp"], readDenies: [], network: "allow" },
    });
    expect(wrapped?.argv[0]).toBe("sandbox-exec");
    expect(wrapped?.argv).toContain("-p");
    expect(wrapped?.argv).toContain("/bin/sh");
    expect(wrapped?.argv).toContain("-c");
    expect(wrapped?.argv).toContain("ls");
  });

  it("returns the bubblewrap provider on linux when the binary exists (normal)", () => {
    const provider = resolveSandbox({
      platform: "linux",
      bubblewrapAvailable: true,
    });
    expect(provider?.id).toBe("bubblewrap");
    const wrapped = provider?.wrapCommand("ls", {
      cwd: "/proj",
      policy: { writeRoots: ["/proj"], readDenies: [], network: "allow" },
    });
    expect(wrapped?.argv[0]).toBe("bwrap");
    expect(wrapped?.argv).toContain("ls");
  });

  it("returns null on darwin when sandbox-exec is missing and no container runtime (boundary)", () => {
    expect(
      resolveSandbox({ platform: "darwin", seatbeltAvailable: false }),
    ).toBeNull();
  });

  it("returns null on linux when bwrap is missing and no container runtime (boundary)", () => {
    expect(
      resolveSandbox({ platform: "linux", bubblewrapAvailable: false }),
    ).toBeNull();
  });
});

describe("resolveSandbox — container fallback", () => {
  it("falls back to the container runtime on darwin when seatbelt is unavailable (boundary)", () => {
    const provider = resolveSandbox({
      platform: "darwin",
      seatbeltAvailable: false,
      containerRuntime: "docker",
    });
    expect(provider?.id).toBe("container-docker");
  });

  it("falls back to the container runtime on linux when bubblewrap is unavailable (boundary)", () => {
    const provider = resolveSandbox({
      platform: "linux",
      bubblewrapAvailable: false,
      containerRuntime: "podman",
    });
    expect(provider?.id).toBe("container-podman");
  });

  it("uses the container runtime on win32, which has no OS-native backend (normal — Windows)", () => {
    const provider = resolveSandbox({
      platform: "win32",
      containerRuntime: "docker",
    });
    expect(provider?.id).toBe("container-docker");

    const wrapped = provider?.wrapCommand("dir", {
      cwd: "C:\\Users\\dev\\project",
      policy: {
        writeRoots: ["C:\\Users\\dev\\project"],
        readDenies: [],
        network: "allow",
      },
    });
    expect(wrapped?.argv[0]).toBe("docker");
    expect(wrapped?.argv).toContain("run");
    expect(wrapped?.argv).toContain("dir");
  });

  it("prefers podman over nothing on win32 when only podman is installed (boundary — Windows)", () => {
    const provider = resolveSandbox({
      platform: "win32",
      containerRuntime: "podman",
    });
    expect(provider?.id).toBe("container-podman");
    expect(provider?.wrapCommand("dir", {
      cwd: "C:\\proj",
      policy: { writeRoots: ["C:\\proj"], readDenies: [], network: "allow" },
    }).argv[0]).toBe("podman");
  });

  it("returns null on win32 when no container runtime is installed (error — no isolation available)", () => {
    // No containerRuntime override — with `options` passed, an unspecified
    // capability defaults to unavailable rather than probing this machine
    // for real, so this is deterministic regardless of what's installed
    // where the suite happens to run.
    expect(resolveSandbox({ platform: "win32" })).toBeNull();
  });

  it("returns null on linux when neither bwrap nor a container runtime exists (error)", () => {
    expect(
      resolveSandbox({
        platform: "linux",
        bubblewrapAvailable: false,
        containerRuntime: null,
      }),
    ).toBeNull();
  });
});

describe("resolveSandbox — mode", () => {
  it("forces the container backend even when a native backend is available (normal — container mode)", () => {
    const provider = resolveSandbox({
      platform: "darwin",
      mode: "container",
      seatbeltAvailable: true,
      containerRuntime: "docker",
    });
    expect(provider?.id).toBe("container-docker");
  });

  it("returns null in container mode when no container runtime exists, even with a native backend available (boundary)", () => {
    const provider = resolveSandbox({
      platform: "darwin",
      mode: "container",
      seatbeltAvailable: true,
      containerRuntime: null,
    });
    expect(provider).toBeNull();
  });

  it("returns null in off mode regardless of what's available (normal — explicit opt-out)", () => {
    const provider = resolveSandbox({
      platform: "darwin",
      mode: "off",
      seatbeltAvailable: true,
      containerRuntime: "docker",
    });
    expect(provider).toBeNull();
  });
});

describe("resolveSandbox — memoization", () => {
  it("memoizes the no-argument production path (boundary)", () => {
    const first = resolveSandbox();
    const second = resolveSandbox();
    expect(first).toBe(second);
  });
});

describe("detectSandboxDenial", () => {
  const provider: SandboxProvider = {
    id: "test",
    executionShell: "/bin/sh",
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
