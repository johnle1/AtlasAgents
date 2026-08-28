/**
 * Ink smoke — SetupWizard and context-backed components.
 */

import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import type { ApprovalRequest } from "../../../../packages/client/src/ui/types.js";

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

const mockContext: { approval: ApprovalRequest | null } & Record<string, unknown> = {
  prompt: "> ",
  input: "",
  setInput: vi.fn(),
  handleSubmit: vi.fn(async () => {}),
  inputDisabled: false,
  busy: false,
  approval: { type: "runSkip", command: "echo hi" },
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
import { QueuedMessageRow } from "../../../../packages/client/src/ui/components/QueuedMessageRow.js";

describe("SetupWizard smoke", () => {
  it("renders welcome text", () => {
    const tree = render(
      React.createElement(SetupWizard, { onComplete: vi.fn() }),
    );
    expect(stripAnsi(tree.lastFrame() ?? "")).toContain("Welcome to AtlasAgents");
    tree.unmount();
  });
});

describe("context-backed components", () => {
  it("ApprovalMenu shows run options", () => {
    const tree = render(React.createElement(ApprovalMenu));
    expect(stripAnsi(tree.lastFrame() ?? "")).toMatch(/Run|Skip/);
    tree.unmount();
  });

  it("ApprovalMenu shows a simple 'Plan · N steps' context line for a plan review", () => {
    const previousApproval = mockContext.approval;
    mockContext.approval = {
      type: "planReview",
      task: "add a login form",
      stepCount: 3,
      agentCount: 1,
      execution: "sequential",
      modeLabel: null,
    };
    try {
      const tree = render(React.createElement(ApprovalMenu));
      const rendered = stripAnsi(tree.lastFrame() ?? "");
      expect(rendered).toContain("Plan: add a login form");
      expect(rendered).toContain("3 steps");
      // The old "N step(s) · M agents · execution" / "Mode: ..." lines are
      // gone — plan mode's checklist no longer surfaces per-agent grouping.
      expect(rendered).not.toContain("agent");
      expect(rendered).not.toContain("sequential");
      tree.unmount();
    } finally {
      mockContext.approval = previousApproval;
    }
  });

  it("InputBox shows prompt", () => {
    const tree = render(React.createElement(InputBox));
    const frame = stripAnsi(tree.lastFrame() ?? "");
    expect(frame).toContain(">");
    expect(frame).toMatch(/╭|┌/);
    tree.unmount();
  });

  it("QueuedMessageRow draws a bordered preview (normal)", () => {
    const tree = render(
      React.createElement(QueuedMessageRow, { items: ["follow up"] }),
    );
    const frame = stripAnsi(tree.lastFrame() ?? "");
    expect(frame).toContain("queued (1)");
    expect(frame).toContain("follow up");
    expect(frame).toMatch(/╭|┌/);
    tree.unmount();
  });

  it("PromptOverlay shows line prompt", () => {
    const tree = render(React.createElement(PromptOverlay));
    expect(stripAnsi(tree.lastFrame() ?? "")).toContain("Enter value");
    tree.unmount();
  });
});
