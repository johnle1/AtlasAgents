/**
 * Unit tests — client commands/mcpHandlers.ts (`/mcp`).
 *
 * Category checklist:
 * - Normal: list/add-custom/add-preset/remove/tools/test happy paths
 * - Boundary: custom add wins over a same-named preset id when --command/--url present;
 *   listing with no servers configured
 * - Error: missing args, unknown server name, a server that fails to connect
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadConfig,
  mockUpdateConfig,
  mockIsTokenSaveOnPath,
  mockListMcpTools,
  mockDisconnectMcpClient,
  mockSyncAllMcpTools,
  mockPrintLine,
  mockPrintError,
  mockPrintSuccess,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockUpdateConfig: vi.fn(),
  mockIsTokenSaveOnPath: vi.fn(),
  mockListMcpTools: vi.fn(),
  mockDisconnectMcpClient: vi.fn(),
  mockSyncAllMcpTools: vi.fn(),
  mockPrintLine: vi.fn(),
  mockPrintError: vi.fn(),
  mockPrintSuccess: vi.fn(),
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: mockLoadConfig,
  updateConfig: mockUpdateConfig,
}));

vi.mock("../../../../packages/client/src/mcp/tokenSaveClient.js", () => ({
  isTokenSaveOnPath: mockIsTokenSaveOnPath,
}));

vi.mock("../../../../packages/client/src/mcp/mcpRegistry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../packages/client/src/mcp/mcpRegistry.js")
  >("../../../../packages/client/src/mcp/mcpRegistry.js");
  return {
    ...actual,
    listMcpTools: mockListMcpTools,
    disconnectMcpClient: mockDisconnectMcpClient,
  };
});

vi.mock("../../../../packages/client/src/commands/tokenSaveHandlers.js", () => ({
  syncAllMcpTools: mockSyncAllMcpTools,
}));

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printLine: mockPrintLine,
  printError: mockPrintError,
  printSuccess: mockPrintSuccess,
}));

import { handleMcp } from "../../../../packages/client/src/commands/mcpHandlers.js";

const conn = {} as never;
const fileProxy = { getWorkspaceRoot: () => "/workspace" } as never;
const prompts = {
  question: vi.fn(async () => "secret-value"),
  choose: vi.fn(),
  pickTheme: vi.fn(),
};

const emptyConfig = () => ({ mcpServers: {}, mcpSecrets: {} });

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue(emptyConfig());
  mockIsTokenSaveOnPath.mockResolvedValue(false);
  mockSyncAllMcpTools.mockResolvedValue(0);
  prompts.question.mockResolvedValue("secret-value");
});

describe("handleMcp — list", () => {
  it("reports no servers when none are configured and tokensave is absent (boundary)", async () => {
    await handleMcp("list", "", conn, fileProxy, prompts);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("No MCP servers configured"),
    );
  });

  it("lists configured servers with their connection shape (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        github: { transport: "http", url: "https://example.invalid/mcp/" },
      },
      mcpSecrets: {},
    });
    await handleMcp("list", "", conn, fileProxy, prompts);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("github"),
    );
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("https://example.invalid/mcp/"),
    );
  });

  it("shows tokensave as built-in when it's on PATH (normal)", async () => {
    mockIsTokenSaveOnPath.mockResolvedValue(true);
    await handleMcp("list", "", conn, fileProxy, prompts);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("tokensave"),
    );
  });

  it("treats bare /mcp the same as /mcp list", async () => {
    await handleMcp("", "", conn, fileProxy, prompts);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("No MCP servers configured"),
    );
  });
});

describe("handleMcp — add (preset)", () => {
  it("prompts for each secret field and writes config for a preset (normal)", async () => {
    await handleMcp("add", "github", conn, fileProxy, prompts);

    expect(prompts.question).toHaveBeenCalledWith(
      expect.stringContaining("personal access token"),
      { masked: true },
    );
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          github: { transport: "http", url: expect.any(String) },
        }),
        mcpSecrets: expect.objectContaining({
          github: { token: "secret-value" },
        }),
      }),
    );
    expect(mockPrintSuccess).toHaveBeenCalled();
  });

  it("syncs tools to the server after adding a preset", async () => {
    mockSyncAllMcpTools.mockResolvedValue(3);
    await handleMcp("add", "slack", conn, fileProxy, prompts);
    expect(mockSyncAllMcpTools).toHaveBeenCalledWith(conn, "/workspace");
    expect(mockPrintSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Synced 3"),
    );
  });
});

describe("handleMcp — add (custom)", () => {
  it("adds a custom stdio server with comma-separated args (normal)", async () => {
    await handleMcp(
      "add",
      "my-tool --command npx --args -y,@me/my-mcp",
      conn,
      fileProxy,
      prompts,
    );
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          "my-tool": {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@me/my-mcp"],
          },
        }),
      }),
    );
  });

  it("adds a custom http server with --readonly", async () => {
    await handleMcp(
      "add",
      "internal-docs --url https://docs.internal/mcp --readonly",
      conn,
      fileProxy,
      prompts,
    );
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          "internal-docs": {
            transport: "http",
            url: "https://docs.internal/mcp",
            readOnly: true,
          },
        }),
      }),
    );
  });

  it("a custom --command wins over a same-named preset id (boundary)", async () => {
    // "github" is also a preset id — an explicit --command must not be
    // silently discarded in favor of the built-in preset.
    await handleMcp(
      "add",
      "github --command my-custom-github-mcp",
      conn,
      fileProxy,
      prompts,
    );
    expect(prompts.question).not.toHaveBeenCalled();
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          github: expect.objectContaining({ command: "my-custom-github-mcp" }),
        }),
      }),
    );
  });

  it("rejects add with no name (error)", async () => {
    await handleMcp("add", "", conn, fileProxy, prompts);
    expect(mockPrintError).toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("rejects a custom add with neither --command nor --url (error)", async () => {
    await handleMcp("add", "my-tool", conn, fileProxy, prompts);
    expect(mockPrintError).toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

describe("handleMcp — remove", () => {
  it("removes a configured server and its secrets, then disconnects (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        github: { transport: "http", url: "https://x" },
        slack: { transport: "stdio", command: "npx" },
      },
      mcpSecrets: { github: { token: "x" } },
    });

    await handleMcp("remove", "github", conn, fileProxy, prompts);

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      mcpServers: { slack: { transport: "stdio", command: "npx" } },
      mcpSecrets: {},
    });
    expect(mockDisconnectMcpClient).toHaveBeenCalledWith("github");
  });

  it("rejects removing an unconfigured server (error)", async () => {
    await handleMcp("remove", "nonexistent", conn, fileProxy, prompts);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("nonexistent"),
    );
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("rejects remove with no name (error)", async () => {
    await handleMcp("remove", "", conn, fileProxy, prompts);
    expect(mockPrintError).toHaveBeenCalled();
  });
});

describe("handleMcp — enable/disable", () => {
  it("disables a configured server, persists it, and re-syncs (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: { github: { transport: "http", url: "https://x" } },
      mcpSecrets: {},
    });

    await handleMcp("disable", "github", conn, fileProxy, prompts);

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      mcpServers: {
        github: { transport: "http", url: "https://x", enabled: false },
      },
    });
    expect(mockSyncAllMcpTools).toHaveBeenCalledWith(conn, "/workspace");
    expect(mockPrintSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Disabled"),
    );
  });

  it("re-enables a disabled server (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        github: { transport: "http", url: "https://x", enabled: false },
      },
      mcpSecrets: {},
    });

    await handleMcp("enable", "github", conn, fileProxy, prompts);

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      mcpServers: {
        github: { transport: "http", url: "https://x", enabled: true },
      },
    });
    expect(mockPrintSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Enabled"),
    );
  });

  it("marks a disabled server in /mcp list", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        github: { transport: "http", url: "https://x", enabled: false },
      },
      mcpSecrets: {},
    });

    await handleMcp("list", "", conn, fileProxy, prompts);

    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("[disabled]"),
    );
  });

  it("rejects enable/disable for an unconfigured server (error)", async () => {
    await handleMcp("disable", "nonexistent", conn, fileProxy, prompts);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("nonexistent"),
    );
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("rejects enable/disable with no name (error)", async () => {
    await handleMcp("disable", "", conn, fileProxy, prompts);
    expect(mockPrintError).toHaveBeenCalled();
  });
});

describe("handleMcp — tools", () => {
  it("lists discovered tools with a read-only marker (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: { github: { transport: "http", url: "https://x" } },
      mcpSecrets: {},
    });
    mockListMcpTools.mockResolvedValue([
      { name: "search_issues", inputSchema: {}, readOnly: true },
      { name: "create_issue", inputSchema: {}, readOnly: false },
    ]);

    await handleMcp("tools", "", conn, fileProxy, prompts);

    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("mcp__github__search_issues (read-only)"),
    );
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("mcp__github__create_issue"),
    );
  });

  it("skips a disabled server when listing tools for all servers (boundary)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        github: { transport: "http", url: "https://x", enabled: false },
        slack: { transport: "stdio", command: "npx" },
      },
      mcpSecrets: {},
    });
    mockListMcpTools.mockResolvedValue([{ name: "send_message", inputSchema: {}, readOnly: false }]);

    await handleMcp("tools", "", conn, fileProxy, prompts);

    expect(mockListMcpTools).not.toHaveBeenCalledWith(
      "github",
      expect.anything(),
      expect.anything(),
    );
    expect(mockListMcpTools).toHaveBeenCalledWith(
      "slack",
      expect.anything(),
      expect.anything(),
    );
  });

  it("still lists a disabled server's tools when named explicitly (boundary)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        github: { transport: "http", url: "https://x", enabled: false },
      },
      mcpSecrets: {},
    });
    mockListMcpTools.mockResolvedValue([{ name: "search_issues", inputSchema: {}, readOnly: true }]);

    await handleMcp("tools", "github", conn, fileProxy, prompts);

    expect(mockListMcpTools).toHaveBeenCalledWith(
      "github",
      expect.anything(),
      expect.anything(),
    );
  });

  it("reports a connection failure for one server without throwing (error)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: { broken: { transport: "http", url: "https://x" } },
      mcpSecrets: {},
    });
    mockListMcpTools.mockRejectedValue(new Error("refused"));

    await handleMcp("tools", "", conn, fileProxy, prompts);

    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("refused"),
    );
  });
});

describe("handleMcp — check", () => {
  it("reports the tool count on success (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: { github: { transport: "http", url: "https://x" } },
      mcpSecrets: {},
    });
    mockListMcpTools.mockResolvedValue([{ name: "a" }, { name: "b" }]);

    await handleMcp("check", "github", conn, fileProxy, prompts);

    expect(mockPrintSuccess).toHaveBeenCalledWith(
      expect.stringContaining("2 tool(s)"),
    );
  });

  it("reports a connection failure (error)", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: { github: { transport: "http", url: "https://x" } },
      mcpSecrets: {},
    });
    mockListMcpTools.mockRejectedValue(new Error("timed out"));

    await handleMcp("check", "github", conn, fileProxy, prompts);

    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("timed out"),
    );
  });

  it("rejects an unconfigured server name (error)", async () => {
    await handleMcp("check", "nonexistent", conn, fileProxy, prompts);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("nonexistent"),
    );
  });
});

describe("handleMcp — unknown subcommand", () => {
  it("prints usage", async () => {
    await handleMcp("bogus", "", conn, fileProxy, prompts);
    expect(mockPrintError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});
