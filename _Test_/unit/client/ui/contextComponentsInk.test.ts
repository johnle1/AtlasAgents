/**
 * Ink smoke — SetupWizard and context-backed components.
 */

import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";

vi.mock("../../../../packages/client/src/config/index.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../packages/client/src/config/index.js")
  >();
  return {
    ...actual,
    loadConfig: () => ({
      server: "localhost",
      port: 7000,
      password: "",
      agentModel: "a",
      subagentModel: "b",
      ui: {},
    }),
    saveConfig: vi.fn(),
  };
});

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  resolveApproval: vi.fn(),
  resolvePrompt: vi.fn(),
  getPendingApproval: () => null,
  getPendingPrompt: () => null,
}));

const mockContext = {
  prompt: "> ",
  input: "",
  setInput: vi.fn(),
  handleSubmit: vi.fn(async () => {}),
  inputDisabled: false,
  approval: { type: "runSkip" as const, command: "echo hi" },
  approvalSelected: 0,
  setApprovalSelected: vi.fn(),
  promptReq: { type: "line" as const, prompt: "Enter value:" },
  promptDraft: { lineValue: "", choiceValue: "", themeSelected: 0 },
  setPromptDraft: vi.fn(),
};

vi.mock("../../../../packages/client/src/state/DataContext.js", () => ({
  useAppContext: () => mockContext,
}));

import { SetupWizard } from "../../../../packages/client/src/ui/bootstrap/SetupWizard.js";
import { ApprovalMenu } from "../../../../packages/client/src/ui/components/ApprovalMenu.js";
import { InputBox } from "../../../../packages/client/src/ui/components/InputBox.js";
import { PromptOverlay } from "../../../../packages/client/src/ui/components/PromptOverlay.js";

describe("SetupWizard smoke", () => {
  it("renders welcome text", () => {
    const tree = render(
      React.createElement(SetupWizard, { onComplete: vi.fn() }),
    );
    expect(stripAnsi(tree.lastFrame() ?? "")).toContain("Welcome to LoopyCode");
    tree.unmount();
  });
});

describe("context-backed components", () => {
  it("ApprovalMenu shows run options", () => {
    const tree = render(React.createElement(ApprovalMenu));
    expect(stripAnsi(tree.lastFrame() ?? "")).toMatch(/Run|Skip/);
    tree.unmount();
  });

  it("InputBox shows prompt", () => {
    const tree = render(React.createElement(InputBox));
    expect(stripAnsi(tree.lastFrame() ?? "")).toContain(">");
    tree.unmount();
  });

  it("PromptOverlay shows line prompt", () => {
    const tree = render(React.createElement(PromptOverlay));
    expect(stripAnsi(tree.lastFrame() ?? "")).toContain("Enter value");
    tree.unmount();
  });
});
