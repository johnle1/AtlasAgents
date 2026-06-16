/**
 * <Summary>
 * What it does:
 *   Root application component for the Ink-based CLI UI.
 *
 * How it fits in the system:
 *   This is the main entry point for the React/Ink UI. It renders the entire terminal interface
 *   including the banner, history view, status spinner, input box, approval menus, and prompts.
 *   It manages the layout of these components using a vertical flexbox and handles conditional
 *   rendering for overlays like approvals and prompts. This component also contains all the
 *   application logic (useCallback, useEffect, useMemo, useRef, useInput) that was moved from
 *   AppContext to keep the context focused on state storage only.
 *
 * Dependencies:
 *   - React — provides the component framework and hooks.
 *   - Ink — provides the terminal rendering primitives and interaction hooks.
 *   - AppProvider — provides the application context with state and setters.
 *   - useAppContext — provides access to application state and setters.
 *   - HistoryView — renders the history output.
 *   - StatusSpinner — renders the bottom-line status indicator.
 *   - InputBox — renders the command input field.
 *   - ApprovalMenu — renders approval dialogs.
 *   - PromptOverlay — renders prompt dialogs.
 *   - AppProps — provides the component props type.
 *   - commandCatalog — provides command label and description utilities.
 *   - taskStream — provides task execution functionality.
 *   - uiBridge — provides bridge hooks for CLI communication.
 *   - historySanitize — provides history line sanitization.
 *
 * Dependants:
 *   - CLI entry point — mounts this component to start the UI.
 * </Summary>
 */

import React, { useCallback, useEffect, useMemo, useRef } from "react";
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
import { getCommandDescription, getCommandLabel } from "./commandCatalog.js";
import { runTaskStream } from "./taskStream.js";
import {
  commandRequiresArgs,
  getCommandSuggestions,
} from "./commandCatalog.js";
import { sanitizeHistoryLine } from "./historySanitize.js";
import {
  enterAlternateScreen,
  exitAlternateScreen,
  registerBridgeHooks,
  registerStreamingHandler,
  setInkActive,
} from "./uiBridge.js";
import { loadConfig } from "../config.js";
import { buildPromptLabel } from "../pathDisplay.js";
import { buildBannerLines } from "../renderer/banner.js";

/**
 * <Summary>
 * What it does:
 *   Root application component that wraps the app with the context provider.
 *
 * How it does it (step by step):
 *   1. Receive application props (connection, command handler, file proxy, etc.).
 *   2. Wrap the app content with the AppProvider to make context available.
 *   3. Render the AppContent component within the provider.
 *
 * Parameters:
 * @param {AppProps} applicationProps — Application configuration including connection, command handler, file proxy, and initial state.
 *
 * Returns:
 * @returns {React.ReactElement} — React element with AppProvider wrapping AppContent.
 *
 * Dependencies:
 *   - AppProvider — provides application context to child components.
 *   - AppContent — renders the main application UI with all logic.
 *
 * Dependants:
 *   - CLI entry point — mounts this component to start the UI.
 * </Summary>
 */
export const App: React.FC<AppProps> = (applicationProps) => (
  <AppProvider {...applicationProps}>
    <AppContent />
  </AppProvider>
);

/**
 * <Summary>
 * What it does:
 *   Main content component that renders the CLI UI layout and contains all application logic.
 *
 * How it does it (step by step):
 *   1. Access application state and setters from context.
 *   2. Get the exit function from Ink's useApp hook.
 *   3. Create a ref for submit lock to prevent duplicate submissions.
 *   4. Create the appendHistory callback.
 *   5. Set up autocomplete reset effect on input changes.
 *   6. Set up exit registration effect.
 *   7. Set up bridge hooks and alternate screen effect.
 *   8. Create submit callback for command execution.
 *   9. Create handleSubmit callback with autocomplete support.
 *   10. Set up keyboard input handling.
 *   11. Calculate derived values (static entries, suggestions, visibility).
 *   12. Render the vertical layout with all components.
 *
 * Returns:
 * @returns {React.ReactElement} — React element with the complete CLI UI layout.
 *
 * Dependencies:
 *   - useAppContext — provides application state and setters.
 *   - useApp — provides exit function.
 *   - useInput — provides keyboard input handling.
 *   - All useCallback, useEffect, useMemo, useRef — provide application logic.
 *   - taskStream — provides task execution.
 *   - commandCatalog — provides autocomplete functionality.
 *   - uiBridge — provides bridge hooks.
 *
 * Dependants:
 *   - App — uses this component within the AppProvider.
 * </Summary>
 */
