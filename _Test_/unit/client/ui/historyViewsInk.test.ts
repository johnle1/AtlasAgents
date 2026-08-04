/**
 * Ink smoke — HistoryView and LiveThinkView.
 */

import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  formatAgentThinkForDisplay: (t: string) => t.trim() || "Planning...",
}));

const mockContext = {
  streamingText: "streaming tokens",
  liveThinks: [
    { id: "think-1", text: "live reasoning", agent: true, label: null },
  ],
};

vi.mock("../../../../packages/client/src/state/DataContext.js", () => ({
  useAppContext: () => mockContext,
}));

import {
  HistoryView,
  LiveThinkView,
} from "../../../../packages/client/src/ui/components/HistoryView.js";

describe("HistoryView / LiveThinkView", () => {
  it("HistoryView renders active streaming text", () => {
    const tree = render(React.createElement(HistoryView));
    expect(stripAnsi(tree.lastFrame() ?? "")).toContain("streaming tokens");
    tree.unmount();
  });

  it("LiveThinkView renders open think streams", () => {
    const tree = render(React.createElement(LiveThinkView));
    expect(stripAnsi(tree.lastFrame() ?? "")).toContain("live reasoning");
    tree.unmount();
  });
});
