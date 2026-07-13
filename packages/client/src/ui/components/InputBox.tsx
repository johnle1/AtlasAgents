import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useAppContext } from "../../DataContext.js";

/**
 * Renders the primary user input terminal field.
 *
 * @remarks
 * Uses `ink-text-input` to capture keystrokes and update the prompt text state.
 * When the input is blocked (e.g. while a task is processing), it prints a dim placeholder
 * ellipsis and ignores keypress events to prevent typing buffer overflow.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { InputBox } from "./InputBox.js";
 * 
 * // Note: Requires parent wrapper with active DataContext.
 * ```
 */
export const InputBox: React.FC = () => {
  // Select active input parameters and submit callbacks from context.
  const { prompt, input, setInput, handleSubmit, inputDisabled } =
    useAppContext();

  return (
    <Box flexDirection="row" marginTop={1}>
      {/* Renders the prompt prefix label (e.g. "> "), dimming it when editing is locked */}
      <Text dimColor={inputDisabled}>{prompt}</Text>

      {/* Shows a static loader when input is disabled, otherwise mounts the interactive text input */}
      {inputDisabled ? (
        <Text dimColor>…</Text>
      ) : (
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      )}
    </Box>
  );
};
