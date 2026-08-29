/**
 * Unit tests — client mcp/mcpRegistry.ts (namespacing, read-only resolution,
 * per-server operation queue). Connection/transport behavior needs a real or
 * mocked MCP server and is exercised in mcpBridge/mcpHandlers tests instead.
 *
 * Category checklist:
 * - Normal: namespacing round-trips; tokensave stays bare; annotation wins
 *   over server default when both are set
 * - Boundary: empty/malformed namespaced names, per-server queue isolation
 * - Error: neither shape matches → parseNamespacedTool returns null
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  enqueueMcpOperation,
  getToolMetadata,
  namespaceToolName,
  parseNamespacedTool,
  registerToolMetadata,
  resetToolRegistryForTests,
  resolveToolReadOnly,
} from "../../../../packages/client/src/mcp/mcpRegistry.js";
import type { McpServerConfig } from "../../../../packages/client/src/config/types.js";

describe("namespaceToolName / parseNamespacedTool", () => {
  it("namespaces a non-tokensave server's tool as mcp__<server>__<tool> (normal)", () => {
    expect(namespaceToolName("github", "create_issue")).toBe(
      "mcp__github__create_issue",
    );
  });

  it("keeps tokensave's tool names bare, for backward compatibility (normal)", () => {
    expect(namespaceToolName("tokensave", "tokensave_search")).toBe(
      "tokensave_search",
    );
  });

  it("round-trips a namespaced name back to server + tool (normal)", () => {
    expect(parseNamespacedTool("mcp__github__create_issue")).toEqual({
      serverId: "github",
      toolName: "create_issue",
    });
  });

  it("round-trips a bare tokensave name (normal)", () => {
    expect(parseNamespacedTool("tokensave_search")).toEqual({
      serverId: "tokensave",
      toolName: "tokensave_search",
    });
  });

  it("preserves double underscores inside the tool name itself (boundary)", () => {
    // Only the first "__" after the server id is the separator — the tool
    // name may itself contain "__" without corrupting the split.
    expect(parseNamespacedTool("mcp__jira__search__issues")).toEqual({
      serverId: "jira",
      toolName: "search__issues",
    });
  });

  it("returns null for a namespaced-looking prefix with no tool separator (error)", () => {
    expect(parseNamespacedTool("mcp__github")).toBeNull();
  });

  it("returns null for a name matching neither shape (error)", () => {
    expect(parseNamespacedTool("read_file")).toBeNull();
    expect(parseNamespacedTool("")).toBeNull();
  });
});

describe("resolveToolReadOnly", () => {
  const httpConfig: McpServerConfig = { transport: "http", url: "https://x" };

  it("uses the tool's own annotation when present (normal)", () => {
    expect(resolveToolReadOnly(true, httpConfig)).toBe(true);
    expect(resolveToolReadOnly(false, httpConfig)).toBe(false);
  });

  it("falls back to the server config override when the annotation is absent (normal)", () => {
    expect(resolveToolReadOnly(undefined, { ...httpConfig, readOnly: true })).toBe(
      true,
    );
  });

  it("defaults to false (not read-only) when neither is set (error — safer default)", () => {
    expect(resolveToolReadOnly(undefined, httpConfig)).toBe(false);
  });

  it("the tool's own annotation wins even over a server override (boundary)", () => {
    expect(resolveToolReadOnly(false, { ...httpConfig, readOnly: true })).toBe(
      false,
    );
  });
});

describe("tool metadata registry", () => {
  beforeEach(() => {
    resetToolRegistryForTests();
  });

  it("registers and looks up a tool by its namespaced name (normal)", () => {
    registerToolMetadata("github", "create_issue", false);
    expect(getToolMetadata("mcp__github__create_issue")).toEqual({
      serverId: "github",
      toolName: "create_issue",
      readOnly: false,
    });
  });

  it("returns undefined for a tool never registered (error)", () => {
    expect(getToolMetadata("mcp__unknown__tool")).toBeUndefined();
  });
});

describe("enqueueMcpOperation", () => {
  it("runs operations for the same server strictly in order, even before any connection exists (normal)", async () => {
    const order: number[] = [];
    const serverId = `test-server-${Math.random()}`;

    const first = enqueueMcpOperation(serverId, async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    const second = enqueueMcpOperation(serverId, async () => {
      order.push(2);
    });

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("does not let one server's queue block another server's operations (boundary)", async () => {
    const order: string[] = [];
    const slow = enqueueMcpOperation("server-a", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a");
    });
    const fast = enqueueMcpOperation("server-b", async () => {
      order.push("b");
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(["b", "a"]);
  });

  it("continues the queue after a failed operation rather than jamming it (error)", async () => {
    const serverId = `test-server-fail-${Math.random()}`;
    const results: string[] = [];

    const failing = enqueueMcpOperation(serverId, async () => {
      throw new Error("boom");
    });
    const next = enqueueMcpOperation(serverId, async () => {
      results.push("ran");
    });

    await expect(failing).rejects.toThrow("boom");
    await next;
    expect(results).toEqual(["ran"]);
  });
});
