/**
 * Ink smoke tests — standalone UI components (no AppProvider).
 */

import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({ ui: { showSpinner: true } }),
}));

vi.mock("../../../../packages/client/src/ui/terminalEnv.js", () => ({
  inTmux: () => false,
  isScreenReaderLikely: () => false,
  colorDisabled: () => false,
  colorForced: () => false,
  supportsOsc9Notifications: () => false,
}));

import { Banner } from "../../../../packages/client/src/ui/components/Banner.js";
import { ConnectionStatusLine } from "../../../../packages/client/src/ui/components/ConnectionStatusLine.js";
import { StatusSpinner } from "../../../../packages/client/src/ui/components/Spinner.js";
import { PlanChecklist } from "../../../../packages/client/src/ui/components/PlanChecklist.js";
import { renderHistoryItem } from "../../../../packages/client/src/ui/components/HistoryView.js";

const frame = (tree: ReturnType<typeof render>) =>
  stripAnsi(tree.lastFrame() ?? "");

describe("Ink component smoke", () => {
  it("Banner renders version and models", () => {
    const tree = render(
      React.createElement(Banner, {
        version: "9.9.9",
        agentModel: "agent-x",
        subagentModel: "sub-y",
      }),
    );
    expect(frame(tree)).toContain("9.9.9");
    tree.unmount();
  });

  it("ConnectionStatusLine renders status label", () => {
    const tree = render(
      React.createElement(ConnectionStatusLine, { status: "Connected" }),
    );
    expect(frame(tree)).toContain("Connected");
    tree.unmount();
  });

  it("StatusSpinner renders when active", () => {
    const tree = render(
      React.createElement(StatusSpinner, {
        state: { active: true, mode: "thinking", label: "Agent" },
      }),
    );
    expect(frame(tree)).toMatch(/Agent/);
    tree.unmount();
  });

  it("PlanChecklist renders nothing for an empty checklist", () => {
    const tree = render(React.createElement(PlanChecklist, { steps: [] }));
    expect(frame(tree)).toBe("");
    tree.unmount();
  });

  it("PlanChecklist renders pending, in-progress, and done steps with the right markers", () => {
    const tree = render(
      React.createElement(PlanChecklist, {
        steps: [
          { id: 1, text: "Read the config parser", status: "done" },
          { id: 2, text: "Wire the flag into routerBuilder", status: "in_progress" },
          { id: 3, text: "Update the tests", status: "pending" },
        ],
      }),
    );
    try {
      const rendered = frame(tree);
      expect(rendered).toContain("Plan");
      // Done and in-progress both render the [#] marker — status.ts.
      expect(rendered).toContain("[#] Read the config parser");
      expect(rendered).toContain("[#] Wire the flag into routerBuilder");
      expect(rendered).toContain("[ ] Update the tests");
    } finally {
      tree.unmount();
    }
  });

  it("PlanChecklist marks a failed step", () => {
    const tree = render(
      React.createElement(PlanChecklist, {
        steps: [{ id: 1, text: "Run the migration", status: "failed" }],
      }),
    );
    try {
      expect(frame(tree)).toContain("[#] Run the migration (failed)");
    } finally {
      tree.unmount();
    }
  });

  it("renderHistoryItem maps text history", () => {
    const node = renderHistoryItem(
      { kind: "text", text: "hello world", variant: "success" },
      "k1",
    );
    const tree = render(React.createElement(React.Fragment, null, node));
    expect(frame(tree)).toContain("hello world");
    tree.unmount();
  });

  it("renderHistoryItem maps a proposed plan as a flat [ ] checklist with risks", () => {
    const node = renderHistoryItem(
      {
        kind: "plan",
        task: "add a login form",
        steps: ["scaffold the component", "wire up validation"],
        risks: ["may need a new dependency"],
        agents: [
          { id: 1, label: "plan", steps: ["scaffold the component", "wire up validation"], dependsOn: [] },
        ],
        agentCount: 1,
        execution: "sequential",
        modeLabel: null,
      },
      "k-plan",
    );
    const tree = render(React.createElement(React.Fragment, null, node));
    const rendered = frame(tree);
    try {
      expect(rendered).toContain("Plan");
      expect(rendered).toContain("Task: add a login form");
      // Proposed steps are all still pending — plain [ ], not [#] — and the
      // old per-agent "┄┄ Agent N — label ┄┄" grouping is gone.
      expect(rendered).toContain("[ ] scaffold the component");
      expect(rendered).toContain("[ ] wire up validation");
      expect(rendered).not.toContain("┄┄");
      expect(rendered).toContain("Risks:");
      expect(rendered).toContain("may need a new dependency");
    } finally {
      tree.unmount();
    }
  });

  it("renderHistoryItem omits the Risks section when there are none", () => {
    const node = renderHistoryItem(
      {
        kind: "plan",
        task: "fix the typo",
        steps: ["fix the typo in README"],
        risks: [],
        agents: [],
        agentCount: 1,
        execution: "sequential",
        modeLabel: null,
      },
      "k-plan-2",
    );
    const tree = render(React.createElement(React.Fragment, null, node));
    try {
      expect(frame(tree)).not.toContain("Risks:");
    } finally {
      tree.unmount();
    }
  });
});
