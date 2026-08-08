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

vi.mock("../../../../packages/client/src/commands/utils.js", () => ({
  formatErrorMessage: (e: unknown) => String(e),
}));

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
          setSigintBusy: vi.fn(),
          onSaveHistory: vi.fn(),
          fileProxy: { clearScreen: vi.fn() } as never,
          setHistory: vi.fn(),
          setActiveIndex: vi.fn(),
          setScrollOffset: vi.fn(),
          setInput,
          setHistIdx: vi.fn(),
        },
        { exit: vi.fn() },
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
});
