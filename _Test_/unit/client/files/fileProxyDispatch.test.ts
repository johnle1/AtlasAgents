/**
 * Unit tests — fileProxy/dispatch.ts
 */

import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../../../../packages/client/src/fileProxy/dispatch.js";
import type { DispatchContext } from "../../../../packages/client/src/fileProxy/types.js";

vi.mock("../../../../packages/client/src/fileProxy/handlers/fileHandlers.js", () => ({
  handleFileRead: vi.fn(async () => ({ content: "x" })),
  handleFileWrite: vi.fn(),
  handleFileListDir: vi.fn(),
  handleFileSearch: vi.fn(),
  handleFileCreateDir: vi.fn(),
  handleFileDeleteFile: vi.fn(),
  handleFileDeleteDir: vi.fn(),
  handleFileCd: vi.fn(),
  handleFileGetCwd: vi.fn(async () => ({ cwd: "/w" })),
}));

vi.mock("../../../../packages/client/src/fileProxy/handlers/commandHandlers.js", () => ({
  handleCommandClassify: vi.fn(async () => ({ classification: "safe" })),
  handleCommandRun: vi.fn(async () => ({ exitCode: 0 })),
}));

vi.mock("../../../../packages/client/src/fileProxy/handlers/mcpHandlers.js", () => ({
  handleMcpCall: vi.fn(async () => ({ isError: false })),
}));

import { handleFileGetCwd } from "../../../../packages/client/src/fileProxy/handlers/fileHandlers.js";
import { handleCommandClassify } from "../../../../packages/client/src/fileProxy/handlers/commandHandlers.js";
import { handleMcpCall } from "../../../../packages/client/src/fileProxy/handlers/mcpHandlers.js";

const baseContext = {
  workspaceRoot: "/w",
  currentDir: "/w",
  resolveAbsolute: (p: string) => `/w/${p}`,
  setCurrentDir: vi.fn(),
  classifyCommand: () => "safe" as const,
  runShell: vi.fn(),
  listStructure: vi.fn(),
} satisfies DispatchContext;

describe("dispatch", () => {
  it("routes file.get_cwd to handleFileGetCwd", async () => {
    const result = await dispatch(baseContext, "file.get_cwd", {});
    expect(handleFileGetCwd).toHaveBeenCalled();
    expect(result).toEqual({ cwd: "/w" });
  });

  it("routes command.classify to handleCommandClassify", async () => {
    const result = await dispatch(baseContext, "command.classify", {
      command: "ls",
    });
    expect(handleCommandClassify).toHaveBeenCalledWith(baseContext, {
      command: "ls",
    });
    expect(result).toEqual({ classification: "safe" });
  });

  it("routes mcp.call to handleMcpCall", async () => {
    await dispatch(baseContext, "mcp.call", { tool: "tokensave_status" });
    expect(handleMcpCall).toHaveBeenCalled();
  });

  it("throws for unknown routes", async () => {
    await expect(
      dispatch(baseContext, "file.nope" as "file.read", {}),
    ).rejects.toThrow("Unknown route");
  });
});
