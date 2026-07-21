/**
 * React hook that sets up the bridge system between server communication and the Ink-based UI.
 *
 * @remarks
 * This hook is the single point of integration between the RSocket server connection
 * and the React UI state. It registers bridge hooks that allow non-React code (server
 * RPC handlers, agent logic) to trigger React state updates. It also manages the
 * terminal's alternate screen buffer mode, which provides a full-screen TUI experience.
 *
 * The bridge hooks registered here are invoked by functions in `uiBridge.ts` when
 * the server sends messages (e.g., history append, spinner update, agent status).
 * This decouples server-side code from React — server code calls bridge functions,
 * which invoke the registered hooks, which update React state.
 *
 * @example
 * ```tsx
 * useBridgeSetup({
 *   setHistory,
 *   setStreamingText,
 *   setSpinner,
 *   setBusy,
 *   setTaskActive,
 *   setPrompt,
 *   setApproval,
 *   setPromptReq,
 *   setBannerEntries,
 *   setSubagentStatuses,
 *   setSubagentBoards,
 * });
 * ```
 */

import { useEffect, useRef } from "react";

import { loadConfig } from "../../config.js";
import { buildPromptLabel } from "../../pathDisplay.js";
import { buildBannerLines } from "../../renderer/banner.js";
import type { BridgeSetupContext } from "./types.js";
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

/**
 * Hook to initialize and clean up global event listener hooks linking server RSocket frames to React state.
 *
 * @remarks
 * This hook runs once on mount and cleans up on unmount. It:
 * 1. Activates the Ink UI bridge so server code knows the UI is ready
 * 2. Enters alternate screen mode if configured (full-screen TUI)
 * 3. Registers bridge hooks that map server messages to React state updates
 * 4. Registers a streaming token handler for LLM response streaming
 * 5. On cleanup: deactivates the bridge, resets state, and exits alternate mode
 *
 * The alternate screen buffer is a terminal feature that saves the current screen
 * content to a separate buffer and switches to a new buffer. When the app exits,
 * the original buffer is restored, making it look like the TUI never happened.
 * This provides a clean full-screen experience without scrolling the user's
 * terminal history.
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
  setSubagentStatuses,
  setSubagentBoards,
}: BridgeSetupContext): void => {
  // Track whether we entered alternate screen mode so we can exit it on cleanup.
  // Using a ref instead of state avoids triggering re-renders when this changes.
  const useAlternateScreenRef = useRef(false);

  useEffect(() => {
    // Activate the Ink UI bridge so server-side code knows the React UI is ready.
    // This is checked by functions like requestApproval and requestPrompt to decide
    // whether to show interactive prompts or resolve with defaults.
    setInkActive(true);

    // Load config to check if the user wants alternate screen mode (full-screen TUI).
    // This is a user preference that can be set via /set ui.useAlternateBuffer true.
    const applicationConfig = loadConfig();
    useAlternateScreenRef.current =
      applicationConfig.ui?.useAlternateBuffer === true;

    // Enter alternate screen mode if configured. This switches to a new terminal
    // buffer, saving the current screen content. When we exit, the original buffer
    // is restored, providing a clean full-screen experience.
    if (useAlternateScreenRef.current) {
      enterAlternateScreen();
    }

    // Register the bridge hooks that map server messages to React state updates.
    // Each hook is invoked by a corresponding function in uiBridge.ts when the
    // server sends an RSocket message. For example, when the server sends a history
    // append message, uiBridge.appendHistory calls onHistoryAppend, which updates
    // the React history state.
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
      onSubagentStatuses: (statusUpdater) => setSubagentStatuses(statusUpdater),
      onSubagentBoards: (boardUpdater) => setSubagentBoards(boardUpdater),
    });

    // Register the streaming token handler for LLM response streaming.
    // When the server streams tokens (e.g., during an subagent response), this handler
    // appends each token to the streaming text state. The UI renders this as
    // progressively updating text below the history.
    registerStreamingHandler((streamingToken) => {
      setStreamingText(
        (previousStreamingText) =>
          (previousStreamingText ?? "") + streamingToken,
      );
    });

    return () => {
      // Deactivate the Ink UI bridge so server code knows the UI is no longer available.
      // This causes functions like requestApproval to resolve with defaults instead
      // of waiting for user input.
      setInkActive(false);

      // Reset bridge state properties before unregistering hooks. This prevents
      // the UI from getting stuck in a busy/loading state if the component unmounts
      // mid-task (e.g., due to a connection error or user exit).
      resetBridgeTaskActive(false);
      resetBridgeBusy(false);
      resetBridgeSpinner(null);

      // Unregister the bridge hooks and streaming handler to prevent memory leaks
      // and stale callbacks. Passing an empty object clears all registered hooks.
      registerBridgeHooks({});
      registerStreamingHandler(null);

      // Exit alternate screen mode if we entered it, restoring the original terminal
      // buffer. This makes the TUI disappear cleanly without leaving artifacts.
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
    setSubagentStatuses,
    setSubagentBoards,
  ]);
};
