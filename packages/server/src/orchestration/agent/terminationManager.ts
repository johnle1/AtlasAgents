/**
 * The Termination Manager: everything that decides "should Atlas keep
 * running?" for the unified agent loop, kept separate from "what should
 * Atlas do next?" (that question belongs to the model, via `reasoner.ts`,
 * and to tool dispatch in `agentTurn.ts`'s `runToolCalls`).
 *
 * @remarks
 * Two independent completion-gap reasons, consulted whenever the model tries
 * to end a turn with plain text and no tool call:
 * - {@link unverifiedWriteGap} — files were written but never verified. This
 *   is the same check `finish` has always enforced (see `finishHandler.ts`'s
 *   CHECK 2); shared here so `runToolCallLoop`'s implicit "no tool call"
 *   exit in `agentTurn.ts` can run it too, instead of bypassing it entirely.
 * - {@link unfinishedChecklistGap} — the turn's own `update_plan` checklist
 *   still has a pending or in_progress step. Only meaningful for the
 *   top-level turn, which owns a checklist; a `run_steps_parallel` worker
 *   step does not, so callers pass `null` there.
 *
 * A completion gap is never itself a reason to stop the turn — see
 * `agentTurn.ts`'s `resolveEmptyTurn`, which nudges instead, with no cap on
 * how many times it may fire. The one loop-control verdict that DOES end a
 * turn from this module is {@link shouldStopForUnproductiveStreak} — a
 * distinct pathology (malformed tool syntax, unknown tool names) from an
 * empty-turn stall, and the only remaining automatic give-up left in the
 * loop besides the iteration ceiling.
 *
 * There is deliberately no setup-commands gap reason here: `commandPlan` is
 * always `emptyCommandPlan()` in this loop (see `agentTurn.ts`), so that
 * check can never fire in practice and stays local to `finishHandler.ts`'s
 * CHECK 1 rather than being promoted into dead shared code.
 */

import type { PlanStep } from "../types.js";
import type { ToolHandlerContext } from "../tools/types.js";
import { VERIFY_REQUIRED_MESSAGE } from "../commandClassifier.js";

/**
 * Reports unverified writes as a corrective message, or `null` when either
 * nothing was written or at least one verification signal is present.
 *
 * @remarks
 * Identical logic to `finishHandler.ts`'s CHECK 2 — `finishHandler.ts` now
 * calls this directly rather than duplicating it.
 */
export const unverifiedWriteGap = (
  trackers: ToolHandlerContext["trackers"],
): string | null => {
  if (trackers.filesWrittenThisTask.size === 0) {
    return null;
  }
  const hasFileVerification = trackers.filesVerifiedThisTask.size > 0;
  const hasCommandVerification = trackers.verifyCommandPassed;
  if (hasFileVerification || hasCommandVerification) {
    return null;
  }
  return VERIFY_REQUIRED_MESSAGE(trackers.filesWrittenThisTask);
};

/**
 * Reports unfinished checklist steps as a corrective message, or `null` when
 * there is no checklist (worker step, or a turn that never called
 * `update_plan`) or every step is `done`/`failed`.
 *
 * @param steps - The current turn's checklist snapshot, or `null` for a
 *   context with no checklist of its own (see module remarks).
 */
export const unfinishedChecklistGap = (
  steps: PlanStep[] | null,
): string | null => {
  if (!steps || steps.length === 0) {
    return null;
  }
  const outstanding = steps.filter(
    (step) => step.status === "pending" || step.status === "in_progress",
  );
  const next = outstanding[0];
  if (!next) {
    return null;
  }
  const lines = [
    `Your checklist still has ${outstanding.length} step(s) unfinished:`,
    ...outstanding.map(
      (step) =>
        `  [${step.status === "in_progress" ? "#" : " "}] ${step.id}. ${step.text}`,
    ),
    `Continue with step ${next.id}, or call update_plan to mark a step done/failed if it no longer applies.`,
  ];
  return lines.join("\n");
};

/**
 * Combined completion gate consulted when a turn tries to end with plain
 * text and no tool call — the checklist gap is checked first (the bigger-
 * picture "there is more work declared" signal), falling back to the
 * write-verification gap.
 *
 * @returns A corrective message to push back to the model, or `null` when
 *   the turn is genuinely finished.
 */
export const completionGap = (input: {
  planSteps: PlanStep[] | null;
  trackers: ToolHandlerContext["trackers"];
}): string | null =>
  unfinishedChecklistGap(input.planSteps) ?? unverifiedWriteGap(input.trackers);

/**
 * Whether the loop should give up after `streak` consecutive iterations that
 * executed no tool due to a PROTOCOL error (malformed legacy tool block,
 * unknown tool name) — as opposed to an empty-turn stall (plain text, no
 * tool call at all), which `agentTurn.ts`'s `resolveEmptyTurn` nudges
 * indefinitely rather than ever stopping for.
 *
 * @remarks
 * This is the one remaining automatic give-up in the loop besides the
 * iteration ceiling: a model that keeps emitting well-formed prose but no
 * valid tool syntax at all has nothing left to observe or reset on, unlike a
 * stalled model (which might still verify a write, advance a checklist step,
 * or otherwise take a real, resettable action). `threshold` defaults to
 * `MAX_UNPRODUCTIVE_ITERATIONS`'s historical value of 100, passed explicitly
 * so this stays a pure function the caller configures rather than a second
 * place the constant is duplicated.
 */
export const shouldStopForUnproductiveStreak = (
  streak: number,
  threshold: number,
): boolean => streak >= threshold;
