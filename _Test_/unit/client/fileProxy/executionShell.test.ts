/**
 * Unit tests — fileProxy/executionShell.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
const mockResolveConfiguredSandbox = vi.fn();

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => mockLoadConfig(),
}));

vi.mock("../../../../packages/client/src/fileProxy/sandbox/index.js", () => ({
  POSIX_EXECUTION_SHELL: "/bin/sh",
  WINDOWS_EXECUTION_SHELL: "cmd.exe",
  resolveConfiguredSandbox: (...args: unknown[]) =>
    mockResolveConfiguredSandbox(...args),
}));

import {
  defaultClientExecutionShell,
  executionShellForProvider,
  resolveClientExecutionShell,
} from "../../../../packages/client/src/fileProxy/executionShell.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("executionShellForProvider", () => {
  it("reports /bin/sh for any sandbox backend", () => {
    expect(
      executionShellForProvider({
        id: "container-docker",
        executionShell: "/bin/sh",
        denialPattern: /x/,
        wrapCommand: () => ({ argv: ["docker"] }),
      }),
    ).toBe("/bin/sh");
  });

  it("reports cmd.exe for unsandboxed Windows", () => {
    if (process.platform !== "win32") {
      expect(executionShellForProvider(null)).toBe("/bin/sh");
      return;
    }
    expect(executionShellForProvider(null)).toBe("cmd.exe");
  });
});

describe("resolveClientExecutionShell", () => {
  it("reports /bin/sh when a sandbox backend is active", () => {
    mockLoadConfig.mockReturnValue({
      sandbox: { mode: "container", containerImage: "atlas-sandbox:latest" },
    });
    mockResolveConfiguredSandbox.mockReturnValue({
      id: "container-docker",
      executionShell: "/bin/sh",
      denialPattern: /x/,
      wrapCommand: () => ({ argv: ["docker"] }),
    });

    expect(resolveClientExecutionShell()).toBe("/bin/sh");
    expect(mockResolveConfiguredSandbox).toHaveBeenCalledWith(
      "container",
      "atlas-sandbox:latest",
    );
  });

  it("falls back to unsandboxed shell when no backend is available", () => {
    mockLoadConfig.mockReturnValue({
      sandbox: { mode: "auto", containerImage: "atlas-sandbox:latest" },
    });
    mockResolveConfiguredSandbox.mockReturnValue(null);

    expect(resolveClientExecutionShell()).toBe(defaultClientExecutionShell());
  });
});
