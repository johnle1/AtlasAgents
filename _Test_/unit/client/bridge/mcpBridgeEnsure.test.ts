/**
 * Unit tests — mcp/mcpBridge ensureInitialized
 */

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasTokenSaveIndex: vi.fn(),
}));

vi.mock("../../../../packages/client/src/mcp/tokenSaveClient.js", () => ({
  hasTokenSaveIndex: mocks.hasTokenSaveIndex,
  getTokenSaveClient: vi.fn(),
  disconnectTokenSaveClient: vi.fn(),
  enqueueTokenSaveOperation: <T>(op: () => Promise<T>) => op(),
}));

import { ensureInitialized } from "../../../../packages/client/src/mcp/mcpBridge.js";

describe("ensureInitialized", () => {
  it("delegates to hasTokenSaveIndex", async () => {
    mocks.hasTokenSaveIndex.mockResolvedValueOnce(true);
    await expect(ensureInitialized("/workspace")).resolves.toBe(true);
    expect(mocks.hasTokenSaveIndex).toHaveBeenCalledWith("/workspace");

    mocks.hasTokenSaveIndex.mockResolvedValueOnce(false);
    await expect(ensureInitialized("/other")).resolves.toBe(false);
  });
});
