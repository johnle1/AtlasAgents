import React from "react";
import { Box, Text } from "ink";
import type { HistoryItem } from "../types.js";
import { formatAgentThinkForDisplay } from "../../renderer.js";
import { tailRows } from "../thinkDisplay.js";
import { MarkdownView } from "../markdown/MarkdownView.js";
import { useAppContext } from "../../state/DataContext.js";

/**
 * Maximum visual rows a single live think block may occupy, as a fraction of
 * terminal height, before its live-view text is clamped to a tail.
 *
 * @remarks
 * Divided further by the number of concurrently-open streams so several
 * agents thinking at once can't push the input prompt off screen — see
 * {@link LiveThinkView}. The full, untruncated text is unaffected: it still
 * commits to scrollback in full on `think-end`.
 */
const LIVE_THINK_HEIGHT_FRACTION = 3;

/** Floor on rows allotted per live think block, even with many concurrent streams. */
const MIN_LIVE_THINK_ROWS = 4;

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
  markdownRaw = false,
): React.ReactNode => {
  switch (item.kind) {
    case "text": {
      const hasAnsiCodes = hasAnsi(item.text);

      const color =
        item.variant === "error"
          ? "red"
          : item.variant === "warning"
            ? "yellow"
            : item.variant === "success"
              ? "green"
              : item.variant === "user"
                ? "cyan"
                : item.variant === "assistant"
                  ? undefined
                  : "gray";

      if (item.variant === "assistant" && !hasAnsiCodes) {
        return (
          <MarkdownView
            key={key}
            source={item.text}
            raw={markdownRaw}
          />
        );
      }

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
          <Text dimColor>{item.agent ? "Agent thinking…" : "thinking…"}</Text>
          <Text>{formatAgentThinkForDisplay(item.text)}</Text>
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
          {/* Map active subagent workflows or fallback to sequential single-agent listings. */}
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
  const { streamingText, markdownRaw } = useAppContext();
  return streamingText !== null && streamingText.length > 0 ? (
    <MarkdownView source={streamingText} raw={markdownRaw} />
  ) : null;
};

/**
 * Renders every in-progress "thinking" stream live, below frozen scrollback.
 *
 * @remarks
 * One dim-labelled block per open `think-start`…`think-end` sequence — the
 * lead agent and any number of concurrently-thinking subagents all render at
 * once here, each identified by its own label. This is what lets reasoning
 * appear incrementally at all: {@link Static} (used for committed history)
 * renders its items once and never repaints them, so a block still being
 * streamed has to live in ordinary React state below it. Once a stream ends,
 * the completed block commits to history as a `kind: "think"` item and is
 * removed from here.
 *
 * Each block's text is clamped to a fraction of the terminal height via
 * {@link tailRows} so several concurrent streams can't push the input prompt
 * off screen — the clamp only affects this live view; the full text still
 * commits to scrollback.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { LiveThinkView } from "./HistoryView.js";
 *
 * // Note: Requires parent wrapper with active DataContext.
 * render(<LiveThinkView />);
 * ```
 */
export const LiveThinkView: React.FC = () => {
  const { liveThinks } = useAppContext();
  if (liveThinks.length === 0) {
    return null;
  }

  const columns = process.stdout.columns ?? 80;
  const totalRows = process.stdout.rows ?? 24;
  const maxRowsPerBlock = Math.max(
    MIN_LIVE_THINK_ROWS,
    Math.floor(totalRows / LIVE_THINK_HEIGHT_FRACTION / liveThinks.length),
  );

  return (
    <>
      {liveThinks.map((liveThink) => (
        <Box key={liveThink.id} flexDirection="column" marginY={1}>
          <Text dimColor>{liveThink.label ?? "Agent"} thinking…</Text>
          <Text>{tailRows(liveThink.text, columns, maxRowsPerBlock)}</Text>
        </Box>
      ))}
    </>
  );
};
