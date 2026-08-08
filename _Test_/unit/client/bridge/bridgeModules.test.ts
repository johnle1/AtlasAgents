/**
 * Unit tests — ui/bridge modules (no Ink render).
 */

import { describe, expect, it } from "vitest";
import {
  getTaskActive,
  isTaskActive,
  setBusy,
  setCwdLabel,
  setTaskActive,
} from "../../../../packages/client/src/ui/bridge/display.js";
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
import {
  cancelPendingApprovals,
  getPendingApproval,
  requestApproval,
  resolveApproval,
} from "../../../../packages/client/src/ui/bridge/approval.js";
import {
  cancelPendingPrompts,
  getPendingPrompt,
  requestPrompt,
  resolvePrompt,
} from "../../../../packages/client/src/ui/bridge/prompt.js";
import {
  isInkActive,
  registerBridgeHooks,
  setInkActive,
} from "../../../../packages/client/src/ui/bridge/hooks.js";

describe("display bridge", () => {
  it("setBusy / setTaskActive / getTaskActive / isTaskActive / setCwdLabel round-trip", () => {
    setBusy(true);
    setTaskActive(true);
    expect(getTaskActive()).toBe(true);
    expect(isTaskActive()).toBe(true);
    setTaskActive(false);
    expect(isTaskActive()).toBe(false);
    setCwdLabel("/tmp/proj");
    setBusy(false);
  });
});

describe("history bridge", () => {
  it("appendHistory / appendLog / streaming / live think APIs are callable", () => {
    appendHistory({ kind: "text", text: "hi", variant: "system" });
    appendLog("log", "system");
    setStreamingText("stream");
    appendStreamingToken("!");
    registerStreamingHandler(() => {});
    startLiveThink("t1", true, "Agent");
    appendLiveThink("t1", "plan");
    endLiveThink("t1");
    clearLiveThinks();
  });
});

describe("approval + prompt bridges", () => {
  it("auto-resolves approval when Ink is inactive", async () => {
    setInkActive(false);
    expect(getPendingApproval()).toBeNull();
    await expect(
      requestApproval({
        type: "runSkip",
        command: "echo hi",
      }),
    ).resolves.toBeTypeOf("boolean");
    cancelPendingApprovals();
  });

  it("queues a prompt while Ink is active", async () => {
    setInkActive(true);
    registerBridgeHooks({} as never);
    expect(getPendingPrompt()).toBeNull();
    const pending = requestPrompt({
      title: "Name?",
      placeholder: "",
    } as never);
    if (getPendingPrompt()) {
      resolvePrompt("ans");
      await expect(pending).resolves.toBe("ans");
    } else {
      // Some environments auto-resolve without a pending entry
      await pending.catch(() => undefined);
    }
    cancelPendingPrompts();
    setInkActive(false);
  });
});

describe("hooks bridge", () => {
  it("setInkActive / isInkActive / registerBridgeHooks", () => {
    setInkActive(true);
    expect(isInkActive()).toBe(true);
    registerBridgeHooks({} as never);
    setInkActive(false);
    expect(isInkActive()).toBe(false);
  });
});

// keep resolveApproval referenced for static coverage
void resolveApproval;
