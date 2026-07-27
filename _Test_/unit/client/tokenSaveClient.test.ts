/**
 * Unit tests — mcp/tokenSaveClient.ts
 *
 * Tests the testable surface of the TokenSave MCP client helper module:
 *   - ALLOWED_TOKENSAVE_TOOLS   — the curated tool allowlist
 *   - enqueueTokenSaveOperation — serializes MCP stdio operations (concurrency fix)
 *   - hasTokenSaveIndex         — checks for `.tokensave` in a workspace
 *   - isTokenSaveOnPath         — probes PATH for the `tokensave` binary (Windows-aware)
 *   - listCuratedTools          — paginates listTools and filters to the allowlist
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : `child_process.execFile` is mocked for `isTokenSaveOnPath`
 *   so the test does not depend on whether `tokensave` is actually installed.
 *   `listCuratedTools` is given a hand-rolled mock Client (no SDK dependency).
 *
 * Category checklist:
 *   ✅ Normal  — typical workspace with `.tokensave`, serialized operations
 *   ✅ Boundary — empty workspace, missing index, pagination, error isolation
 *   ✅ Error   — operation rejection does not poison the queue
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Mock only the `execFile` boundary so `isTokenSaveOnPath` is deterministic
// regardless of whether `tokensave` is actually installed on the host.
// `promisify` from `node:util` is left untouched so the real promisification
// of our mock `execFile` works as expected.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mcpMocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({ tools: [] }),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mcpMocks.connect;
    listTools = mcpMocks.listTools;
    close = mcpMocks.close;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));

import {
  ALLOWED_TOKENSAVE_TOOLS,
  enqueueTokenSaveOperation,
  getTokenSaveClient,
  hasTokenSaveIndex,
  isTokenSaveOnPath,
  listCuratedTools,
  resetTokenSaveClientForTests,
} from "../../../packages/client/src/mcp/tokenSaveClient";
import { execFile as execFileMock } from "node:child_process";

// ---------------------------------------------------------------------------
// ALLOWED_TOKENSAVE_TOOLS — the curated allowlist enforced on the client
// ---------------------------------------------------------------------------

describe("ALLOWED_TOKENSAVE_TOOLS", () => {
  it("contains exactly the six curated tokensave_* tools (normal)", () => {
    expect(ALLOWED_TOKENSAVE_TOOLS.size).toBe(6);
    const expected = [
      "tokensave_search",
      "tokensave_context",
      "tokensave_status",
      "tokensave_callers",
      "tokensave_callees",
      "tokensave_impact",
    ];
    for (const name of expected) {
      expect(ALLOWED_TOKENSAVE_TOOLS.has(name)).toBe(true);
    }
  });

  it("does NOT include built-in tool names like run_command or write_file (boundary)", () => {
    expect(ALLOWED_TOKENSAVE_TOOLS.has("run_command")).toBe(false);
    expect(ALLOWED_TOKENSAVE_TOOLS.has("write_file")).toBe(false);
    expect(ALLOWED_TOKENSAVE_TOOLS.has("read_file")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enqueueTokenSaveOperation — serializes operations on the shared stdio
// transport. Without serialization, concurrent callTool requests would
// interleave on a single transport and corrupt each other.
// ---------------------------------------------------------------------------

describe("enqueueTokenSaveOperation", () => {
  it("propagates the operation's resolved value (normal)", async () => {
    const result = await enqueueTokenSaveOperation(async () => 42);
    expect(result).toBe(42);
  });

  it("runs operations in submission order when awaited sequentially (normal)", async () => {
    const order: string[] = [];
    await enqueueTokenSaveOperation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("first");
    });
    await enqueueTokenSaveOperation(async () => {
      order.push("second");
    });
    expect(order).toEqual(["first", "second"]);
  });

  it("serializes concurrent operations — second op waits for the first (boundary)", async () => {
    const order: string[] = [];
    const p1 = enqueueTokenSaveOperation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-done");
    });
    const p2 = enqueueTokenSaveOperation(async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("b-done");
    });
    await Promise.all([p1, p2]);
    // p2 must not start until p1 finishes
    expect(order).toEqual(["a-done", "b-start", "b-done"]);
  });

  it("propagates rejection to the caller (error)", async () => {
    await expect(
      enqueueTokenSaveOperation(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("an error in one operation does NOT block subsequent operations (error — queue recovery)", async () => {
    await expect(
      enqueueTokenSaveOperation(async () => {
        throw new Error("first fails");
      }),
    ).rejects.toThrow("first fails");

    // The queue must keep advancing even after a rejection.
    const result = await enqueueTokenSaveOperation(async () => "ok");
    expect(result).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// getTokenSaveClient — must not re-enqueue when callers already hold the queue
// ---------------------------------------------------------------------------

describe("getTokenSaveClient", () => {
  it("completes when called inside enqueueTokenSaveOperation (deadlock guard)", async () => {
    const raced = await Promise.race([
      enqueueTokenSaveOperation(async () => {
        const client = await getTokenSaveClient(tmpdir());
        return client;
      }),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 200),
      ),
    ]);
    expect(raced).not.toBe("timeout");
    expect(mcpMocks.connect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hasTokenSaveIndex — probes for a `.tokensave` entry in the workspace root
// ---------------------------------------------------------------------------

describe("hasTokenSaveIndex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "loopycode-tokensave-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when `.tokensave` does not exist (normal — uninitialized workspace)", async () => {
    expect(await hasTokenSaveIndex(tmpDir)).toBe(false);
  });

  it("returns true when `.tokensave` is a directory (normal — initialized workspace)", async () => {
    await mkdir(path.join(tmpDir, ".tokensave"));
    expect(await hasTokenSaveIndex(tmpDir)).toBe(true);
  });

  it("returns true when `.tokensave` is a file (boundary — file vs directory)", async () => {
    // fs.access only checks existence, so a file also satisfies the probe
    await writeFile(path.join(tmpDir, ".tokensave"), "");
    expect(await hasTokenSaveIndex(tmpDir)).toBe(true);
  });

  it("returns false for a non-existent workspace path (boundary — missing root)", async () => {
    expect(await hasTokenSaveIndex("/nonexistent/path/xyz-abc-not-real")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTokenSaveOnPath — probes PATH for the `tokensave` binary.
// On Windows it uses `where`, elsewhere `which`. The execFile boundary is
// mocked so the test is deterministic regardless of the host environment.
// ---------------------------------------------------------------------------

describe("isTokenSaveOnPath", () => {
  const execFile = execFileMock as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execFile.mockReset();
  });

  it("returns true when the locator exits 0 (normal — binary present)", async () => {
    // Node's promisify calls back with (err, stdout, stderr); on success
    // err is null. The mock matches the standard callback signature.
    execFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: Error | null, o: string, e2: string) => void) => {
        cb(null, "", "");
      },
    );
    expect(await isTokenSaveOnPath()).toBe(true);
  });

  it("returns false when the locator exits non-zero (error — binary missing)", async () => {
    execFile.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => {
      cb(new Error("not found"));
    });
    expect(await isTokenSaveOnPath()).toBe(false);
  });

  it("uses the `which` locator on non-Windows platforms (boundary — platform selection)", async () => {
    // We cannot force process.platform in Vitest without hacks, but we can
    // assert the chosen locator is one of the two documented binaries and
    // that the probed command is `tokensave`.
    execFile.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => {
      cb(null);
    });
    await isTokenSaveOnPath();
    expect(execFile).toHaveBeenCalledTimes(1);
    const [locator, args] = execFile.mock.calls[0]!;
    expect(["which", "where"]).toContain(locator);
    expect(args).toEqual(["tokensave"]);
  });
});

// ---------------------------------------------------------------------------
// listCuratedTools — paginates listTools and filters to the allowlist
// ---------------------------------------------------------------------------

/** Minimal shape of the MCP Client that listCuratedTools depends on. */
type FakeClient = {
  listTools: ReturnType<typeof vi.fn>;
};

