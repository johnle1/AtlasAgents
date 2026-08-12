/**
 * Pure keyboard-input handler for the Ink CLI.
 *
 * @remarks
 * Extracted from {@link useKeyboardInput} so the key contract can be unit-tested
 * without rendering an Ink tree. The React hook is a thin `useMemo` wrapper
 * around {@link createKeyHandler}.
 *
 * Contract (gemini-cli-aligned):
 * - Esc while busy → cancel the running task; CLI stays alive
 * - Esc while idle → clear the input buffer (no-op if empty)
 * - Ctrl+C while busy → cancel + warn; second press force-quits
 * - Ctrl+C idle + non-empty input → clear input; idle + empty → exit
 * - Ctrl+L → clear the screen (never exits)
 *
 * Overlay prompts (`approval` / `promptReq`) own their own keys; this handler
 * returns immediately while they are active.
 */

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
 * Keys this handler consumes. Kept in sync with {@link SHORTCUT_CATALOG}
 * (see `ui/shortcutCatalog.ts`) so the cheat-sheet cannot drift from behavior.
 */
export const HANDLED_KEYS = [
  "escape",
  "ctrl+c",
  "ctrl+l",
  "ctrl+o",
  "tab",
  "up",
  "down",
  "?",
] as const;

/**
 * Ink `useInput` key flags this handler reads.
 *
 * @remarks
 * `escape` is the Phase 1 addition — Ink sets it for Esc / Ctrl+[.
 */
export type KeyInformation = {
  ctrl?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  tab?: boolean;
  escape?: boolean;
};

/**
 * Builds a key-event callback for Ink's `useInput`.
 *
 * @param context - Selected app state values and setters.
 * @param handlers - External actions (exit, cancel task, clear screen).
 * @returns The key handler callback.
 *
 * @example
 * ```ts
 * const handle = createKeyHandler(context, {
 *   exit,
 *   cancelActiveTask,
 *   clearScreen,
 * });
 * handle("c", { ctrl: true });
 * ```
 */
export const createKeyHandler = (
  {
    approval,
    promptReq,
    busy,
    inputHistory,
    histIdx,
    input,
    activeIndex,
    scrollOffset,
    sigintBusy,
    setSigintBusy,
    onSaveHistory,
    fileProxy,
    setHistory,
    setActiveIndex,
    setScrollOffset,
    setInput,
    setHistIdx,
    showShortcuts,
    setShowShortcuts,
  }: KeyboardInputContext,
  { exit, cancelActiveTask, clearScreen }: KeyboardInputHandlers,
) =>
  (
    inputCharacter: string,
    keyInformation: KeyInformation,
  ): void => {
    // Overlays own the keyboard; do not steal Esc/Ctrl+C from them.
    if (approval || promptReq) return;

    if (keyInformation.escape) {
      if (busy) {
        cancelActiveTask();
        return;
      }
      if (input.length > 0) {
        setInput("");
      }
      return;
    }

    if (keyInformation.ctrl && inputCharacter === "c") {
      if (busy) {
        cancelActiveTask();
        if (sigintBusy >= 1) {
          onSaveHistory(inputHistory);
          exit();
        } else {
          setSigintBusy(1);
        }
        return;
      }
      if (input.length > 0) {
        setInput("");
        return;
      }
      onSaveHistory(inputHistory);
      exit();
      return;
    }

    if (keyInformation.ctrl && inputCharacter === "l") {
      clearScreen();
      return;
    }

    // Shortcuts panel: `?` on empty input toggles it; any other key closes it.
    if (setShowShortcuts) {
      if (showShortcuts) {
        setShowShortcuts(false);
        return;
      }
      if (
        inputCharacter === "?" &&
        input.length === 0 &&
        !busy &&
        !keyInformation.ctrl
      ) {
        setShowShortcuts(true);
        setInput("");
        return;
      }
    }

    if (busy) return;

    if (keyInformation.ctrl && inputCharacter === "o") {
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

    const commandSuggestions = getCommandSuggestions(input);

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
      if (keyInformation.upArrow && inputHistory.length > 0) {
        const nextHistoryIndex =
          histIdx < 0 ? inputHistory.length - 1 : Math.max(0, histIdx - 1);

        if (nextHistoryIndex >= 0 && nextHistoryIndex < inputHistory.length) {
          setHistIdx(nextHistoryIndex);
          setInput(inputHistory[nextHistoryIndex]!);
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
          setInput(inputHistory[nextHistoryIndex]!);
        }
      }
    }
  };
