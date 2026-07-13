/**
 * Command line submission handler hook for the CLI input box.
 *
 * @remarks
 * This hook returns a callback that processes text input when the user presses Enter.
 * It handles three types of input:
 *
 * 1. **Slash commands** (e.g., `/help`, `/exit`, `/set`) - Executed locally via CommandHandler
 * 2. **Raw tasks** (e.g., "write a hello world function") - Sent to the server for agent execution
 * 3. **Empty input** - Ignored
 *
 * Before executing a raw task, the hook validates that the advisor and agent models
 * are configured. If not, it shows an error message instead of attempting to connect.
 *
 * The hook includes a submission lock to prevent double-execution from rapid Enter presses,
 * and it manages input history persistence across CLI restarts.
 *
 * @example
 * ```tsx
 * const { submit } = useSubmitLine(context);
 * await submit("write a function");
 * ```
 */

import { useCallback, useRef } from "react";

import { formatErrorMessage } from "../../commands/utils.js";
import { loadConfig } from "../../config.js";
import type { SubmitLineContext } from "./types.js";
import { sanitizeHistoryLine } from "../historySanitize.js";
import { MAX_INPUT_HISTORY } from "../constants.js";
import { runTaskStream } from "../taskStream.js";

/**
 * Hook returning a submission callback that processes text input on Enter press.
 *
 * @remarks
 * The returned `submit` callback is typically registered with the React context
 * via `setHandleSubmit` so the InputBox component can invoke it on Enter.
 *
 * @param context - Selected app state values and setters.
 * @returns An object containing the `submit` callback and `submitLockRef`.
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
  // Lock to avoid double execution on duplicate quick clicks/Enters.
  // This prevents the same command from being submitted twice if the user
  // presses Enter rapidly or if there are multiple event handlers.
  const submitLockRef = useRef(false);

  const submitHandler = useCallback(
    async (inputLine: string) => {
      const trimmedInputLine = inputLine.trim();

      // Acquire the submission lock. If already locked, another submission is
      // in progress, so we ignore this one to prevent double-execution.
      if (submitLockRef.current) return;
      submitLockRef.current = true;

      // Don't execute anything if input is empty or if blocking interaction dialogs are open.
      // This prevents submitting commands while the user is responding to an approval
      // or prompt, which could lead to confusing state.
      if (!trimmedInputLine.length || busy || approval || promptReq) {
        submitLockRef.current = false;
        return;
      }

      // Sanitize the input line before adding to history (removes sensitive data like API keys).
      // Then truncate history to MAX_INPUT_HISTORY to prevent unbounded memory growth.
      const sanitizedHistoryLine = sanitizeHistoryLine(trimmedInputLine);
      const updatedInputHistory = [...inputHistory, sanitizedHistoryLine].slice(
        -MAX_INPUT_HISTORY,
      );

      // Update both React state and the external ref (used by BootstrapApp on exit).
      // This ensures history is persisted even if the component unmounts unexpectedly.
      setInputHistory(updatedInputHistory);
      onInputHistoryRef.current = updatedInputHistory;

      // Reset input state: clear the input field, reset history navigation index,
      // and set busy flag to show the user that work is in progress.
      setHistIdx(-1);
      setInput("");
      setBusy(true);

      try {
        // Attempt to run as a local command first (e.g., /help, /exit, /set).
        // CommandHandler.handle returns true if it handled the command, false if not.
        const wasCommandExecuted =
          await commandHandler.handle(trimmedInputLine);

        if (!wasCommandExecuted) {
          // If not a local command, treat it as a raw task to send to the server.
          // First validate that the required LLM models are configured.
          const taskConfiguration = loadConfig();

          // Validate LLM model configuration setup before launching a remote agent task.
          // Without these models configured, the server cannot execute the task, so we
          // fail fast with a helpful error message instead of attempting to connect.
          if (
            !(taskConfiguration.advisorModel ?? "").trim() ||
            !(taskConfiguration.agentModel ?? "").trim()
          ) {
            setHistory((previousHistory) => [
              ...previousHistory,
              {
                kind: "text",
                text: "Advisor and agent models must be set. Use /set advisor and /set agent.",
                variant: "error",
              },
            ]);
          } else {
            // Models are configured, so send the task to the server for agent execution.
            // runTaskStream handles the full workflow: sending the task, streaming
            // the response, and updating the UI with progress and results.
            await runTaskStream(connection, trimmedInputLine);
          }
        }
      } catch (executionError) {
        // If anything fails during command or task execution, show an error message
        // in the history so the user knows what went wrong. The error is formatted
        // to be user-friendly (e.g., "Connection refused" instead of a stack trace).
        setHistory((previousHistory) => [
          ...previousHistory,
          {
            kind: "text",
            text: formatErrorMessage(executionError),
            variant: "error",
          },
        ]);
      } finally {
        // Always release the submission lock and reset UI state, even if an error occurred.
        // This ensures the UI is ready for the next command regardless of success/failure.
        submitLockRef.current = false;
        setBusy(false);
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

  return { submit: submitHandler, submitLockRef };
};