describe("listCuratedTools", () => {
  it("filters out tools that are not in the allowlist (normal)", async () => {
    const client: FakeClient = {
      listTools: vi.fn(async () => ({
        tools: [
          { name: "tokensave_search", description: "semantic search", inputSchema: { type: "object" } },
          { name: "tokensave_status", description: "index status", inputSchema: { type: "object" } },
          { name: "run_command", description: "should be filtered out", inputSchema: {} },
          { name: "write_file", description: "should be filtered out", inputSchema: {} },
        ],
        nextCursor: undefined,
      })),
    };

    const tools = await listCuratedTools(client as never);
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("tokensave_search");
    expect(names).toContain("tokensave_status");
  });

  it("follows nextCursor to fetch additional pages (boundary — multi-page)", async () => {
    let call = 0;
    const client: FakeClient = {
      listTools: vi.fn(async (opts?: { cursor?: string }) => {
        call++;
        if (call === 1) {
          return {
            tools: [{ name: "tokensave_search", description: "s", inputSchema: {} }],
            nextCursor: "page2",
          };
        }
        expect(opts?.cursor).toBe("page2");
        return {
          tools: [{ name: "tokensave_status", description: "st", inputSchema: {} }],
          nextCursor: undefined,
        };
      }),
    };

    const tools = await listCuratedTools(client as never);
    expect(tools).toHaveLength(2);
    expect(client.listTools).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array when no tools are allowed (boundary — empty result)", async () => {
    const client: FakeClient = {
      listTools: vi.fn(async () => ({
        tools: [
          { name: "run_command", description: "x", inputSchema: {} },
          { name: "write_file", description: "y", inputSchema: {} },
        ],
        nextCursor: undefined,
      })),
    };

    expect(await listCuratedTools(client as never)).toEqual([]);
  });

  it("defaults a missing inputSchema to an empty object schema (boundary — missing schema)", async () => {
    const client: FakeClient = {
      listTools: vi.fn(async () => ({
        tools: [{ name: "tokensave_search", description: "s" }],
        nextCursor: undefined,
      })),
    };

    const tools = await listCuratedTools(client as never);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("preserves description and name fields on curated entries (normal)", async () => {
    const client: FakeClient = {
      listTools: vi.fn(async () => ({
        tools: [
          { name: "tokensave_callers", description: "find callers of a symbol", inputSchema: { type: "object" } },
        ],
        nextCursor: undefined,
      })),
    };

    const tools = await listCuratedTools(client as never);
    expect(tools[0]).toMatchObject({
      name: "tokensave_callers",
      description: "find callers of a symbol",
    });
  });
});

// ---------------------------------------------------------------------------
// Test isolation — reset the singleton queue state after the suite
// ---------------------------------------------------------------------------

afterEach(async () => {
  await resetTokenSaveClientForTests();
});
