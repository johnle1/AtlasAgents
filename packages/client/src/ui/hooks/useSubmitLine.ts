/**
 * <Summary>
 * What it does:
 *   React hook that handles submission of command lines from the input box,
 *   including command history management, command execution, and task streaming.
 *
 * How it fits in the system:
 *   This hook is called when the user presses Enter in the input box to submit
 *   a command. It manages the command history, executes commands through the
 *   command handler, or streams tasks to the server if the input is not a command.
 *   It also handles error display and manages the busy state during execution.
 *
 * Dependencies:
 *   - React hooks — useCallback for memoization, useRef for submit lock.
 *   - formatErrorMessage — formats error messages for display.
 *   - loadConfig — loads application configuration.
 *   - sanitizeHistoryLine — sanitizes input before adding to history.
 *   - MAX_INPUT_HISTORY — maximum number of history entries to keep.
 *   - runTaskStream — streams tasks to the server.
 *
 * Dependants:
 *   - AppContent component — uses this hook to handle command submission.
 * </Summary>
 */

import { useCallback, useRef } from "react";

import { formatErrorMessage } from "../../commands/utils.js";
import { loadConfig } from "../../config.js";
import type { AppContextValue } from "../../DataContext.js";
import { sanitizeHistoryLine } from "../historySanitize.js";
import { MAX_INPUT_HISTORY } from "../constants.js";
import { runTaskStream } from "../taskStream.js";

/**
 * <Summary>
 * What it does:
 *   Defines the subset of AppContextValue needed for line submission handling.
 *
 * Used by:
 *   - useSubmitLine hook — receives these dependencies.
 *
 * Produced by:
 *   - AppContext — provides these state values and setter functions.
 * </Summary>
 */
type SubmitLineContext = Pick<
  AppContextValue,
  | "busy"
  | "approval"
  | "promptReq"
  | "inputHistory"
  | "setInputHistory"
  | "onInputHistoryRef"
  | "setHistIdx"
  | "setInput"
  | "setBusy"
  | "setHistory"
  | "setSigintBusy"
  | "connection"
  | "commandHandler"
>;

/**
 * <Summary>
 * What it does:
 *   Creates a line submission handler that processes command input and manages
 *   the execution workflow.
 *
 * How it does it (step by step):
 *   1. Checks submit lock to prevent duplicate submissions.
 *   2. Validates input and checks blocking states (busy, approval, prompt).
 *   3. Sanitizes and adds input to command history.
 *   4. Sets busy state and resets input.
 *   5. Attempts to execute as a command through command handler.
 *   6. If not a command, validates model configuration.
 *   7. If models are configured, streams task to server.
 *   8. Handles errors by displaying them in history.
 *   9. Releases submit lock and resets busy state in finally block.
 *
 * Parameters:
 *   @param {SubmitLineContext} submitLineDependencies — State and setters from context.
 *
 * Returns:
 *   @returns {{ submit: Function, submitLockRef: React.RefObject<boolean> }} — The submit handler and lock ref.
 *
 * Dependencies:
 *   - React hooks — useCallback for memoization, useRef for submit lock.
 *   - Command utilities — for command execution and error formatting.
 *   - Task streaming — for non-command input handling.
 *
 * Dependants:
 *   - AppContent component — uses this hook to handle command submission.
 * </Summary>
 */
export const useSubmitLine = ({
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
}: SubmitLineContext) => {
  // ===== STEP 1: Create Submit Lock Ref =====
  // Step 1a: Create a ref to track if a submission is in progress
  // Step 1b: This prevents duplicate submissions (e.g., rapid Enter presses)
  const submitLockRef = useRef(false);

  // ===== STEP 2: Create Submit Handler =====
  const submitHandler = useCallback(
    async (inputLine: string) => {
      // ===== STEP 2a: Trim Input Line =====
      // Step 2a-i: Remove leading/trailing whitespace from input
      const trimmedInputLine = inputLine.trim();

      // ===== STEP 2b: Check Submit Lock =====
      // Step 2b-i: If submission is already in progress, return immediately
      // Step 2b-ii: This prevents duplicate submissions
      if (submitLockRef.current) return;

      // Step 2b-iii: Set submit lock to true
      submitLockRef.current = true;

      // ===== STEP 2c: Validate Input and Check Blocking States =====
      // Step 2c-i: Check if input is empty or blocking states are active
      // Step 2c-ii: If so, release lock and return without submitting
      if (!trimmedInputLine.length || busy || approval || promptReq) {
        submitLockRef.current = false;
        return;
      }

      // ===== STEP 2d: Add to Command History =====
      // Step 2d-i: Sanitize the input line before adding to history
      const sanitizedHistoryLine = sanitizeHistoryLine(trimmedInputLine);

      // Step 2d-ii: Create new history array with the new entry
      // Step 2d-iii: Keep only the last MAX_INPUT_HISTORY entries
      const updatedInputHistory = [...inputHistory, sanitizedHistoryLine].slice(
        -MAX_INPUT_HISTORY,
      );

      // Step 2d-iv: Update input history state
      setInputHistory(updatedInputHistory);

      // Step 2d-v: Update the ref for history persistence
      onInputHistoryRef.current = updatedInputHistory;

      // Step 2d-vi: Reset history index to -1 (newest)
      setHistIdx(-1);

      // Step 2d-vii: Clear the input box
      setInput("");

      // Step 2d-viii: Set busy state to indicate operation is in progress
      setBusy(true);

      // ===== STEP 2e: Execute Command or Stream Task =====
      try {
        // ===== STEP 2e-i: Try to Execute as Command =====
        // Step 2e-i-1: Attempt to handle the input as a command
        const wasCommandExecuted =
          await commandHandler.handle(trimmedInputLine);

        // ===== STEP 2e-ii: Handle Non-Command Input =====
        if (!wasCommandExecuted) {
          // Step 2e-ii-1: Load task configuration
          const taskConfiguration = loadConfig();

          // Step 2e-ii-2: Validate model configuration
          // Step 2e-ii-2-a: Check if advisor and agent models are set
          if (
            !(taskConfiguration.advisorModel ?? "").trim() ||
            !(taskConfiguration.agentModel ?? "").trim()
          ) {
            // Step 2e-ii-2-a-1: Display error if models not configured
            setHistory((previousHistory) => [
              ...previousHistory,
              {
                kind: "text",
                text: "Advisor and agent models must be set. Use /set advisor and /set agent.",
                variant: "error",
              },
            ]);
          } else {
            // Step 2e-ii-2-b: Stream task to server
            // Step 2e-ii-2-b-1: Input is not a command, so stream as a task
            await runTaskStream(connection, trimmedInputLine);
          }
        }
      } catch (executionError) {
        // ===== STEP 2e-iii: Handle Execution Errors =====
        // Step 2e-iii-1: Display error message in history
        setHistory((previousHistory) => [
          ...previousHistory,
          {
            kind: "text",
            text: formatErrorMessage(executionError),
            variant: "error",
          },
        ]);
      } finally {
        // ===== STEP 2f: Cleanup After Execution =====
        // Step 2f-i: Release submit lock to allow new submissions
        submitLockRef.current = false;

        // Step 2f-ii: Clear busy state to indicate operation is complete
        setBusy(false);

        // Step 2f-iii: Reset SIGINT counter
        setSigintBusy(0);
      }
    },
    [
      approval,
      promptReq,
      busy,
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
    ],
  );

  // ===== STEP 3: Return Handler and Lock Ref =====
  return { submit: submitHandler, submitLockRef };
};
