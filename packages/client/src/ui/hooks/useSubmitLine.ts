/**
 * Command line submission handler hook for the CLI input box.
 *
 * @remarks
 * This hook returns a callback that processes text input when the user presses Enter.
 * It handles these kinds of input:
 *
 * 1. **Bang shell** (`!ls`) — local `runShell`, never sent to the agent
 * 2. **Slash commands** (e.g., `/help`, `/exit`, `/set`) - Executed locally via CommandHandler
 * 3. **Raw tasks** (e.g., "write a hello world function") - Sent to the server for subagent execution
 * 4. **Queued lines** — while a task is running, Enter enqueues instead of submitting
 * 5. **Empty input** - Ignored
 *
 * `@path` mentions in a raw task are expanded (file/dir inlined) before the
 * line is sent. Secret-ish files such as `.env` are refused with an inline error.
 *
 * Before executing a raw task, the hook validates that the agent and subagent models
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
import { loadConfig } from "../../config/index.js";
import {
  handleBang,
  parseBang,
} from "../../commands/shellPassthrough.js";
import { runShell } from "../../fileProxy/shellRunner.js";
import type { SubmitLineContext } from "./types.js";
import { sanitizeHistoryLine } from "../historySanitize.js";
import { MAX_INPUT_HISTORY } from "../constants.js";
import { runTaskStream } from "../taskStream.js";
import { requestApproval } from "../uiBridge.js";
import {
  dequeueSessionMessage,
  enqueueSessionMessage,
} from "../queue/messageQueue.js";
import {
  expandMentions,
  resolverFromFileProxy,
} from "../mentions/expand.js";

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
  fileProxy,
  setQueuedMessages,
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
      if (!trimmedInputLine.length || approval || promptReq) {
        submitLockRef.current = false;
        return;
      }

      if (busy) {
        const queued = enqueueSessionMessage(trimmedInputLine);
        setQueuedMessages(queued.items);
        setInput("");
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
        const bangCommand = parseBang(trimmedInputLine);
        if (bangCommand !== null) {
          const taskConfiguration = loadConfig();
          const entries = await handleBang({
            command: bangCommand,
            runShell,
            cwd: fileProxy.getCwd(),
            timeoutMs: taskConfiguration.shellTimeoutMs,
            classifyCommand: fileProxy.classifyCommand,
            requestApproval: async (command) => {
              const decision = await requestApproval({
                type: "runSkip",
                command,
              });
              return decision === true;
            },
          });
          setHistory((previousHistory) => [...previousHistory, ...entries]);
        } else {
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
              !(taskConfiguration.agentModel ?? "").trim() ||
              !(taskConfiguration.subagentModel ?? "").trim()
            ) {
              setHistory((previousHistory) => [
                ...previousHistory,
                {
                  kind: "text",
                  text: "Agent and subagent models must be set. Use /set agent and /set subagent.",
                  variant: "error",
                },
              ]);
            } else {
              const { text: expanded } = await expandMentions(
                trimmedInputLine,
                resolverFromFileProxy(fileProxy),
              );
              await runTaskStream(connection, expanded);
            }
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
        const drained = dequeueSessionMessage();
        setQueuedMessages(drained.state.items);
        if (drained.next) {
          void submitHandler(drained.next);
        }
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
      fileProxy,
      setQueuedMessages,
    ],
  );

  return { submit: submitHandler, submitLockRef };
};
