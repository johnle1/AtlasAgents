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
  mockLoadConfig,
  mockListMcpTools,
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
  mockLoadConfig: vi.fn(),
  mockListMcpTools: vi.fn(),
}));

vi.mock("../../../../packages/client/src/mcp/tokenSaveClient.js", () => ({
  enqueueTokenSaveOperation: mockEnqueue,
  getTokenSaveClient: mockGetClient,
  hasTokenSaveIndex: mockHasIndex,
  isTokenSaveOnPath: mockIsOnPath,
  listCuratedTools: mockListTools,
}));

vi.mock("../../../../packages/client/src/mcp/mcpBridge.js", () => ({
  callTokenSaveTool: mockCallTool,
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../../../packages/client/src/mcp/mcpRegistry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../packages/client/src/mcp/mcpRegistry.js")
  >("../../../../packages/client/src/mcp/mcpRegistry.js");
  return { ...actual, listMcpTools: mockListMcpTools };
});

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printLine: mockPrintLine,
  printError: mockPrintError,
  printSuccess: mockPrintSuccess,
}));

vi.mock("../../../../packages/client/src/ui/approvalFlow.js", () => ({
  requestApprovalWithFeedback: mockRequestApprovalWithFeedback,
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import {
  handleTokenSave,
  printTokenSaveInitTip,
  syncAllMcpTools,
  syncTokenSaveTools,
} from "../../../../packages/client/src/commands/tokenSaveHandlers.js";

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
  mockLoadConfig.mockReturnValue({ mcpServers: {}, mcpSecrets: {} });
  mockListMcpTools.mockResolvedValue([]);
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

describe("syncAllMcpTools", () => {
  it("sends TokenSave tools marked read-only when no other servers are configured (normal)", async () => {
    mockListTools.mockResolvedValue([
      { name: "tokensave_search", description: "search" },
    ]);
    const count = await syncAllMcpTools(conn, "/workspace");
    expect(count).toBe(1);
    expect(mockSendCommand).toHaveBeenCalledWith("mcp.tools.sync", {
      tools: [
        {
          name: "tokensave_search",
          description: "search",
          inputSchema: undefined,
          readOnly: true,
        },
      ],
    });
  });

  it("combines TokenSave tools with every configured server's tools, namespaced (normal)", async () => {
    mockListTools.mockResolvedValue([{ name: "tokensave_search" }]);
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        github: { transport: "http", url: "https://example.invalid/mcp/" },
      },
      mcpSecrets: { github: { token: "ghp_x" } },
    });
    mockListMcpTools.mockResolvedValue([
      { name: "create_issue", description: "Create an issue", inputSchema: {}, readOnly: false },
    ]);

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(2);
    expect(mockListMcpTools).toHaveBeenCalledWith(
      "github",
      { transport: "http", url: "https://example.invalid/mcp/" },
      { token: "ghp_x" },
    );
    const [, payload] = mockSendCommand.mock.calls[0]!;
    const names = (payload as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(["tokensave_search", "mcp__github__create_issue"]);
  });

  it("skips a disabled server without connecting to it (boundary)", async () => {
    mockListTools.mockResolvedValue([{ name: "tokensave_search" }]);
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        github: {
          transport: "http",
          url: "https://example.invalid/mcp/",
          enabled: false,
        },
      },
      mcpSecrets: {},
    });

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1); // TokenSave only — the disabled server contributes nothing.
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("skips a server that fails to connect without blocking the others (error isolation)", async () => {
    mockListTools.mockResolvedValue([{ name: "tokensave_search" }]);
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        broken: { transport: "http", url: "https://broken.invalid/mcp/" },
      },
      mcpSecrets: {},
    });
    mockListMcpTools.mockRejectedValue(new Error("connection refused"));

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1); // TokenSave's tool still made it through.
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("broken"),
    );
  });

  it("returns 0 and sends nothing when there is nothing to sync (boundary)", async () => {
    mockIsOnPath.mockResolvedValue(false);
    const count = await syncAllMcpTools(conn, "/workspace");
    expect(count).toBe(0);
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  it("still syncs TokenSave's tools when reading mcpServers config fails (error)", async () => {
    mockListTools.mockResolvedValue([{ name: "tokensave_search" }]);
    mockLoadConfig.mockImplementation(() => {
      throw new Error("cipher locked");
    });

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("cipher locked"),
    );
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
