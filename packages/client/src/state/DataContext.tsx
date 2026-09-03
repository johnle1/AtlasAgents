/**
 * React context that holds Ink UI state for the main application shell.
 *
 * @remarks
 * {@link AppProvider} owns all shared state (history, input, approvals,
 * prompts, agent boards). Side effects and keyboard wiring live in
 * {@link App} and custom hooks — this module is storage and wiring only.
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { loadConfig, parsePersistedApprovalMode, type Config } from "../config/index.js";
import { setSessionApprovalMode } from "../ui/bridge/allowlist.js";
import type { ApprovalMode } from "../config/approvalMode.js";
import { buildPromptLabel } from "../utils/pathDisplay.js";
import { buildBannerLines } from "../renderer/banner.js";
import type {
  SubagentBoardState,
  SubagentStatusState,
  PlanStepState,
  AppProps,
  ApprovalRequest,
  HistoryItem,
  LiveThink,
  PromptRequest,
  SpinnerState,
  StaticEntry,
} from "../ui/types.js";
import { getPendingApproval, getPendingPrompt } from "../ui/uiBridge.js";

/**
 * Mutable draft fields for the active {@link PromptOverlay} sub-form.
 *
 * @remarks
 * Reset to {@link emptyPromptDraft} whenever a new `promptReq` arrives
 * so stale input from a prior prompt cannot leak into the next one.
 */
export type PromptDraft = {
  lineValue: string;
  choiceValue: string;
  themeSelected: number;
  optionBarSelected: number;
};

/** Returns a zeroed {@link PromptDraft} for overlay initialization. */
export const emptyPromptDraft = (): PromptDraft => ({
  lineValue: "",
  choiceValue: "",
  themeSelected: 0,
  optionBarSelected: 0,
});

const buildBannerEntries = (configuration: Config): StaticEntry[] =>
  buildBannerLines(configuration).map((bannerLine, lineIndex) => ({
    kind: "banner" as const,
    key: `banner-${lineIndex}`,
    line: bannerLine,
  }));

/**
 * Full context value exposed to UI components and hooks via {@link useAppContext}.
 */
export type AppContextValue = {
  history: HistoryItem[];
  setHistory: React.Dispatch<React.SetStateAction<HistoryItem[]>>;

  /** Live token stream appended below history while a model responds. */
  streamingText: string | null;
  setStreamingText: React.Dispatch<React.SetStateAction<string | null>>;

  /**
   * In-progress "thinking" streams, one per active `think-start`…`think-end`
   * sequence. Rendered below `streamingText` and above `subagentBoards`;
   * committed to `history` and removed here on `think-end`.
   */
  liveThinks: LiveThink[];
  setLiveThinks: React.Dispatch<React.SetStateAction<LiveThink[]>>;

  spinner: SpinnerState | null;
  setSpinner: React.Dispatch<React.SetStateAction<SpinnerState | null>>;

  /** Fixed-position banner + frozen history rows for Ink {@link Static}. */
  bannerEntries: StaticEntry[];
  setBannerEntries: React.Dispatch<React.SetStateAction<StaticEntry[]>>;

  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;

  inputHistory: string[];
  setInputHistory: React.Dispatch<React.SetStateAction<string[]>>;

  /** Index into `inputHistory` while navigating with arrow keys; `-1` when idle. */
  histIdx: number;
  setHistIdx: React.Dispatch<React.SetStateAction<number>>;

  /** Left-hand prompt label (typically cwd-based). */
  prompt: string;
  setPrompt: React.Dispatch<React.SetStateAction<string>>;

  /** Selected row in the slash-command autocomplete list. */
  activeIndex: number;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;

  /** Window offset when autocomplete list exceeds visible row count. */
  scrollOffset: number;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;

  /** `true` while a command or agent task is in flight. */
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;

  /** `true` while an agent task stream is actively running. */
  taskActive: boolean;
  setTaskActive: React.Dispatch<React.SetStateAction<boolean>>;

  approval: ApprovalRequest | null;
  setApproval: React.Dispatch<React.SetStateAction<ApprovalRequest | null>>;

  promptReq: PromptRequest | null;
  setPromptReq: React.Dispatch<React.SetStateAction<PromptRequest | null>>;

  approvalSelected: number;
  setApprovalSelected: React.Dispatch<React.SetStateAction<number>>;

  promptDraft: PromptDraft;
  setPromptDraft: React.Dispatch<React.SetStateAction<PromptDraft>>;

  subagentStatuses: Map<number | "agent", SubagentStatusState>;
  setSubagentStatuses: React.Dispatch<
    React.SetStateAction<Map<number | "agent", SubagentStatusState>>
  >;

  subagentBoards: SubagentBoardState[];
  setSubagentBoards: React.Dispatch<React.SetStateAction<SubagentBoardState[]>>;

  /** The agent's live `update_plan` checklist — see `PlanChecklist.tsx`. */
  activePlan: PlanStepState[];
  setActivePlan: React.Dispatch<React.SetStateAction<PlanStepState[]>>;

  /** First Ctrl+C during `busy` increments this; second press exits. */
  sigintBusy: number;
  setSigintBusy: React.Dispatch<React.SetStateAction<number>>;

  /** Whether the `?` shortcuts cheat-sheet overlay is visible. */
  showShortcuts: boolean;
  setShowShortcuts: React.Dispatch<React.SetStateAction<boolean>>;

  /**
   * Latest context-window sample from a server `usage` frame, or `null`
   * before any has arrived (footer shows `—`).
   */
  contextUsage: { usedTokens: number; contextWindow: number } | null;
  setContextUsage: React.Dispatch<
    React.SetStateAction<{
      usedTokens: number;
      contextWindow: number;
    } | null>
  >;

  /**
   * Session approval mode. Defaults to the persisted config value;
   * Shift+Tab cycles default / accept-edits / plan.
   */
  approvalMode: ApprovalMode;
  setApprovalMode: React.Dispatch<React.SetStateAction<ApprovalMode>>;

  /**
   * When true, assistant markdown is shown as the raw source (Alt+M).
   * Default false — formatted markdown is on.
   */
  markdownRaw: boolean;
  setMarkdownRaw: React.Dispatch<React.SetStateAction<boolean>>;

  /**
   * Lines waiting to run after the current task (Enter while busy).
   */
  queuedMessages: string[];
  setQueuedMessages: React.Dispatch<React.SetStateAction<string[]>>;

  /** Registered by {@link App} once submit/autocomplete logic is ready. */
  handleSubmit: (line: string) => Promise<void>;
  setHandleSubmit: React.Dispatch<
    React.SetStateAction<(line: string) => Promise<void>>
  >;

  /** Derived: main input is blocked while an overlay owns the keyboard. */
  inputDisabled: boolean;

  connection: AppProps["connection"];
  commandHandler: AppProps["commandHandler"];
  fileProxy: AppProps["fileProxy"];
  onSaveHistory: AppProps["onSaveHistory"];
  registerExit: AppProps["registerExit"];
  onInputHistoryRef: AppProps["onInputHistoryRef"];
};

