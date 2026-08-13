import React from "react";
import { Box, Text } from "ink";
import { useAppContext } from "../../state/DataContext.js";
import { MultilineInput } from "./MultilineInput.js";

/**
 * Renders the primary user input terminal field.
 *
 * @remarks
 * Uses a {@link MultilineInput} (pure `TextBuffer` + block
 * caret) instead of `ink-text-input`, which is single-line and truncates
 * large pastes. Drawn inside a round gray border so the prompt reads as a
 * distinct field. The editor stays mounted while a task is running so the
 * user can type the next line (Enter queues it). Overlays unmount this
 * box from {@link App} instead.
 *
 * Newlines: Shift+Enter / Alt+Enter / Ctrl+J, or a trailing `\` before
 * Enter. Plain Enter submits (or queues while busy). Pastes above the
 * collapse threshold become an atomic `[Pasted text #N: X lines]` token;
 * submit expands them.
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
  const { prompt, input, setInput, handleSubmit, busy } = useAppContext();

  return (
    <Box
      flexDirection="row"
      marginTop={1}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text>{prompt}</Text>
      <MultilineInput
        value={input}
        onChange={setInput}
        onSubmit={(line) => {
          // Enter while busy is owned by the key handler (queue). Trailing
          // `\` newlines still land here because the handler bails first.
          if (busy) return;
          void handleSubmit(line);
        }}
      />
    </Box>
  );
};
