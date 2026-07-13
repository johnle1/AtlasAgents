/**
 * Unit tests — mcp/mcpBridge.ts
 *
 * Tests `callTokenSaveTool` — the public entry point that the file-proxy MCP
 * handler invokes. This module wraps the raw MCP `callTool` result and
 * converts non-string content into a safe string for `errorMessage`.
 *
 * Coverage focus
 * --------------
 * The recent unsafe-cast fix lives in the private helper
 * `formatToolContentAsString`. It guarantees `errorMessage` is always a
 * string even when the MCP server returns object or undefined content on the
 * error path. We exercise it via `callTokenSaveTool` with a mocked
 * `getTokenSaveClient` so the conversion behavior is observable.
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : `tokenSaveClient` module is mocked so we control
 *   the MCP client's `callTool` return value without spawning a real
 *   `tokensave` subprocess. `renderer.printError` is stubbed to keep the
 *   test silent.
 *
 * Category checklist:
 *   ✅ Normal  — string content on success and error paths
 *   ✅ Boundary — array of text blocks, object content, undefined content
 *   ✅ Error   — client throws → errorMessage is the thrown message string
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks: vi.mock factories are hoisted above imports, so any
//     variables they close over must be created with vi.hoisted(). ---
const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  getTokenSaveClient: vi.fn(),
  hasTokenSaveIndex: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("../../packages/client/src/mcp/tokenSaveClient", () => ({
  getTokenSaveClient: mocks.getTokenSaveClient,
  hasTokenSaveIndex: mocks.hasTokenSaveIndex,
  disconnectTokenSaveClient: mocks.disconnect,
  // Run operations inline — the queue itself is tested in tokenSaveClient.test.ts
  enqueueTokenSaveOperation: <T>(op: () => Promise<T>) => op(),
}));

vi.mock("../../packages/client/src/renderer", () => ({
  printError: vi.fn(),
  printLine: vi.fn(),
  printSuccess: vi.fn(),
}));

import { callTokenSaveTool } from "../../packages/client/src/mcp/mcpBridge";

const { callTool, getTokenSaveClient, hasTokenSaveIndex, disconnect } = mocks;

// ---------------------------------------------------------------------------
// Test fixture — a workspace root string used by all calls
// ---------------------------------------------------------------------------

const WORKSPACE = "/workspace/root";

beforeEach(() => {
  callTool.mockReset();
  getTokenSaveClient.mockReset();
  hasTokenSaveIndex.mockReset();
  disconnect.mockReset();
  disconnect.mockResolvedValue(undefined);
  // Re-establish the default happy-path mocks after reset
  getTokenSaveClient.mockResolvedValue({ callTool: callTool });
  hasTokenSaveIndex.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Not-initialized guard — callTokenSaveTool short-circuits before invoking MCP
// ---------------------------------------------------------------------------

describe("callTokenSaveTool — not initialized", () => {
  it("returns an error result without invoking the MCP client (boundary — guard)", async () => {
    hasTokenSaveIndex.mockResolvedValueOnce(false);

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("TokenSave not initialized");
    expect(getTokenSaveClient).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success path — isError: false
// ---------------------------------------------------------------------------

describe("callTokenSaveTool — success path", () => {
  it("returns string content unchanged (normal)", async () => {
    callTool.mockResolvedValueOnce({
      isError: false,
      content: "ok result",
    });

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", { query: "foo" });

    expect(result.isError).toBe(false);
    expect(result.data).toBe("ok result");
    expect(callTool).toHaveBeenCalledWith({
      name: "tokensave_search",
      arguments: { query: "foo" },
    });
  });

  it("joins an array of text blocks with newlines (normal — array content)", async () => {
    callTool.mockResolvedValueOnce({
      isError: false,
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_status", {});

    expect(result.isError).toBe(false);
    expect(result.data).toBe("first\nsecond");
  });

  it("defaults missing arguments to an empty object (boundary — no args)", async () => {
    callTool.mockResolvedValueOnce({ isError: false, content: "ok" });

    await callTokenSaveTool(WORKSPACE, "tokensave_status", undefined);

    expect(callTool).toHaveBeenCalledWith({
      name: "tokensave_status",
      arguments: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Error path — isError: true. This exercises formatToolContentAsString, the
// recent fix that guarantees errorMessage is always a string.
// ---------------------------------------------------------------------------

describe("callTokenSaveTool — error path content conversion (formatToolContentAsString)", () => {
  it("returns string content as-is on the error path (normal)", async () => {
    callTool.mockResolvedValueOnce({
      isError: true,
      content: "simple error message",
    });

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(result.isError).toBe(true);
    expect(typeof result.errorMessage).toBe("string");
    expect(result.errorMessage).toBe("simple error message");
  });

  it("joins an array of text blocks on the error path (normal — array content)", async () => {
    callTool.mockResolvedValueOnce({
      isError: true,
      content: [
        { type: "text", text: "first error" },
        { type: "text", text: "second error" },
      ],
    });

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("first error\nsecond error");
  });

  it("converts object content to a JSON string on the error path (boundary — non-string content)", async () => {
    // This is the exact case the fix targets: formatToolContent returns the
    // object unchanged for non-string non-array content. The old code cast
    // it `as string`, lying to the type system. The fix JSON-stringifies it.
    callTool.mockResolvedValueOnce({
      isError: true,
      content: { error: "complex object", code: 500 },
    });

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(result.isError).toBe(true);
    expect(typeof result.errorMessage).toBe("string");
    expect(result.errorMessage).toContain("complex object");
    expect(result.errorMessage).toContain("500");
  });

  it("returns an empty string for undefined content on the error path (boundary)", async () => {
    callTool.mockResolvedValueOnce({
      isError: true,
      content: undefined,
    });

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(result.isError).toBe(true);
    expect(typeof result.errorMessage).toBe("string");
    expect(result.errorMessage).toBe("");
  });

  it("handles a number content value on the error path (boundary — primitive non-string)", async () => {
    callTool.mockResolvedValueOnce({
      isError: true,
      content: 404,
    });

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(result.isError).toBe(true);
    expect(typeof result.errorMessage).toBe("string");
    // Numbers are not arrays and not strings → JSON.stringify produces "404"
    expect(result.errorMessage).toBe("404");
  });
});

// ---------------------------------------------------------------------------
// Exception path — client.callTool throws
// ---------------------------------------------------------------------------

describe("callTokenSaveTool — client throws", () => {
  it("returns an error result with the thrown message (error)", async () => {
    callTool.mockRejectedValueOnce(new Error("transport closed"));

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("transport closed");
  });

  it("stringifies non-Error throwables (error — boundary)", async () => {
    callTool.mockRejectedValueOnce("string throw");

    const result = await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("string throw");
  });

  it("resets the client after an exception so the next call reconnects (error — recovery)", async () => {
    callTool.mockRejectedValueOnce(new Error("boom"));

    await callTokenSaveTool(WORKSPACE, "tokensave_search", {});

    expect(disconnect).toHaveBeenCalled();
  });
});
