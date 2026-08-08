/**
 * Unit tests — agentStatus bridge helpers (mocked uiBridge).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getTaskActive = vi.fn(() => false);
const isInkActive = vi.fn(() => true);
const setSpinner = vi.fn();
const setTaskActiveBridge = vi.fn();

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  getTaskActive: () => getTaskActive(),
  isInkActive: () => isInkActive(),
  setSpinner: (...args: unknown[]) => setSpinner(...args),
  setTaskActive: (...args: unknown[]) => setTaskActiveBridge(...args),
}));

import {
  beginBlockOutput,
  isTaskActive,
  setTaskActive,
  startThinking,
  startWorking,
  stopAnimated,
} from "../../../../packages/client/src/state/agentStatus.js";

describe("agentStatus", () => {
  beforeEach(() => {
    getTaskActive.mockReturnValue(false);
    isInkActive.mockReturnValue(true);
    setSpinner.mockClear();
    setTaskActiveBridge.mockClear();
  });

  it("isTaskActive / setTaskActive delegate to the bridge", () => {
    getTaskActive.mockReturnValue(true);
    expect(isTaskActive()).toBe(true);
    setTaskActive(true);
    expect(setTaskActiveBridge).toHaveBeenCalledWith(true);
  });

  it("stopAnimated clears the spinner when Ink is active", () => {
    stopAnimated();
    expect(setSpinner).toHaveBeenCalledWith(null);
  });

  it("startThinking / startWorking no-op when task inactive", () => {
    startThinking("Agent");
    startWorking("Subagent");
    expect(setSpinner).not.toHaveBeenCalled();
  });

  it("startThinking / startWorking set spinner when task active", () => {
    getTaskActive.mockReturnValue(true);
    startThinking("Agent");
    expect(setSpinner).toHaveBeenCalled();
    setSpinner.mockClear();
    startWorking("Subagent");
    expect(setSpinner).toHaveBeenCalled();
  });

  it("beginBlockOutput clears spinner for block output", () => {
    beginBlockOutput();
    expect(setSpinner).toHaveBeenCalledWith(null);
  });
});
