/**
 * Unit tests — client commands/tokenSaveHandlers.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnqueue,
  mockGetClient,
  mockHasIndex,
  mockIsOnPath,
  mockListTools,
  mockCallTool,
  mockPrintLine,
  mockPrintError,
  mockPrintSuccess,
  mockRequestApprovalWithFeedback,
  mockSendCommand,
  mockExecFile,
} = vi.hoisted(() => ({
  mockEnqueue: vi.fn(),
  mockGetClient: vi.fn(),
  mockHasIndex: vi.fn(),
  mockIsOnPath: vi.fn(),
  mockListTools: vi.fn(),
  mockCallTool: vi.fn(),
  mockPrintLine: vi.fn(),
  mockPrintError: vi.fn(),
  mockPrintSuccess: vi.fn(),
  mockRequestApprovalWithFeedback: vi.fn(),
  mockSendCommand: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock("../../../packages/client/src/mcp/tokenSaveClient.js", () => ({
  enqueueTokenSaveOperation: mockEnqueue,
  getTokenSaveClient: mockGetClient,
  hasTokenSaveIndex: mockHasIndex,
  isTokenSaveOnPath: mockIsOnPath,
  listCuratedTools: mockListTools,
}));

vi.mock("../../../packages/client/src/mcp/mcpBridge.js", () => ({
  callTokenSaveTool: mockCallTool,
}));

vi.mock("../../../packages/client/src/renderer.js", () => ({
  printLine: mockPrintLine,
  printError: mockPrintError,
  printSuccess: mockPrintSuccess,
}));

vi.mock("../../../packages/client/src/ui/approvalFlow.js", () => ({
  requestApprovalWithFeedback: mockRequestApprovalWithFeedback,
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import {
  handleTokenSave,
  printTokenSaveInitTip,
  syncTokenSaveTools,
} from "../../../packages/client/src/commands/tokenSaveHandlers.js";

const conn = { sendCommand: mockSendCommand } as never;
const fileProxy = { getWorkspaceRoot: () => "/workspace" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnqueue.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mockIsOnPath.mockResolvedValue(true);
  mockHasIndex.mockResolvedValue(true);
  mockGetClient.mockResolvedValue({});
  mockListTools.mockResolvedValue([
    { name: "tokensave_search", description: "search" },
  ]);
  mockSendCommand.mockResolvedValue(undefined);
  mockRequestApprovalWithFeedback.mockResolvedValue({ approved: true });
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null) => void,
    ) => {
      cb(null);
    },
  );
});

describe("syncTokenSaveTools", () => {
  it("returns 0 when tokensave is not on PATH", async () => {
    mockIsOnPath.mockResolvedValue(false);
    expect(await syncTokenSaveTools(conn, "/workspace")).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("returns 0 when workspace has no index", async () => {
    mockHasIndex.mockResolvedValue(false);
    expect(await syncTokenSaveTools(conn, "/workspace")).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("returns 0 when curated tools list is empty", async () => {
    mockListTools.mockResolvedValue([]);
    expect(await syncTokenSaveTools(conn, "/workspace")).toBe(0);
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  it("syncs tools and returns count on happy path", async () => {
    const tools = [{ name: "tokensave_search" }];
    mockListTools.mockResolvedValue(tools);
    const count = await syncTokenSaveTools(conn, "/workspace");
    expect(count).toBe(1);
    expect(mockSendCommand).toHaveBeenCalledWith("mcp.tools.sync", { tools });
    expect(mockEnqueue).toHaveBeenCalled();
  });
});

describe("printTokenSaveInitTip", () => {
  it("does nothing when tokensave is not installed", async () => {
    mockIsOnPath.mockResolvedValue(false);
    await printTokenSaveInitTip("/workspace");
    expect(mockPrintLine).not.toHaveBeenCalled();
  });

  it("does nothing when index already exists", async () => {
    await printTokenSaveInitTip("/workspace");
    expect(mockPrintLine).not.toHaveBeenCalled();
  });

  it("prints tip when tokensave is installed but not initialized", async () => {
    mockHasIndex.mockResolvedValue(false);
    await printTokenSaveInitTip("/workspace");
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("/tokensave init"),
    );
  });
});

describe("handleTokenSave init", () => {
  it("prints error when tokensave is not installed", async () => {
    mockIsOnPath.mockResolvedValue(false);
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("not installed"),
    );
  });

  it("prints success when already initialized", async () => {
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintSuccess).toHaveBeenCalledWith(
      expect.stringContaining("already initialized"),
    );
  });

  it("cancels when approval is rejected", async () => {
    mockHasIndex.mockResolvedValue(false);
    mockRequestApprovalWithFeedback.mockResolvedValue({ approved: false });
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("cancels (does not run init) when the user picks Revise instead of approving", async () => {
    mockHasIndex.mockResolvedValue(false);
    mockRequestApprovalWithFeedback.mockResolvedValue({
      approved: false,
      feedback: "don't create that folder yet",
    });
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("runs tokensave init and syncs on success", async () => {
    mockHasIndex.mockResolvedValueOnce(false).mockResolvedValue(true);
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockExecFile).toHaveBeenCalledWith(
      "tokensave",
      ["init"],
      expect.objectContaining({ cwd: "/workspace" }),
      expect.any(Function),
    );
    expect(mockPrintSuccess).toHaveBeenCalledWith(
      expect.stringContaining("initialized"),
    );
    expect(mockSendCommand).toHaveBeenCalled();
  });

  it("prints error when tokensave init fails", async () => {
    mockHasIndex.mockResolvedValue(false);
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("init failed"));
      },
    );
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("init failed"),
    );
  });
});

describe("handleTokenSave status", () => {
  it("prints formatted status on success", async () => {
    mockCallTool.mockResolvedValue({
      isError: false,
      data: { ready: true },
    });
    await handleTokenSave("status", "", conn, fileProxy);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining('"ready": true'),
    );
  });

  it("prints error when status call fails", async () => {
    mockCallTool.mockResolvedValue({
      isError: true,
      errorMessage: "status boom",
    });
    await handleTokenSave("status", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith("status boom");
  });

  it("prints error when status throws", async () => {
    mockCallTool.mockRejectedValue(new Error("network"));
    await handleTokenSave("status", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("network"),
    );
  });
});

describe("handleTokenSave unknown subcommand", () => {
  it("prints usage error", async () => {
    await handleTokenSave("bogus", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /tokensave"),
    );
  });
});
