/**
 * Main Ink application shell: context provider, layout, and input wiring.
 *
 * @remarks
 * {@link App} wraps {@link AppContent} with {@link AppProvider}. All server
 * → UI traffic flows through {@link useBridgeSetup}; keyboard and submit
 * logic live in dedicated hooks so this file stays focused on composition.
 */
import React, { useCallback, useEffect, useMemo } from "react";
import { useApp, useInput } from "ink";
import { Box, Static, Text } from "ink";

import { AppProvider, useAppContext } from "../state/DataContext.js";
import {
  HistoryView,
  LiveThinkView,
  renderHistoryItem,
} from "./components/HistoryView.js";
import { StatusSpinner } from "./components/Spinner.js";
import { ConnectionStatusLine } from "./components/ConnectionStatusLine.js";
import { InputBox } from "./components/InputBox.js";
import { ApprovalMenu } from "./components/ApprovalMenu.js";
import { PromptOverlay } from "./components/PromptOverlay.js";
import { SubagentTaskBoard } from "./components/SubagentTaskBoard.js";
import type { AppProps } from "./types.js";
import {
  commandRequiresArgs,
  getCommandDescription,
  getCommandLabel,
  getCommandSuggestions,
} from "./commandCatalog.js";
import { AUTOCOMPLETE_VISIBLE_COUNT } from "./constants.js";
import { useBridgeSetup } from "./hooks/useBridgeSetup.js";
import { useConnectionStatus } from "./hooks/useConnectionStatus.js";
import { useConnectionDisconnectCleanup } from "./hooks/useConnectionDisconnectCleanup.js";
import { useKeyboardInput } from "./hooks/useKeyboardInput.js";
import { useSubmitLine } from "./hooks/useSubmitLine.js";

/**
 * Root component mounted by {@link BootstrapApp} once the server is connected.
 *
 * @remarks
 * {@link App} is a thin wrapper that provides the React context ({@link AppProvider})
 * and renders the main application content ({@link AppContent}). All actual UI
 * logic lives in {@link AppContent} and its child components.
 *
 * @example
 * ```tsx
 * This is typically rendered by BootstrapApp after successful connection:
 * <App
 *   connection={connection}
 *   commandHandler={commandHandler}
 *   fileProxy={fileProxy}
 *   onSaveHistory={saveHistory}
 *   initialHistoryLines={sessionMessages}
 *   initialInputHistory={historyLines}
 *   registerExit={registerExit}
 *   onInputHistoryRef={historyRef}
 * />
 * ```
 */
export const App: React.FC<AppProps> = (appProps) => (
  <AppProvider {...appProps}>
    <AppContent />
  </AppProvider>
);

/**
 * Composes the terminal layout and connects hooks to shared context state.
 *
 * @remarks
 * {@link AppContent} is where the UI is assembled: it wires up keyboard input,
 * command submission, autocomplete, and the visual hierarchy (static history,
 * streaming output, input box, status line). This component is intentionally
 * focused on composition — business logic lives in dedicated hooks:
 *
 * - {@link useBridgeSetup} — handles server → UI message routing
 * - {@link useConnectionStatus} — tracks RSocket connection state
 * - {@link useConnectionDisconnectCleanup} — resets UI state on disconnect
 * - {@link useKeyboardInput} — maps keyboard events to actions
 * - {@link useSubmitLine} — handles command/line submission
 *
 * The layout uses Ink's {@link Static} component for committed history (which
 * stays fixed at the top) and regular components for the live input area
 * (which stays at the bottom). This creates a terminal-like experience where
 * new output appears above the input line without scrolling the entire screen.
 */
