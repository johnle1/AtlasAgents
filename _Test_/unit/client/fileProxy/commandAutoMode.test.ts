/**
 * Unit tests — handleCommandRun full-bypass `auto` mode (WS-B), and its
 * interaction with sandboxing.
 *
 * @remarks
 * `auto` is full bypass on the **approval prompt**: every command — safe,
 * cautious, or dangerous — runs with no confirmation. Sandboxing is a
 * separate axis (see fileProxy/sandbox/index.ts) that still applies in
 * every mode when a backend is available; `auto` is specifically the mode
 * where its network policy switches to deny-by-default, since it's the one
 * mode with no human reviewing the command first.
 *
 * Category checklist:
 * - Normal: auto skips the prompt for a safe command, still sandboxes it
 * - Boundary: auto also skips the prompt for cautious/dangerous commands;
 *   auto's sandbox policy denies network while default's allows it
 * - Error: no sandbox backend available → runs unsandboxed regardless of mode,
 *   and warns once per process (not at all when `mode: "off"`)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import type { DispatchContext } from "../../../../packages/client/src/fileProxy/types.js";
import { handleCommandRun } from "../../../../packages/client/src/fileProxy/handlers/commandHandlers.js";

const {
  mockGetApprovalMode,
  mockRequestApprovalWithFeedback,
  mockResolveConfiguredSandbox,
} = vi.hoisted(() => ({
  mockGetApprovalMode: vi.fn(() => "default"),
  mockRequestApprovalWithFeedback: vi.fn(async () => ({ approved: true })),
  mockResolveConfiguredSandbox: vi.fn(() => null as unknown),
}));

vi.mock("../../../../packages/client/src/ui/bridge/allowlist.js", () => ({
  getApprovalMode: mockGetApprovalMode,
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({
    sandbox: { mode: "auto", containerImage: "atlas-sandbox:latest" },
  }),
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

// resolveConfiguredSandbox is mocked so these tests are deterministic
// regardless of what the machine running the suite actually has installed
// (CI runs all three OSes); detectSandboxDenial/buildSandboxPolicy stay
// real (pure logic) — commandHandlers.ts calls resolveConfiguredSandbox,
// not resolveSandbox directly (see resolveSandboxForCommand).
vi.mock("../../../../packages/client/src/fileProxy/sandbox/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../packages/client/src/fileProxy/sandbox/index.js")
  >("../../../../packages/client/src/fileProxy/sandbox/index.js");
  return { ...actual, resolveConfiguredSandbox: mockResolveConfiguredSandbox };
});

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

const fakeSandbox = {
  id: "test-sandbox",
  denialPattern: /never-matches/,
  wrapCommand: (command: string) => ({ argv: ["/bin/sh", "-c", command] }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetApprovalMode.mockReturnValue("default");
  mockRequestApprovalWithFeedback.mockResolvedValue({ approved: true });
  mockResolveConfiguredSandbox.mockReturnValue(null);
});

describe("handleCommandRun — auto (full bypass on the prompt)", () => {
  it("skips the prompt for a safe command (normal)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const context = makeContext({ classifyCommand: () => "safe", runShell });
    await handleCommandRun(context, { command: "ls" });
    expect(mockRequestApprovalWithFeedback).not.toHaveBeenCalled();
    expect(runShell).toHaveBeenCalled();
  });

  it("skips the prompt for a cautious command (boundary)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
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
  });

  it("skips the prompt for a dangerous command (boundary — this is what changed from the old soft auto)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
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
    expect(mockRequestApprovalWithFeedback).not.toHaveBeenCalled();
    expect(runShell).toHaveBeenCalled();
  });
});

describe("handleCommandRun — sandboxing is independent of the approval prompt", () => {
  it("runs unsandboxed when no backend is available, in any mode (error — no backend)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
    mockResolveConfiguredSandbox.mockReturnValue(null);
    const runShell = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const context = makeContext({ classifyCommand: () => "safe", runShell });

    await handleCommandRun(context, { command: "ls" });
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBeUndefined();
  });

  it("sandboxes a safe command in auto mode with network denied (normal)", async () => {
    mockGetApprovalMode.mockReturnValue("auto");
    mockResolveConfiguredSandbox.mockReturnValue(fakeSandbox);
    const runShell = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const context = makeContext({ classifyCommand: () => "safe", runShell });

    await handleCommandRun(context, { command: "ls" });
    const [, options] = runShell.mock.calls[0] ?? [];
    expect(options?.sandbox).toBe(fakeSandbox);
    expect(options?.policy?.network).toBe("deny");
  });

  it("sandboxes a safe command in default mode with network allowed (boundary — human is reviewing)", async () => {
    mockGetApprovalMode.mockReturnValue("default");
    mockResolveConfiguredSandbox.mockReturnValue(fakeSandbox);
    const runShell = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const context = makeContext({ classifyCommand: () => "safe", runShell });

    await handleCommandRun(context, { command: "ls" });
    const [, options] = runShell.mock.calls[0] ?? [];
    expect(options?.sandbox).toBe(fakeSandbox);
    expect(options?.policy?.network).toBe("allow");
  });
});

describe("handleCommandRun — sandbox-unavailable warning", () => {
  // Reset the module graph so commandHandlers.ts's once-per-process warned
  // flag starts fresh — the describe blocks above already ran commands
  // through the same null-sandbox path and would otherwise have tripped it.
  it("warns once per process, not on every command (normal)", async () => {
    vi.resetModules();
    const freshLogger = await import(
      "../../../../packages/client/src/utils/logger.js"
    );
    const { handleCommandRun: freshHandleCommandRun } = await import(
      "../../../../packages/client/src/fileProxy/handlers/commandHandlers.js"
    );

    mockGetApprovalMode.mockReturnValue("auto");
    mockResolveConfiguredSandbox.mockReturnValue(null);
    const runShell = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const context = makeContext({ classifyCommand: () => "safe", runShell });

    await freshHandleCommandRun(context, { command: "ls" });
    await freshHandleCommandRun(context, { command: "pwd" });

    const warnCalls = (
      freshLogger.logger.info as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([line]) =>
        typeof line === "string" &&
        line.includes("No sandbox backend available"),
    );
    expect(warnCalls).toHaveLength(1);
  });

  it("does not warn when sandbox.mode is \"off\" (boundary — off is a deliberate choice)", async () => {
    vi.resetModules();
    vi.doMock("../../../../packages/client/src/config/index.js", () => ({
      loadConfig: () => ({
        sandbox: { mode: "off", containerImage: "atlas-sandbox:latest" },
      }),
    }));
    const freshLogger = await import(
      "../../../../packages/client/src/utils/logger.js"
    );
    const { handleCommandRun: freshHandleCommandRun } = await import(
      "../../../../packages/client/src/fileProxy/handlers/commandHandlers.js"
    );

    mockGetApprovalMode.mockReturnValue("auto");
    mockResolveConfiguredSandbox.mockReturnValue(null);
    const runShell = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const context = makeContext({ classifyCommand: () => "safe", runShell });

    await freshHandleCommandRun(context, { command: "ls" });

    const warnCalls = (
      freshLogger.logger.info as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([line]) =>
        typeof line === "string" &&
        line.includes("No sandbox backend available"),
    );
    expect(warnCalls).toHaveLength(0);
    vi.doUnmock("../../../../packages/client/src/config/index.js");
  });
});
