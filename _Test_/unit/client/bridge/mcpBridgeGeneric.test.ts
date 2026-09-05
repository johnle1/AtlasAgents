/**
 * Unit tests — mcp/mcpBridge.ts: callMcpTool.
 *
 * @remarks
 * `callTokenSaveTool` (the TokenSave-only path) is already covered in
 * `mcpBridge.test.ts`. `callMcpTool` — the path every non-TokenSave server
 * added via `/mcp add` goes through — had zero direct coverage before this
 * file; it was only exercised indirectly through `fileProxyHandlers.test.ts`'s
 * mocked `mcpBridge.js`.
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : `config/index.js` (`loadConfig`) and
 *   `mcp/mcpRegistry.js` (`callMcpToolOnServer`) are mocked so no real
 *   connection is ever attempted.
 *
 * Category checklist:
 *   ✅ Normal  — configured server found, secrets passed through, content
 *                formatting mirrors the TokenSave cases (string, array,
 *                object)
 *   ✅ Boundary — missing mcpSecrets entry defaults to {}, undefined content
 *   ✅ Error   — unconfigured server, result.isError, thrown error caught
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  callMcpToolOnServer: vi.fn(),
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../../../packages/client/src/mcp/mcpRegistry.js", () => ({
  callMcpToolOnServer: mocks.callMcpToolOnServer,
}));

vi.mock("../../../../packages/client/src/mcp/tokenSaveClient.js", () => ({
  getTokenSaveClient: vi.fn(),
  hasTokenSaveIndex: vi.fn(),
  disconnectTokenSaveClient: vi.fn(),
  enqueueTokenSaveOperation: <T>(op: () => Promise<T>) => op(),
}));

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printError: vi.fn(),
  printLine: vi.fn(),
  printSuccess: vi.fn(),
}));

import { callMcpTool } from "../../../../packages/client/src/mcp/mcpBridge.js";

const { loadConfig, callMcpToolOnServer } = mocks;

const configWith = (
  mcpServers: Record<string, unknown>,
  mcpSecrets: Record<string, Record<string, string>> = {},
) => ({ mcpServers, mcpSecrets });

beforeEach(() => {
  loadConfig.mockReset();
  callMcpToolOnServer.mockReset();
});

describe("callMcpTool — unconfigured server (error)", () => {
  it("returns an error result without calling callMcpToolOnServer (error)", async () => {
    loadConfig.mockReturnValue(configWith({}));

    const result = await callMcpTool("github", "create_issue", {});

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain('"github"');
    expect(result.errorMessage).toContain("not configured");
    expect(callMcpToolOnServer).not.toHaveBeenCalled();
  });
});

describe("callMcpTool — secrets lookup", () => {
  it("passes the server's mcpSecrets entry through (normal)", async () => {
    loadConfig.mockReturnValue(
      configWith(
        { github: { transport: "http", url: "https://x" } },
        { github: { token: "tok-123" } },
      ),
    );
    callMcpToolOnServer.mockResolvedValue({ isError: false, content: "ok" });

    await callMcpTool("github", "search_issues", { q: "bug" });

    expect(callMcpToolOnServer).toHaveBeenCalledWith(
      "github",
      { transport: "http", url: "https://x" },
      { token: "tok-123" },
      "search_issues",
      { q: "bug" },
    );
  });

  it("defaults to an empty secrets object when mcpSecrets has no entry (boundary)", async () => {
    loadConfig.mockReturnValue(
      configWith({ github: { transport: "http", url: "https://x" } }),
    );
    callMcpToolOnServer.mockResolvedValue({ isError: false, content: "ok" });

    await callMcpTool("github", "search_issues", {});

    expect(callMcpToolOnServer).toHaveBeenCalledWith(
      "github",
      { transport: "http", url: "https://x" },
      {},
      "search_issues",
      {},
    );
  });

  it("defaults missing/undefined arguments to an empty object (boundary)", async () => {
    loadConfig.mockReturnValue(
      configWith({ github: { transport: "http", url: "https://x" } }),
    );
    callMcpToolOnServer.mockResolvedValue({ isError: false, content: "ok" });

    await callMcpTool("github", "search_issues", undefined);

    expect(callMcpToolOnServer).toHaveBeenCalledWith(
      "github",
      { transport: "http", url: "https://x" },
      {},
      "search_issues",
      {},
    );
  });
});

describe("callMcpTool — success content formatting", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue(
      configWith({ github: { transport: "http", url: "https://x" } }),
    );
  });

  it("returns string content unchanged (normal)", async () => {
    callMcpToolOnServer.mockResolvedValue({ isError: false, content: "plain text" });
    const result = await callMcpTool("github", "search_issues", {});
    expect(result).toEqual({ isError: false, data: "plain text" });
  });

  it("joins an array of text blocks with newlines (normal)", async () => {
    callMcpToolOnServer.mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
    });
    const result = await callMcpTool("github", "search_issues", {});
    expect(result).toEqual({ isError: false, data: "line1\nline2" });
  });

  it("JSON-stringifies a non-text block inside an array (boundary)", async () => {
    callMcpToolOnServer.mockResolvedValue({
      isError: false,
      content: [{ type: "image", data: "base64==" }],
    });
    const result = await callMcpTool("github", "search_issues", {});
    expect(result).toEqual({
      isError: false,
      data: JSON.stringify({ type: "image", data: "base64==" }),
    });
  });

  it("passes through object content untouched when not an array (boundary)", async () => {
    callMcpToolOnServer.mockResolvedValue({ isError: false, content: { raw: true } });
    const result = await callMcpTool("github", "search_issues", {});
    expect(result).toEqual({ isError: false, data: { raw: true } });
  });
});

describe("callMcpTool — result.isError from the server (error)", () => {
  it("returns isError: true with a string errorMessage (error)", async () => {
    loadConfig.mockReturnValue(
      configWith({ github: { transport: "http", url: "https://x" } }),
    );
    callMcpToolOnServer.mockResolvedValue({
      isError: true,
      content: "rate limited",
    });

    const result = await callMcpTool("github", "search_issues", {});

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("rate limited");
    expect(result.data).toBe("rate limited");
  });

  it("stringifies object content into errorMessage on the error path (boundary)", async () => {
    loadConfig.mockReturnValue(
      configWith({ github: { transport: "http", url: "https://x" } }),
    );
    callMcpToolOnServer.mockResolvedValue({
      isError: true,
      content: { code: 429 },
    });

    const result = await callMcpTool("github", "search_issues", {});

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe(JSON.stringify({ code: 429 }));
  });

  it("returns an empty string errorMessage for undefined content on the error path (boundary)", async () => {
    loadConfig.mockReturnValue(
      configWith({ github: { transport: "http", url: "https://x" } }),
    );
    callMcpToolOnServer.mockResolvedValue({ isError: true, content: undefined });

    const result = await callMcpTool("github", "search_issues", {});

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("");
  });
});

describe("callMcpTool — thrown error (error)", () => {
  it("catches a thrown Error and returns its message, not rethrown (error)", async () => {
    loadConfig.mockReturnValue(
      configWith({ github: { transport: "http", url: "https://x" } }),
    );
    callMcpToolOnServer.mockRejectedValue(new Error("connection refused"));

    const result = await callMcpTool("github", "search_issues", {});

    expect(result).toEqual({ isError: true, errorMessage: "connection refused" });
  });

  it("stringifies a non-Error throwable (error — boundary)", async () => {
    loadConfig.mockReturnValue(
      configWith({ github: { transport: "http", url: "https://x" } }),
    );
    callMcpToolOnServer.mockRejectedValue("plain string failure");

    const result = await callMcpTool("github", "search_issues", {});

    expect(result).toEqual({ isError: true, errorMessage: "plain string failure" });
  });
});
