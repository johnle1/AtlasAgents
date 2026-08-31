/**
 * Unit tests — client mcp/mcpToolsCache.ts
 *
 * Category checklist:
 * - Normal: per-server file round-trip, write/delete isolation
 * - Boundary: legacy blob cleanup, one corrupt file doesn't poison the batch
 * - Error: missing directory, malformed JSON
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockReaddirSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockRenameSync,
  mockUnlinkSync,
  mockMkdirSync,
  mockEnsureDirs,
} = vi.hoisted(() => ({
  mockReaddirSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockEnsureDirs: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
    unlinkSync: mockUnlinkSync,
    mkdirSync: mockMkdirSync,
  },
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  unlinkSync: mockUnlinkSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  CONFIG_DIR: "/fake-home/.atlasagents",
  ensureDirs: mockEnsureDirs,
}));

import {
  deleteCacheEntry,
  loadMcpToolsCache,
  writeCacheEntry,
  type CachedEntry,
} from "../../../../packages/client/src/mcp/mcpToolsCache.js";

const githubEntry: CachedEntry = {
  serverId: "github",
  marker: "marker-1",
  tools: [{ name: "create_issue", description: "make one", inputSchema: {}, readOnly: false }],
  discoveredAt: 1000,
  pinned: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockReturnValue([]);
  mockUnlinkSync.mockImplementation(() => undefined);
});

describe("loadMcpToolsCache", () => {
  it("returns an empty map when the cache directory doesn't exist yet (boundary)", () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadMcpToolsCache()).toEqual({});
  });

  it("loads every entry, keyed by its own serverId field (normal)", () => {
    mockReaddirSync.mockReturnValue(["file-a.json", "file-b.json"]);
    mockReadFileSync.mockImplementation((filePath: string) =>
      filePath.includes("file-a")
        ? JSON.stringify(githubEntry)
        : JSON.stringify({ ...githubEntry, serverId: "jira", marker: "marker-2" }),
    );

    const result = loadMcpToolsCache();

    expect(Object.keys(result).sort()).toEqual(["github", "jira"]);
    expect(result.github).toEqual(githubEntry);
  });

  it("skips one corrupt file without failing the whole load (error — no poisoning the batch)", () => {
    mockReaddirSync.mockReturnValue(["good.json", "corrupt.json"]);
    mockReadFileSync.mockImplementation((filePath: string) =>
      filePath.includes("corrupt") ? "{not json" : JSON.stringify(githubEntry),
    );

    const result = loadMcpToolsCache();

    expect(Object.keys(result)).toEqual(["github"]);
  });

  it("deletes the legacy single-blob cache file if present (boundary — migration)", () => {
    loadMcpToolsCache();
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      "/fake-home/.atlasagents/mcpToolsCache.json",
    );
  });

  it("does not throw when the legacy file is already gone (normal)", () => {
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => loadMcpToolsCache()).not.toThrow();
  });
});

describe("writeCacheEntry", () => {
  it("writes to a temp file then renames it over the destination (normal — atomic write)", () => {
    writeCacheEntry(githubEntry);

    expect(mockEnsureDirs).toHaveBeenCalled();
    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/fake-home/.atlasagents/mcpToolsCache",
      { recursive: true },
    );
    const [writtenPath, writtenData] = mockWriteFileSync.mock.calls[0]!;
    expect(writtenPath).toMatch(/\.tmp-.+\.json$/);
    expect(JSON.parse(writtenData as string)).toEqual(githubEntry);

    const [fromPath, toPath] = mockRenameSync.mock.calls[0]!;
    expect(fromPath).toBe(writtenPath);
    expect(toPath).not.toBe(writtenPath);
    expect(toPath).toMatch(/^\/fake-home\/\.atlasagents\/mcpToolsCache\/.+\.json$/);
  });

  it("writes different servers to different files (normal — O(Δ) isolation)", () => {
    writeCacheEntry(githubEntry);
    const githubDest = mockRenameSync.mock.calls[0]![1];
    vi.clearAllMocks();

    writeCacheEntry({ ...githubEntry, serverId: "jira" });
    const jiraDest = mockRenameSync.mock.calls[0]![1];

    expect(jiraDest).not.toBe(githubDest);
  });

  it("writing one server never touches another server's file (normal)", () => {
    writeCacheEntry(githubEntry);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
  });
});

describe("deleteCacheEntry", () => {
  it("unlinks the entry's file (normal)", () => {
    deleteCacheEntry("github");
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/fake-home\/\.atlasagents\/mcpToolsCache\/.+\.json$/),
    );
  });

  it("does not throw when the file is already gone (error — idempotent)", () => {
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => deleteCacheEntry("github")).not.toThrow();
  });

  it("uses the same file path deleteCacheEntry and writeCacheEntry both address (boundary — round trip)", () => {
    writeCacheEntry(githubEntry);
    const writtenDest = mockRenameSync.mock.calls[0]![1];
    vi.clearAllMocks();

    deleteCacheEntry("github");
    expect(mockUnlinkSync).toHaveBeenCalledWith(writtenDest);
  });
});
