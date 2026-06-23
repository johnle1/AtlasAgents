/**
 * <Summary>
 * What it does:
 *   React hook that handles keyboard input events for the Ink-based CLI UI,
 *   including navigation through command history, autocomplete suggestions,
 * and special keyboard shortcuts (Ctrl+C, Ctrl+L, Ctrl+O).
 *
 * How it fits in the system:
 *   This hook processes all keyboard events from the Ink useInput hook and
 *   dispatches them to the appropriate handlers based on the current application
 *   state. It manages keyboard navigation through autocomplete menus and command
 *   history, as well as handling special key combinations for exit, clear, and
 *   directory expansion.
 * </Summary>
 */

import { useCallback } from "react";

import { formatErrorMessage } from "../../commands/utils.js";
import type { AppContextValue } from "../../DataContext.js";
import {
  commandRequiresArgs,
  getCommandSuggestions,
} from "../commandCatalog.js";
import {
  AUTOCOMPLETE_SCROLL_TRIGGER_OFFSET,
  AUTOCOMPLETE_VISIBLE_COUNT,
} from "../constants.js";

/**
 * <Summary>
 * What it does:
 *   Defines the subset of AppContextValue needed for keyboard input handling.
 *
 * Used by:
 *   - useKeyboardInput hook — receives these dependencies.
 *
 * Produced by:
 *   - AppContext — provides these state values and setter functions.
 * </Summary>
 */
type KeyboardInputContext = Pick<
  AppContextValue,
  | "approval"
  | "promptReq"
  | "busy"
  | "inputHistory"
  | "histIdx"
  | "input"
  | "activeIndex"
  | "scrollOffset"
  | "setSigintBusy"
  | "onSaveHistory"
  | "fileProxy"
  | "setHistory"
  | "setActiveIndex"
  | "setScrollOffset"
  | "setInput"
  | "setHistIdx"
>;

/**
 * <Summary>
 * What it does:
 *   Defines the external handlers that keyboard input can invoke.
 *
 * Used by:
 *   - useKeyboardInput hook — receives these handlers.
 *
 * Produced by:
 *   - AppContent component — provides these handler functions.
 * </Summary>
 */
type KeyboardInputHandlers = {
  /** Function to exit the application. */
  exit: () => void;
};

/**
 * <Summary>
 * What it does:
 *   Creates a keyboard input handler that processes keystrokes and updates
 *   application state accordingly.
 *
 * How it does it (step by step):
 *   1. Checks if approval or prompt is active (blocks input if so).
 *   2. Handles special key combinations (Ctrl+C, Ctrl+L, Ctrl+O).
 *   3. Handles autocomplete navigation (up/down arrows, tab).
 *   4. Handles command history navigation (up/down arrows).
 *   5. Updates input, active index, scroll offset, and history index.
 *
 * Parameters:
 *   @param keyboardInputDependencies - State and setters from context.
 *   @param keyboardInputHandlers - External handlers like exit.
 *
 * Returns:
 *   @returns The keyboard input handler function.
 * </Summary>
 */
