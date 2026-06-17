/**
 * <Summary>
 * What it does:
 *   Root application component for the Ink-based CLI UI that provides
 *   the context provider and main content rendering.
 *
 * How it fits in the system:
 *   This is the top-level React component that wraps the entire application
 *   with the AppProvider context and renders the main AppContent component.
 *   It serves as the entry point for the Ink-based terminal user interface.
 *
 * Dependencies:
 *   - AppProvider — provides global application state context.
 *   - AppContent — main application content component.
 *
 * Dependants:
 *   - BootstrapApp — renders this component after initialization.
 * </Summary>
 */

import React, { useCallback, useEffect, useMemo } from "react";
import { useApp, useInput } from "ink";
import { Box, Static, Text } from "ink";

import { AppProvider, useAppContext } from "../DataContext.js";
import { HistoryView, renderHistoryItem } from "./components/HistoryView.js";
import { StatusSpinner } from "./components/Spinner.js";
import { InputBox } from "./components/InputBox.js";
import { ApprovalMenu } from "./components/ApprovalMenu.js";
import { PromptOverlay } from "./components/PromptOverlay.js";
import { AgentTaskBoard } from "./components/AgentTaskBoard.js";
import type { AppProps } from "./types.js";
import {
  commandRequiresArgs,
  getCommandDescription,
  getCommandLabel,
  getCommandSuggestions,
} from "./commandCatalog.js";
import { AUTOCOMPLETE_VISIBLE_COUNT } from "./constants.js";
import { useBridgeSetup } from "./hooks/useBridgeSetup.js";
import { useKeyboardInput } from "./hooks/useKeyboardInput.js";
import { useSubmitLine } from "./hooks/useSubmitLine.js";

/**
 * <Summary>
 * What it does:
 *   Root component that wraps the application with context provider.
 *
 * How it does it (step by step):
 *   1. Receives application props from parent component.
 *   2. Wraps AppContent with AppProvider to supply context.
 *   3. Renders the wrapped component tree.
 *
 * Parameters:
 *   @param {AppProps} appProps — Application properties (connection, handlers, etc.).
 *
 * Returns:
 *   @returns {JSX.Element} — The wrapped application component tree.
 *
 * Dependencies:
 *   - AppProvider — supplies global application state context.
 *   - AppContent — main application content.
 *
 * Dependants:
 *   - BootstrapApp — renders this component after initialization.
 * </Summary>
 */
export const App: React.FC<AppProps> = (appProps) => (
  <AppProvider {...appProps}>
    <AppContent />
  </AppProvider>
);

/**
 * <Summary>
 * What it does:
 *   Main application content component that manages the terminal UI,
 *   input handling, command autocomplete, and renders all UI elements.
 *
 * How it fits in the system:
 *   This component contains the core UI logic for the CLI interface including
 *   history display, input handling, command autocomplete, agent task boards,
 *   approval menus, and prompt overlays. It coordinates between user input
 *   and the application state through the context system.
 *
 * Dependencies:
 *   - AppContext — provides global application state and setter functions.
 *   - useApp — provides Ink app exit functionality.
 *   - Custom hooks — useBridgeSetup, useSubmitLine, useKeyboardInput.
 *   - UI components — HistoryView, InputBox, ApprovalMenu, etc.
 *
 * Dependants:
 *   - App — renders this component wrapped in context provider.
 * </Summary>
 */
