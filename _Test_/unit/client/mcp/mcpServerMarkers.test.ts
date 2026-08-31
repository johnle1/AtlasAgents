/**
 * Unit tests — client mcp/mcpServerMarkers.ts
 *
 * Category checklist:
 * - Normal: stable fingerprints, pin detection for npm/python-style specs
 * - Boundary: key ordering, scoped packages, dist-tags
 * - Error: HTTP transport, unparseable/local commands never count as pinned
 */

import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  computeRootMarker,
  computeServerMarker,
  isVersionPinned,
} from "../../../../packages/client/src/mcp/mcpServerMarkers.js";
import type { McpServerConfig } from "../../../../packages/client/src/config/types.js";

describe("canonicalStringify", () => {
  it("produces identical output regardless of key insertion order (normal)", () => {
    const a = { z: 1, a: 2, m: { y: 1, b: 2 } };
    const b = { a: 2, m: { b: 2, y: 1 }, z: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("distinguishes arrays from objects and preserves array order (boundary)", () => {
    expect(canonicalStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalStringify([3, 2, 1])).not.toBe(canonicalStringify([1, 2, 3]));
  });

  it("distinguishes different values that would collide as strings (error)", () => {
    expect(canonicalStringify({ a: "1" })).not.toBe(canonicalStringify({ a: 1 }));
  });
});

describe("computeServerMarker", () => {
  const config: McpServerConfig = { transport: "stdio", command: "npx", args: ["-y", "pkg"] };

  it("is stable for identical inputs (normal)", () => {
    expect(computeServerMarker("github", config, { token: "x" })).toBe(
      computeServerMarker("github", config, { token: "x" }),
    );
  });

  it("changes when the serverId changes, even with identical config (boundary)", () => {
    expect(computeServerMarker("github", config, {})).not.toBe(
      computeServerMarker("jira", config, {}),
    );
  });

  it("changes when secrets change (normal — secret rotation invalidates the cache)", () => {
    expect(computeServerMarker("github", config, { token: "old" })).not.toBe(
      computeServerMarker("github", config, { token: "new" }),
    );
  });

  it("does not change for key-order differences in args/config objects (boundary)", () => {
    const withEnabled: McpServerConfig = { ...config, enabled: true, readOnly: false };
    const reordered = { readOnly: false, enabled: true, ...config } as McpServerConfig;
    expect(computeServerMarker("github", withEnabled, {})).toBe(
      computeServerMarker("github", reordered, {}),
    );
  });
});

describe("computeRootMarker", () => {
  it("is order-independent over the leaves map (normal)", () => {
    const a = computeRootMarker({ github: "m1", jira: "m2" });
    const b = computeRootMarker({ jira: "m2", github: "m1" });
    expect(a).toBe(b);
  });

  it("changes when any single leaf changes (normal)", () => {
    const before = computeRootMarker({ github: "m1", jira: "m2" });
    const after = computeRootMarker({ github: "m1-changed", jira: "m2" });
    expect(before).not.toBe(after);
  });

  it("changes when a server is added or removed (normal)", () => {
    const two = computeRootMarker({ github: "m1", jira: "m2" });
    const one = computeRootMarker({ github: "m1" });
    expect(two).not.toBe(one);
  });

  it("is deterministic for an empty leaf set (boundary)", () => {
    expect(computeRootMarker({})).toBe(computeRootMarker({}));
  });
});

describe("isVersionPinned", () => {
  it("treats a scoped package with an exact version as pinned (normal)", () => {
    expect(
      isVersionPinned({ transport: "stdio", command: "npx", args: ["-y", "@scope/pkg@1.2.3"] }),
    ).toBe(true);
  });

  it("treats an unscoped package with an exact version as pinned (normal)", () => {
    expect(isVersionPinned({ transport: "stdio", command: "npx", args: ["-y", "pkg@1.2.3"] })).toBe(
      true,
    );
  });

  it("treats a python-style pinned spec as pinned (normal)", () => {
    expect(
      isVersionPinned({ transport: "stdio", command: "uvx", args: ["pkg==1.2.3"] }),
    ).toBe(true);
  });

  it("does not treat a scoped package with no version as pinned (boundary — the scope-@ trap)", () => {
    expect(isVersionPinned({ transport: "stdio", command: "npx", args: ["-y", "@scope/pkg"] })).toBe(
      false,
    );
  });

  it("does not treat a dist-tag as pinned (boundary)", () => {
    expect(
      isVersionPinned({ transport: "stdio", command: "npx", args: ["-y", "@scope/pkg@latest"] }),
    ).toBe(false);
    expect(isVersionPinned({ transport: "stdio", command: "npx", args: ["pkg@next"] })).toBe(false);
  });

  it("skips a runner subcommand like pnpm dlx before finding the spec (normal)", () => {
    expect(
      isVersionPinned({ transport: "stdio", command: "pnpm", args: ["dlx", "pkg@1.2.3"] }),
    ).toBe(true);
  });

  it("never treats an HTTP transport as pinned (error — always re-checkable)", () => {
    expect(isVersionPinned({ transport: "http", url: "https://example.invalid" })).toBe(false);
  });

  it("does not treat a bare local script path as pinned (error)", () => {
    expect(
      isVersionPinned({ transport: "stdio", command: "node", args: ["./server.js"] }),
    ).toBe(false);
  });

  it("does not treat a command with no args as pinned (boundary)", () => {
    expect(isVersionPinned({ transport: "stdio", command: "my-mcp-server" })).toBe(false);
  });
});