const AppContent: React.FC = () => {
  const {
    history,
    bannerEntries,
    spinner,
    input,
    setInput,
    activeIndex,
    scrollOffset,
    busy,
    approval,
    promptReq,
    subagentBoards,
    sigintBusy,
    setActiveIndex,
    setScrollOffset,
    setHandleSubmit,
    setHistory,
    setStreamingText,
    setLiveThinks,
    setSpinner,
    setBusy,
    setTaskActive,
    setPrompt,
    setApproval,
    setPromptReq,
    setBannerEntries,
    setSubagentStatuses,
    setSubagentBoards,
    setSigintBusy,
    inputHistory,
    setInputHistory,
    histIdx,
    setHistIdx,
    onSaveHistory,
    registerExit,
    fileProxy,
    connection,
    commandHandler,
    onInputHistoryRef,
  } = useAppContext();

  // Track the RSocket connection state for display in the status line.
  // This hook subscribes to connection status changes and returns the current state.
  const connectionStatus = useConnectionStatus(connection);

  // Reset UI state when the connection drops. This ensures that if the server
  // disconnects mid-task, we clear spinners, streaming text, and agent boards
  // so the user sees a clean state when they reconnect.
  useConnectionDisconnectCleanup(connection, {
    setTaskActive,
    setBusy,
    setSpinner,
    setStreamingText,
    setLiveThinks,
    setSubagentStatuses,
    setSubagentBoards,
  });

  const { exit } = useApp();

  // New typing resets autocomplete selection and scroll window.
  // This ensures that when the user types a new character, we start from
  // the top of the suggestion list rather than remembering a previous selection.
  useEffect(() => {
    setActiveIndex(0);
    setScrollOffset(0);
  }, [input, setActiveIndex, setScrollOffset]);

  // Register the exit handler with BootstrapApp so Ctrl+C and /exit share
  // the same teardown path. The cleanup function unregisters to prevent
  // calling a stale exit handler if this component remounts.
  useEffect(() => {
    registerExit(exit);
    return () => registerExit(() => {});
  }, [exit, registerExit]);

  // Wire up the server → UI message bridge. This hook subscribes to RSocket
  // events and updates the UI state accordingly. It's the single source of
  // truth for all server-initiated state changes.
  useBridgeSetup({
    setHistory,
    setStreamingText,
    setLiveThinks,
    setSpinner,
    setBusy,
    setTaskActive,
    setPrompt,
    setApproval,
    setPromptReq,
    setBannerEntries,
    setSubagentStatuses,
    setSubagentBoards,
  });

  const { submit } = useSubmitLine({
    busy,
    approval,
    promptReq,
    inputHistory,
    setInputHistory,
    onInputHistoryRef,
    setHistIdx,
    setInput,
    setBusy,
    setHistory,
    setSigintBusy,
    connection,
    commandHandler,
  });

  /**
   * Two-phase Enter handler when autocomplete is open.
   *
   * @remarks
   * When the user presses Enter and autocomplete suggestions are visible:
   * - First press: fills the input with the highlighted command (adds a trailing
   *   space if the command requires arguments)
   * - Second press (with input matching the filled value): submits the command
   *
   * This UX pattern lets users quickly select commands without accidentally
   * submitting incomplete commands. For example, typing `/f` → Enter fills
   * `/file ` (with space), then typing `read path` → Enter submits the full
   * command.
   *
   * @param inputLine - The current input text to handle.
   */
  const handleSubmitCallback = useCallback(
    async (inputLine: string) => {
      const commandSuggestions = getCommandSuggestions(inputLine);

      if (
        commandSuggestions.length > 0 &&
        activeIndex >= 0 &&
        activeIndex < commandSuggestions.length
      ) {
        const selectedSuggestion = commandSuggestions[activeIndex]!;
        const needsSpaceAfterCommand = commandRequiresArgs(
          selectedSuggestion.command,
        );
        const autocompletedValue =
          selectedSuggestion.command + (needsSpaceAfterCommand ? " " : "");

        // If the input already matches the autocompleted value, this is the
        // second Enter press — submit the command. Otherwise, fill the input
        // with the autocompleted value and wait for the user to continue typing.
        if (
          inputLine === autocompletedValue ||
          (!needsSpaceAfterCommand && inputLine === selectedSuggestion.command)
        ) {
          await submit(inputLine);
        } else {
          setInput(autocompletedValue);
        }
        return;
      }

      await submit(inputLine);
    },
    [activeIndex, submit, setInput],
  );

  // Register the submit callback with the context so InputBox can invoke it.
  // We use useCallback to memoize the handler and only update it when dependencies
  // change, preventing unnecessary re-renders of InputBox.
  useEffect(() => {
    setHandleSubmit(() => handleSubmitCallback);
  }, [handleSubmitCallback, setHandleSubmit]);

  // Build the keyboard input handler that maps raw key events to UI actions.
  // This hook handles arrow keys (history navigation, autocomplete selection),
  // Ctrl+C (interrupt), and other special keys. The handler is registered with
  // Ink's useInput hook so it receives all keyboard events.
  const keyboardInputHandler = useKeyboardInput(
    {
      approval,
      promptReq,
      busy,
      inputHistory,
      histIdx,
      input,
      activeIndex,
      scrollOffset,
      setSigintBusy,
      onSaveHistory,
      fileProxy,
      setHistory,
      setActiveIndex,
      setScrollOffset,
      setInput,
      setHistIdx,
    },
    { exit },
  );

  useInput(keyboardInputHandler);

  // Compute autocomplete suggestions for the current input. We only show
  // suggestions when there are matches, and we paginate the display to avoid
  // overwhelming the terminal with a long list.
  const commandSuggestions = getCommandSuggestions(input);
  const shouldShowAutocomplete = commandSuggestions.length > 0;
  const visibleSuggestions = commandSuggestions.slice(
    scrollOffset,
    scrollOffset + AUTOCOMPLETE_VISIBLE_COUNT,
  );

  // Static region: banner + committed history (does not scroll with live stream).
  // Ink's Static component renders items once and keeps them fixed at the top
  // of the screen. This is critical for a terminal-like experience where new
  // output appears above the input line without pushing old content off-screen.
  // We memoize this array to avoid re-rendering the entire history on every keystroke.
  const staticEntries = useMemo(
    () => [
      ...bannerEntries,
      ...history.map((historyEntry, itemIndex) => ({
        kind: "history" as const,
        key: `hist-${itemIndex}`,
        item: historyEntry,
      })),
    ],
    [history, bannerEntries],
  );

  return (
    <Box flexDirection="column" height="100%">
      {/* Static region: fixed at top, contains banner and committed history */}
      <Static items={staticEntries}>
        {(staticEntry) =>
          staticEntry.kind === "banner" ? (
            <Text key={staticEntry.key}>{staticEntry.line}</Text>
          ) : (
            <Box key={staticEntry.key} flexDirection="column">
              {renderHistoryItem(staticEntry.item, staticEntry.key)}
            </Box>
          )
        }
      </Static>

      {/* Live "thinking" streams: reasoning still in progress, one block per
          agent/subagent. Rendered above answer text — committed items in
          Static can't grow, so in-progress blocks have to live here. */}
      <LiveThinkView />

      {/* Streaming history: appears below static region, updates in real-time */}
      <HistoryView />

      {/* Agent task boards: one per active agent, shows parallel work */}
      {subagentBoards.map((agentBoard) => (
        <SubagentTaskBoard key={agentBoard.id} board={agentBoard} />
      ))}

      {/* Status spinner: shows loading state for long-running operations */}
      <StatusSpinner state={spinner} />

      {/* Approval menu: appears when server requests user confirmation */}
      {approval && <ApprovalMenu />}

      {/* Prompt overlay: appears when server requests user input */}
      {promptReq && <PromptOverlay />}

      {/* Input area: only shown when not in approval/prompt mode */}
      {!approval && !promptReq && (
        <Box flexDirection="column">
          {shouldShowAutocomplete && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {visibleSuggestions.map((suggestion, visibleIndex) => {
                const absoluteSuggestionIndex = scrollOffset + visibleIndex;
                const isSuggestionSelected =
                  absoluteSuggestionIndex === activeIndex;
                const commandLabel = getCommandLabel(suggestion.command);
                const commandDescription = getCommandDescription(
                  suggestion.command,
                );

                return (
                  <Box key={suggestion.command}>
                    <Text dimColor={!isSuggestionSelected}>
                      {isSuggestionSelected ? "▸ " : "  "}
                    </Text>
                    <Text color="green" bold={isSuggestionSelected}>
                      {commandLabel}
                    </Text>
                    <Text dimColor>
                      {"  "}
                      {commandDescription}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}

          {/* Input box: the main text input field */}
          <InputBox />

          {/* Connection status line: shows Connected/Connecting/Disconnected */}
          <ConnectionStatusLine status={connectionStatus} />
        </Box>
      )}

      {/* Double-Ctrl+C warning: shown when user presses Ctrl+C during a busy task */}
      {busy && sigintBusy === 1 && (
        <Text dimColor>Press Ctrl+C again to exit</Text>
      )}
    </Box>
  );
};