const AppContent: React.FC = () => {
  // ===== STEP 1: Extract Application State from Context =====
  // Step 1a: Destructure all needed state values and setter functions from context
  // Step 1b: This provides access to global application state and update functions
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
    agentBoards,
    sigintBusy,
    setActiveIndex,
    setScrollOffset,
    setHandleSubmit,
    setHistory,
    setStreamingText,
    setSpinner,
    setBusy,
    setPrompt,
    setApproval,
    setPromptReq,
    setBannerEntries,
    setAgentStatuses,
    setAgentBoards,
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

  // ===== STEP 2: Get Ink App Exit Function =====
  // Step 2a: Extract the exit function from the Ink useApp hook
  // Step 2b: This allows the application to cleanly exit the terminal UI
  const { exit } = useApp();

  // ===== STEP 3: Reset Autocomplete State on Input Change =====
  // Step 3a: Use useEffect to reset autocomplete when input text changes
  // Step 3b: This ensures autocomplete starts fresh when user begins typing
  useEffect(() => {
    setActiveIndex(0);
    setScrollOffset(0);
  }, [input, setActiveIndex, setScrollOffset]);

  // ===== STEP 4: Register Exit Handler =====
  // Step 4a: Use useEffect to register the exit handler on mount
  // Step 4b: Clean up by registering a no-op handler on unmount
  useEffect(() => {
    registerExit(exit);
    return () => registerExit(() => {});
  }, [exit, registerExit]);

  // ===== STEP 5: Setup UI Bridge for Server Communication =====
  // Step 5a: Configure the bridge that handles server-to-UI communication
  // Step 5b: This sets up callbacks for streaming data from the server
  useBridgeSetup({
    setHistory,
    setStreamingText,
    setSpinner,
    setBusy,
    setPrompt,
    setApproval,
    setPromptReq,
    setBannerEntries,
    setAgentStatuses,
    setAgentBoards,
  });

  // ===== STEP 6: Setup Line Submission Handler =====
  // Step 6a: Configure the hook that handles command line submission
  // Step 6b: This provides the submit function for executing commands
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

  // ===== STEP 7: Handle Input Submission with Autocomplete =====
  // Step 7a: Create callback for handling input submission with autocomplete logic
  // Step 7b: This checks if user is submitting an autocomplete suggestion
  const handleSubmitCallback = useCallback(
    async (inputLine: string) => {
      // ===== STEP 7a-i: Get Command Suggestions =====
      // Step 7a-i-1: Fetch all command suggestions for the current input
      const commandSuggestions = getCommandSuggestions(inputLine);

      // ===== STEP 7a-ii: Check if Autocomplete Selection is Active =====
      // Step 7a-ii-1: Check if there are suggestions and a valid selection
      // Step 7a-ii-2: Validate that activeIndex is within suggestions array bounds
      if (
        commandSuggestions.length > 0 &&
        activeIndex >= 0 &&
        activeIndex < commandSuggestions.length
      ) {
        // ===== STEP 7a-ii-1-a: Get Selected Suggestion =====
        const selectedSuggestion = commandSuggestions[activeIndex]!;

        // ===== STEP 7a-ii-1-b: Determine if Command Needs Arguments =====
        const needsSpaceAfterCommand = commandRequiresArgs(
          selectedSuggestion.command,
        );

        // ===== STEP 7a-ii-1-c: Build Autocomplete Value =====
        const autocompletedValue =
          selectedSuggestion.command + (needsSpaceAfterCommand ? " " : "");

        // ===== STEP 7a-ii-1-d: Check if User Confirmed Autocomplete =====
        // Step 7a-ii-1-d-1: If input matches autocomplete, submit the command
        // Step 7a-ii-1-d-2: This handles Enter key on autocomplete selection
        if (
          inputLine === autocompletedValue ||
          (!needsSpaceAfterCommand && inputLine === selectedSuggestion.command)
        ) {
          await submit(inputLine);
        } else {
          // ===== STEP 7a-ii-1-d-3: Apply Autocomplete =====
          // Step 7a-ii-1-d-3-1: Update input with autocomplete value
          // Step 7a-ii-1-d-3-2: This fills in the command when user navigates suggestions
          setInput(autocompletedValue);
        }
        return;
      }

      // ===== STEP 7a-iii: Submit Input Directly =====
      // Step 7a-iii-1: No autocomplete selection, submit input as-is
      await submit(inputLine);
    },
    [activeIndex, submit, setInput],
  );

  // ===== STEP 8: Register Submit Handler =====
  // Step 8a: Register the submit callback with the context
  useEffect(() => {
    setHandleSubmit(() => handleSubmitCallback);
  }, [handleSubmitCallback, setHandleSubmit]);

  // ===== STEP 9: Setup Keyboard Input Handler =====
  // Step 9a: Configure the hook that handles keyboard input events
  // Step 9b: This processes arrow keys, Ctrl+C, Enter, and other keyboard events
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

  // ===== STEP 10: Register Keyboard Handler with Ink =====
  // Step 10a: Register the keyboard handler with Ink's useInput hook
  useInput(keyboardInputHandler);

  // ===== STEP 11: Prepare Autocomplete UI State =====
  // Step 11a: Get command suggestions for current input
  const commandSuggestions = getCommandSuggestions(input);

  // Step 11b: Determine if autocomplete should be shown
  const shouldShowAutocomplete = commandSuggestions.length > 0;

  // Step 11c: Calculate visible suggestions for pagination
  const visibleSuggestions = commandSuggestions.slice(
    scrollOffset,
    scrollOffset + AUTOCOMPLETE_VISIBLE_COUNT,
  );

  // ===== STEP 12: Prepare Static Display Entries =====
  // Step 12a: Use useMemo to optimize static entries calculation
  // Step 12b: Combine banner entries and history items for fixed-position display
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

  // ===== STEP 13: Render Application UI =====
  // Step 13a: Return the main UI component tree
  return (
    <Box flexDirection="column" height="100%">
      {/* ===== SECTION 1: Static Content (Banner + History) ===== */}
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

      {/* ===== SECTION 2: Dynamic History View ===== */}
      <HistoryView />

      {/* ===== SECTION 3: Agent Task Boards ===== */}
      {agentBoards.map((agentBoard) => (
        <AgentTaskBoard key={agentBoard.id} board={agentBoard} />
      ))}

      {/* ===== SECTION 4: Status Spinner ===== */}
      <StatusSpinner state={spinner} />

      {/* ===== SECTION 5: Approval Menu ===== */}
      {approval && <ApprovalMenu />}

      {/* ===== SECTION 6: Prompt Overlay ===== */}
      {promptReq && <PromptOverlay />}

      {/* ===== SECTION 7: Input Area with Autocomplete ===== */}
      {!approval && !promptReq && (
        <Box flexDirection="column">
          {/* Autocomplete Suggestions Box */}
          {shouldShowAutocomplete && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {visibleSuggestions.map((suggestion, visibleIndex) => {
                // ===== CALCULATE AUTOCOMPLETE SELECTION STATE =====
                const absoluteSuggestionIndex = scrollOffset + visibleIndex;
                const isSuggestionSelected =
                  absoluteSuggestionIndex === activeIndex;

                // ===== GET COMMAND DISPLAY INFORMATION =====
                const commandLabel = getCommandLabel(suggestion.command);
                const commandDescription = getCommandDescription(
                  suggestion.command,
                );

                // ===== RENDER AUTOCOMPLETE ITEM =====
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

          {/* Input Box */}
          <InputBox />
        </Box>
      )}

      {/* ===== SECTION 8: Ctrl+C Exit Warning ===== */}
      {busy && sigintBusy === 1 && (
        <Text dimColor>Press Ctrl+C again to exit</Text>
      )}
    </Box>
  );
};
