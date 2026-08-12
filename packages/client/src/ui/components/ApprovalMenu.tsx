import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { resolveApproval } from "../uiBridge.js";
import { useAppContext } from "../../state/DataContext.js";
import { buildOptions, resolveApprovalKey } from "./approvalKeymap.js";

/**
 * Renders an interactive decision form that blocks the main CLI loop until a choice is submitted.
 *
 * @remarks
 * Listens to active approval state in the application context and binds global key events (`useInput`).
 * Arrow keys move the highlight; Enter confirms; digits 1–3 jump+confirm; Esc dismisses with the
 * same safe default as a disconnect ({@link dismissValueFor}).
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { ApprovalMenu } from "./ApprovalMenu.js";
 *
 * Note: Requires DataContext wrapper configured with an active approval request.
 * ```
 */
export const ApprovalMenu: React.FC = () => {
  // Pull interactive control states and state update functions from data context.
  const { approval, approvalSelected, setApprovalSelected } = useAppContext();

  // Maps the request action list depending on whether approval is required.
  const options = useMemo(
    () => (approval ? buildOptions(approval) : []),
    [approval],
  );

  // Binds standard keyboard listeners to intercept cursor controls and choices.
  useInput((input, key) => {
    // Escape early when no prompt is actively displayed to avoid key hijacking.
    if (!approval) return;

    const action = resolveApprovalKey(
      input,
      key,
      options,
      approvalSelected,
      approval.type,
    );

    if (action.type === "move") {
      setApprovalSelected(action.index);
      return;
    }

    if (action.type === "confirm" || action.type === "dismiss") {
      resolveApproval(action.value);
    }
  });

  // Short-circuit render cycle if no confirmation dialog is pending from agent.
  if (!approval) return null;
  const request = approval;

  // Format context rows based on target operation constraints.
  const contextLines =
    request.type === "planReview"
      ? [
          `Plan: ${request.task.slice(0, 56)}`,
          `${request.stepCount} step(s) · ${request.agentCount} agent${request.agentCount === 1 ? "" : "s"} · ${request.execution}`,
          request.modeLabel ? `Mode: ${request.modeLabel}` : "",
        ].filter((line) => line.length > 0)
      : request.type === "runSkip"
        ? [`Run command: ${request.command}`]
        : [request.contextLabel];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      {/* Dynamic Header details regarding the task / command being requested */}
      {contextLines.map((line, lineIndex) => (
        <Text key={`ctx-${lineIndex}`}>{line}</Text>
      ))}

      {/* Selectable choices formatted with hover indicators */}
      {options.map((option, optionIndex) => (
        <Text
          key={`opt-${optionIndex}`}
          bold={optionIndex === approvalSelected}
          color={option.color}
        >
          {optionIndex === approvalSelected ? "▸ " : "  "}
          {option.label}
        </Text>
      ))}

      {/* Helper tooltip to assist developers navigating keyboard interactions */}
      <Text dimColor>↑↓ move · Enter confirm · 1-3 select · Esc dismiss</Text>
    </Box>
  );
};
