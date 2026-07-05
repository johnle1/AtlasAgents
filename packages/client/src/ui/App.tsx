/**
 * Main Ink application shell: context provider, layout, and input wiring.
 *
 * @remarks
 * {@link App} wraps {@link AppContent} with {@link AppProvider}. All server
 * → UI traffic flows through {@link useBridgeSetup}; keyboard and submit
 * logic live in dedicated hooks so this file stays focused on composition.
 */
import React, { useCallback, useEffect, useMemo } from "react";
import { useApp, useInput } from "ink";
import { Box, Static, Text } from "ink";

import { AppProvider, useAppContext } from "../DataContext.js";
import { HistoryView, renderHistoryItem } from "./components/HistoryView.js";
import { StatusSpinner } from "./components/Spinner.js";
import { ConnectionStatusLine } from "./components/ConnectionStatusLine.js";
import { InputBox } from "./components/InputBox.js";
import { ApprovalMenu } from "./components/ApprovalMenu.js";
import { PromptOverlay } from "./components/PromptOverlay.js";
import { AgentTaskBoard } from "./components/AgentTaskBoard.js";
import type { AppProps } from "./types.js";
import {
  commandRequiresArgs,
  getCommandDescription,
  getCommandLabel,
  getCommandSuggestions,
} from "./commandCatalog.js";
import { AUTOCOMPLETE_VISIBLE_COUNT } from "./constants.js";
import { useBridgeSetup } from "./hooks/useBridgeSetup.js";
import { useConnectionStatus } from "./hooks/useConnectionStatus.js";
import { useConnectionDisconnectCleanup } from "./hooks/useConnectionDisconnectCleanup.js";
import { useKeyboardInput } from "./hooks/useKeyboardInput.js";
import { useSubmitLine } from "./hooks/useSubmitLine.js";

/**
 * Root component mounted by {@link BootstrapApp} once the server is connected.
 
 */
export const App: React.FC<AppProps> = (appProps) => (
  <AppProvider {...appProps}>
    <AppContent />
  </AppProvider>
);

/**
 * Composes the terminal layout and connects hooks to shared context state.
 */
const AppContent: React.FC = () => {
  const {
    history,
    bannerEntries,
    spinner,
    input,
    setInput,
    activeIndex,
    scrollOffset,
    busy,
    approval,
    promptReq,
    agentBoards,
    sigintBusy,
    setActiveIndex,
    setScrollOffset,
    setHandleSubmit,
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
    setSigintBusy,
    inputHistory,
    setInputHistory,
    histIdx,
    setHistIdx,
    onSaveHistory,
    registerExit,
    fileProxy,
    connection,
    commandHandler,
    onInputHistoryRef,
  } = useAppContext();

  const connectionStatus = useConnectionStatus(connection);
  useConnectionDisconnectCleanup(connection, {
    setTaskActive,
    setBusy,
    setSpinner,
    setStreamingText,
    setAgentStatuses,
    setAgentBoards,
  });

  const { exit } = useApp();

  // New typing resets autocomplete selection and scroll window
  useEffect(() => {
    setActiveIndex(0);
    setScrollOffset(0);
  }, [input, setActiveIndex, setScrollOffset]);

  useEffect(() => {
    registerExit(exit);
    return () => registerExit(() => {});
  }, [exit, registerExit]);

  useBridgeSetup({
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
  });

  const { submit } = useSubmitLine({
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
  });

  /**
   * Two-phase Enter when autocomplete is open: first Enter fills the
   * highlighted command; second Enter (with input matching the fill)
   * actually submits.
   */
  const handleSubmitCallback = useCallback(
    async (inputLine: string) => {
      const commandSuggestions = getCommandSuggestions(inputLine);

      if (
        commandSuggestions.length > 0 &&
        activeIndex >= 0 &&
        activeIndex < commandSuggestions.length
      ) {
        const selectedSuggestion = commandSuggestions[activeIndex]!;
        const needsSpaceAfterCommand = commandRequiresArgs(
          selectedSuggestion.command,
        );
        const autocompletedValue =
          selectedSuggestion.command + (needsSpaceAfterCommand ? " " : "");

        if (
          inputLine === autocompletedValue ||
          (!needsSpaceAfterCommand && inputLine === selectedSuggestion.command)
        ) {
          await submit(inputLine);
        } else {
          setInput(autocompletedValue);
        }
        return;
      }

      await submit(inputLine);
    },
    [activeIndex, submit, setInput],
  );

  useEffect(() => {
    setHandleSubmit(() => handleSubmitCallback);
  }, [handleSubmitCallback, setHandleSubmit]);

  const keyboardInputHandler = useKeyboardInput(
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
    },
    { exit },
  );

  useInput(keyboardInputHandler);

  const commandSuggestions = getCommandSuggestions(input);
  const shouldShowAutocomplete = commandSuggestions.length > 0;
  const visibleSuggestions = commandSuggestions.slice(
    scrollOffset,
    scrollOffset + AUTOCOMPLETE_VISIBLE_COUNT,
  );

  // Static region: banner + committed history (does not scroll with live stream)
  const staticEntries = useMemo(
    () => [
      ...bannerEntries,
      ...history.map((historyEntry, itemIndex) => ({
        kind: "history" as const,
        key: `hist-${itemIndex}`,
        item: historyEntry,
      })),
    ],
    [history, bannerEntries],
  );

  return (
    <Box flexDirection="column" height="100%">
      <Static items={staticEntries}>
        {(staticEntry) =>
          staticEntry.kind === "banner" ? (
            <Text key={staticEntry.key}>{staticEntry.line}</Text>
          ) : (
            <Box key={staticEntry.key} flexDirection="column">
              {renderHistoryItem(staticEntry.item, staticEntry.key)}
            </Box>
          )
        }
      </Static>

      <HistoryView />

      {agentBoards.map((agentBoard) => (
        <AgentTaskBoard key={agentBoard.id} board={agentBoard} />
      ))}

      <StatusSpinner state={spinner} />

      {approval && <ApprovalMenu />}

      {promptReq && <PromptOverlay />}

      {!approval && !promptReq && (
        <Box flexDirection="column">
          {shouldShowAutocomplete && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {visibleSuggestions.map((suggestion, visibleIndex) => {
                const absoluteSuggestionIndex = scrollOffset + visibleIndex;
                const isSuggestionSelected =
                  absoluteSuggestionIndex === activeIndex;
                const commandLabel = getCommandLabel(suggestion.command);
                const commandDescription = getCommandDescription(
                  suggestion.command,
                );

                return (
                  <Box key={suggestion.command}>
                    <Text dimColor={!isSuggestionSelected}>
                      {isSuggestionSelected ? "▸ " : "  "}
                    </Text>
                    <Text color="green" bold={isSuggestionSelected}>
                      {commandLabel}
                    </Text>
                    <Text dimColor>
                      {"  "}
                      {commandDescription}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}

          <InputBox />

          <ConnectionStatusLine status={connectionStatus} />
        </Box>
      )}

      {busy && sigintBusy === 1 && (
        <Text dimColor>Press Ctrl+C again to exit</Text>
      )}
    </Box>
  );
};
