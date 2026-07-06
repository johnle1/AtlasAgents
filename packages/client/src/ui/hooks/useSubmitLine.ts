/**
 * Command line submission handler hook for the CLI input box.
 *
 * @remarks
 * Handles executing special `/` commands via the CommandHandler, validates configuration
 * inputs, and runs task stream execution workflows when raw tasks are entered.
 */

import { useCallback, useRef } from "react";

import { formatErrorMessage } from "../../commands/utils.js";
import { loadConfig } from "../../config.js";
import type { AppContextValue } from "../../DataContext.js";
import { sanitizeHistoryLine } from "../historySanitize.js";
import { MAX_INPUT_HISTORY } from "../constants.js";
import { runTaskStream } from "../taskStream.js";

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
 * Hook returning a submission callback that processes text input on Enter press.
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
  // Lock to avoid double execution on duplicate quick clicks/Enters
  const submitLockRef = useRef(false);

  const submitHandler = useCallback(
    async (inputLine: string) => {
      const trimmedInputLine = inputLine.trim();

      if (submitLockRef.current) return;
      submitLockRef.current = true;

      // Don't execute anything if input is empty or if blocking interaction dialogs are open
      if (!trimmedInputLine.length || busy || approval || promptReq) {
        submitLockRef.current = false;
        return;
      }

      const sanitizedHistoryLine = sanitizeHistoryLine(trimmedInputLine);
      const updatedInputHistory = [...inputHistory, sanitizedHistoryLine].slice(
        -MAX_INPUT_HISTORY,
      );

      setInputHistory(updatedInputHistory);
      onInputHistoryRef.current = updatedInputHistory;
      setHistIdx(-1);
      setInput("");
      setBusy(true);

      try {
        // Attempt to run as a local command first (e.g., /help, /exit, /set)
        const wasCommandExecuted =
          await commandHandler.handle(trimmedInputLine);

        if (!wasCommandExecuted) {
          const taskConfiguration = loadConfig();

          // Validate LLM model configuration setup before launching a remote agent task
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
            await runTaskStream(connection, trimmedInputLine);
          }
        }
      } catch (executionError) {
        setHistory((previousHistory) => [
          ...previousHistory,
          {
            kind: "text",
            text: formatErrorMessage(executionError),
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

