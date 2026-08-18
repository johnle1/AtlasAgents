/**
 * Unit tests — Phase 5 export smoke without mounting Ink trees.
 *
 * Full Ink renders are excluded in vitest.config.ts (React 19 / ink peer issues).
 * This file still imports the symbols so the static untested-export report shrinks.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AppProvider,
  emptyPromptDraft,
  useAppContext,
} from "../../../../packages/client/src/state/DataContext.js";
import { useBridgeSetup } from "../../../../packages/client/src/ui/hooks/useBridgeSetup.js";
import { useConnectionDisconnectCleanup } from "../../../../packages/client/src/ui/hooks/useConnectionDisconnectCleanup.js";
import { useConnectionStatus } from "../../../../packages/client/src/ui/hooks/useConnectionStatus.js";
import { useKeyboardInput } from "../../../../packages/client/src/ui/hooks/useKeyboardInput.js";
import { useSubmitLine } from "../../../../packages/client/src/ui/hooks/useSubmitLine.js";
import { Banner } from "../../../../packages/client/src/ui/components/Banner.js";
import { ConnectionStatusLine } from "../../../../packages/client/src/ui/components/ConnectionStatusLine.js";
import {
  HistoryView,
  LiveThinkView,
  renderHistoryItem,
} from "../../../../packages/client/src/ui/components/HistoryView.js";
import { StatusSpinner } from "../../../../packages/client/src/ui/components/Spinner.js";
import { SubagentStatusBox } from "../../../../packages/client/src/ui/components/SubagentStatusBox.js";
import { SubagentTaskBoard } from "../../../../packages/client/src/ui/components/SubagentTaskBoard.js";

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({
    agentModel: "a",
    subagentModel: "b",
    server: "localhost",
    port: 7000,
    password: "",
    ui: { theme: "default", showSpinner: true },
  }),
  updateConfig: vi.fn(),
  HISTORY_FILE: "/tmp/atlas-history-test",
}));

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({
    textBold: "",
    textSecondary: "",
    textAccent: "",
    textDim: "",
    success: "",
    warning: "",
    error: "",
    reset: "",
  }),
  loadTheme: vi.fn(),
  setTheme: vi.fn(),
  getThemeKey: () => "default",
}));

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  appendHistory: vi.fn(),
  appendLog: vi.fn(),
  setBusy: vi.fn(),
  setTaskActive: vi.fn(),
  getTaskActive: () => false,
  isInkActive: () => false,
  setSpinner: vi.fn(),
  refreshInkBanner: vi.fn(),
}));

vi.mock("ink", () => ({
  render: vi.fn(),
  Box: "Box",
  Text: "Text",
  useInput: vi.fn(),
  useApp: () => ({ exit: vi.fn() }),
  useStdout: () => ({ stdout: { columns: 80, rows: 24, write: vi.fn() } }),
}));

describe("UI non-component helpers", () => {
  it("imports hooks as functions", () => {
    expect(typeof useBridgeSetup).toBe("function");
    expect(typeof useConnectionDisconnectCleanup).toBe("function");
    expect(typeof useConnectionStatus).toBe("function");
    expect(typeof useKeyboardInput).toBe("function");
    expect(typeof useSubmitLine).toBe("function");
  });

  it("imports prompt/history/banner/data helpers", async () => {
    const { createInkPromptPort } = await import(
      "../../../../packages/client/src/ui/promptPort.js"
    );
    const { printDeclineFeedback } = await import(
      "../../../../packages/client/src/ui/approvalFlow.js"
    );
    const { buildBannerLines } = await import(
      "../../../../packages/client/src/ui/banner/buildBannerLines.js"
    );
    const { loadHistory, saveHistory } = await import(
      "../../../../packages/client/src/ui/bootstrap/historyPersist.js"
    );
    expect(typeof createInkPromptPort).toBe("function");
    expect(typeof printDeclineFeedback).toBe("function");
    expect(typeof buildBannerLines).toBe("function");
    expect(typeof loadHistory).toBe("function");
    expect(typeof saveHistory).toBe("function");
    expect(typeof emptyPromptDraft).toBe("function");
    expect(typeof useAppContext).toBe("function");
    expect(typeof AppProvider).toBe("function");
  });

  it("imports leaf component constructors (mocked ink)", () => {
    expect(typeof Banner).toBe("function");
    expect(typeof ConnectionStatusLine).toBe("function");
    expect(typeof StatusSpinner).toBe("function");
    expect(typeof SubagentStatusBox).toBe("function");
    expect(typeof SubagentTaskBoard).toBe("function");
    expect(typeof HistoryView).toBe("function");
    expect(typeof LiveThinkView).toBe("function");
    expect(typeof renderHistoryItem).toBe("function");
  });
});