const AppContext = createContext<AppContextValue | null>(null);

/**
 * Returns the application context from the nearest {@link AppProvider}.
 *
 * @throws {Error} When called outside of {@link AppProvider}.
 */
export const useAppContext = (): AppContextValue => {
  const contextValue = useContext(AppContext);
  if (!contextValue) {
    throw new Error("useAppContext must be used within AppProvider");
  }
  return contextValue;
};

type AppProviderProps = AppProps & {
  children: React.ReactNode;
};

/**
 * Initializes UI state and provides {@link AppContextValue} to descendants.
 *
 * @remarks
 * Seeds history from bootstrap session messages, restores input history
 * from disk, and hydrates any approval/prompt the bridge queued before
 * React mounted. {@link App} attaches submit handlers and bridge callbacks
 * after mount.
 *
 * @example
 * ```tsx
 * <AppProvider {...appProps}>
 *   <AppContent />
 * </AppProvider>
 * ```
 */
export const AppProvider: React.FC<AppProviderProps> = ({
  connection,
  commandHandler,
  fileProxy,
  initialHistoryLines,
  onSaveHistory,
  initialInputHistory,
  registerExit,
  onInputHistoryRef,
  children,
}) => {
  const [inputHistory, setInputHistory] = useState(initialInputHistory);

  // BootstrapApp reads this ref on exit — keep it aligned with React state
  useEffect(() => {
    onInputHistoryRef.current = inputHistory;
  }, [inputHistory]);

  const [history, setHistory] = useState<HistoryItem[]>(() =>
    initialHistoryLines.map(
      (historyLine): HistoryItem => ({
        kind: "text",
        text: historyLine,
        variant: "system",
      }),
    ),
  );

  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [liveThinks, setLiveThinks] = useState<LiveThink[]>([]);
  const [spinner, setSpinner] = useState<SpinnerState | null>(null);

  const [bannerEntries, setBannerEntries] = useState<StaticEntry[]>(() =>
    buildBannerEntries(loadConfig()),
  );

  const [input, setInput] = useState("");

  const [prompt, setPrompt] = useState(() => {
    try {
      return buildPromptLabel(fileProxy.getCwd());
    } catch {
      // Safe to ignore: fileProxy may not be initialized yet on first render
      // (workspace root not resolved) — the generic "$ " prompt is a fine
      // placeholder until the next cwd change re-renders it correctly.
      return "$ ";
    }
  });

  // Bridge may queue approval/prompt before the provider mounts (e.g. fast RPC)
  const [approval, setApproval] = useState(() => {
    try {
      return getPendingApproval();
    } catch {
      // Safe to ignore: the bridge module may not be wired up yet on first
      // render — no approval can be pending before the bridge exists, so
      // `null` (no pending approval) is the correct value, not a fallback.
      return null;
    }
  });

  const [promptReq, setPromptReq] = useState(() => {
    try {
      return getPendingPrompt();
    } catch {
      // Safe to ignore: same bridge-not-yet-wired case as `approval` above —
      // `null` (no pending prompt) is correct, not a fallback default.
      return null;
    }
  });

  const [approvalSelected, setApprovalSelected] = useState(0);
  const [promptDraft, setPromptDraft] = useState<PromptDraft>(emptyPromptDraft);

  const [subagentStatuses, setSubagentStatuses] = useState(
    () => new Map<number | "agent", SubagentStatusState>(),
  );
  const [subagentBoards, setSubagentBoards] = useState<SubagentBoardState[]>(
    [],
  );
  // The agent's live `update_plan` checklist — drives `PlanChecklist`, the
  // replacement for the per-agent task boards above (which the unified
  // agent loop no longer populates; kept only for wire back-compat).
  const [activePlan, setActivePlan] = useState<PlanStepState[]>([]);

  const [histIdx, setHistIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [taskActive, setTaskActive] = useState(false);
  const [sigintBusy, setSigintBusy] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [contextUsage, setContextUsage] = useState<{
    usedTokens: number;
    contextWindow: number;
  } | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() => {
    const persisted = parsePersistedApprovalMode(loadConfig().approvalMode);
    setSessionApprovalMode(persisted);
    return persisted;
  });
  const [markdownRaw, setMarkdownRaw] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Placeholder until App registers the real submit handler
  const [handleSubmit, setHandleSubmit] = useState<
    (line: string) => Promise<void>
  >(async () => {});

  const inputDisabled = useMemo(
    () => approval !== null || promptReq !== null,
    [approval, promptReq],
  );

  useEffect(() => {
    if (approval !== null) {
      setApprovalSelected(0);
    }
  }, [approval, setApprovalSelected]);

  useEffect(() => {
    if (promptReq !== null) {
      // An optionBar prompt opens already highlighting the current value
      // (the model/effort in effect) rather than always starting at index
      // 0 — every other draft field still resets to its zeroed default.
      setPromptDraft(
        promptReq.type === "optionBar"
          ? { ...emptyPromptDraft(), optionBarSelected: promptReq.initialIndex }
          : emptyPromptDraft(),
      );
    }
  }, [promptReq, setPromptDraft]);

  const contextValue: AppContextValue = useMemo(
    () => ({
      history,
      setHistory,
      streamingText,
      setStreamingText,
      liveThinks,
      setLiveThinks,
      spinner,
      setSpinner,
      bannerEntries,
      setBannerEntries,
      input,
      setInput,
      inputHistory,
      setInputHistory,
      histIdx,
      setHistIdx,
      prompt,
      setPrompt,
      activeIndex,
      setActiveIndex,
      scrollOffset,
      setScrollOffset,
      busy,
      setBusy,
      taskActive,
      setTaskActive,
      approval,
      setApproval,
      promptReq,
      setPromptReq,
      approvalSelected,
      setApprovalSelected,
      promptDraft,
      setPromptDraft,
      subagentStatuses,
      setSubagentStatuses,
      subagentBoards,
      setSubagentBoards,
      activePlan,
      setActivePlan,
      sigintBusy,
      setSigintBusy,
      showShortcuts,
      setShowShortcuts,
      contextUsage,
      setContextUsage,
      approvalMode,
      setApprovalMode,
      markdownRaw,
      setMarkdownRaw,
      queuedMessages,
      setQueuedMessages,
      handleSubmit,
      setHandleSubmit,
      inputDisabled,
      connection,
      commandHandler,
      fileProxy,
      onSaveHistory,
      registerExit,
      onInputHistoryRef,
    }),
    [
      history,
      streamingText,
      liveThinks,
      spinner,
      bannerEntries,
      input,
      inputHistory,
      histIdx,
      prompt,
      activeIndex,
      scrollOffset,
      busy,
      taskActive,
      approval,
      promptReq,
      approvalSelected,
      promptDraft,
      subagentStatuses,
      subagentBoards,
      activePlan,
      sigintBusy,
      showShortcuts,
      handleSubmit,
      inputDisabled,
      connection,
      commandHandler,
      fileProxy,
      onSaveHistory,
      registerExit,
      onInputHistoryRef,
      contextUsage,
      approvalMode,
      markdownRaw,
      queuedMessages,
    ],
  );

  return (
    <AppContext.Provider value={contextValue}>{children}</AppContext.Provider>
  );
};
