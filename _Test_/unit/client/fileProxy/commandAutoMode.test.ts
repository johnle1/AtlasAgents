/**
 * Unit tests — handleCommandRun auto / bypass / sandbox-denial retry (WS-B).
 *
 * Category checklist:
 * - Normal: auto + safe runs without prompt; auto + cautious passes sandbox
 * - Boundary: auto + dangerous still prompts; sandbox denial retries unsandboxed
 * - Error: no sandbox provider falls back to prompting
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import type { DispatchContext } from "../../../../packages/client/src/fileProxy/types.js";
import { handleCommandRun } from "../../../../packages/client/src/fileProxy/handlers/commandHandlers.js";

const {
  mockGetApprovalMode,
  mockResolveSandbox,
  mockDetectSandboxDenial,
  mockRequestApprovalWithFeedback,
} = vi.hoisted(() => ({
  mockGetApprovalMode: vi.fn(() => "default"),
  mockResolveSandbox: vi.fn(() => null),
  mockDetectSandboxDenial: vi.fn(() => false),
  mockRequestApprovalWithFeedback: vi.fn(async () => ({ approved: true })),
}));

vi.mock("../../../../packages/client/src/ui/bridge/allowlist.js", () => ({
  getApprovalMode: mockGetApprovalMode,
}));

vi.mock("../../../../packages/client/src/fileProxy/sandbox/index.js", () => ({
  resolveSandbox: mockResolveSandbox,
  detectSandboxDenial: mockDetectSandboxDenial,
}));

vi.mock("../../../../packages/client/src/ui/approvalFlow.js", () => ({
  requestApprovalWithFeedback: mockRequestApprovalWithFeedback,
  printDeclineFeedback: vi.fn(),
}));

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printBash: vi.fn(),
  printBashApproved: vi.fn(),
  printBashRan: vi.fn(),
  printBashResult: vi.fn(),
}));

vi.mock("../../../../packages/client/src/state/agentStatus.js", () => ({
  beginBlockOutput: vi.fn(),
}));

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({ warning: "", reset: "" }),
}));

vi.mock("../../../../packages/client/src/utils/logger.js", () => ({
  logger: { info: vi.fn(), blank: vi.fn() },
}));

const fakeSandbox = {
  id: "test",
  wrapCommand: (command: string) => ({
    argv: ["/bin/sh", "-c", command],
  }),
  denialPattern: /sandbox deny/i,
};

const makeContext = (
  overrides?: Partial<DispatchContext>,
): DispatchContext => ({
  workspaceRoot: os.tmpdir(),
  currentDir: os.tmpdir(),
  resolveAbsolute: (rel: string) => rel,
  setCurrentDir: vi.fn(),
  classifyCommand: () => "safe",
  runShell: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  listStructure: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetApprovalMode.mockReturnValue("default");
  mockResolveSandbox.mockReturnValue(null);
  mockDetectSandboxDenial.mockReturnValue(false);
  mockRequestApprovalWithFeedback.mockResolvedValue({ approved: true });
});

describe("handleCommandRun — auto mode", () => {
  it("runs safe commands without prompting (normal)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const context = makeContext({
      classifyCommand: () => "safe",
      runShell,
    });
    await handleCommandRun(context, { command: "ls" });
    expect(mockRequestApprovalWithFeedback).not.toHaveBeenCalled();
    expect(runShell).toHaveBeenCalled();
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBeUndefined();
  });

  it("runs cautious commands sandboxed without prompting (normal)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
    mockResolveSandbox.mockReturnValue(fakeSandbox);
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const context = makeContext({
      classifyCommand: () => "cautious",
      runShell,
    });
    await handleCommandRun(context, { command: "npm test" });
    expect(mockRequestApprovalWithFeedback).not.toHaveBeenCalled();
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBe(fakeSandbox);
  });

  it("prompts for dangerous commands even in auto (boundary)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
    mockResolveSandbox.mockReturnValue(fakeSandbox);
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const context = makeContext({
      classifyCommand: () => "dangerous",
      runShell,
    });
    await handleCommandRun(context, { command: "rm -rf build" });
    expect(mockRequestApprovalWithFeedback).toHaveBeenCalled();
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBeUndefined();
  });

  it("retries unsandboxed after a sandbox denial is approved (boundary)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
    mockResolveSandbox.mockReturnValue(fakeSandbox);
    mockDetectSandboxDenial.mockReturnValueOnce(true);
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "sandbox deny file-write*",
      exitCode: 1,
    }));
    const context = makeContext({
      classifyCommand: () => "cautious",
      runShell,
    });
    await handleCommandRun(context, { command: "npm test" });
    expect(mockRequestApprovalWithFeedback).toHaveBeenCalled();
    expect(runShell).toHaveBeenCalledTimes(2);
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBe(fakeSandbox);
    expect(runShell.mock.calls[1]?.[1]?.sandbox).toBeUndefined();
  });

  it("prompts cautious commands when no sandbox is available (error)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
    mockResolveSandbox.mockReturnValue(null);
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const context = makeContext({
      classifyCommand: () => "cautious",
      runShell,
    });
    await handleCommandRun(context, { command: "npm test" });
    expect(mockRequestApprovalWithFeedback).toHaveBeenCalled();
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBeUndefined();
  });
});

describe("handleCommandRun — bypass", () => {
  it("skips prompts for cautious commands (normal)", async () => {
    mockGetApprovalMode.mockReturnValue("bypass");
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const context = makeContext({
      classifyCommand: () => "cautious",
      runShell,
    });
    await handleCommandRun(context, { command: "npm test" });
    expect(mockRequestApprovalWithFeedback).not.toHaveBeenCalled();
    expect(runShell).toHaveBeenCalled();
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBeUndefined();
  });
});
