import React from "react";
import { Box, Text } from "ink";
import type { HistoryItem } from "../types.js";
import { formatAdvisorThinkForDisplay } from "../../renderer.js";
import { useAppContext } from "../../DataContext.js";

/**
 * <Summary>
 * What it does:
 *   Detects whether a string contains ANSI escape codes for terminal coloring.
 *
 * How it does it (step by step):
 *   1. Use regex pattern to match ANSI escape sequences (ESC[...m format).
 *   2. Return true if any ANSI codes are found in the string.
 *
 * Parameters:
 *   @param text - The string to check for ANSI escape codes.
 *
 * Returns:
 *   @returns True if string contains ANSI codes, false otherwise.
 * </Summary>
 */
const hasAnsi = (text: string): boolean => /\x1b\[[0-9;]*m/.test(text);

/**
 * <Summary>
 * What it does:
 *   Renders a single history item based on its type (text, think, plan, diff, block).
 *
 * How it does it (step by step):
 *   1. Switch on the history item kind to determine rendering strategy.
 *   2. For text items: determine color based on variant and render with appropriate styling.
 *   3. For think items: show thinking indicator and formatted thought content.
 *   4. For plan items: display task, execution details, agent steps, and risks.
 *   5. For diff items: show file path and diff body.
 *   6. For block items: render lines joined by newlines.
 *
 * Parameters:
 *   @param item - The history item to render.
 *   @param key - Unique key for React rendering.
 *
 * Returns:
 *   @returns Rendered React element for the history item.
 * </Summary>
 */
export const renderHistoryItem = (
  item: HistoryItem,
  key: string,
): React.ReactNode => {
  switch (item.kind) {
    case "text": {
      // Check if text already contains ANSI color codes
      const hasAnsiCodes = hasAnsi(item.text);

      // Determine color based on text variant
      const color =
        item.variant === "error"
          ? "red"
          : item.variant === "success"
            ? "green"
            : item.variant === "user"
              ? "cyan"
              : item.variant === "assistant"
                ? undefined
                : "gray";

      return (
        <Text key={key} {...(hasAnsiCodes ? {} : { color })}>
          {item.text}
        </Text>
      );
    }
    case "think":
      return (
        <Box key={key} flexDirection="column" marginY={1}>
          <Text dimColor>
            {item.advisor ? "Advisor thinking…" : "thinking…"}
          </Text>
          <Text>
            {item.advisor ? formatAdvisorThinkForDisplay(item.text) : item.text}
          </Text>
        </Box>
      );
    case "plan": {
      // Build execution label from mode or agent/execution info
      const executionLabel =
        item.modeLabel ??
        `${item.agentCount} agent${item.agentCount === 1 ? "" : "s"} · ${item.execution}`;

      return (
        <Box key={key} flexDirection="column" marginY={1}>
          <Text bold>Plan</Text>
          <Text>Task: {item.task}</Text>
          <Text dimColor>{executionLabel}</Text>

          {/* ===== AGENT-SPECIFIC STEPS ===== */}
          {item.agents.length > 0
            ? item.agents.map((agent) => (
                <Box key={`${key}-agent-${agent.id}`} flexDirection="column">
                  <Text dimColor>
                    ┄┄ Agent {agent.id} — {agent.label} ┄┄
                  </Text>
                  {agent.steps.map((step, stepIndex) => (
                    <Text key={`${key}-a${agent.id}-s${stepIndex}`}>
                      {" "}
                      {stepIndex + 1}. {step}
                    </Text>
                  ))}
                </Box>
              ))
            : item.steps.map((step, stepIndex) => (
                <Text key={`${key}-s-${stepIndex}`}>
                  {" "}
                  {stepIndex + 1}. {step}
                </Text>
              ))}

          {/* ===== RISKS SECTION ===== */}
          {item.risks.length > 0 && (
            <>
              <Text bold>Risks:</Text>
              {item.risks.map((risk, riskIndex) => (
                <Text key={`${key}-r-${riskIndex}`} dimColor>
                  {" "}
                  • {risk}
                </Text>
              ))}
            </>
          )}
        </Box>
      );
    }
    case "diff":
      return (
        <Box key={key} flexDirection="column" marginY={1}>
          <Text bold>{item.path}</Text>
          <Text>{item.body}</Text>
        </Box>
      );
    case "block":
      return (
        <Box key={key} flexDirection="column">
          <Text>{item.lines.join("\n")}</Text>
        </Box>
      );
    default:
      return null;
  }
};

/**
 * <Summary>
 * What it does:
 *   Renders the current streaming text output for real-time updates.
 *
 * How it fits in the system:
 *   Displays streaming text (like live command output or model responses)
 *   as it arrives from the server. Provides immediate feedback during
 *   long-running operations.
 * </Summary>
 */
export const HistoryView: React.FC = () => {
  const { streamingText } = useAppContext();
  return streamingText !== null && streamingText.length > 0 ? (
    <Text>{streamingText}</Text>
  ) : null;
};
