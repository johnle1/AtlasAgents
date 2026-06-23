/**
 * <Summary>
 * What it does:
 *   Central React context for Ink application state — manages history, input, session, and bridge hooks.
 *
 * How it fits in the system:
 *   Provides the global state management for the entire Ink-based CLI interface. This context
 *   manages all application state including command history, streaming text, spinner status,
 *   input handling, approval requests, prompt overlays, and command autocomplete. It also
 *   provides setter functions for updating the state. The actual logic and effects are
 *   implemented in App.tsx to keep this context focused on state storage only.
 * </Summary>
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { loadConfig, type Config } from "./config.js";
import { buildPromptLabel } from "./pathDisplay.js";
import { buildBannerLines } from "./renderer/banner.js";
import type {
  AgentBoardState,
  AgentStatusState,
  AppProps,
  ApprovalRequest,
  HistoryItem,
  PromptRequest,
  SpinnerState,
  StaticEntry,
} from "./ui/types.js";
import { getPendingApproval, getPendingPrompt } from "./ui/uiBridge.js";

/** Draft input state for prompt overlay sub-forms. */
export type PromptDraft = {
  lineValue: string;
  choiceValue: string;
  planLines: string[];
  planCurrent: string;
  themeSelected: number;
};

export const emptyPromptDraft = (): PromptDraft => ({
  lineValue: "",
  choiceValue: "",
  planLines: [],
  planCurrent: "",
  themeSelected: 0,
});

/**
 * <Summary>
 * What it does:
 *   Builds static banner entries from the configuration.
 *
 * How it does it (step by step):
 *   1. Build banner lines from the configuration.
 *   2. Map each banner line to a static entry with a unique key.
 *
 * Parameters:
 * @param configuration - The application configuration.
 *
 * Returns:
 * @returns Array of static banner entries.
 * </Summary>
 */
const buildBannerEntries = (configuration: Config): StaticEntry[] =>
  buildBannerLines(configuration).map((bannerLine, lineIndex) => ({
    kind: "banner" as const,
    key: `banner-${lineIndex}`,
    line: bannerLine,
  }));

/**
 * <Summary>
 * What it does:
 *   Defines the shape of the application context value.
 *
 * Used by:
 *   - AppContext — provides this type for the context value.
 *   - useAppContext — returns values of this type.
 *   - AppContent — consumes this type for state access.
 *
 * Produced by:
 *   - AppProvider — creates and provides this context value.
 * </Summary>
 */
export type AppContextValue = {
  /** Array of history items displayed in the terminal. */
  history: HistoryItem[];

  /** Setter function for history state. */
  setHistory: React.Dispatch<React.SetStateAction<HistoryItem[]>>;

  /** Current streaming text being displayed (null if not streaming). */
  streamingText: string | null;

  /** Setter function for streaming text state. */
  setStreamingText: React.Dispatch<React.SetStateAction<string | null>>;

  /** Current spinner state for bottom-line status indicator (null if no spinner). */
  spinner: SpinnerState | null;

  /** Setter function for spinner state. */
  setSpinner: React.Dispatch<React.SetStateAction<SpinnerState | null>>;

  /** Array of static entries (banner + history) for fixed-position display. */
  bannerEntries: StaticEntry[];

  /** Setter function for banner entries state. */
  setBannerEntries: React.Dispatch<React.SetStateAction<StaticEntry[]>>;

  /** Current user input text. */
  input: string;

  /** Setter function for input state. */
  setInput: React.Dispatch<React.SetStateAction<string>>;

  /** Array of previous input commands for history navigation. */
  inputHistory: string[];

  /** Setter function for input history state. */
  setInputHistory: React.Dispatch<React.SetStateAction<string[]>>;

  /** Current index in input history for history navigation (-1 if not navigating). */
  histIdx: number;

  /** Setter function for history index state. */
  setHistIdx: React.Dispatch<React.SetStateAction<number>>;

  /** The prompt label displayed before the input field. */
  prompt: string;

  /** Setter function for prompt state. */
  setPrompt: React.Dispatch<React.SetStateAction<string>>;

  /** Currently selected index in command autocomplete suggestions. */
  activeIndex: number;

  /** Setter function for active index state. */
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;

  /** Scroll offset for command autocomplete suggestions (for pagination). */
  scrollOffset: number;

  /** Setter function for scroll offset state. */
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;

  /** Whether the application is currently busy processing a command. */
  busy: boolean;

  /** Setter function for busy state. */
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;

  /** Current approval request (null if no approval pending). */
  approval: ApprovalRequest | null;

  /** Setter function for approval state. */
  setApproval: React.Dispatch<React.SetStateAction<ApprovalRequest | null>>;

  /** Current prompt request (null if no prompt pending). */
  promptReq: PromptRequest | null;

  /** Setter function for prompt request state. */
  setPromptReq: React.Dispatch<React.SetStateAction<PromptRequest | null>>;

  /** Selected index in the approval menu. */
  approvalSelected: number;

  /** Setter function for approval menu selection. */
  setApprovalSelected: React.Dispatch<React.SetStateAction<number>>;

  /** Draft input state for the active prompt overlay. */
  promptDraft: PromptDraft;

  /** Setter function for prompt overlay draft state. */
  setPromptDraft: React.Dispatch<React.SetStateAction<PromptDraft>>;

  /** Map of agent/advisor status indicators. */
  agentStatuses: Map<number | "advisor", AgentStatusState>;

  /** Setter function for agent status map. */
  setAgentStatuses: React.Dispatch<
    React.SetStateAction<Map<number | "advisor", AgentStatusState>>
  >;

  /** Per-agent task board snapshots. */
  agentBoards: AgentBoardState[];

  /** Setter function for agent boards. */
  setAgentBoards: React.Dispatch<React.SetStateAction<AgentBoardState[]>>;

  /** Counter for Ctrl+C presses during busy state (requires 2 to exit). */
  sigintBusy: number;

  /** Setter function for sigint busy counter. */
  setSigintBusy: React.Dispatch<React.SetStateAction<number>>;

  /** Function to handle input submission (command execution). */
  handleSubmit: (line: string) => Promise<void>;

  /** Setter function for handleSubmit. */
  setHandleSubmit: React.Dispatch<
    React.SetStateAction<(line: string) => Promise<void>>
  >;

  /** Whether user input is currently disabled (during prompts or approvals). */
  inputDisabled: boolean;

  /** The RSocket connection for communication with the server. */
  connection: AppProps["connection"];

  /** The command handler for processing CLI commands. */
  commandHandler: AppProps["commandHandler"];

  /** The file proxy for file system operations. */
  fileProxy: AppProps["fileProxy"];

  /** Callback to save history before exit. */
  onSaveHistory: AppProps["onSaveHistory"];

  /** Function to register the application exit handler. */
  registerExit: AppProps["registerExit"];

  /** Mutable ref to access input history from external code. */
  onInputHistoryRef: AppProps["onInputHistoryRef"];
};