export const useKeyboardInput = (
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
  }: KeyboardInputContext,
  { exit }: KeyboardInputHandlers,
) =>
  useCallback(
    (
      inputCharacter: string,
      keyInformation: {
        ctrl?: boolean;
        upArrow?: boolean;
        downArrow?: boolean;
        tab?: boolean;
      },
    ) => {
      // ===== STEP 1: Check for Blocking UI States =====
      // Step 1a: Check if approval menu or prompt overlay is active
      // Step 1b: If so, block keyboard input to prevent interference
      if (approval || promptReq) return;

      // ===== STEP 2: Handle Ctrl+C (Exit/Interrupt) =====
      // Step 2a: Check for Ctrl+C key combination
      if (keyInformation.ctrl && inputCharacter === "c") {
        // ===== STEP 2a-i: Handle Exit During Busy State =====
        // Step 2a-i-1: If application is busy, require double Ctrl+C
        if (busy) {
          // Step 2a-i-1-a: Increment SIGINT counter
          setSigintBusy((sigintCounter) => {
            // Step 2a-i-1-a-1: Check if this is the second Ctrl+C
            if (sigintCounter + 1 >= 2) {
              // Step 2a-i-1-a-1-1: Save input history before exit
              onSaveHistory(inputHistory);
              // Step 2a-i-1-a-1-2: Exit the application
              exit();
            }
            // Step 2a-i-1-a-2: Return incremented counter
            return sigintCounter + 1;
          });
        } else {
          // ===== STEP 2a-ii: Handle Exit When Not Busy =====
          // Step 2a-ii-1: Save input history before exit
          onSaveHistory(inputHistory);
          // Step 2a-ii-2: Exit the application immediately
          exit();
        }
        return;
      }

      // ===== STEP 3: Handle Ctrl+L (Clear Screen) =====
      // Step 3a: Check for Ctrl+L key combination
      if (keyInformation.ctrl && inputCharacter === "l") {
        // Step 3a-i: Save input history before clearing screen
        onSaveHistory(inputHistory);
        // Step 3a-ii: Exit to clear the screen (Ink will re-render)
        exit();
        return;
      }

      // ===== STEP 4: Handle Ctrl+O (Expand Directory) =====
      // Step 4a: Check for Ctrl+O key combination
      if (keyInformation.ctrl && inputCharacter === "o" && !busy) {
        // Step 4a-i: Dynamically import listExpandState module
        // Step 4a-i-1: This is a lazy import to avoid loading when not needed
        void import("../../listExpandState.js").then(({ peekUnexpanded }) => {
          // Step 4a-i-1-a: Get the next unexpanded directory entry
          const expandResult = peekUnexpanded();
          // Step 4a-i-1-b: If an entry was found, expand it
          if (expandResult.found && expandResult.entry) {
            // Step 4a-i-1-b-1: Expand the directory through file proxy
            void fileProxy
              .expandDirectory(
                expandResult.entry.absolutePath,
                expandResult.entry.indent,
              )
              .catch((expansionError) => {
                // Step 4a-i-1-b-1-a: Handle expansion errors
                // Step 4a-i-1-b-1-a-1: Display error message in history
                setHistory((previousHistory) => [
                  ...previousHistory,
                  {
                    kind: "text",
                    text: formatErrorMessage(expansionError),
                    variant: "error",
                  },
                ]);
              });
          }
        });
        return;
      }

      // ===== STEP 5: Block Input During Busy State =====
      // Step 5a: If application is busy, block all other input
      if (busy) return;

      // ===== STEP 6: Get Command Autocomplete Suggestions =====
      // Step 6a: Fetch command suggestions for current input
      const commandSuggestions = getCommandSuggestions(input);

      // ===== STEP 7: Handle Autocomplete Navigation =====
      // Step 7a: If suggestions are available, handle autocomplete navigation
      if (commandSuggestions.length > 0) {
        // ===== STEP 7a-i: Handle Up Arrow (Previous Suggestion) =====
        if (keyInformation.upArrow) {
          // Step 7a-i-1: Update active index to previous suggestion
          setActiveIndex((previousActiveIndex) => {
            // Step 7a-i-1-a: Calculate new index (wrap around to last if at first)
            const newActiveIndex =
              previousActiveIndex <= 0
                ? commandSuggestions.length - 1
                : previousActiveIndex - 1;

            // Step 7a-i-1-b: Adjust scroll offset if needed
            // Step 7a-i-1-b-1: If new index is above visible range, scroll up
            if (newActiveIndex < scrollOffset) {
              setScrollOffset(newActiveIndex);
            }

            // Step 7a-i-1-c: Return the new active index
            return newActiveIndex;
          });
          return;
        }

        // ===== STEP 7a-ii: Handle Down Arrow (Next Suggestion) =====
        if (keyInformation.downArrow) {
          // Step 7a-ii-1: Update active index to next suggestion
          setActiveIndex((previousActiveIndex) => {
            // Step 7a-ii-1-a: Calculate new index (wrap around to first if at last)
            const newActiveIndex =
              previousActiveIndex >= commandSuggestions.length - 1
                ? 0
                : previousActiveIndex + 1;

            // Step 7a-ii-1-b: Adjust scroll offset if needed
            // Step 7a-ii-1-b-1: If new index is below visible range, scroll down
            if (newActiveIndex >= scrollOffset + AUTOCOMPLETE_VISIBLE_COUNT) {
              setScrollOffset(
                newActiveIndex - AUTOCOMPLETE_SCROLL_TRIGGER_OFFSET,
              );
            }

            // Step 7a-ii-1-c: Return the new active index
            return newActiveIndex;
          });
          return;
        }

        // ===== STEP 7a-iii: Handle Tab (Autocomplete) =====
        if (keyInformation.tab) {
          // Step 7a-iii-1: Get the currently selected suggestion
          const selectedSuggestion = commandSuggestions[activeIndex];
          if (selectedSuggestion) {
            // Step 7a-iii-1-a: Apply autocomplete to input
            // Step 7a-iii-1-a-1: Append space if command requires arguments
            setInput(
              selectedSuggestion.command +
                (commandRequiresArgs(selectedSuggestion.command) ? " " : ""),
            );
          }
          return;
        }
      } else {
        // ===== STEP 7b: Handle Command History Navigation =====
        // Step 7b-a: Navigate through command history when no suggestions

        // ===== STEP 7b-a-i: Handle Up Arrow (Previous History Entry) =====
        if (keyInformation.upArrow && inputHistory.length > 0) {
          // Step 7b-a-i-1: Calculate the next history index
          const nextHistoryIndex =
            histIdx < 0 ? inputHistory.length - 1 : Math.max(0, histIdx - 1);

          // Step 7b-a-i-2: Bounds check before array access
          if (nextHistoryIndex >= 0 && nextHistoryIndex < inputHistory.length) {
            // Step 7b-a-i-2-a: Update history index
            setHistIdx(nextHistoryIndex);
            // Step 7b-a-i-2-b: Set input to the history entry
            setInput(inputHistory[nextHistoryIndex]);
          }
          return;
        }

        // ===== STEP 7b-a-ii: Handle Down Arrow (Next History Entry) =====
        if (keyInformation.downArrow && histIdx >= 0) {
          // Step 7b-a-ii-1: Calculate the next history index
          const nextHistoryIndex = histIdx + 1;

          // Step 7b-a-ii-2: Check if we've gone past the end
          if (nextHistoryIndex >= inputHistory.length) {
            // Step 7b-a-ii-2-a: Reset to empty input (after last entry)
            setHistIdx(-1);
            setInput("");
          } else if (
            // Step 7b-a-ii-3: Bounds check before array access
            nextHistoryIndex >= 0 &&
            nextHistoryIndex < inputHistory.length
          ) {
            // Step 7b-a-ii-3-a: Update history index
            setHistIdx(nextHistoryIndex);
            // Step 7b-a-ii-3-b: Set input to the history entry
            setInput(inputHistory[nextHistoryIndex]);
          }
        }
      }
    },
    [
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
      exit,
      fileProxy,
      setHistory,
      setActiveIndex,
      setScrollOffset,
      setInput,
      setHistIdx,
    ],
  );
