/**
 * Unit tests — fileProxy/directoryListing.ts and LocalFileProxy listing APIs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  expandDirectory,
  listDirectoryEntries,
  listStructure,
} from "../../../../packages/client/src/fileProxy/directoryListing.js";
import { LocalFileProxy } from "../../../../packages/client/src/fileProxy/proxy.js";

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printListDir: vi.fn(),
  printListDirEntries: vi.fn(),
}));

vi.mock("../../../../packages/client/src/state/listExpandState.js", () => ({
  markExpanded: vi.fn(),
  pushListDir: vi.fn(),
}));

describe("listDirectoryEntries", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-list-"));
    await fs.writeFile(path.join(workspace, "a.txt"), "a");
    await fs.mkdir(path.join(workspace, "sub"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("lists files and directories under the workspace", async () => {
    const entries = await listDirectoryEntries(workspace, workspace);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "sub"]);
    expect(entries.find((e) => e.name === "sub")?.isDirectory).toBe(true);
  });

  it("rejects paths outside the workspace root", async () => {
    await expect(
      listDirectoryEntries(workspace, os.tmpdir()),
    ).rejects.toThrow("Path escapes workspace root");
  });
});

describe("listStructure", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tree-"));
    await fs.mkdir(path.join(workspace, "src"));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), "");
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("returns indented structure text", async () => {
    const text = await listStructure(
      { workspaceRoot: workspace, currentDir: workspace },
      2,
    );
    expect(text).toContain("src");
    expect(text).toContain("index.ts");
  });
});

describe("expandDirectory", () => {
  it("loads entries via injected listDirectoryEntries", async () => {
    const listDirectoryEntriesFn = vi.fn(async () => [
      { name: "child", isDirectory: false },
    ]);
    await expandDirectory(
      {
        workspaceRoot: "/w",
        listDirectoryEntries: listDirectoryEntriesFn,
      },
      "/w",
      0,
    );
    expect(listDirectoryEntriesFn).toHaveBeenCalledWith("/w");
  });
});

describe("LocalFileProxy", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-proxy-"));
    await fs.writeFile(path.join(workspace, "readme.md"), "# hi");
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("exposes cwd, workspace root, and resolveAbsolute", () => {
    const proxy = new LocalFileProxy(workspace);
    expect(proxy.getWorkspaceRoot()).toBe(path.resolve(workspace));
    expect(proxy.getCwd()).toBe(path.resolve(workspace));
    expect(proxy.resolveAbsolute("readme.md")).toBe(
      path.join(workspace, "readme.md"),
    );
  });

  it("setWorkspaceRoot resets cwd and notifies callback", () => {
    const onCwd = vi.fn();
    const proxy = new LocalFileProxy(workspace, onCwd);
    const other = path.join(workspace, "nested");
    proxy.setWorkspaceRoot(other);
    expect(proxy.getWorkspaceRoot()).toBe(path.resolve(other));
    expect(onCwd).toHaveBeenCalledWith(path.resolve(other));
  });

  it("handle returns connection lost when session aborted", async () => {
    const proxy = new LocalFileProxy(workspace);
    const controller = new AbortController();
    controller.abort();
    proxy.setSessionAbortSignal(() => controller.signal);
    const result = await proxy.handle("file.get_cwd", {});
    expect(result).toEqual({ ok: false, error: "Connection lost" });
  });

  it("handle dispatches file.get_cwd successfully", async () => {
    const proxy = new LocalFileProxy(workspace);
    const result = await proxy.handle("file.get_cwd", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ cwd: path.resolve(workspace) });
    }
  });
});
