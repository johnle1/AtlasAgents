/**
 * Unit tests — approvalFlow printDeclineFeedback, promptPort, historyPersist, runInkApp.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const printReviseRequested = vi.fn();
const printSkipped = vi.fn();

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printReviseRequested: (...args: unknown[]) => printReviseRequested(...args),
  printSkipped: (...args: unknown[]) => printSkipped(...args),
}));

import { printDeclineFeedback } from "../../../../packages/client/src/ui/approvalFlow.js";

describe("printDeclineFeedback", () => {
  beforeEach(() => {
    printReviseRequested.mockClear();
    printSkipped.mockClear();
  });

  it("prints revise line when feedback is present", () => {
    printDeclineFeedback("use pnpm");
    expect(printReviseRequested).toHaveBeenCalled();
  });

  it("prints skipped when feedback is absent", () => {
    printDeclineFeedback();
    expect(printSkipped).toHaveBeenCalled();
  });
});

const mockRequestPrompt = vi.fn();

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  requestPrompt: (...args: unknown[]) => mockRequestPrompt(...args),
}));

import { createInkPromptPort } from "../../../../packages/client/src/ui/promptPort.js";

describe("createInkPromptPort", () => {
  it("question and choose forward to requestPrompt", async () => {
    mockRequestPrompt.mockResolvedValueOnce("answer").mockResolvedValueOnce(2);
    const port = createInkPromptPort();
    await expect(port.question("Name?")).resolves.toBe("answer");
    await expect(port.choose("Pick", 3)).resolves.toBe(2);
  });
});

const readFileSync = vi.fn();
const writeFileSync = vi.fn();
const ensureDirs = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => readFileSync(...args),
    writeFileSync: (...args: unknown[]) => writeFileSync(...args),
  },
  readFileSync: (...args: unknown[]) => readFileSync(...args),
  writeFileSync: (...args: unknown[]) => writeFileSync(...args),
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  HISTORY_FILE: "/tmp/history.txt",
  ensureDirs: (...args: unknown[]) => ensureDirs(...args),
}));

import {
  loadHistory,
  saveHistory,
} from "../../../../packages/client/src/ui/bootstrap/historyPersist.js";

describe("historyPersist", () => {
  beforeEach(() => {
    readFileSync.mockReset();
    writeFileSync.mockReset();
  });

  it("loadHistory sanitizes and saveHistory writes", () => {
    readFileSync.mockReturnValue("/help\n");
    expect(loadHistory()).toEqual(["/help"]);
    saveHistory(["a"]);
    expect(writeFileSync).toHaveBeenCalled();
  });
});

const inkRender = vi.fn((..._args: unknown[]) => ({
  waitUntilExit: vi.fn(async () => {}),
}));

vi.mock("ink", () => ({
  render: (...args: unknown[]) => inkRender(...args),
}));

vi.mock("../../../../packages/client/src/ui/bootstrap/BootstrapApp.js", () => ({
  BootstrapApp: () => React.createElement("div", null, "bootstrap"),
}));

import { runInkApp } from "../../../../packages/client/src/ui/bootstrap/runApp.js";

describe("runInkApp", () => {
  it("calls ink render", () => {
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    runInkApp({ cliOverrides: {}, needsSetup: false });
    expect(inkRender).toHaveBeenCalled();
  });
});
