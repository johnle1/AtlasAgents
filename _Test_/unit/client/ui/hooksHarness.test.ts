/**
 * Hook harness tests — useKeyboardInput and useSubmitLine.
 */

import { describe, expect, it, vi } from "vitest";
import React, { useEffect } from "react";
import { render } from "ink-testing-library";

import { useKeyboardInput } from "../../../../packages/client/src/ui/hooks/useKeyboardInput.js";
import { useSubmitLine } from "../../../../packages/client/src/ui/hooks/useSubmitLine.js";

vi.mock("../../../../packages/client/src/ui/taskStream.js", () => ({
  runTaskStream: vi.fn(async () => {}),
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({
    server: "localhost",
    port: 7000,
    password: "",
    agentModel: "m",
    subagentModel: "m",
    shellTimeoutMs: 5_000,
    ui: { theme: "default" },
  }),
}));

vi.mock("../../../../packages/client/src/fileProxy/shellRunner.js", () => ({
  runShell: vi.fn(async () => ({ stdout: "ok\n", stderr: "", exitCode: 0 })),
  SHELL_TIMEOUT_MARKER: "[TIMEOUT]",
}));

vi.mock("../../../../packages/client/src/ui/uiBridge.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../packages/client/src/ui/uiBridge.js")
  >();
  return {
    ...actual,
    requestApproval: vi.fn(async () => true),
  };
});

describe("useKeyboardInput", () => {
  it("ignores keys when approval overlay is active", () => {
    const setInput = vi.fn();
    const KeyboardProbe = () => {
      const handler = useKeyboardInput(
        {
          approval: { type: "runSkip", command: "x" },
          promptReq: null,
          busy: false,
          inputHistory: [],
          histIdx: -1,
          input: "",
          activeIndex: 0,
          scrollOffset: 0,
          sigintBusy: 0,
          showShortcuts: false,
          setShowShortcuts: vi.fn(),
          setSigintBusy: vi.fn(),
          onSaveHistory: vi.fn(),
          fileProxy: { clearScreen: vi.fn() } as never,
          setHistory: vi.fn(),
          setActiveIndex: vi.fn(),
          setScrollOffset: vi.fn(),
          setInput,
          setHistIdx: vi.fn(),
          markdownRaw: false,
          setMarkdownRaw: vi.fn(),
          approvalMode: "default",
          setApprovalMode: vi.fn(),
        },
        { exit: vi.fn(), cancelActiveTask: vi.fn(), clearScreen: vi.fn(), insertNewline: vi.fn(), enqueueMessage: vi.fn() },
      );
      useEffect(() => {
        handler("a", {});
      }, [handler]);
      return null;
    };
    const tree = render(React.createElement(KeyboardProbe));
    expect(setInput).not.toHaveBeenCalled();
    tree.unmount();
  });
});

describe("useSubmitLine", () => {
  it("skips empty submissions", async () => {
    const setBusy = vi.fn();
    const SubmitProbe = () => {
      const { submit } = useSubmitLine({
        busy: false,
        approval: null,
        promptReq: null,
        inputHistory: [],
        setInputHistory: vi.fn(),
        onInputHistoryRef: { current: [] },
        setHistIdx: vi.fn(),
        setInput: vi.fn(),
        setBusy,
        setHistory: vi.fn(),
        setSigintBusy: vi.fn(),
        connection: {} as never,
        commandHandler: {} as never,
        fileProxy: {} as never,
        setQueuedMessages: vi.fn(),
      });
      useEffect(() => {
        void submit("   ");
      }, [submit]);
      return null;
    };
    const tree = render(React.createElement(SubmitProbe));
    expect(setBusy).not.toHaveBeenCalled();
    tree.unmount();
  });

  it("routes !ls through handleBang and never reaches CommandHandler or runTaskStream (normal)", async () => {
    const { runTaskStream } = await import(
      "../../../../packages/client/src/ui/taskStream.js"
    );
    const { runShell } = await import(
      "../../../../packages/client/src/fileProxy/shellRunner.js"
    );
    const commandHandler = { handle: vi.fn(async () => true) };
    const setHistory = vi.fn();
    const SubmitProbe = () => {
      const { submit } = useSubmitLine({
        busy: false,
        approval: null,
        promptReq: null,
        inputHistory: [],
        setInputHistory: vi.fn(),
        onInputHistoryRef: { current: [] },
        setHistIdx: vi.fn(),
        setInput: vi.fn(),
        setBusy: vi.fn(),
        setHistory,
        setSigintBusy: vi.fn(),
        connection: {} as never,
        commandHandler: commandHandler as never,
        fileProxy: {
          getCwd: () => "/tmp",
          classifyCommand: () => "safe",
        } as never,
        setQueuedMessages: vi.fn(),
      });
      useEffect(() => {
        void submit("!ls");
      }, [submit]);
      return null;
    };
    const tree = render(React.createElement(SubmitProbe));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runShell).toHaveBeenCalled();
    expect(commandHandler.handle).not.toHaveBeenCalled();
    expect(runTaskStream).not.toHaveBeenCalled();
    tree.unmount();
  });
});
