/**
 * Unit tests — fileProxy/handlers (file, command, mcp).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DispatchContext } from "../../../../packages/client/src/fileProxy/types.js";
import {
  handleFileCd,
  handleFileCreateDir,
  handleFileDeleteDir,
  handleFileDeleteFile,
  handleFileGetCwd,
  handleFileListDir,
  handleFileRead,
  handleFileSearch,
  handleFileWrite,
} from "../../../../packages/client/src/fileProxy/handlers/fileHandlers.js";
import {
  handleCommandClassify,
  handleCommandRun,
} from "../../../../packages/client/src/fileProxy/handlers/commandHandlers.js";
import { handleMcpCall } from "../../../../packages/client/src/fileProxy/handlers/mcpHandlers.js";

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printRead: vi.fn(),
  printWrite: vi.fn(async () => {}),
  printCreateDir: vi.fn(),
  printDelete: vi.fn(),
  printCd: vi.fn(),
  printSkipped: vi.fn(),
  printSuccessOp: vi.fn(),
  printBash: vi.fn(),
  printBashApproved: vi.fn(),
  printBashRan: vi.fn(),
  printBashResult: vi.fn(),
}));

vi.mock("../../../../packages/client/src/renderer/fileOperations.js", () => ({
  printTokenSaveOp: vi.fn(),
  printTokenSaveResult: vi.fn(),
}));

vi.mock("../../../../packages/client/src/ui/approvalFlow.js", () => ({
  requestApprovalWithFeedback: vi.fn(async () => ({ approved: true })),
  printDeclineFeedback: vi.fn(),
}));

vi.mock("../../../../packages/client/src/mcp/mcpBridge.js", () => ({
  callTokenSaveTool: vi.fn(async () => ({
    isError: false,
    data: "ok",
  })),
}));

vi.mock("../../../../packages/client/src/state/agentStatus.js", () => ({
  beginBlockOutput: vi.fn(),
}));

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({ warning: "", reset: "" }),
}));

vi.mock("../../../../packages/client/src/fileProxy/directoryListing.js", () => ({
  listStructure: vi.fn(async () => "tree"),
}));

const makeContext = (
  workspace: string,
  overrides?: Partial<DispatchContext>,
): DispatchContext => {
  const root = path.resolve(workspace);
  let currentDir = root;
  return {
    workspaceRoot: root,
    currentDir,
    resolveAbsolute: (rel: string) => path.resolve(currentDir, rel),
    setCurrentDir: (abs: string) => {
      currentDir = abs;
    },
    classifyCommand: () => "safe",
    runShell: vi.fn(async () => ({
      stdout: "out",
      stderr: "",
      exitCode: 0,
    })),
    listStructure: vi.fn(),
    ...overrides,
  };
};

describe("handleFileRead / handleFileGetCwd", () => {
  let workspace: string;
  let context: DispatchContext;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-fh-"));
    await fs.writeFile(path.join(workspace, "f.txt"), "hello");
    context = makeContext(workspace);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("reads file content", async () => {
    const result = (await handleFileRead(context, { path: "f.txt" })) as {
      content: string;
    };
    expect(result.content).toBe("hello");
  });

  it("returns cwd from get_cwd", async () => {
    const result = (await handleFileGetCwd(context)) as { cwd: string };
    expect(result.cwd).toBe(path.resolve(workspace));
  });
});

describe("handleFileWrite and mutations with approval", () => {
  let workspace: string;
  let context: DispatchContext;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-fh-mut-"));
    context = makeContext(workspace);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("writes a new file when approved", async () => {
    const result = (await handleFileWrite(context, {
      path: "new.txt",
      content: "data",
    })) as { accepted: boolean };
    expect(result.accepted).toBe(true);
    await expect(fs.readFile(path.join(workspace, "new.txt"), "utf8")).resolves.toBe(
      "data",
    );
  });

  it("creates a directory when approved", async () => {
    const result = (await handleFileCreateDir(context, { path: "dir-a" })) as {
      created: boolean;
    };
    expect(result.created).toBe(true);
    const stat = await fs.stat(path.join(workspace, "dir-a"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("deletes file and directory when approved", async () => {
    await fs.writeFile(path.join(workspace, "rm.txt"), "x");
    await fs.mkdir(path.join(workspace, "rm-dir"));
    expect(
      ((await handleFileDeleteFile(context, { path: "rm.txt" })) as {
        deleted: boolean;
      }).deleted,
    ).toBe(true);
    expect(
      ((await handleFileDeleteDir(context, { path: "rm-dir" })) as {
        deleted: boolean;
      }).deleted,
    ).toBe(true);
  });

  it("changes cwd for file.cd", async () => {
    await fs.mkdir(path.join(workspace, "sub"));
    const result = (await handleFileCd(context, { path: "sub" })) as {
      cwd: string;
    };
    expect(result.cwd).toBe(path.join(workspace, "sub"));
  });
});

describe("handleFileListDir and handleFileSearch", () => {
  let workspace: string;
  let context: DispatchContext;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-fh-search-"));
    await fs.writeFile(path.join(workspace, "match.ts"), "");
    context = makeContext(workspace);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("returns list_dir text from listStructure", async () => {
    const result = (await handleFileListDir(context, { depth: 1 })) as {
      text: string;
    };
    expect(result.text).toBe("tree");
  });

  it("searches with a glob pattern", async () => {
    const result = (await handleFileSearch(context, {
      pattern: "*.ts",
    })) as { paths: string[] };
    expect(result.paths.some((p) => p.endsWith("match.ts"))).toBe(true);
  });
});

describe("command handlers", () => {
  it("classifies commands via context", async () => {
    const context = makeContext(os.tmpdir(), {
      classifyCommand: () => "cautious",
    });
    const result = (await handleCommandClassify(context, {
      command: "rm -rf /",
    })) as { classification: string };
    expect(result.classification).toBe("cautious");
  });

  it("runs safe commands through runShell", async () => {
    const runShell = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const context = makeContext(os.tmpdir(), { runShell });
    await handleCommandRun(context, { command: "echo hi" });
    expect(runShell).toHaveBeenCalled();
  });
});

describe("handleMcpCall", () => {
  it("rejects missing tool name", async () => {
    const context = makeContext(os.tmpdir());
    await expect(handleMcpCall(context, {})).rejects.toThrow(
      "requires a tool name",
    );
  });

  it("rejects disallowed tools", async () => {
    const context = makeContext(os.tmpdir());
    await expect(
      handleMcpCall(context, { tool: "evil_tool" }),
    ).rejects.toThrow("not allowed");
  });

  it("calls allowed tokensave tool", async () => {
    const { callTokenSaveTool } = await import(
      "../../../../packages/client/src/mcp/mcpBridge.js"
    );
    const context = makeContext(os.tmpdir());
    const result = await handleMcpCall(context, {
      tool: "tokensave_status",
      arguments: {},
    });
    expect(callTokenSaveTool).toHaveBeenCalled();
    expect(result).toMatchObject({ isError: false });
  });
});