/**
 * <Summary>
 * What it does:
 *   React context for application state management.
 *
 * Used by:
 *   - AppProvider — provides this context to child components.
 *   - useAppContext — consumes this context to access state.
 *
 * Produced by:
 *   - createContext — creates this React context.
 * </Summary>
 */
const AppContext = createContext<AppContextValue | null>(null);

/**
 * <Summary>
 * What it does:
 *   Hook to access the application context.
 *
 * How it does it (step by step):
 *   1. Get the context value using useContext.
 *   2. Check if context is null (used outside provider).
 *   3. Throw error if context is null (must be used within AppProvider).
 *   4. Return the context value.
 *
 * Returns:
 * @returns The application context value.
 * </Summary>
 */
export const useAppContext = (): AppContextValue => {
  const contextValue = useContext(AppContext);
  if (!contextValue) {
    throw new Error("useAppContext must be used within AppProvider");
  }
  return contextValue;
};

/**
 * <Summary>
 * What it does:
 *   Props type for the AppProvider component.
 *
 * Used by:
 *   - AppProvider — receives these props for initialization.
 *
 * Produced by:
 *   - Application entry point — passes these props to AppProvider.
 * </Summary>
 */
type AppProviderProps = AppProps & {
  children: React.ReactNode;
};

/**
 * <Summary>
 * What it does:
 *   Provider component for application context — manages all application state and provides it to child components.
 *
 * How it does it (step by step):
 *   1. Extract props including connection, handlers, and initial state.
 *   2. Initialize state for input history and keep it in sync with the ref.
 *   3. Initialize history state from initial history lines.
 *   4. Initialize streaming text state.
 *   5. Initialize spinner state.
 *   6. Initialize busy state.
 *   7. Initialize input state.
 *   8. Initialize prompt state from current working directory.
 *   9. Initialize approval and prompt request states.
 *   10. Initialize history navigation state.
 *   11. Initialize autocomplete navigation state.
 *   12. Initialize banner entries state.
 *   13. Create memoized context value with all state and setters.
 *   14. Render AppContext.Provider with the value and children.
 *
 * Parameters:
 * @param props - Provider props including app props and children.
 *
 * Returns:
 * @returns The AppContext.Provider component with context value and children.
 * </Summary>
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
  // ===== STEP 1: Initialize input history state =====
  // Step 1a: Initialize input history state from initial input history
  const [inputHistory, setInputHistory] = useState(initialInputHistory);

  // Step 1b: Keep the ref in sync with the state for external access
  useEffect(() => {
    onInputHistoryRef.current = inputHistory;
  }, [inputHistory]);

  // ===== STEP 2: Initialize history state =====
  // Step 2a: Initialize history state from initial history lines
  // Step 2b: Transform each line into a history item with kind "text" and variant "system"
  const [history, setHistory] = useState<HistoryItem[]>(() =>
    initialHistoryLines.map(
      (historyLine): HistoryItem => ({
        kind: "text",
        text: historyLine,
        variant: "system",
      }),
    ),
  );

  // ===== STEP 3: Initialize streaming text state =====
  // Step 3a: Initialize streaming text state to null (no streaming initially)
  const [streamingText, setStreamingText] = useState<string | null>(null);

  // ===== STEP 4: Initialize spinner state =====
  // Step 4a: Initialize spinner state to null (no spinner initially)
  const [spinner, setSpinner] = useState<SpinnerState | null>(null);

  // ===== STEP 5: Initialize banner entries state =====
  // Step 5a: Initialize banner entries from configuration
  const [bannerEntries, setBannerEntries] = useState<StaticEntry[]>(() =>
    buildBannerEntries(loadConfig()),
  );

  // ===== STEP 6: Initialize input state =====
  // Step 6a: Initialize input state to empty string
  const [input, setInput] = useState("");

  // ===== STEP 7: Initialize prompt state =====
  // Step 7a: Initialize prompt state from current working directory
  // Step 7b: Use fileProxy to get current directory and build prompt label
  const [prompt, setPrompt] = useState(() => {
    try {
      return buildPromptLabel(fileProxy.getCwd());
    } catch {
      return "$ ";
    }
  });

  // ===== STEP 8: Initialize approval state =====
  // Step 8a: Initialize approval state from pending approval (if any)
  const [approval, setApproval] = useState(() => {
    try {
      return getPendingApproval();
    } catch {
      return null;
    }
  });

  // ===== STEP 9: Initialize prompt request state =====
  // Step 9a: Initialize prompt request state from pending prompt (if any)
  const [promptReq, setPromptReq] = useState(() => {
    try {
      return getPendingPrompt();
    } catch {
      return null;
    }
  });

  const [approvalSelected, setApprovalSelected] = useState(0);
  const [promptDraft, setPromptDraft] = useState<PromptDraft>(emptyPromptDraft);

  const [agentStatuses, setAgentStatuses] = useState(
    () => new Map<number | "advisor", AgentStatusState>(),
  );
  const [agentBoards, setAgentBoards] = useState<AgentBoardState[]>([]);

  // ===== STEP 10: Initialize history navigation state =====
  // Step 10a: Initialize history index to -1 (not navigating history initially)
  const [histIdx, setHistIdx] = useState(-1);

  // ===== STEP 11: Initialize busy state =====
  // Step 11a: Initialize busy state to false (not busy initially)
  const [busy, setBusy] = useState(false);

  // ===== STEP 12: Initialize Ctrl+C counter =====
  // Step 12a: Initialize sigint counter to 0 (no Ctrl+C presses yet)
  const [sigintBusy, setSigintBusy] = useState(0);

  // ===== STEP 13: Initialize autocomplete navigation state =====
  // Step 13a: Initialize active index to 0 (first suggestion selected)
  const [activeIndex, setActiveIndex] = useState(0);

  // Step 13b: Initialize scroll offset to 0 (no scrolling initially)
  const [scrollOffset, setScrollOffset] = useState(0);

  // ===== STEP 14: Initialize handleSubmit function =====
  // Step 14a: Initialize handleSubmit to a no-op function (will be set by App.tsx)
  const [handleSubmit, setHandleSubmit] = useState<
    (line: string) => Promise<void>
  >(async () => {});

  const inputDisabled = useMemo(
    () => busy || approval !== null || promptReq !== null,
    [busy, approval, promptReq],
  );

  useEffect(() => {
    if (approval !== null) {
      setApprovalSelected(0);
    }
  }, [approval, setApprovalSelected]);

  useEffect(() => {
    if (promptReq !== null) {
      setPromptDraft(emptyPromptDraft());
    }
  }, [promptReq, setPromptDraft]);

  // ===== STEP 14: Create memoized context value =====
  // Step 14a: Create context value with all state and setters, memoized to prevent unnecessary re-renders
  const contextValue: AppContextValue = useMemo(
    () => ({
      history,
      setHistory,
      streamingText,
      setStreamingText,
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
      approval,
      setApproval,
      promptReq,
      setPromptReq,
      approvalSelected,
      setApprovalSelected,
      promptDraft,
      setPromptDraft,
      agentStatuses,
      setAgentStatuses,
      agentBoards,
      setAgentBoards,
      sigintBusy,
      setSigintBusy,
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
      spinner,
      bannerEntries,
      input,
      inputHistory,
      histIdx,
      prompt,
      activeIndex,
      scrollOffset,
      busy,
      approval,
      promptReq,
      approvalSelected,
      promptDraft,
      agentStatuses,
      agentBoards,
      sigintBusy,
      handleSubmit,
      inputDisabled,
      connection,
      commandHandler,
      fileProxy,
      onSaveHistory,
      registerExit,
      onInputHistoryRef,
    ],
  );

  // ===== STEP 15: Render provider with context value =====
  // Step 15a: Render the AppContext.Provider with the context value and children
  return (
    <AppContext.Provider value={contextValue}>{children}</AppContext.Provider>
  );
};
