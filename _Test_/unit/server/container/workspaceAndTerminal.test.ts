/**
 * Unit tests — workspace manager, terminal executor, and WorkspaceError
 */

import { describe, expect, it, vi } from "vitest";
import { WorkspaceError } from "../../../../packages/server/src/workspace/manager/types.js";
import { WorkspaceManager } from "../../../../packages/server/src/workspace/manager/workspaceManager.js";
import { TerminalExecutor } from "../../../../packages/server/src/workspace/execution/terminalExecutor.js";
import { ClientBridge } from "../../../../packages/server/src/transport/clientBridge.js";

describe("WorkspaceError", () => {
  it("sets name and code", () => {
    const err = new WorkspaceError("NO_ROOT", "No client session bound");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WorkspaceError");
    expect(err.code).toBe("NO_ROOT");
    expect(err.message).toBe("No client session bound");
  });
});

describe("WorkspaceManager", () => {
  it("throws NO_ROOT when unbound", async () => {
    const manager = new WorkspaceManager(new ClientBridge(vi.fn()));
    await expect(manager.readFile("src/index.ts")).rejects.toMatchObject({
      code: "NO_ROOT",
    });
  });

  it("delegates readFile to the client bridge when bound", async () => {
    const request = vi.fn().mockResolvedValue({ content: "hello" });
    const bridge = { request } as unknown as ClientBridge;
    const manager = new WorkspaceManager(bridge);
    manager.bindRequester("client-1");

    await expect(manager.readFile("readme.md")).resolves.toBe("hello");
    expect(request).toHaveBeenCalledWith("client-1", "file.read", {
      path: "readme.md",
    });
  });
});

describe("TerminalExecutor", () => {
  it("throws when unbound", async () => {
    const executor = new TerminalExecutor(new ClientBridge(vi.fn()));
    await expect(executor.run("echo hi")).rejects.toThrow(/No client session bound/);
  });

  it("delegates run to the client bridge when bound", async () => {
    const request = vi.fn().mockResolvedValue({
      stdout: "hi",
      stderr: "",
      exitCode: 0,
    });
    const bridge = { request } as unknown as ClientBridge;
    const executor = new TerminalExecutor(bridge);
    executor.bindRequester("client-1");

    const result = await executor.run("echo hi");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(request).toHaveBeenCalled();
  });
});
