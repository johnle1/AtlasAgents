/**
 * <Summary>
 * What it does:
 *   React hook that sets up the bridge system between server communication
 *   and the Ink-based UI, registering state update callbacks and configuring
 *   terminal features like alternate screen mode.
 *
 * How it fits in the system:
 *   This hook is called in the AppContent component to establish the communication
 *   bridge between server-side code and the React UI. It registers callbacks for
 * all state updates (history, streaming, agent status, approvals, etc.) and manages
 *   terminal mode settings for the Ink UI.
 *
 * Dependencies:
 *   - React hooks — useEffect, useRef for lifecycle management.
 *   - loadConfig — loads application configuration.
 *   - buildPromptLabel — builds the prompt label for display.
 *   - buildBannerLines — generates the UI banner lines.
 *   - enterAlternateScreen/exitAlternateScreen — manage terminal alternate screen.
 *   - registerBridgeHooks — registers state update callbacks.
 *   - registerStreamingHandler — registers streaming token handler.
 *   - setInkActive — manages Ink UI active state.
 *
 * Dependants:
 *   - AppContent component — calls this hook to set up the bridge system.
 * </Summary>
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
  setInkActive,
} from "../uiBridge.js";

/**
 * <Summary>
 * What it does:
 *   Defines the subset of AppContextValue needed for bridge setup.
 *
 * Used by:
 *   - useBridgeSetup hook — receives these dependencies.
 *
 * Produced by:
 *   - AppContext — provides these state setter functions.
 * </Summary>
 */
type BridgeSetupContext = Pick<
  AppContextValue,
  | "setHistory"
  | "setStreamingText"
  | "setSpinner"
  | "setBusy"
  | "setPrompt"
  | "setApproval"
  | "setPromptReq"
  | "setBannerEntries"
  | "setAgentStatuses"
  | "setAgentBoards"
>;

/**
 * <Summary>
 * What it does:
 *   Sets up the bridge system by registering state update callbacks and
 *   configuring terminal features.
 *
 * How it does it (step by step):
 *   1. Creates a ref to track alternate screen mode usage.
 *   2. On mount, activates Ink UI and loads configuration.
 *   3. Checks config for alternate screen mode preference.
 *   4. Enters alternate screen mode if configured.
 *   5. Registers bridge hooks for all state updates.
 *   6. Registers streaming handler for token processing.
 *   7. On unmount, deactivates Ink UI and cleans up registrations.
 *   8. Exits alternate screen mode if it was used.
 *
 * Parameters:
 *   @param {BridgeSetupContext} bridgeSetupDependencies — State setter functions from context.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - React hooks — useEffect, useRef for lifecycle management.
 *   - Configuration system — loads and checks config settings.
 *   - Bridge system — registers hooks and handlers.
 *
 * Dependants:
 *   - AppContent component — calls this hook during component render.
 * </Summary>
 */
export const useBridgeSetup = ({
  setHistory,
  setStreamingText,
  setSpinner,
  setBusy,
  setPrompt,
  setApproval,
  setPromptReq,
  setBannerEntries,
  setAgentStatuses,
  setAgentBoards,
}: BridgeSetupContext): void => {
  // ===== STEP 1: Create Ref for Alternate Screen Tracking =====
  // Step 1a: Create a ref to track whether alternate screen mode is in use
  // Step 1b: This ref persists across re-renders to ensure proper cleanup
  const useAlternateScreenRef = useRef(false);

  // ===== STEP 2: Setup Bridge System on Mount =====
  useEffect(() => {
    // ===== STEP 2a: Activate Ink UI =====
    // Step 2a-i: Set Ink UI active flag to enable bridge communication
    setInkActive(true);

    // ===== STEP 2b: Load Configuration =====
    // Step 2b-i: Load the application configuration
    // Step 2b-ii: Check if alternate screen mode is enabled in config
    const applicationConfig = loadConfig();
    useAlternateScreenRef.current =
      applicationConfig.ui?.useAlternateBuffer === true;

    // ===== STEP 2c: Enter Alternate Screen Mode if Configured =====
    // Step 2c-i: If alternate screen mode is enabled, enter it
    // Step 2c-ii: This provides a full-screen UI without scrollback
    if (useAlternateScreenRef.current) {
      enterAlternateScreen();
    }

    // ===== STEP 2d: Register Bridge Hooks =====
    // Step 2d-i: Register callbacks for all state update notifications
    // Step 2d-ii: This connects server-side events to UI state updates
    registerBridgeHooks({
      // History append handler
      onHistoryAppend: (historyItem) =>
        setHistory((previousHistory) => [...previousHistory, historyItem]),
      // Streaming text handler
      onStreamingSet: (streamingText) => setStreamingText(streamingText),
      // Spinner state handler
      onSpinner: (spinnerState) => setSpinner(spinnerState),
      // Busy state handler
      onBusy: (isBusy) => setBusy(isBusy),
      // Working directory change handler
      onCwd: (currentWorkingDirectory) =>
        setPrompt(buildPromptLabel(currentWorkingDirectory)),
      // Approval request change handler
      onApprovalChange: (approvalRequest) => setApproval(approvalRequest),
      // Prompt request change handler
      onPromptChange: (promptRequest) => setPromptReq(promptRequest),
      // Banner refresh handler
      onBannerRefresh: (configuration) =>
        setBannerEntries(
          buildBannerLines(configuration).map((bannerLine, lineIndex) => ({
            kind: "banner" as const,
            key: `banner-${lineIndex}`,
            line: bannerLine,
          })),
        ),
      // Agent statuses update handler
      onAgentStatuses: (statusUpdater) => setAgentStatuses(statusUpdater),
      // Agent boards update handler
      onAgentBoards: (boardUpdater) => setAgentBoards(boardUpdater),
    });

    // ===== STEP 2e: Register Streaming Token Handler =====
    // Step 2e-i: Register a handler for streaming tokens from the server
    // Step 2e-ii: This handler appends tokens to the current streaming text
    registerStreamingHandler((streamingToken) => {
      setStreamingText(
        (previousStreamingText) =>
          (previousStreamingText ?? "") + streamingToken,
      );
    });

    // ===== STEP 3: Cleanup on Unmount =====
    // Step 3a: Return cleanup function to run on component unmount
    return () => {
      // Step 3a-i: Deactivate Ink UI
      setInkActive(false);

      // Step 3a-ii: Clear bridge hooks to prevent memory leaks
      registerBridgeHooks({});

      // Step 3a-iii: Clear streaming handler
      registerStreamingHandler(null);

      // Step 3a-iv: Exit alternate screen mode if it was used
      // Step 3a-iv-1: This restores normal terminal display
      if (useAlternateScreenRef.current) {
        exitAlternateScreen();
      }
    };
  }, [
    setHistory,
    setStreamingText,
    setSpinner,
    setBusy,
    setPrompt,
    setApproval,
    setPromptReq,
    setBannerEntries,
    setAgentStatuses,
    setAgentBoards,
  ]);
};
