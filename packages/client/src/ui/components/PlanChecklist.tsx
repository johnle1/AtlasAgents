import React from "react";
import { Box, Text } from "ink";
import type { PlanChecklistProps as Props } from "./types.js";

/**
 * Renders the agent's live `update_plan` checklist as a flat `[ ] / [#]`
 * list, matching Claude Code's own plan-mode checklist style.
 *
 * @remarks
 * Replaces the old per-agent {@link SubagentTaskBoard} cards — there is no
 * border, no progress bar, and no per-agent grouping. Only two marker
 * glyphs exist: `[ ]` for a pending step, `[#]` for everything else.
 * Completion is signaled by strikethrough text, not a third marker — a
 * `"done"` step still renders `[#]`, just struck through and dimmed, so an
 * in-progress step and a just-finished one read as the same "worked on"
 * marker at a glance, with the strikethrough as the only extra signal.
 *
 * @example
 * ```tsx
 * <PlanChecklist steps={[
 *   { id: 1, text: "Read the config parser", status: "done" },
 *   { id: 2, text: "Wire the flag into routerBuilder", status: "in_progress" },
 *   { id: 3, text: "Update the tests", status: "pending" },
 * ]} />
 * ```
 */
export const PlanChecklist: React.FC<Props> = ({ steps }) => {
  if (steps.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text bold>Plan</Text>
      {steps.map((step) => {
        const isDone = step.status === "done";
        const isFailed = step.status === "failed";
        const marker = step.status === "pending" ? "[ ]" : "[#]";
        const color = isFailed ? "red" : isDone ? undefined : "cyan";
        return (
          <Text
            key={step.id}
            color={color}
            dimColor={isDone}
            strikethrough={isDone}
          >
            {marker} {step.text}
            {isFailed ? " (failed)" : ""}
          </Text>
        );
      })}
    </Box>
  );
};
