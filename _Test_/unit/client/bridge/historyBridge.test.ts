/**
 * Unit tests — ui/bridge/history.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setBridgeHooks,
  setStreamingTokenHandler,
} from "../../../../packages/client/src/ui/bridge/state.js";
import {
  appendHistory,
  appendLiveThink,
  appendLog,
  appendStreamingToken,
  clearLiveThinks,
  endLiveThink,
  registerStreamingHandler,
  setStreamingText,
  startLiveThink,
} from "../../../../packages/client/src/ui/bridge/history.js";

beforeEach(() => {
  setBridgeHooks({});
  setStreamingTokenHandler(null);
});

describe("history bridge", () => {
  it("appendHistory / appendLog forward to onHistoryAppend", () => {
    const onHistoryAppend = vi.fn();
    setBridgeHooks({ onHistoryAppend });
    appendLog("hello", "success");
    expect(onHistoryAppend).toHaveBeenCalledWith({
      kind: "text",
      text: "hello",
      variant: "success",
    });
    appendHistory({ kind: "block", lines: ["a"] });
    expect(onHistoryAppend).toHaveBeenCalledWith({ kind: "block", lines: ["a"] });
  });

  it("setStreamingText invokes onStreamingSet", () => {
    const onStreamingSet = vi.fn();
    setBridgeHooks({ onStreamingSet });
    setStreamingText("stream");
    expect(onStreamingSet).toHaveBeenCalledWith("stream");
  });

  it("registerStreamingHandler and appendStreamingToken deliver tokens", () => {
    const onStreamingSet = vi.fn();
    const handler = vi.fn();
    setBridgeHooks({ onStreamingSet });
    registerStreamingHandler(handler);
    appendStreamingToken("tok");
    expect(onStreamingSet).toHaveBeenCalledWith(null);
    expect(handler).toHaveBeenCalledWith("tok");
  });

  it("live think hooks apply updater callbacks", () => {
    const onLiveThink = vi.fn();
    setBridgeHooks({ onLiveThink });
    startLiveThink("id-1", true, null);
    expect(onLiveThink).toHaveBeenCalled();
    const afterStart = onLiveThink.mock.calls[0]![0]([]);
    expect(afterStart).toEqual([
      { id: "id-1", text: "", agent: true, label: null },
    ]);

    appendLiveThink("id-1", "plan");
    const afterAppend = onLiveThink.mock.calls[1]![0](afterStart);
    expect(afterAppend[0]?.text).toBe("plan");

    endLiveThink("id-1");
    const afterEnd = onLiveThink.mock.calls[2]![0](afterAppend);
    expect(afterEnd).toEqual([]);

    clearLiveThinks();
    const afterClear = onLiveThink.mock.calls[3]![0]([{ id: "x", text: "y", agent: false, label: "w" }]);
    expect(afterClear).toEqual([]);
  });
});
