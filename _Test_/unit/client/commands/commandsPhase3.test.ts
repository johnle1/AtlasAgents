/**
 * Unit tests — commands handlers (config, session, display, workspace, memory, models, skills) and CommandHandler.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { CommandHandler } from "../../../../packages/client/src/commands/index.js";
import { handleAgent, handleConfig, handleSet } from "../../../../packages/client/src/commands/configHandlers.js";
import { handleSpinner, handleThink, handleNotify } from "../../../../packages/client/src/commands/displayHandlers.js";
import { handleMemory } from "../../../../packages/client/src/commands/memoryHandlers.js";
import { handleModels } from "../../../../packages/client/src/commands/modelHandlers.js";
import { handleExplore, handleExit, handleNew } from "../../../../packages/client/src/commands/sessionHandlers.js";
import { handleSkills } from "../../../../packages/client/src/commands/skillHandlers.js";
import { handleCwd, handleWorkspace } from "../../../../packages/client/src/commands/workspaceHandlers.js";
import type { Connection } from "../../../../packages/client/src/connection/index.js";
import type { PromptPort } from "../../../../packages/client/src/ui/promptPort.js";
import { LocalFileProxy } from "../../../../packages/client/src/fileProxy/proxy.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const configState = {
  subagentCap: 3,
  ui: { showSpinner: true, theme: "default" },
  showThinkOutput: true,
};

vi.mock("../../../../packages/client/src/config/index.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../packages/client/src/config/index.js")
  >();
  return {
    ...actual,
    loadConfig: () => ({
      ...configState,
      server: "localhost",
      port: 7000,
      password: "p",
      subagentModel: "m",
      subsubagentModel: "m",
      agentTemp: 0,
      subagentTemp: 0.4,
      retries: 3,
      timeout: 5000,
      workspace: "",
    }),
    updateConfig: vi.fn((patch: Partial<typeof configState>) => {
      Object.assign(configState, patch);
      if (patch.ui) configState.ui = { ...configState.ui, ...patch.ui };
    }),
  };
});

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printError: vi.fn(),
  printSuccess: vi.fn(),
  printLine: vi.fn(),
  printConfig: vi.fn(),
  printMemory: vi.fn(),
  printInstalledModels: vi.fn(),
  printModelFind: vi.fn(),
  printProgress: vi.fn(),
  resetPullProgress: vi.fn(),
  finishPullProgress: vi.fn(),
  printSkills: vi.fn(),
  printSuccessOp: vi.fn(),
  printHelp: vi.fn(),
}));

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  appendLog: vi.fn(),
  setStreamingText: vi.fn(),
  clearScreen: vi.fn(),
}));

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({}),
}));

vi.mock("../../../../packages/client/src/commands/modelSelectionHandlers.js", () => ({
  handleSetModel: vi.fn(async () => {}),
}));

vi.mock("../../../../packages/client/src/skills/skills.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../packages/client/src/skills/skills.js")
  >();
  return {
    ...actual,
    listSkills: () => ["demo"],
  };
});

const fakeConn = (overrides: Partial<Connection> = {}): Connection =>
  ({
    sendCommand: vi.fn(async () => ({ message: "ok" })),
    sendStream: vi.fn(async (opts: { onFrame: (f: { kind: string; text?: string }) => void }) => {
      await opts.onFrame({ kind: "token", text: "explore" });
      return { done: Promise.resolve(), cancel: () => {} };
    }),
    getMemory: vi.fn(async () => [{ topic: "t", rules: ["r"] }]),
    forgetMemory: vi.fn(async () => {}),
    clearMemory: vi.fn(async () => {}),
    fetchModelsDetailed: vi.fn(async () => [{ name: "gemma:4b" }]),
    syncSkills: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    ...overrides,
  }) as unknown as Connection;

describe("handleAgent", () => {
  it("prints current cap when no value given", () => {
    handleAgent("", "");
    handleAgent("cap", "");
  });

  it("sets numeric cap", () => {
    handleAgent("cap", "5");
    expect(configState.subagentCap).toBe(5);
  });

  it("rejects unknown subcommands", () => {
    handleAgent("nope", "");
  });
});

describe("handleSet / handleConfig", () => {
  it("handleSet updates port and reloads connection", async () => {
    const reload = vi.fn(async () => {});
    const connection = fakeConn({ reload });
    await handleSet("port", "8001", {
      connection,
      prompts: { prompt: vi.fn() } as never,
      handleSetModel: vi.fn(),
    });
    expect(reload).toHaveBeenCalled();
  });

  it("handleConfig runs without throwing", async () => {
    await expect(handleConfig()).resolves.toBeUndefined();
  });
});

describe("handleSet approval (removed — Shift+Tab is the only way to change mode)", () => {
  const setDeps = (prompts: { question: ReturnType<typeof vi.fn> }) => ({
    connection: fakeConn(),
    prompts: prompts as never,
    handleSetModel: vi.fn(),
  });

  it("falls into the unknown-subcommand path for /set approval and /set agent (error)", async () => {
    const { printError } = await import(
      "../../../../packages/client/src/renderer.js"
    );
    await handleSet("approval", "auto", setDeps({ question: vi.fn() }));
    expect(printError).toHaveBeenCalledWith(
      "Unknown /set subcommand. Use: password, server, port, or subagent.",
    );

    (printError as ReturnType<typeof vi.fn>).mockClear();
    await handleSet("agent", "", setDeps({ question: vi.fn() }));
    expect(printError).toHaveBeenCalledWith(
      "Unknown /set subcommand. Use: password, server, port, or subagent.",
    );
  });
});

describe("handleSpinner / handleThink / handleNotify", () => {
  it("toggles spinner setting", () => {
    handleSpinner("off", "");
    expect(configState.ui.showSpinner).toBe(false);
    handleSpinner("on", "");
    expect(configState.ui.showSpinner).toBe(true);
  });

  it("toggles think output", () => {
    handleThink("off", "");
    expect(configState.showThinkOutput).toBe(false);
    handleThink("on", "");
    expect(configState.showThinkOutput).toBe(true);
  });

  it("toggles notifications setting (normal)", () => {
    handleNotify("on", "");
    expect(configState.ui.notifications).toBe(true);
    handleNotify("off", "");
    expect(configState.ui.notifications).toBe(false);
  });
});

describe("session handlers", () => {
  it("handleExplore streams tokens", async () => {
    const conn = fakeConn();
    await handleExplore(conn);
    expect(conn.sendStream).toHaveBeenCalled();
  });

  it("handleNew calls session.clear", async () => {
    const sendCommand = vi.fn(async () => ({ message: "cleared" }));
    // sendCommand is generic (`<TResponse>(...) => Promise<TResponse>`); a mock
    // returning one concrete shape can't satisfy that signature directly.
    await handleNew(fakeConn({ sendCommand } as unknown as Partial<Connection>));
    expect(sendCommand).toHaveBeenCalledWith("session.clear", {});
  });

  it("handleExit invokes custom onExit", () => {
    const onExit = vi.fn();
    handleExit(onExit);
    expect(onExit).toHaveBeenCalled();
  });
});

describe("handleMemory", () => {
  it("show fetches memory", async () => {
    const conn = fakeConn();
    await handleMemory("show", "", conn);
    expect(conn.getMemory).toHaveBeenCalled();
  });

  it("forget requires topic", async () => {
    await handleMemory("forget", "", fakeConn());
  });

  it("forget and clear call connection", async () => {
    const conn = fakeConn();
    await handleMemory("forget", "topic-a", conn);
    expect(conn.forgetMemory).toHaveBeenCalledWith("topic-a");
    await handleMemory("clear", "", conn);
    expect(conn.clearMemory).toHaveBeenCalled();
  });
});

describe("handleModels", () => {
  it("list uses fetchModelsDetailed", async () => {
    const conn = fakeConn();
    await handleModels("list", "", conn);
    expect(conn.fetchModelsDetailed).toHaveBeenCalled();
  });

  it("find requires a name", async () => {
    await handleModels("find", "", fakeConn());
  });
});

describe("handleSkills", () => {
  it("list prints skills via module helper", async () => {
    await handleSkills("list", "", undefined, fakeConn());
  });
});

describe("workspace handlers", () => {
  it("handleCwd prints proxy cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cwd-"));
  try {
      const proxy = new LocalFileProxy(dir);
      handleCwd(proxy);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleWorkspace set updates proxy root", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ws-"));
    try {
      const proxy = new LocalFileProxy(dir);
      const onPromptUpdate = vi.fn();
      await handleWorkspace("set", dir, proxy, onPromptUpdate);
      expect(proxy.getWorkspaceRoot()).toBe(path.resolve(dir));
      expect(onPromptUpdate).toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CommandHandler", () => {
  const prompts: PromptPort = {
    question: vi.fn(async () => ""),
    choose: vi.fn(async () => 1),
    pickTheme: vi.fn(async () => {}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false for non-slash input", async () => {
    const handler = new CommandHandler({ conn: fakeConn(), prompts });
    expect(await handler.handle("plain task")).toBe(false);
  });

  it("returns false for !ls so bang passthrough stays client-local (boundary)", async () => {
    const handler = new CommandHandler({ conn: fakeConn(), prompts });
    expect(await handler.handle("!ls")).toBe(false);
  });

  it("routes /memory and /models", async () => {
    const conn = fakeConn();
    const handler = new CommandHandler({ conn, prompts });
    expect(await handler.handle("/memory show")).toBe(true);
    expect(await handler.handle("/models list")).toBe(true);
    expect(conn.getMemory).toHaveBeenCalled();
    expect(conn.fetchModelsDetailed).toHaveBeenCalled();
  });

  it("routes /agent and /spinner", async () => {
    const handler = new CommandHandler({ conn: fakeConn(), prompts });
    expect(await handler.handle("/agent cap 2")).toBe(true);
    expect(await handler.handle("/spinner off")).toBe(true);
    expect(configState.subagentCap).toBe(2);
  });

  it("routes /help to the help printer and returns true (normal)", async () => {
    const { printHelp, printError } = await import(
      "../../../../packages/client/src/renderer.js"
    );
    const handler = new CommandHandler({ conn: fakeConn(), prompts });
    expect(await handler.handle("/help")).toBe(true);
    expect(printHelp).toHaveBeenCalledOnce();
    expect(printError).not.toHaveBeenCalled();
  });

  it("routes /clear to clearScreen and returns true (normal)", async () => {
    const { clearScreen } = await import(
      "../../../../packages/client/src/ui/uiBridge.js"
    );
    const handler = new CommandHandler({ conn: fakeConn(), prompts });
    expect(await handler.handle("/clear")).toBe(true);
    expect(clearScreen).toHaveBeenCalledOnce();
  });

  it("routes /notify on and returns true (normal)", async () => {
    const handler = new CommandHandler({ conn: fakeConn(), prompts });
    expect(await handler.handle("/notify on")).toBe(true);
    expect(configState.ui.notifications).toBe(true);
  });

  it("routes /model to handleSetModel with the agent role (normal)", async () => {
    const { handleSetModel } = await import(
      "../../../../packages/client/src/commands/modelSelectionHandlers.js"
    );
    const conn = fakeConn();
    const handler = new CommandHandler({ conn, prompts });
    expect(await handler.handle("/model")).toBe(true);
    expect(handleSetModel).toHaveBeenCalledWith("agent", conn, prompts);
  });
});
