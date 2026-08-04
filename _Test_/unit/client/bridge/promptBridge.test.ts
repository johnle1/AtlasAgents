/**
 * Unit tests — ui/bridge/prompt.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setBridgeHooks,
  setInkUIActiveValue,
  setPendingPromptEntry,
} from "../../../../packages/client/src/ui/bridge/state.js";
import {
  cancelPendingPrompts,
  getPendingPrompt,
  requestPrompt,
  resolvePrompt,
} from "../../../../packages/client/src/ui/bridge/prompt.js";

beforeEach(() => {
  setBridgeHooks({});
  setInkUIActiveValue(false);
  setPendingPromptEntry(null);
});

describe("prompt bridge", () => {
  it("auto-resolves defaults when Ink is inactive", async () => {
    await expect(requestPrompt({ type: "line", prompt: "Name?" })).resolves.toBe("");
    await expect(
      requestPrompt({ type: "choice", prompt: "Pick", max: 3 }),
    ).resolves.toBe(0);
  });

  it("queues prompt when Ink is active", async () => {
    const onPromptChange = vi.fn();
    setInkUIActiveValue(true);
    setBridgeHooks({ onPromptChange });

    const pending = requestPrompt({ type: "line", prompt: "Value?" });
    expect(getPendingPrompt()).toEqual({ type: "line", prompt: "Value?" });
    expect(onPromptChange).toHaveBeenCalledWith({ type: "line", prompt: "Value?" });

    resolvePrompt("answer");
    await expect(pending).resolves.toBe("answer");
    expect(getPendingPrompt()).toBeNull();
  });

  it("cancelPendingPrompts resolves with type defaults", async () => {
    setInkUIActiveValue(true);
    const pending = requestPrompt({ type: "choice", prompt: "Pick", max: 2 });
    cancelPendingPrompts();
    await expect(pending).resolves.toBe(0);
    expect(getPendingPrompt()).toBeNull();
  });
});
