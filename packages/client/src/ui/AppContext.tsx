/**
 * <Summary>
 * What it does:
 *   Central React context for Ink application state — manages history, input, session, and bridge hooks.
 *
 * How it fits in the system:
 *   Provides the global state management for the entire Ink-based CLI interface. This context
 *   manages all application state including command history, streaming text, spinner status,
 *   input handling, approval requests, prompt overlays, and command autocomplete. It also
 *   bridges between the React UI and the underlying CLI command system through uiBridge hooks.
 *
 * Dependencies:
 *   - React — provides the context API for state management.
 *   - Ink — provides useApp and useInput hooks for terminal interaction.
 *   - loadConfig — provides configuration for initialization.
 *   - buildPromptLabel — creates the prompt label from current directory.
 *   - uiBridge — provides hooks for communication with the CLI layer.
 *   - taskStream — provides streaming task execution.
 *   - commandCatalog — provides command autocomplete functionality.
 *
 * Dependants:
 *   - App — uses AppProvider to wrap the application.
 *   - AppContent — uses useAppContext to access application state.
 *   - All child components — use useAppContext to access state and functions.
 * </Summary>
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApp, useInput } from "ink";

import { loadConfig, type Config } from "../config.js";
import { buildPromptLabel } from "../pathDisplay.js";
import { buildBannerLines } from "../renderer/banner.js";
import type {
  AppProps,
  ApprovalRequest,
  HistoryItem,
  PromptRequest,
  SpinnerState,
  StaticEntry,
} from "./types.js";
import {
  enterAlternateScreen,
  exitAlternateScreen,
  getPendingApproval,
  getPendingPrompt,
  registerBridgeHooks,
  registerStreamingHandler,
  setCwdLabel,
  setInkActive,
} from "./uiBridge.js";
import { runTaskStream } from "./taskStream.js";
import {
  commandRequiresArgs,
  getCommandSuggestions,
  type CommandEntry,
} from "./commandCatalog.js";
import { sanitizeHistoryLine } from "./historySanitize.js";

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

  /** Current streaming text being displayed (null if not streaming). */
  streamingText: string | null;

  /** Current spinner state for bottom-line status indicator (null if no spinner). */
  spinner: SpinnerState | null;

  /** Array of static entries (banner + history) for fixed-position display. */
  staticEntries: StaticEntry[];

  /** Current user input text. */
  input: string;

  /** Array of previous input commands for history navigation. */
  inputHistory: string[];

  /** Current index in input history for history navigation (-1 if not navigating). */
  histIdx: number;

  /** The prompt label displayed before the input field. */
  prompt: string;

  /** Currently selected index in command autocomplete suggestions. */
  activeIndex: number;

  /** Scroll offset for command autocomplete suggestions (for pagination). */
  scrollOffset: number;

  /** Whether the application is currently busy processing a command. */
  busy: boolean;

  /** Current approval request (null if no approval pending). */
  approval: ApprovalRequest | null;

  /** Current prompt request (null if no prompt pending). */
  promptReq: PromptRequest | null;

  /** Counter for Ctrl+C presses during busy state (requires 2 to exit). */
  sigintBusy: number;

  /** Whether user input is currently disabled (during prompts or approvals). */
  inputDisabled: boolean;

  /** All matching command suggestions for autocomplete. */
  fullSuggestions: CommandEntry[];

  /** Whether autocomplete suggestions should be shown. */
  showAutocomplete: boolean;

  /** Currently visible suggestions in the autocomplete dropdown (paginated). */
  visibleSuggestions: CommandEntry[];

  /** Function to set the current input text. */
  setInput: (value: string) => void;

  /** Function to handle input submission (command execution). */
  handleSubmit: (line: string) => Promise<void>;

  /** Function to append a new item to the history. */
  appendHistory: (item: HistoryItem) => void;

  /** The RSocket connection for communication with the server. */
  connection: AppProps["connection"];

  /** The command handler for processing CLI commands. */
  commandHandler: AppProps["commandHandler"];

  /** The file proxy for file system operations. */
  fileProxy: AppProps["fileProxy"];

  /** Callback to save history before exit. */
  onSaveHistory: AppProps["onSaveHistory"];

  /** Function to exit the application. */
  exit: () => void;
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
 * @returns {AppContextValue} — The application context value.
 *
 * Dependencies:
 *   - AppContext — provides the React context.
 *   - useContext — provides access to context value.
 *
 * Dependants:
 *   - All child components — use this to access application state.
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
 *   2. Get the exit function from Ink's useApp hook.
 *   3. Initialize state for input history and keep it in sync with the ref.
 *   4. Initialize history state from initial history lines.
 *   5. Initialize streaming text state.
 *   6. Initialize spinner state.
 *   7. Initialize busy state.
 *   8. Initialize input state.
 *   9. Initialize prompt state from current working directory.
 *   10. Initialize approval and prompt request states.
 *   11. Initialize history navigation state.
 *   12. Initialize autocomplete navigation state.
 *   13. Calculate command suggestions and visibility.
 *   14. Create appendHistory callback.
 *   15. Set up autocomplete reset effect on input changes.
 *   16. Set up exit registration effect.
 *   17. Set up bridge hooks and alternate screen effect.
 *   18. Create submit callback for command execution.
 *   19. Create handleSubmit callback with autocomplete support.
 *   20. Set up keyboard input handling.
 *   21. Calculate static entries from banner and history.
 *   22. Create memoized context value.
 *   23. Render AppContext.Provider with the value and children.
 *
 * Parameters:
 * @param {AppProviderProps} props — Provider props including app props, banner entries, and children.
 *
 * Returns:
 * @returns {JSX.Element} — The AppContext.Provider component with context value and children.
 *
 * Dependencies:
 *   - React — provides hooks for state management and effects.
 *   - Ink — provides useApp and useInput hooks.
 *   - loadConfig — provides configuration for initialization.
 *   - buildPromptLabel — creates prompt from current directory.
 *   - uiBridge — provides bridge hooks for CLI communication.
 *   - taskStream — provides task execution.
 *   - commandCatalog — provides command autocomplete.
 *
 * Dependants:
 *   - App — wraps application content with this provider.
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
  const { exit } = useApp();
  const submitLockRef = useRef(false);

  const [inputHistory, setInputHistory] = useState(initialInputHistory);
  onInputHistoryRef.current = inputHistory;

  // ===== STEP 3: Initialize history state =====
  // Step 3a: Initialize history state from initial history lines
  // Step 3b: Transform each line into a history item with kind "text" and variant "system"
  const [history, setHistory] = useState<HistoryItem[]>(() =>
    initialHistoryLines.map(
      (historyLine): HistoryItem => ({
        kind: "text",
        text: historyLine,
        variant: "system",
      }),
    ),
  );

  // ===== STEP 4: Initialize streaming text state =====
  // Step 4a: Initialize streaming text state to null (no streaming initially)
  const [streamingText, setStreamingText] = useState<string | null>(null);

  // ===== STEP 5: Initialize spinner state =====
  // Step 5a: Initialize spinner state to null (no spinner initially)
  const [spinner, setSpinnerState] = useState<SpinnerState | null>(null);

  // ===== STEP 6: Initialize busy state =====
  // Step 6a: Initialize busy state to false (not busy initially)
  const [busy, setBusy] = useState(false);

  // ===== STEP 7: Initialize input state =====
  // Step 7a: Initialize input state to empty string
  const [input, setInput] = useState("");

  // ===== STEP 8: Initialize prompt state =====
  // Step 8a: Initialize prompt state from current working directory
  // Step 8b: Use fileProxy to get current directory and build prompt label
  const [prompt, setPrompt] = useState(() =>
    buildPromptLabel(fileProxy.getCwd()),
  );

  // ===== STEP 9: Initialize approval state =====
  // Step 9a: Initialize approval state from pending approval (if any)
  const [approval, setApproval] = useState(() => getPendingApproval());

  // ===== STEP 10: Initialize prompt request state =====
  // Step 10a: Initialize prompt request state from pending prompt (if any)
  const [promptReq, setPromptReq] = useState(() => getPendingPrompt());

  // ===== STEP 11: Initialize history navigation state =====
  // Step 11a: Initialize history index to -1 (not navigating history initially)
  const [histIdx, setHistIdx] = useState(-1);

  // ===== STEP 12: Initialize Ctrl+C counter =====
  // Step 12a: Initialize sigint counter to 0 (no Ctrl+C presses yet)
  const [sigintBusy, setSigintBusy] = useState(0);

  // ===== STEP 13: Initialize autocomplete navigation state =====
  // Step 13a: Initialize active index to 0 (first suggestion selected)
  const [activeIndex, setActiveIndex] = useState(0);

  // Step 13b: Initialize scroll offset to 0 (no scrolling initially)
  const [scrollOffset, setScrollOffset] = useState(0);

  const [bannerEntries, setBannerEntries] = useState<StaticEntry[]>(() =>
    buildBannerEntries(loadConfig()),
  );

  const fullSuggestions = getCommandSuggestions(input);

  // Step 14b: Determine if autocomplete should be shown (has suggestions)
  const showAutocomplete = fullSuggestions.length > 0;

  // Step 14c: Calculate visible suggestions (paginated to 5 items)
  const visibleSuggestions = fullSuggestions.slice(
    scrollOffset,
    scrollOffset + 5,
  );

  // Step 14d: Determine if input should be disabled (during busy, approval, or prompt)
  const inputDisabled = busy || approval !== null || promptReq !== null;

  // ===== STEP 15: Create appendHistory callback =====
  // Step 15a: Create callback to append a new item to history
  // Step 15b: Use functional state update to append item to existing history
  const appendHistory = useCallback((item: HistoryItem) => {
    setHistory((previousHistory) => [...previousHistory, item]);
  }, []);

  // ===== STEP 16: Reset autocomplete on input change =====
  // Step 16a: Reset active index to 0 when input changes
  // Step 16b: Reset scroll offset to 0 when input changes
  // Step 16c: This ensures autocomplete starts fresh with each input change
  useEffect(() => {
    setActiveIndex(0);
    setScrollOffset(0);
  }, [input]);

  // ===== STEP 17: Register exit handler =====
  // Step 17a: Register the exit function with the exit registry
  // Step 17b: This allows external code to trigger application exit
  useEffect(() => {
    registerExit(exit);
  }, [exit, registerExit]);

  // ===== STEP 18: Set up bridge hooks and alternate screen =====
  // Step 18a: Set up bridge hooks on mount and cleanup on unmount
  useEffect(() => {
    // ===== STEP 18a-1: Initialize Ink =====
    // Step 18a-1a: Mark Ink as active for the UI bridge
    setInkActive(true);

    // ===== STEP 18a-2: Load configuration =====
    // Step 18a-2a: Load configuration to check for alternate buffer preference
    const config = loadConfig();

    // ===== STEP 18a-3: Enter alternate screen if configured =====
    // Step 18a-3a: If alternate buffer is enabled, enter alternate screen mode
    // Step 18a-3b: This provides a full-screen interface that doesn't scroll
    if (config.ui?.useAlternateBuffer === true) {
      enterAlternateScreen();
    }

    // ===== STEP 18a-4: Set initial CWD label =====
    // Step 18a-4a: Set the current working directory label in the UI bridge
    setCwdLabel(fileProxy.getCwd());

    // ===== STEP 18a-5: Register bridge hooks =====
    // Step 18a-5a: Register callbacks for UI bridge to communicate with React
    registerBridgeHooks({
      onHistoryAppend: (historyItem) =>
        setHistory((previousHistory) => [...previousHistory, historyItem]),
      onStreamingSet: (streamingText) => setStreamingText(streamingText),
      onSpinner: (spinnerState) => setSpinnerState(spinnerState),
      onBusy: (isBusy) => setBusy(isBusy),
      onCwd: (currentWorkingDirectory) =>
        setPrompt(buildPromptLabel(currentWorkingDirectory)),
      onApprovalChange: (approvalRequest) => setApproval(approvalRequest),
      onPromptChange: (promptRequest) => setPromptReq(promptRequest),
      onBannerRefresh: (configuration) =>
        setBannerEntries(buildBannerEntries(configuration)),
    });

    // ===== STEP 18a-6: Register streaming handler =====
    // Step 18a-6a: Register handler for streaming text tokens
    registerStreamingHandler((token) => {
      // Step 18a-6b: Append new token to existing streaming text
      setStreamingText(
        (previousStreamingText) => (previousStreamingText ?? "") + token,
      );
    });

    // ===== STEP 18a-7: Cleanup on unmount =====
    // Step 18a-7a: Return cleanup function to run on component unmount
    return () => {
      // Step 18a-7b: Mark Ink as inactive for the UI bridge
      setInkActive(false);

      // Step 18a-7c: Clear bridge hooks to prevent memory leaks
      registerBridgeHooks({});

      // Step 18a-7d: Clear streaming handler
      registerStreamingHandler(null);

      // Step 18a-7e: Exit alternate screen if it was entered
      if (config.ui?.useAlternateBuffer === true) {
        exitAlternateScreen();
      }
    };
  }, [fileProxy]);

  // ===== STEP 19: Create submit callback for command execution =====
  // Step 19a: Create callback to submit a line for execution
  const submit = useCallback(
    async (inputLine: string) => {
      // ===== STEP 19a-1: Trim and validate input =====
      // Step 19a-1a: Trim whitespace from input line
      const trimmedLine = inputLine.trim();

      // Step 19a-1b: Return early if input is empty or app is busy/approving/prompting
      if (
        submitLockRef.current ||
        !trimmedLine.length ||
        busy ||
        approval ||
        promptReq
      ) {
        return;
      }

      submitLockRef.current = true;

      const historyLine = sanitizeHistoryLine(trimmedLine);
      const nextHistory = [...inputHistory, historyLine].slice(-1000);
      setInputHistory(nextHistory);
      onInputHistoryRef.current = nextHistory;

      // Step 19a-2d: Reset history navigation index
      setHistIdx(-1);

      // Step 19a-2e: Clear the input field
      setInput("");

      // ===== STEP 19a-3: Set busy state =====
      // Step 19a-3a: Mark application as busy to prevent duplicate submissions
      setBusy(true);

      // ===== STEP 19a-4: Execute command =====
      // Step 19a-4a: Try to execute the command
      try {
        // Step 19a-4b: Let command handler process the line
        const wasCommand = await commandHandler.handle(trimmedLine);

        // Step 19a-4c: If not a CLI command, execute as agent task
        if (!wasCommand) {
          // Step 19a-4d: Load task configuration to check for model settings
          const taskConfiguration = loadConfig();

          // Step 19a-4e: Check if advisor and agent models are configured
          if (
            !(taskConfiguration.advisorModel ?? "").trim() ||
            !(taskConfiguration.agentModel ?? "").trim()
          ) {
            // Step 19a-4f: Add error message if models not configured
            setHistory((previousHistory) => [
              ...previousHistory,
              {
                kind: "text",
                text: "Advisor and agent models must be set. Use /set advisor and /set agent.",
                variant: "error",
              },
            ]);
          } else {
            // Step 19a-4g: Execute the task using the connection
            await runTaskStream(connection, trimmedLine);
          }
        }
      } catch (error) {
        // ===== STEP 19a-5: Handle errors =====
        // Step 19a-5a: Add error message to history on failure
        setHistory((previousHistory) => [
          ...previousHistory,
          {
            kind: "text",
            text: error instanceof Error ? error.message : String(error),
            variant: "error",
          },
        ]);
      } finally {
        submitLockRef.current = false;
        setBusy(false);
        setSigintBusy(0);
      }
    },
    [approval, promptReq, busy, commandHandler, connection, inputHistory],
  );

  // ===== STEP 20: Create handleSubmit with autocomplete support =====
  // Step 20a: Create callback to handle input submission with autocomplete support
  const handleSubmit = useCallback(
    async (inputLine: string) => {
      // ===== STEP 20a-1: Handle autocomplete selection =====
      // Step 20a-1a: Check if autocomplete is shown and a suggestion is selected
      if (
        showAutocomplete &&
        activeIndex >= 0 &&
        activeIndex < fullSuggestions.length
      ) {
        // Step 20a-1b: Get the selected suggestion
        const selectedSuggestion = fullSuggestions[activeIndex]!;

        // Step 20a-1c: Check if the command requires a space after it
        const needsSpaceAfterCommand = commandRequiresArgs(
          selectedSuggestion.command,
        );

        // Step 20a-1d: Build the autocompleted value with optional trailing space
        const autocompletedValue =
          selectedSuggestion.command + (needsSpaceAfterCommand ? " " : "");

        // Step 20a-1e: Check if the input matches the autocompleted value
        if (
          inputLine === autocompletedValue ||
          (!needsSpaceAfterCommand && inputLine === selectedSuggestion.command)
        ) {
          // Step 20a-1f: If match, submit the command
          await submit(inputLine);
        } else {
          // Step 20a-1g: Otherwise, set the input to the autocompleted value
          setInput(autocompletedValue);
        }
        // Step 20a-1h: Return early as autocomplete was handled
        return;
      }

      // ===== STEP 20a-2: Submit regular input =====
      // Step 20a-2a: If no autocomplete, submit the input directly
      await submit(inputLine);
    },
    [showAutocomplete, activeIndex, fullSuggestions, submit],
  );

  // ===== STEP 21: Set up keyboard input handling =====
  // Step 21a: Set up useInput hook to handle keyboard events
  useInput((inputChar, key) => {
    // ===== STEP 21a-1: Skip if modal is active =====
    // Step 21a-1a: Return early if approval or prompt is active (modals take precedence)
    if (approval || promptReq) return;

    // ===== STEP 21a-2: Handle Ctrl+C (exit) =====
    // Step 21a-2a: Check if Ctrl+C was pressed
    if (key.ctrl && inputChar === "c") {
      if (busy) {
        // Step 21a-2b: If busy, increment Ctrl+C counter and check for double press
        setSigintBusy((sigintCounter) => {
          // Step 21a-2c: If this is the second Ctrl+C, exit and save history
          if (sigintCounter + 1 >= 2) {
            onSaveHistory(inputHistory);
            exit();
          }
          // Step 21a-2d: Increment the counter
          return sigintCounter + 1;
        });
      } else {
        // Step 21a-2e: If not busy, exit immediately and save history
        onSaveHistory(inputHistory);
        exit();
      }
      // Step 21a-2f: Return early after handling Ctrl+C
      return;
    }

    // ===== STEP 21a-3: Handle Ctrl+L (force exit) =====
    // Step 21a-3a: Check if Ctrl+L was pressed (force exit)
    if (key.ctrl && inputChar === "l") {
      // Step 21a-3b: Save history and exit
      onSaveHistory(inputHistory);
      exit();
      // Step 21a-3c: Return early after handling Ctrl+L
      return;
    }

    // ===== STEP 21a-4: Handle Ctrl+O (expand directory) =====
    // Step 21a-4a: Check if Ctrl+O was pressed and not busy
    if (key.ctrl && inputChar === "o" && !busy) {
      // Step 21a-4b: Dynamically import listExpandState module
      void import("../listExpandState.js").then(({ peekUnexpanded }) => {
        // Step 21a-4c: Peek at unexpanded directories
        const expandResult = peekUnexpanded();
        // Step 21a-4d: If found, expand the directory
        if (expandResult.found && expandResult.entry) {
          void fileProxy
            .expandDirectory(
              expandResult.entry.absolutePath,
              expandResult.entry.indent,
            )
            .catch((expansionError) => {
              // Step 21a-4e: Add error message to history if expansion fails
              setHistory((previousHistory) => [
                ...previousHistory,
                {
                  kind: "text",
                  text:
                    expansionError instanceof Error
                      ? expansionError.message
                      : String(expansionError),
                  variant: "error",
                },
              ]);
            });
        }
      });
      // Step 21a-4f: Return early after handling Ctrl+O
      return;
    }

    // ===== STEP 21a-5: Skip input if busy =====
    // Step 21a-5a: Return early if busy (no input processing during busy state)
    if (busy) return;

    // ===== STEP 21a-6: Handle autocomplete navigation =====
    // Step 21a-6a: Check if autocomplete is shown
    if (showAutocomplete) {
      // ===== STEP 21a-6b: Handle up arrow =====
      // Step 21a-6b-1: Check if up arrow was pressed
      if (key.upArrow) {
        // Step 21a-6b-2: Move selection up (wrap to bottom if at top)
        setActiveIndex((previousIndex) => {
          // Step 21a-6b-3: Calculate new index (wrap to last if at first)
          const newIndex =
            previousIndex <= 0 ? fullSuggestions.length - 1 : previousIndex - 1;

          // Step 21a-6b-4: Adjust scroll offset if selection is out of view
          if (newIndex < scrollOffset) {
            setScrollOffset(newIndex);
          }

          // Step 21a-6b-5: Return the new index
          return newIndex;
        });
        // Step 21a-6b-6: Return early after handling up arrow
        return;
      }

      // ===== STEP 21a-6c: Handle down arrow =====
      // Step 21a-6c-1: Check if down arrow was pressed
      if (key.downArrow) {
        // Step 21a-6c-2: Move selection down (wrap to top if at bottom)
        setActiveIndex((previousIndex) => {
          // Step 21a-6c-3: Calculate new index (wrap to first if at last)
          const newIndex =
            previousIndex >= fullSuggestions.length - 1 ? 0 : previousIndex + 1;

          // Step 21a-6c-4: Adjust scroll offset if selection is out of view
          if (newIndex >= scrollOffset + 5) {
            setScrollOffset(newIndex - 4);
          }

          // Step 21a-6c-5: Return the new index
          return newIndex;
        });
        // Step 21a-6c-6: Return early after handling down arrow
        return;
      }

      // ===== STEP 21a-6d: Handle Tab key =====
      // Step 21a-6d-1: Check if Tab was pressed
      if (key.tab) {
        // Step 21a-6d-2: Get the currently selected suggestion
        const selectedSuggestion = fullSuggestions[activeIndex];
        if (selectedSuggestion) {
          // Step 21a-6d-3: Set input to autocompleted value with optional trailing space
          setInput(
            selectedSuggestion.command +
              (commandRequiresArgs(selectedSuggestion.command) ? " " : ""),
          );
        }
        // Step 21a-6d-4: Return early after handling Tab
        return;
      }
    } else {
      // ===== STEP 21a-7: Handle history navigation =====
      // Step 21a-7a: Check if up arrow was pressed and history exists
      if (key.upArrow && inputHistory.length > 0) {
        // Step 21a-7b: Move up in history (move to previous entry)
        const nextHistoryIndex =
          histIdx < 0 ? inputHistory.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(nextHistoryIndex);
        setInput(inputHistory[nextHistoryIndex] ?? "");
        // Step 21a-7c: Return early after handling up arrow
        return;
      }

      // ===== STEP 21a-8: Handle down arrow in history =====
      // Step 21a-8a: Check if down arrow was pressed while navigating history
      if (key.downArrow && histIdx >= 0) {
        // Step 21a-8b: Move down in history (move to next entry or clear)
        const nextHistoryIndex = histIdx + 1;
        if (nextHistoryIndex >= inputHistory.length) {
          // Step 21a-8c: If past the end, clear history navigation and input
          setHistIdx(-1);
          setInput("");
        } else {
          // Step 21a-8d: Otherwise, set input to the next history entry
          setHistIdx(nextHistoryIndex);
          setInput(inputHistory[nextHistoryIndex] ?? "");
        }
      }
    }
  });

  // ===== STEP 22: Calculate static entries =====
  // Step 22a: Create memoized static entries from banner and history
  // Step 22b: Combine banner entries and history entries into a single array
  // Step 22c: Transform history items into static entries with unique keys
  const staticEntries = useMemo(
    (): StaticEntry[] => [
      ...bannerEntries,
      ...history.map(
        (historyItem, historyIndex): StaticEntry => ({
          kind: "history",
          key: `hist-${historyIndex}`,
          item: historyItem,
        }),
      ),
    ],
    [history, bannerEntries],
  );

  // ===== STEP 23: Create memoized context value =====
  // Step 23a: Create memoized context value with all state and functions
  // Step 23b: This prevents unnecessary re-renders of child components
  const contextValue = useMemo(
    (): AppContextValue => ({
      // ===== STEP 23a-1: State values =====
      history,
      streamingText,
      spinner,
      staticEntries,
      input,
      inputHistory,
      histIdx,
      prompt,
      activeIndex,
      scrollOffset,
      busy,
      approval,
      promptReq,
      sigintBusy,
      inputDisabled,
      fullSuggestions,
      showAutocomplete,
      visibleSuggestions,

      // ===== STEP 23a-2: State setters and callbacks =====
      setInput,
      handleSubmit,
      appendHistory,

      // ===== STEP 23a-3: External dependencies =====
      connection,
      commandHandler,
      fileProxy,
      onSaveHistory,
      exit,
    }),
    [
      history,
      streamingText,
      spinner,
      staticEntries,
      input,
      inputHistory,
      histIdx,
      prompt,
      activeIndex,
      scrollOffset,
      busy,
      approval,
      promptReq,
      sigintBusy,
      inputDisabled,
      fullSuggestions,
      showAutocomplete,
      visibleSuggestions,
      handleSubmit,
      appendHistory,
      connection,
      commandHandler,
      fileProxy,
      onSaveHistory,
      exit,
    ],
  );

  // ===== STEP 24: Render context provider =====
  // Step 24a: Render the AppContext.Provider with the context value and children
  return (
    <AppContext.Provider value={contextValue}>{children}</AppContext.Provider>
  );
};
