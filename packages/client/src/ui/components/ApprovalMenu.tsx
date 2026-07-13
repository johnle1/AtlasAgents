import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalRequest, PlanDecision } from "../types.js";
import { resolveApproval } from "../uiBridge.js";
import { useAppContext } from "../../DataContext.js";
import type { ApprovalMenuOption as Option } from "./types.js";

/**
 * Evaluates the request schema and generates the selectable menu items.
 *
 * @remarks
 * Maps the incoming `ApprovalRequest` type (e.g., `planReview`, `runSkip`) to the correct list of
 * available actions, colorizing high-stakes items to draw attention.
 *
 * @param request - The active verification or approval payload received from the advisor.
 * @returns A list of configuration options detailing menu text, selection value, and styling.
 */
const buildOptions = (
  request: ApprovalRequest,
): Option<boolean | PlanDecision>[] =>
  request.type === "planReview"
    ? [
        { label: "Implement", value: "implement", color: "green" },
        { label: "Edit plan", value: "edit", color: "cyan" },
        { label: "Skip task", value: "skip" },
      ]
    : request.type === "runSkip"
      ? [
          { label: "Run", value: true, color: "green" },
          { label: "Skip", value: false, color: "red" },
        ]
      : [
          { label: "Keep", value: true, color: "cyan" },
          { label: "Undo", value: false },
        ];

/**
 * Renders an interactive decision form that blocks the main CLI loop until a choice is submitted.
 *
 * @remarks
 * Listens to active approval state in the application context and binds global key events (`useInput`).
 * Supports keyboard navigation via arrow keys and selection confirmation using the `return` key.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { ApprovalMenu } from "./ApprovalMenu.js";
 * 
 * // Note: Requires DataContext wrapper configured with an active approval request.
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
  useInput((_input, key) => {
    // Escape early when no prompt is actively displayed to avoid key hijacking.
    if (!approval) return;

    // Navigate up option indices, keeping boundaries safe.
    if (key.upArrow) {
      setApprovalSelected((previousIndex) => Math.max(0, previousIndex - 1));
      return;
    }

    // Navigate down option indices, capping at option counts.
    if (key.downArrow) {
      setApprovalSelected((previousIndex) =>
        Math.min(options.length - 1, previousIndex + 1),
      );
      return;
    }

    // Submit selection value directly through the IPC channel bridge.
    if (key.return) {
      resolveApproval(options[approvalSelected]!.value);
    }
  });

  // Short-circuit render cycle if no confirmation dialog is pending from advisor.
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
      <Text dimColor>↑↓ move · Enter to confirm</Text>
    </Box>
  );
};
