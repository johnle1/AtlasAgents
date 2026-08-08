/**
 * Unit tests — mcp/tokenSaveClient disconnectTokenSaveClient
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mcpMocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mcpMocks.connect;
    close = mcpMocks.close;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import {
  disconnectTokenSaveClient,
  getTokenSaveClient,
  resetTokenSaveClientForTests,
} from "../../../../packages/client/src/mcp/tokenSaveClient.js";

describe("disconnectTokenSaveClient", () => {
  beforeEach(() => {
    resetTokenSaveClientForTests();
    mcpMocks.connect.mockClear();
    mcpMocks.close.mockClear();
  });

  it("closes an active client and allows reconnect", async () => {
    await getTokenSaveClient("/tmp/workspace");
    expect(mcpMocks.connect).toHaveBeenCalled();

    await disconnectTokenSaveClient();
    expect(mcpMocks.close).toHaveBeenCalled();

    await getTokenSaveClient("/tmp/workspace");
    expect(mcpMocks.connect).toHaveBeenCalledTimes(2);
  });

  it("is safe when no client exists", async () => {
    await expect(disconnectTokenSaveClient()).resolves.toBeUndefined();
    expect(mcpMocks.close).not.toHaveBeenCalled();
  });
});
