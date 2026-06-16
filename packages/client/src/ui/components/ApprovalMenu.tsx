import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalRequest, PlanDecision } from "../types.js";
import { resolveApproval } from "../uiBridge.js";
import { useAppContext } from "../../DataContext.js";

/**
 * <Summary>
 * What it does:
 *   Defines the structure for a menu option with label, value, and optional color.
 *
 * Used by:
 *   - ApprovalMenu — renders selectable options for user approval decisions.
 *
 * Produced by:
 *   - buildOptions — creates option arrays based on approval request type.
 * </Summary>
 */
type Option<T> = { label: string; value: T; color?: string };

/**
 * <Summary>
 * What it does:
 *   Builds the appropriate menu options based on the type of approval request.
 *
 * How it does it (step by step):
 *   1. Check the approval request type to determine which options to show.
 *   2. For planReview: return Implement, Edit plan, Skip task options.
 *   3. For runSkip: return Run and Skip options.
 *   4. For other types: return Keep and Undo options.
 *
 * Parameters:
 *   @param {ApprovalRequest} request — The approval request containing type and details.
 *
 * Returns:
 *   @returns {Option<boolean | PlanDecision>[]} — Array of menu options with labels and values.
 *
 * Dependencies:
 *   - None (pure function).
 *
 * Dependants:
 *   - ApprovalMenu — calls this to generate menu options for display.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Renders an interactive approval menu for user decisions with keyboard navigation.
 *
 * How it fits in the system:
 *   Displays approval requests (plan review, command execution, etc.) when the
 *   server requires user confirmation. Handles keyboard input for navigation
 *   and selection, then resolves the approval through the UI bridge.
 *
 * Dependencies:
 *   - React/ink — for terminal UI rendering and input handling.
 *   - useAppContext — accesses approval state and selection index.
 *   - resolveApproval — sends user decision back to server.
 *   - buildOptions — generates menu options based on request type.
 *
 * Dependants:
 *   - Main UI components — renders ApprovalMenu when approval request exists.
 * </Summary>
 */
export const ApprovalMenu: React.FC = () => {
  // ===== STATE ACCESS =====
  const { approval, approvalSelected, setApprovalSelected } = useAppContext();

  // ===== DERIVED STATE =====
  // Build menu options based on current approval request type
  const options = useMemo(
    () => (approval ? buildOptions(approval) : []),
    [approval],
  );

  // ===== KEYBOARD INPUT HANDLING =====
  useInput((_input, key) => {
    // Only process input when there's an active approval request
    if (!approval) return;

    // Navigate up through menu options
    if (key.upArrow) {
      setApprovalSelected((previousIndex) => Math.max(0, previousIndex - 1));
      return;
    }

    // Navigate down through menu options
    if (key.downArrow) {
      setApprovalSelected((previousIndex) =>
        Math.min(options.length - 1, previousIndex + 1),
      );
      return;
    }

    // Submit selected option when Enter is pressed
    if (key.return) {
      resolveApproval(options[approvalSelected]!.value);
    }
  });

  // Don't render if no approval request exists
  if (!approval) return null;
  const request = approval;

  // ===== CONTEXT LINE GENERATION =====
  // Build context description lines based on approval request type
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
      {/* ===== CONTEXT INFORMATION ===== */}
      {contextLines.map((line, lineIndex) => (
        <Text key={`ctx-${lineIndex}`}>{line}</Text>
      ))}

      {/* ===== MENU OPTIONS ===== */}
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

      {/* ===== KEYBOARD HINTS ===== */}
      <Text dimColor>↑↓ move · Enter to confirm</Text>
    </Box>
  );
};
