/**
 * Keyboard input hook for CLI interactions and commands.
 *
 * @remarks
 * This hook returns a callback function that can be passed to Ink's `useInput` hook.
 * It handles all keyboard input for the CLI, including:
 *
 * - **Ctrl+C**: Interrupt current task (requires double-press if task is running)
 * - **Ctrl+L**: Clear screen (exits and re-enters the CLI)
 * - **Ctrl+O**: Expand next folder in directory tree display
 * - **Arrow keys**: Navigate command history or autocomplete suggestions
 * - **Tab**: Autocomplete the current command
 *
 * The handler respects UI state — it ignores input when approval/prompt overlays
 * are active, and blocks text input during task execution.
 *
 * @example
 * ```tsx
 * const keyboardHandler = useKeyboardInput(context, { exit });
 * useInput(keyboardHandler);
 * ```
 */

import { useCallback } from "react";

import { formatErrorMessage } from "../../commands/utils.js";
import type { KeyboardInputContext, KeyboardInputHandlers } from "./types.js";
import {
  commandRequiresArgs,
  getCommandSuggestions,
} from "../commandCatalog.js";
import {
  AUTOCOMPLETE_SCROLL_TRIGGER_OFFSET,
  AUTOCOMPLETE_VISIBLE_COUNT,
} from "../constants.js";

/**
 * React hook that returns a keyboard input handler callback for Ink's `useInput`.
 *
 * @remarks
 * The returned callback is invoked by Ink for every key event. It uses
 * `useCallback` to maintain a stable reference across re-renders, preventing
 * the `useInput` hook from re-subscribing unnecessarily.
 *
 * @param context - Selected app state values and setters.
 * @param handlers - External functions for application actions.
 * @returns The key handler callback.
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
      // Ignore main input keys when blocking overlay prompt/approval dialogs are active.
      // These overlays have their own keyboard handlers and should receive all input.
      if (approval || promptReq) return;

      // Handle SIGINT / interrupt (Ctrl+C)
      if (keyInformation.ctrl && inputCharacter === "c") {
        if (busy) {
          // If task is running, require a second Ctrl+C to force exit.
          // This prevents accidental task interruption. The first press shows
          // a warning message ("Press Ctrl+C again to exit").
          setSigintBusy((sigintCounter) => {
            if (sigintCounter + 1 >= 2) {
              onSaveHistory(inputHistory);
              exit();
            }
            return sigintCounter + 1;
          });
        } else {
          // If no task is running, exit immediately on first Ctrl+C.
          onSaveHistory(inputHistory);
          exit();
        }
        return;
      }

      // Ctrl+L: Clear screen by exiting the CLI. Ink handles the reprint gracefully
      // when the user restarts, so this effectively clears the terminal.
      if (keyInformation.ctrl && inputCharacter === "l") {
        onSaveHistory(inputHistory);
        exit();
        return;
      }

      // Ctrl+O: Expand the next folder in the directory tree display.
      // This is a convenience shortcut for exploring the workspace without
      // typing file commands. Only works when not busy to avoid interrupting tasks.
      if (keyInformation.ctrl && inputCharacter === "o" && !busy) {
        void import("../../state/listExpandState.js").then(
          ({ peekUnexpanded }) => {
            const expandResult = peekUnexpanded();
            if (expandResult.found && expandResult.entry) {
              void fileProxy
                .expandDirectory(
                  expandResult.entry.absolutePath,
                  expandResult.entry.indent,
                )
                .catch((expansionError) => {
                  // If expansion fails, show an error message in the history.
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
          },
        );
        return;
      }

      // Prevent key inputs from modifying text state during active task execution.
      // This blocks autocomplete, history navigation, and text editing while a
      // task is running to avoid confusing the user or corrupting input state.
      if (busy) return;

      const commandSuggestions = getCommandSuggestions(input);

      // Handle autocomplete navigation if there are matching suggestions.
      // Arrow keys move the selection through the suggestion list, Tab fills
      // the selected command into the input field.
      if (commandSuggestions.length > 0) {
        if (keyInformation.upArrow) {
          setActiveIndex((previousActiveIndex) => {
            // Wrap around to the last item if at the top
            const newActiveIndex =
              previousActiveIndex <= 0
                ? commandSuggestions.length - 1
                : previousActiveIndex - 1;

            // Adjust scroll offset if the new selection is above the visible window.
            // This keeps the selected item visible when navigating up.
            if (newActiveIndex < scrollOffset) {
              setScrollOffset(newActiveIndex);
            }
            return newActiveIndex;
          });
          return;
        }

        if (keyInformation.downArrow) {
          setActiveIndex((previousActiveIndex) => {
            // Wrap around to the first item if at the bottom
            const newActiveIndex =
              previousActiveIndex >= commandSuggestions.length - 1
                ? 0
                : previousActiveIndex + 1;

            // Adjust scroll offset if the new selection is below the visible window.
            // We trigger scroll a bit before the bottom to show the next item coming.
            if (newActiveIndex >= scrollOffset + AUTOCOMPLETE_VISIBLE_COUNT) {
              setScrollOffset(
                newActiveIndex - AUTOCOMPLETE_SCROLL_TRIGGER_OFFSET,
              );
            }
            return newActiveIndex;
          });
          return;
        }

        if (keyInformation.tab) {
          // Fill the input with the selected command, adding a trailing space
          // if the command requires arguments (e.g., /file needs a path).
          const selectedSuggestion = commandSuggestions[activeIndex];
          if (selectedSuggestion) {
            setInput(
              selectedSuggestion.command +
                (commandRequiresArgs(selectedSuggestion.command) ? " " : ""),
            );
          }
          return;
        }
      } else {
        // No autocomplete suggestions: fall back to line input history navigation.
        // Arrow keys navigate through previously submitted commands.
        if (keyInformation.upArrow && inputHistory.length > 0) {
          // Start from the most recent command if not already navigating history.
          const nextHistoryIndex =
            histIdx < 0 ? inputHistory.length - 1 : Math.max(0, histIdx - 1);

          if (nextHistoryIndex >= 0 && nextHistoryIndex < inputHistory.length) {
            setHistIdx(nextHistoryIndex);
            setInput(inputHistory[nextHistoryIndex]);
          }
          return;
        }

        if (keyInformation.downArrow && histIdx >= 0) {
          const nextHistoryIndex = histIdx + 1;

          // If we go past the end of history, clear the input and reset the index.
          // This allows the user to type a new command after navigating history.
          if (nextHistoryIndex >= inputHistory.length) {
            setHistIdx(-1);
            setInput("");
          } else if (
            nextHistoryIndex >= 0 &&
            nextHistoryIndex < inputHistory.length
          ) {
            setHistIdx(nextHistoryIndex);
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
