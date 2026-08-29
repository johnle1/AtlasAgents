/**
 * Unit tests — handleCommandRun full-bypass `auto` mode (WS-B).
 *
 * @remarks
 * `auto` is full bypass (renamed from the old `bypass` mode): every command
 * — safe, cautious, or dangerous — runs with no prompt and no sandboxing.
 * The old soft `auto` (edits auto-approve, cautious sandboxed, dangerous
 * still prompts) no longer exists as a distinct mode.
 *
 * Category checklist:
 * - Normal: auto skips the prompt for a safe command
 * - Boundary: auto also skips the prompt for a cautious or dangerous command
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import type { DispatchContext } from "../../../../packages/client/src/fileProxy/types.js";
import { handleCommandRun } from "../../../../packages/client/src/fileProxy/handlers/commandHandlers.js";

const { mockGetApprovalMode, mockRequestApprovalWithFeedback } = vi.hoisted(
  () => ({
    mockGetApprovalMode: vi.fn(() => "default"),
    mockRequestApprovalWithFeedback: vi.fn(async () => ({ approved: true })),
  }),
);

vi.mock("../../../../packages/client/src/ui/bridge/allowlist.js", () => ({
  getApprovalMode: mockGetApprovalMode,
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
  mockRequestApprovalWithFeedback.mockResolvedValue({ approved: true });
});

describe("handleCommandRun — auto (full bypass)", () => {
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
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBeUndefined();
  });

  it("skips the prompt for a cautious command, unsandboxed (boundary)", async () => {
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
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBeUndefined();
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
    expect(runShell.mock.calls[0]?.[1]?.sandbox).toBeUndefined();
  });
});
