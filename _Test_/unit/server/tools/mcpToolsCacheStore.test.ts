/**
 * Unit tests — server orchestration/mcp/mcpToolsCacheStore.ts
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { McpToolsCacheStore } from "../../../../packages/server/src/orchestration/mcp/mcpToolsCacheStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "atlas-mcp-tools-cache-store-"),
  );
  tempRoots.push(root);
  return root;
};

const someTools = [
  { name: "create_issue", description: "Create an issue", inputSchema: {}, readOnly: false },
];

describe("McpToolsCacheStore", () => {
  it("returns undefined for a key that was never set (boundary)", async () => {
    const store = new McpToolsCacheStore({ rootDir: await makeRoot() });
    expect(store.get("client-1", "/workspace")).toBeUndefined();
  });

  it("returns undefined when the cache file doesn't exist yet (boundary)", async () => {
    const missingRoot = path.join(os.tmpdir(), `atlas-mcp-cache-missing-${Date.now()}`);
    const store = new McpToolsCacheStore({ rootDir: missingRoot });
    expect(store.get("client-1", "/workspace")).toBeUndefined();
  });

  it("stores and retrieves an entry for (clientId, workspaceRoot) (normal)", async () => {
    const store = new McpToolsCacheStore({ rootDir: await makeRoot() });
    await store.set("client-1", "/workspace", "marker-a", someTools);
    expect(store.get("client-1", "/workspace")).toEqual({
      marker: "marker-a",
      tools: someTools,
    });
  });

  it("keeps different clients' entries for the same workspace separate (normal — the multi-client fix)", async () => {
    const store = new McpToolsCacheStore({ rootDir: await makeRoot() });
    await store.set("client-1", "/workspace", "marker-a", someTools);
    expect(store.get("client-2", "/workspace")).toBeUndefined();
  });

  it("keeps the same client's entries for different workspaces separate (normal)", async () => {
    const store = new McpToolsCacheStore({ rootDir: await makeRoot() });
    await store.set("client-1", "/workspace-a", "marker-a", someTools);
    expect(store.get("client-1", "/workspace-b")).toBeUndefined();
  });

  it("persists across a new store instance reading the same rootDir (normal — survives a restart)", async () => {
    const root = await makeRoot();
    const store1 = new McpToolsCacheStore({ rootDir: root });
    await store1.set("client-1", "/workspace", "marker-a", someTools);

    const store2 = new McpToolsCacheStore({ rootDir: root });
    expect(store2.get("client-1", "/workspace")).toEqual({
      marker: "marker-a",
      tools: someTools,
    });
  });

  it("overwrites a stale entry with a new marker for the same key (normal)", async () => {
    const store = new McpToolsCacheStore({ rootDir: await makeRoot() });
    await store.set("client-1", "/workspace", "marker-a", someTools);
    await store.set("client-1", "/workspace", "marker-b", []);
    expect(store.get("client-1", "/workspace")).toEqual({
      marker: "marker-b",
      tools: [],
    });
  });
});
