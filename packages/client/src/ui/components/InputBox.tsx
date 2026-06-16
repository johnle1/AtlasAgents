import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useAppContext } from "../../DataContext.js";

/**
 * <Summary>
 * What it does:
 *   Renders the user input box with prompt label and text input field.
 *
 * How it fits in the system:
 *   Provides the main input interface for user commands and responses.
 *   Shows a prompt label and either an active input field or disabled
 *   indicator when input is not available (e.g., during processing).
 *
 * Dependencies:
 *   - React/ink — for terminal UI rendering.
 *   - TextInput — handles keyboard input and editing.
 *   - useAppContext — accesses prompt, input state, and handlers.
 *
 * Dependants:
 *   - Main UI components — renders InputBox for user interaction.
 * </Summary>
 */
export const InputBox: React.FC = () => {
  // ===== STATE ACCESS =====
  const { prompt, input, setInput, handleSubmit, inputDisabled } =
    useAppContext();

  return (
    <Box flexDirection="row" marginTop={1}>
      {/* ===== PROMPT LABEL ===== */}
      <Text dimColor={inputDisabled}>{prompt}</Text>

      {/* ===== INPUT FIELD OR DISABLED INDICATOR ===== */}
      {inputDisabled ? (
        // Show ellipsis when input is disabled (e.g., during processing)
        <Text dimColor>…</Text>
      ) : (
        // Show active text input field when enabled
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      )}
    </Box>
  );
};
