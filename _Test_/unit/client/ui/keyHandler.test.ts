/**
 * Unit tests — client ui/hooks/keyHandler.ts
 *
 * `createKeyHandler` is a pure factory (no React / Ink) so these cases drive
 * the keyboard contract without rendering a tree. ink-testing-library
 * full-tree harnesses are excluded in vitest.config.ts for a reason.
 *
 * Category checklist:
 * - Normal: Esc cancels a busy task; Ctrl+C idle empty exits; Ctrl+L clears
 * - Boundary: Ctrl+C busy first press cancels + warns, second press force-quits;
 *   Ctrl+C idle with input clears the buffer; Esc idle with input clears it
 * - Error: keys are ignored while an approval or prompt overlay is active
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createKeyHandler,
} from "../../../../packages/client/src/ui/hooks/keyHandler.js";
import type {
  KeyboardInputContext,
  KeyboardInputHandlers,
} from "../../../../packages/client/src/ui/hooks/types.js";

const makeContext = (
  overrides: Partial<KeyboardInputContext> = {},
): KeyboardInputContext =>
  ({
    approval: null,
    promptReq: null,
    busy: false,
    inputHistory: ["prev"],
    histIdx: -1,
    input: "",
    activeIndex: 0,
    scrollOffset: 0,
    sigintBusy: 0,
    setSigintBusy: vi.fn(),
    onSaveHistory: vi.fn(),
    fileProxy: { expandDirectory: vi.fn() },
    setHistory: vi.fn(),
    setActiveIndex: vi.fn(),
    setScrollOffset: vi.fn(),
    setInput: vi.fn(),
    setHistIdx: vi.fn(),
    ...overrides,
  }) as unknown as KeyboardInputContext;

const makeHandlers = (
  overrides: Partial<KeyboardInputHandlers> = {},
): KeyboardInputHandlers => ({
  exit: vi.fn(),
  cancelActiveTask: vi.fn(),
  clearScreen: vi.fn(),
  ...overrides,
});

const emptyKey = {
  ctrl: false,
  upArrow: false,
  downArrow: false,
  tab: false,
  escape: false,
};

describe("createKeyHandler — Esc", () => {
  it("cancels the running task and does not exit when busy (normal)", () => {
    const context = makeContext({ busy: true });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("", { ...emptyKey, escape: true });

    expect(handlers.cancelActiveTask).toHaveBeenCalledOnce();
    expect(handlers.exit).not.toHaveBeenCalled();
    expect(handlers.clearScreen).not.toHaveBeenCalled();
  });

  it("clears non-empty input when idle (boundary)", () => {
    const context = makeContext({ busy: false, input: "half-typed" });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("", { ...emptyKey, escape: true });

    expect(context.setInput).toHaveBeenCalledWith("");
    expect(handlers.cancelActiveTask).not.toHaveBeenCalled();
    expect(handlers.exit).not.toHaveBeenCalled();
  });

  it("is a no-op when idle with empty input (boundary)", () => {
    const context = makeContext({ busy: false, input: "" });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("", { ...emptyKey, escape: true });

    expect(context.setInput).not.toHaveBeenCalled();
    expect(handlers.exit).not.toHaveBeenCalled();
    expect(handlers.cancelActiveTask).not.toHaveBeenCalled();
  });
});

describe("createKeyHandler — Ctrl+C", () => {
  it("cancels the task and sets sigintBusy to 1 on the first press while busy (normal)", () => {
    const context = makeContext({ busy: true, sigintBusy: 0 });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("c", { ...emptyKey, ctrl: true });

    expect(handlers.cancelActiveTask).toHaveBeenCalledOnce();
    expect(context.setSigintBusy).toHaveBeenCalledWith(1);
    expect(handlers.exit).not.toHaveBeenCalled();
  });

  it("force-quits on the second Ctrl+C while still busy (boundary — escape hatch)", () => {
    const context = makeContext({ busy: true, sigintBusy: 1 });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("c", { ...emptyKey, ctrl: true });

    expect(handlers.exit).toHaveBeenCalledOnce();
    expect(context.onSaveHistory).toHaveBeenCalledWith(context.inputHistory);
  });

  it("clears non-empty input when idle and does not exit (boundary)", () => {
    const context = makeContext({ busy: false, input: "draft" });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("c", { ...emptyKey, ctrl: true });

    expect(context.setInput).toHaveBeenCalledWith("");
    expect(handlers.exit).not.toHaveBeenCalled();
    expect(handlers.cancelActiveTask).not.toHaveBeenCalled();
  });

  it("exits immediately when idle with empty input (normal)", () => {
    const context = makeContext({ busy: false, input: "" });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("c", { ...emptyKey, ctrl: true });

    expect(handlers.exit).toHaveBeenCalledOnce();
    expect(context.onSaveHistory).toHaveBeenCalledWith(context.inputHistory);
  });
});

describe("createKeyHandler — Ctrl+L", () => {
  it("clears the screen and never exits (normal)", () => {
    const context = makeContext({ busy: false });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("l", { ...emptyKey, ctrl: true });

    expect(handlers.clearScreen).toHaveBeenCalledOnce();
    expect(handlers.exit).not.toHaveBeenCalled();
  });

  it("still clears (does not exit) while a task is running (boundary)", () => {
    const context = makeContext({ busy: true });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("l", { ...emptyKey, ctrl: true });

    expect(handlers.clearScreen).toHaveBeenCalledOnce();
    expect(handlers.exit).not.toHaveBeenCalled();
  });
});

describe("createKeyHandler — overlay guard (error)", () => {
  it("ignores Esc / Ctrl+C / Ctrl+L while an approval overlay is active", () => {
    const context = makeContext({
      approval: { type: "runSkip", command: "rm" } as KeyboardInputContext["approval"],
    });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("", { ...emptyKey, escape: true });
    handle("c", { ...emptyKey, ctrl: true });
    handle("l", { ...emptyKey, ctrl: true });

    expect(handlers.cancelActiveTask).not.toHaveBeenCalled();
    expect(handlers.exit).not.toHaveBeenCalled();
    expect(handlers.clearScreen).not.toHaveBeenCalled();
  });

  it("ignores Esc / Ctrl+C / Ctrl+L while a prompt overlay is active", () => {
    const context = makeContext({
      promptReq: { type: "line", prompt: "?" } as KeyboardInputContext["promptReq"],
    });
    const handlers = makeHandlers();
    const handle = createKeyHandler(context, handlers);

    handle("", { ...emptyKey, escape: true });
    handle("c", { ...emptyKey, ctrl: true });
    handle("l", { ...emptyKey, ctrl: true });

    expect(handlers.cancelActiveTask).not.toHaveBeenCalled();
    expect(handlers.exit).not.toHaveBeenCalled();
    expect(handlers.clearScreen).not.toHaveBeenCalled();
  });
});

describe("createKeyHandler — unused import guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("still exposes createKeyHandler as a function (sanity)", () => {
    expect(typeof createKeyHandler).toBe("function");
  });
});

describe("createKeyHandler — ? shortcuts panel", () => {
  it("opens the panel on ? with empty input and clears the buffer (normal)", () => {
    const setShowShortcuts = vi.fn();
    const context = makeContext({
      input: "",
      showShortcuts: false,
      setShowShortcuts,
    });
    const handle = createKeyHandler(context, makeHandlers());

    handle("?", emptyKey);

    expect(setShowShortcuts).toHaveBeenCalledWith(true);
    expect(context.setInput).toHaveBeenCalledWith("");
  });

  it("closes the panel on any subsequent key (normal)", () => {
    const setShowShortcuts = vi.fn();
    const context = makeContext({
      showShortcuts: true,
      setShowShortcuts,
    });
    const handle = createKeyHandler(context, makeHandlers());

    handle("x", emptyKey);

    expect(setShowShortcuts).toHaveBeenCalledWith(false);
  });

  it("does nothing with ? while busy (boundary — auto-hide rule)", () => {
    const setShowShortcuts = vi.fn();
    const context = makeContext({
      busy: true,
      input: "",
      showShortcuts: false,
      setShowShortcuts,
    });
    const handle = createKeyHandler(context, makeHandlers());

    handle("?", emptyKey);

    expect(setShowShortcuts).not.toHaveBeenCalled();
  });

  it("does nothing with ? while an approval overlay is active (error)", () => {
    const setShowShortcuts = vi.fn();
    const context = makeContext({
      approval: { type: "runSkip", command: "rm" } as KeyboardInputContext["approval"],
      input: "",
      setShowShortcuts,
    });
    const handle = createKeyHandler(context, makeHandlers());

    handle("?", emptyKey);

    expect(setShowShortcuts).not.toHaveBeenCalled();
  });

  it("does nothing with ? while a prompt overlay is active (error)", () => {
    const setShowShortcuts = vi.fn();
    const context = makeContext({
      promptReq: { type: "line", prompt: "?" } as KeyboardInputContext["promptReq"],
      input: "",
      setShowShortcuts,
    });
    const handle = createKeyHandler(context, makeHandlers());

    handle("?", emptyKey);

    expect(setShowShortcuts).not.toHaveBeenCalled();
  });
});