const AppContent: React.FC = () => {
  // ===== STEP 1: Access application state from context =====
  // Step 1a: Destructure all needed state values and setters from the application context
  const {
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
    agentBoards,
    setAgentStatuses,
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
  } = useAppContext();

  // ===== STEP 2: Get exit function =====
  // Step 2a: Get the exit function from Ink's useApp hook
  const { exit } = useApp();

  // ===== STEP 3: Create submit lock ref =====
  // Step 3a: Create a ref to prevent duplicate submissions
  const submitLockRef = useRef(false);

  // ===== STEP 3b: Create ref to track alternate buffer state =====
  // Step 3b-1: Track the initial useAlternateBuffer state to ensure cleanup matches actual state
  const useAlternateBufferRef = useRef(false);

  // ===== STEP 4: Reset autocomplete on input change =====
  // Step 5a: Reset active index to 0 when input changes
  // Step 5b: Reset scroll offset to 0 when input changes
  // Step 5c: This ensures autocomplete starts fresh with each input change
  useEffect(() => {
    setActiveIndex(0);
    setScrollOffset(0);
  }, [input, setActiveIndex, setScrollOffset]);

  // ===== STEP 6: Register exit handler =====
  // Step 6a: Register the exit function with the exit registry
  // Step 6b: This allows external code to trigger application exit
  useEffect(() => {
    registerExit(exit);
    return () => registerExit(() => {});
  }, [exit, registerExit]);

  // ===== STEP 7: Set up bridge hooks and alternate screen =====
  // Step 7a: Set up bridge hooks on mount and cleanup on unmount
  useEffect(() => {
    // ===== STEP 7a-1: Initialize Ink =====
    // Step 7a-1a: Mark Ink as active for the UI bridge
    setInkActive(true);

    // ===== STEP 7a-2: Load configuration =====
    // Step 7a-2a: Load configuration to check for alternate buffer preference
    const config = loadConfig();

    // ===== STEP 7a-2b: Update ref with current alternate buffer state =====
    // Step 7a-2b-1: Store the current useAlternateBuffer state in the ref for cleanup
    useAlternateBufferRef.current = config.ui?.useAlternateBuffer === true;

    // ===== STEP 7a-3: Enter alternate screen if configured =====
    // Step 7a-3a: If alternate buffer is enabled, enter alternate screen mode
    // Step 7a-3b: This provides a full-screen interface that doesn't scroll
    if (useAlternateBufferRef.current) {
      enterAlternateScreen();
    }

    // ===== STEP 7a-4: Register bridge hooks =====
    // Step 7a-5a: Register callbacks for UI bridge to communicate with React
    registerBridgeHooks({
      onHistoryAppend: (historyItem) =>
        setHistory((previousHistory) => [...previousHistory, historyItem]),
      onStreamingSet: (text) => setStreamingText(text),
      onSpinner: (spinnerState) => setSpinner(spinnerState),
      onBusy: (isBusy) => setBusy(isBusy),
      onCwd: (currentWorkingDirectory) =>
        setPrompt(buildPromptLabel(currentWorkingDirectory)),
      onApprovalChange: (approvalRequest) => setApproval(approvalRequest),
      onPromptChange: (promptRequest) => setPromptReq(promptRequest),
      onBannerRefresh: (configuration) =>
        setBannerEntries(
          buildBannerLines(configuration).map((bannerLine, lineIndex) => ({
            kind: "banner" as const,
            key: `banner-${lineIndex}`,
            line: bannerLine,
          })),
        ),
      onAgentStatuses: (updater) => setAgentStatuses(updater),
      onAgentBoards: (updater) => setAgentBoards(updater),
    });

    // ===== STEP 7a-6: Register streaming handler =====
    // Step 7a-6a: Register handler for streaming text tokens
    registerStreamingHandler((token) => {
      // Step 7a-6b: Append new token to existing streaming text
      setStreamingText(
        (previousStreamingText) => (previousStreamingText ?? "") + token,
      );
    });

    // ===== STEP 7a-7: Cleanup on unmount =====
    // Step 7a-7a: Return cleanup function to run on component unmount
    return () => {
      // Step 7a-7b: Mark Ink as inactive for the UI bridge
      setInkActive(false);

      // Step 7a-7c: Clear bridge hooks to prevent memory leaks
      registerBridgeHooks({});

      // Step 7a-7d: Clear streaming handler
      registerStreamingHandler(null);

      // Step 7a-7e: Exit alternate screen if it was entered
      // Step 7a-7e-1: Use the ref to check if alternate screen should be exited
      if (useAlternateBufferRef.current) {
        exitAlternateScreen();
      }
    };
  }, [
    fileProxy,
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
  ]);

  // ===== STEP 8: Create submit callback for command execution =====
  // Step 8a: Create callback to submit a line for execution
  const submit = useCallback(
    async (inputLine: string) => {
      // ===== STEP 8a-1: Trim and validate input =====
      // Step 8a-1a: Trim whitespace from input line
      const trimmedLine = inputLine.trim();

      // Step 8a-1b: Return early if input is empty or app is busy/approving/prompting
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

      // Step 8a-2d: Reset history navigation index
      setHistIdx(-1);

      // Step 8a-2e: Clear the input field
      setInput("");

      // ===== STEP 8a-3: Set busy state =====
      // Step 8a-3a: Mark application as busy to prevent duplicate submissions
      setBusy(true);

      // ===== STEP 8a-4: Execute command =====
      // Step 8a-4a: Try to execute the command
      try {
        // Step 8a-4b: Let command handler process the line
        const wasCommand = await commandHandler.handle(trimmedLine);

        // Step 8a-4c: If not a CLI command, execute as agent task
        if (!wasCommand) {
          // Step 8a-4d: Load task configuration to check for model settings
          const taskConfiguration = loadConfig();

          // Step 8a-4e: Check if advisor and agent models are configured
          if (
            !(taskConfiguration.advisorModel ?? "").trim() ||
            !(taskConfiguration.agentModel ?? "").trim()
          ) {
            // Step 8a-4f: Add error message if models not configured
            setHistory((previousHistory) => [
              ...previousHistory,
              {
                kind: "text",
                text: "Advisor and agent models must be set. Use /set advisor and /set agent.",
                variant: "error",
              },
            ]);
          } else {
            // Step 8a-4g: Execute the task using the connection
            await runTaskStream(connection, trimmedLine);
          }
        }
      } catch (error) {
        // ===== STEP 8a-5: Handle errors =====
        // Step 8a-5a: Add error message to history on failure
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
    [
      approval,
      promptReq,
      busy,
      commandHandler,
      connection,
      inputHistory,
      setInputHistory,
      onInputHistoryRef,
      setHistIdx,
      setInput,
      setBusy,
      setHistory,
      setSigintBusy,
    ],
  );

  // ===== STEP 9: Create handleSubmit with autocomplete support =====
  // Step 9a: Create callback to handle input submission with autocomplete support
  const handleSubmitCallback = useCallback(
    async (inputLine: string) => {
      // ===== STEP 9a-1: Handle autocomplete selection =====
      // Step 9a-1a: Calculate command suggestions
      const fullSuggestions = getCommandSuggestions(inputLine);

      // Step 9a-1b: Check if autocomplete is shown and a suggestion is selected
      if (
        fullSuggestions.length > 0 &&
        activeIndex >= 0 &&
        activeIndex < fullSuggestions.length
      ) {
        // Step 9a-1c: Get the selected suggestion
        const selectedSuggestion = fullSuggestions[activeIndex]!;

        // Step 9a-1d: Check if the command requires a space after it
        const needsSpaceAfterCommand = commandRequiresArgs(
          selectedSuggestion.command,
        );

        // Step 9a-1e: Build the autocompleted value with optional trailing space
        const autocompletedValue =
          selectedSuggestion.command + (needsSpaceAfterCommand ? " " : "");

        // Step 9a-1f: Check if the input matches the autocompleted value
        if (
          inputLine === autocompletedValue ||
          (!needsSpaceAfterCommand && inputLine === selectedSuggestion.command)
        ) {
          // Step 9a-1g: If match, submit the command
          await submit(inputLine);
        } else {
          // Step 9a-1h: Otherwise, set the input to the autocompleted value
          setInput(autocompletedValue);
        }
        // Step 9a-1i: Return early as autocomplete was handled
        return;
      }

      // ===== STEP 9a-2: Submit regular input =====
      // Step 9a-2a: If no autocomplete, submit the input directly
      await submit(inputLine);
    },
    [activeIndex, submit, setInput],
  );

  // ===== STEP 10: Set up keyboard input handling =====
  // Step 10a: Wrap input handler in useCallback to prevent re-registration on every render
  const handleInput = useCallback(
    (
      inputChar: string,
      key: {
        ctrl?: boolean;
        upArrow?: boolean;
        downArrow?: boolean;
        tab?: boolean;
      },
    ) => {
      // ===== STEP 10a-1: Skip if modal is active =====
      // Step 10a-1a: Return early if approval or prompt is active (modals take precedence)
      if (approval || promptReq) return;

      // ===== STEP 10a-2: Handle Ctrl+C (exit) =====
      // Step 10a-2a: Check if Ctrl+C was pressed
      if (key.ctrl && inputChar === "c") {
        if (busy) {
          // Step 10a-2b: If busy, increment Ctrl+C counter and check for double press
          setSigintBusy((sigintCounter) => {
            // Step 10a-2c: If this is the second Ctrl+C, exit and save history
            if (sigintCounter + 1 >= 2) {
              onSaveHistory(inputHistory);
              exit();
            }
            // Step 10a-2d: Increment the counter
            return sigintCounter + 1;
          });
        } else {
          // Step 10a-2e: If not busy, exit immediately and save history
          onSaveHistory(inputHistory);
          exit();
        }
        // Step 10a-2f: Return early after handling Ctrl+C
        return;
      }

      // ===== STEP 10a-3: Handle Ctrl+L (force exit) =====
      // Step 10a-3a: Check if Ctrl+L was pressed (force exit)
      if (key.ctrl && inputChar === "l") {
        // Step 10a-3b: Save history and exit
        onSaveHistory(inputHistory);
        exit();
        // Step 10a-3c: Return early after handling Ctrl+L
        return;
      }

      // ===== STEP 10a-4: Handle Ctrl+O (expand directory) =====
      // Step 10a-4a: Check if Ctrl+O was pressed and not busy
      if (key.ctrl && inputChar === "o" && !busy) {
        // Step 10a-4b: Dynamically import listExpandState module
        void import("../listExpandState.js").then(({ peekUnexpanded }) => {
          // Step 10a-4c: Peek at unexpanded directories
          const expandResult = peekUnexpanded();
          // Step 10a-4d: If found, expand the directory
          if (expandResult.found && expandResult.entry) {
            void fileProxy
              .expandDirectory(
                expandResult.entry.absolutePath,
                expandResult.entry.indent,
              )
              .catch((expansionError) => {
                // Step 10a-4e: Add error message to history if expansion fails
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
        // Step 10a-4f: Return early after handling Ctrl+O
        return;
      }

      // ===== STEP 10a-5: Skip input if busy =====
      // Step 10a-5a: Return early if busy (no input processing during busy state)
      if (busy) return;

      // ===== STEP 10a-6: Handle autocomplete navigation =====
      // Step 10a-6a: Calculate command suggestions
      const fullSuggestions = getCommandSuggestions(input);

      // Step 10a-6b: Check if autocomplete is shown
      if (fullSuggestions.length > 0) {
        // ===== STEP 10a-6c: Handle up arrow =====
        // Step 10a-6c-1: Check if up arrow was pressed
        if (key.upArrow) {
          // Step 10a-6c-2: Move selection up (wrap to bottom if at top)
          setActiveIndex((previousIndex) => {
            // Step 10a-6c-3: Calculate new index (wrap to last if at first)
            const newIndex =
              previousIndex <= 0
                ? fullSuggestions.length - 1
                : previousIndex - 1;

            // Step 10a-6c-4: Adjust scroll offset if selection is out of view
            if (newIndex < scrollOffset) {
              setScrollOffset(newIndex);
            }

            // Step 10a-6c-5: Return the new index
            return newIndex;
          });
          // Step 10a-6c-6: Return early after handling up arrow
          return;
        }

        // ===== STEP 10a-6d: Handle down arrow =====
        // Step 10a-6d-1: Check if down arrow was pressed
        if (key.downArrow) {
          // Step 10a-6d-2: Move selection down (wrap to top if at bottom)
          setActiveIndex((previousIndex) => {
            // Step 10a-6d-3: Calculate new index (wrap to first if at last)
            const newIndex =
              previousIndex >= fullSuggestions.length - 1
                ? 0
                : previousIndex + 1;

            // Step 10a-6d-4: Adjust scroll offset if selection is out of view
            if (newIndex >= scrollOffset + 5) {
              setScrollOffset(newIndex - 4);
            }

            // Step 10a-6d-5: Return the new index
            return newIndex;
          });
          // Step 10a-6d-6: Return early after handling down arrow
          return;
        }

        // ===== STEP 10a-6e: Handle Tab key =====
        // Step 10a-6e-1: Check if Tab was pressed
        if (key.tab) {
          // Step 10a-6e-2: Get the currently selected suggestion
          const selectedSuggestion = fullSuggestions[activeIndex];
          if (selectedSuggestion) {
            // Step 10a-6e-3: Set input to autocompleted value with optional trailing space
            setInput(
              selectedSuggestion.command +
                (commandRequiresArgs(selectedSuggestion.command) ? " " : ""),
            );
          }
          // Step 10a-6e-4: Return early after handling Tab
          return;
        }
      } else {
        // ===== STEP 10a-7: Handle history navigation =====
        // Step 10a-7a: Check if up arrow was pressed and history exists
        if (key.upArrow && inputHistory.length > 0) {
          // Step 10a-7b: Move up in history (move to previous entry)
          const nextHistoryIndex =
            histIdx < 0 ? inputHistory.length - 1 : Math.max(0, histIdx - 1);
          setHistIdx(nextHistoryIndex);
          setInput(inputHistory[nextHistoryIndex] ?? "");
          // Step 10a-7c: Return early after handling up arrow
          return;
        }

        // ===== STEP 10a-8: Handle down arrow in history =====
        // Step 10a-8a: Check if down arrow was pressed while navigating history
        if (key.downArrow && histIdx >= 0) {
          // Step 10a-8b: Move down in history (move to next entry or clear)
          const nextHistoryIndex = histIdx + 1;
          if (nextHistoryIndex >= inputHistory.length) {
            // Step 10a-8c: If past the end, clear history navigation and input
            setHistIdx(-1);
            setInput("");
          } else {
            // Step 10a-8d: Otherwise, set input to the next history entry
            setHistIdx(nextHistoryIndex);
            setInput(inputHistory[nextHistoryIndex] ?? "");
          }
        }
      }
    },
    [
      approval,
      promptReq,
      busy,
      sigintBusy,
      inputHistory,
      histIdx,
      input,
      activeIndex,
      scrollOffset,
      setSigintBusy,
      onSaveHistory,
      exit,
      fileProxy,
      setHistory,
      setActiveIndex,
      setScrollOffset,
      setInput,
      setHistIdx,
    ],
  );

  // Step 10b: Set up useInput hook with the memoized handler
  useInput(handleInput);

  // ===== STEP 11: Calculate derived values =====
  // Step 11a: Calculate command suggestions
  const fullSuggestions = getCommandSuggestions(input);

  // Step 11b: Determine if autocomplete should be shown (has suggestions)
  const showAutocomplete = fullSuggestions.length > 0;

  // Step 11c: Calculate visible suggestions (paginated to 5 items)
  const visibleSuggestions = fullSuggestions.slice(
    scrollOffset,
    scrollOffset + 5,
  );

  // Step 11d: inputDisabled is derived in AppProvider from busy/approval/promptReq

  // Step 11e: Update context with handleSubmit callback
  useEffect(() => {
    setHandleSubmit(() => handleSubmitCallback);
  }, [handleSubmitCallback, setHandleSubmit]);

  // Step 11f: Calculate static entries from banner and history
  const staticEntries = useMemo(
    () => [
      ...bannerEntries,
      ...history.map((historyItem, historyIndex) => ({
        kind: "history" as const,
        key: `hist-${historyIndex}`,
        item: historyItem,
      })),
    ],
    [history, bannerEntries],
  );

  // ===== STEP 12: Render the main layout =====
  return (
    // Step 12a: Create a vertical flexbox that fills the available height
    <Box flexDirection="column" height="100%">
      {/* ===== SECTION 1: Static content (banner and history) ===== */}
      {/* Step 12b: Render static entries (banner lines and history items) */}
      {/* Step 12c: Static items don't scroll with the rest of the terminal output */}
      <Static items={staticEntries}>
        {(staticEntryItem) =>
          // Step 12d: Render banner line if the entry is a banner
          staticEntryItem.kind === "banner" ? (
            <Text key={staticEntryItem.key}>{staticEntryItem.line}</Text>
          ) : (
            // Step 12e: Render history item if the entry is history
            <Box key={staticEntryItem.key} flexDirection="column">
              {renderHistoryItem(staticEntryItem.item, staticEntryItem.key)}
            </Box>
          )
        }
      </Static>

      {/* ===== SECTION 2: Dynamic content ===== */}
      {/* Step 12f: Render the dynamic history view (scrollable) */}
      <HistoryView />

      {agentBoards.map((board) => (
        <AgentTaskBoard key={board.id} board={board} />
      ))}

      {/* Step 12g: Render the status spinner at the bottom line */}
      <StatusSpinner state={spinner} />

      {/* ===== SECTION 3: Overlay dialogs ===== */}
      {/* Step 12h: Render approval menu if an approval request is pending */}
      {approval && <ApprovalMenu />}

      {/* Step 12i: Render prompt overlay if a prompt request is pending */}
      {promptReq && <PromptOverlay />}

      {/* ===== SECTION 4: Input area (only shown when no overlays) ===== */}
      {/* Step 12j: Only render input area when no overlays are active */}
      {!approval && !promptReq && (
        <Box flexDirection="column">
          {/* ===== SECTION 4a: Autocomplete suggestions ===== */}
          {/* Step 12k: Render autocomplete suggestions if enabled and visible */}
          {showAutocomplete && (
            // Step 12l: Create a bordered box for suggestion display
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {/* Step 12m: Map over visible suggestions to render each one */}
              {visibleSuggestions.map(
                (suggestionItem, visibleSuggestionIndex) => {
                  // Step 12m-1: Calculate the global suggestion index (accounting for scroll offset)
                  const absoluteSuggestionIndex =
                    scrollOffset + visibleSuggestionIndex;

                  // Step 12m-2: Check if this suggestion is the currently selected one
                  const isSelected = absoluteSuggestionIndex === activeIndex;

                  // Step 12m-3: Get the command label for display
                  const commandLabel = getCommandLabel(suggestionItem.command);

                  // Step 12m-4: Get the command description for display
                  const commandDescription = getCommandDescription(
                    suggestionItem.command,
                  );

                  // Step 12m-5: Render the suggestion row with selection highlighting
                  return (
                    <Box key={suggestionItem.command}>
                      {/* Step 12m-5a: Render selection indicator (▸ for selected, spaces for unselected) */}
                      <Text dimColor={!isSelected}>
                        {isSelected ? "▸ " : "  "}
                      </Text>

                      {/* Step 12m-5b: Render command label (green, bold if selected) */}
                      <Text color="green" bold={isSelected}>
                        {commandLabel}
                      </Text>

                      {/* Step 12m-5c: Render command description (dim color) */}
                      <Text dimColor>
                        {"  "}
                        {commandDescription}
                      </Text>
                    </Box>
                  );
                },
              )}
            </Box>
          )}

          {/* ===== SECTION 4b: Input box ===== */}
          {/* Step 12n: Render the command input box */}
          <InputBox />
        </Box>
      )}

      {/* ===== SECTION 5: Sigint busy message ===== */}
      {/* Step 12o: Render message if user pressed Ctrl+C once (busy and sigintBusy === 1) */}
      {busy && sigintBusy === 1 && (
        <Text dimColor>Press Ctrl+C again to exit</Text>
      )}
    </Box>
  );
};
