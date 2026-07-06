/**
 * Keyboard input hook for CLI interactions and commands.
 *
 * @remarks
 * Listens for key events inside the Ink environment and maps them to input updates,
 * command history navigation, autocomplete suggestions, or key combinations (like Ctrl+C, Ctrl+L, Ctrl+O).
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

type KeyboardInputHandlers = {
  /** Function to exit the application. */
  exit: () => void;
};

/**
 * React hook that returns a keyboard input handler callback for Ink's `useInput`.
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
      // Ignore main input keys when blocking overlay prompt/approval dialogs are active
      if (approval || promptReq) return;

      // Handle SIGINT / interrupt
      if (keyInformation.ctrl && inputCharacter === "c") {
        if (busy) {
          // If task is running, require a second Ctrl+C to force exit
          setSigintBusy((sigintCounter) => {
            if (sigintCounter + 1 >= 2) {
              onSaveHistory(inputHistory);
              exit();
            }
            return sigintCounter + 1;
          });
        } else {
          onSaveHistory(inputHistory);
          exit();
        }
        return;
      }

      // Ctrl+L: Clear screen by exiting (Ink handles the reprint gracefully)
      if (keyInformation.ctrl && inputCharacter === "l") {
        onSaveHistory(inputHistory);
        exit();
        return;
      }

      // Ctrl+O: Expand the next folder in the directory tree display
      if (keyInformation.ctrl && inputCharacter === "o" && !busy) {
        void import("../../listExpandState.js").then(({ peekUnexpanded }) => {
          const expandResult = peekUnexpanded();
          if (expandResult.found && expandResult.entry) {
            void fileProxy
              .expandDirectory(
                expandResult.entry.absolutePath,
                expandResult.entry.indent,
              )
              .catch((expansionError) => {
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

      // Prevent key inputs from modifying text state during active task execution
      if (busy) return;

      const commandSuggestions = getCommandSuggestions(input);

      // Handle autocomplete navigation if there are matching suggestions
      if (commandSuggestions.length > 0) {
        if (keyInformation.upArrow) {
          setActiveIndex((previousActiveIndex) => {
            const newActiveIndex =
              previousActiveIndex <= 0
                ? commandSuggestions.length - 1
                : previousActiveIndex - 1;

            if (newActiveIndex < scrollOffset) {
              setScrollOffset(newActiveIndex);
            }
            return newActiveIndex;
          });
          return;
        }

        if (keyInformation.downArrow) {
          setActiveIndex((previousActiveIndex) => {
            const newActiveIndex =
              previousActiveIndex >= commandSuggestions.length - 1
                ? 0
                : previousActiveIndex + 1;

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
        // Fall back to line input history navigation
        if (keyInformation.upArrow && inputHistory.length > 0) {
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

