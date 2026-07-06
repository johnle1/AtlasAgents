/**
 * React hook that sets up the bridge system between server communication and the Ink-based UI.
 *
 * @remarks
 * Connects incoming RSocket messages to React state setters, registers streaming handlers,
 * and controls full-screen alternate buffer entry/exit based on user configuration.
 */

import { useEffect, useRef } from "react";

import { loadConfig } from "../../config.js";
import { buildPromptLabel } from "../../pathDisplay.js";
import { buildBannerLines } from "../../renderer/banner.js";
import type { AppContextValue } from "../../DataContext.js";
import {
  enterAlternateScreen,
  exitAlternateScreen,
  registerBridgeHooks,
  registerStreamingHandler,
  setBusy as resetBridgeBusy,
  setInkActive,
  setSpinner as resetBridgeSpinner,
  setTaskActive as resetBridgeTaskActive,
} from "../uiBridge.js";

type BridgeSetupContext = Pick<
  AppContextValue,
  | "setHistory"
  | "setStreamingText"
  | "setSpinner"
  | "setBusy"
  | "setTaskActive"
  | "setPrompt"
  | "setApproval"
  | "setPromptReq"
  | "setBannerEntries"
  | "setAgentStatuses"
  | "setAgentBoards"
>;

/**
 * Hook to initialize and clean up global event listener hooks linking server RSocket frames to React state.
 *
 * @param context - Picked state setters from the app context.
 */
export const useBridgeSetup = ({
  setHistory,
  setStreamingText,
  setSpinner,
  setBusy,
  setTaskActive,
  setPrompt,
  setApproval,
  setPromptReq,
  setBannerEntries,
  setAgentStatuses,
  setAgentBoards,
}: BridgeSetupContext): void => {
  const useAlternateScreenRef = useRef(false);

  useEffect(() => {
    setInkActive(true);

    const applicationConfig = loadConfig();
    useAlternateScreenRef.current =
      applicationConfig.ui?.useAlternateBuffer === true;

    if (useAlternateScreenRef.current) {
      enterAlternateScreen();
    }

    registerBridgeHooks({
      onHistoryAppend: (historyItem) =>
        setHistory((previousHistory) => [...previousHistory, historyItem]),
      onStreamingSet: (streamingText) => setStreamingText(streamingText),
      onSpinner: (spinnerState) => setSpinner(spinnerState),
      onBusy: (isBusy) => setBusy(isBusy),
      onTaskActive: (isTaskActive) => setTaskActive(isTaskActive),
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
      onAgentStatuses: (statusUpdater) => setAgentStatuses(statusUpdater),
      onAgentBoards: (boardUpdater) => setAgentBoards(boardUpdater),
    });

    registerStreamingHandler((streamingToken) => {
      setStreamingText(
        (previousStreamingText) =>
          (previousStreamingText ?? "") + streamingToken,
      );
    });

    return () => {
      setInkActive(false);

      // Reset state properties before hooks are unregistered to avoid locking UI
      resetBridgeTaskActive(false);
      resetBridgeBusy(false);
      resetBridgeSpinner(null);

      registerBridgeHooks({});
      registerStreamingHandler(null);

      if (useAlternateScreenRef.current) {
        exitAlternateScreen();
      }
    };
  }, [
    setHistory,
    setStreamingText,
    setSpinner,
    setBusy,
    setTaskActive,
    setPrompt,
    setApproval,
    setPromptReq,
    setBannerEntries,
    setAgentStatuses,
    setAgentBoards,
  ]);
};

