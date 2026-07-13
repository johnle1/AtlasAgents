import React from "react";
import { Box, Text } from "ink";
import type { HistoryItem } from "../types.js";
import { formatAdvisorThinkForDisplay, formatAgentThinkForDisplay } from "../../renderer.js";
import { useAppContext } from "../../DataContext.js";

/**
 * Detects whether a text block contains standard ANSI escape character codes.
 *
 * @remarks
 * Used to check if color codes have already been applied to incoming server logs,
 * preventing duplicate colorization wrappers which disrupt terminal layouts.
 *
 * @param text - The raw string representation to analyze.
 * @returns `true` if the text contains one or more ANSI escape segments, otherwise `false`.
 *
 * @example
 * ```ts
 * const hasColor = hasAnsi("\x1b[31mError occurred\x1b[0m"); // returns true
 * ```
 */
const hasAnsi = (text: string): boolean => /\x1b\[[0-9;]*m/.test(text);

/**
 * Maps a structured historical activity log entry to its corresponding Ink node representation.
 *
 * @remarks
 * Supports formatting for various console events:
 * - standard user/assistant messages (`text`)
 * - dynamic thinking logs (`think`)
 * - multi-step agent plans and risks (`plan`)
 * - codebase changes (`diff`)
 * - raw text log blocks (`block`)
 *
 * @param item - The structured data model containing type and payloads of the event.
 * @param key - A unique rendering key mapping to React's list reconciliation algorithm.
 * @returns React node representing the formatted log view.
 *
 * @example
 * ```tsx
 * import { renderHistoryItem } from "./HistoryView.js";
 * 
 * const textItem = { kind: "text" as const, text: "Completed compile step", variant: "success" };
 * const node = renderHistoryItem(textItem, "item-1");
 * ```
 */
export const renderHistoryItem = (
  item: HistoryItem,
  key: string,
): React.ReactNode => {
  switch (item.kind) {
    case "text": {
      // Check if the server pre-colored this text stream. If so, we bypass the variant theme coloring to avoid corruption.
      const hasAnsiCodes = hasAnsi(item.text);

      // Resolve the terminal text color based on the semantic variant of the response payload.
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
          {/* Label indicating whether the thought trace belongs to the coordinator or a worker */}
          <Text dimColor>
            {item.advisor ? "Advisor thinking…" : "thinking…"}
          </Text>
          <Text>
            {item.advisor
              ? formatAdvisorThinkForDisplay(item.text)
              : formatAgentThinkForDisplay(item.text)}
          </Text>
        </Box>
      );
    case "plan": {
      // Draw execution summary, recalculating default values if mode labels are absent.
      const executionLabel =
        item.modeLabel ??
        `${item.agentCount} agent${item.agentCount === 1 ? "" : "s"} · ${item.execution}`;

      return (
        <Box key={key} flexDirection="column" marginY={1}>
          <Text bold>Plan</Text>
          <Text>Task: {item.task}</Text>
          <Text dimColor>{executionLabel}</Text>

          {/* ===== AGENT-SPECIFIC STEPS ===== */}
          {/* Map active agent workflows or fallback to sequential single-agent listings. */}
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
 * Renders streaming/live textual updates originating from active background tasks.
 *
 * @remarks
 * Pulls the live stream buffer from `useAppContext` and draws it directly to stdout.
 * Facilitates immediate feedback for streaming execution payloads.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { HistoryView } from "./HistoryView.js";
 * 
 * // Note: Requires parent wrapper with active DataContext.
 * ```
 */
export const HistoryView: React.FC = () => {
  const { streamingText } = useAppContext();
  return streamingText !== null && streamingText.length > 0 ? (
    <Text>{streamingText}</Text>
  ) : null;
};
