/**
 * Bridge for the agent's live `update_plan` checklist.
 *
 * @remarks
 * Deliberately separate from `subagentStatus.ts` — that module manages
 * per-agent status/board state for dispatched subagents, which the unified
 * agent loop keeps hidden from the UI entirely (see `run_steps_parallel`).
 * The checklist here is the opposite: the one piece of multi-step progress
 * that IS shown to the user, driven by `update_plan` rather than subagent
 * dispatch. Keeping it in its own file avoids the naming confusion of
 * plan-checklist code living in a module named after subagents.
 */

import type { PlanStepState } from "../types.js";
import { getBridgeHooks, getActivePlanValue, setActivePlanValue } from "./state.js";

/**
 * Replaces the agent's live `update_plan` checklist with a fresh snapshot.
 *
 * @remarks
 * Unlike `setSubagentBoards`, there's no partial-merge logic here — every
 * `plan-update` frame carries the complete checklist, so the React state is
 * just replaced wholesale. See `PlanChecklist.tsx` for the rendering. Also
 * mirrors the value into the module-level bridge state so non-React code
 * (`getActivePlan` below) can read the current checklist synchronously.
 *
 * @param steps - The complete, current checklist.
 */
export const setActivePlan = (steps: PlanStepState[]): void => {
  setActivePlanValue(steps);
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onActivePlan?.(steps);
};

/**
 * Reads the agent's current live checklist without a React context.
 *
 * @remarks
 * Used by `modelSelectionHandlers.ts` to report carried-over progress right
 * after a model switch (see the plan-handoff feature) — that code runs as a
 * plain async function outside the component tree, so it can't call
 * `useAppContext()`.
 */
export const getActivePlan = (): PlanStepState[] => getActivePlanValue();
