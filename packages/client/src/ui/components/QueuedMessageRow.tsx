import React from "react";
import { Box, Text } from "ink";

/**
 * Dim bordered row listing lines waiting to run after the current task.
 *
 * @param props.items - FIFO queued prompts (oldest first).
 */
export const QueuedMessageRow: React.FC<{
  items: string[];
}> = ({ items }) => {
  if (items.length === 0) {
    return null;
  }

  const preview = items
    .map((line) => (line.length > 40 ? `${line.slice(0, 37)}…` : line))
    .join(" · ");

  return (
    <Box
      marginTop={1}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text dimColor>
        queued ({items.length}): {preview}
      </Text>
    </Box>
  );
};
