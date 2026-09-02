/**
 * The `update_plan` tool: the agent's only way to declare and progress a
 * multi-step checklist.
 *
 * @remarks
 * Deliberately the *sole* plan-authoring mechanism in the unified agent
 * loop — there is no separate up-front "planning phase" anymore. The agent
 * calls this when a task is genuinely multi-step, then calls it again as
 * steps move from `pending` to `in_progress` to `done`. The client mirrors
 * whatever this reports as a flat `[ ] / [#] / ~~done~~` checklist (see
 * `PlanChecklist.tsx`) — there is no separate wire event for "step started"
 * vs. "step finished"; each call is a full checklist snapshot.
 *
 * In plan-review mode (`approvalMode === "plan"`), the first call blocks on
 * user approval via the existing plan-review broker before any further tool
 * calls are allowed to execute — see `planTools.updatePlan` in `agentTurn.ts`.
 */

import type {
  ToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
  PlanStepInput,
} from "./types.js";
import { formatObservation, toolExecutionErrorResult } from "./toolHandler.js";

const VALID_STATUSES = new Set(["pending", "in_progress", "done", "failed"]);

/** Coerces and validates the raw `steps` argument into `PlanStepInput[]`, or throws. */
const parseSteps = (raw: unknown): PlanStepInput[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("steps must be a non-empty array");
  }
  const seenIds = new Set<number>();
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`steps[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new Error(`steps[${index}].id must be a positive integer`);
    }
    if (seenIds.has(id)) {
      throw new Error(`steps[${index}].id ${id} is duplicated`);
    }
    seenIds.add(id);
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text.length === 0) {
      throw new Error(`steps[${index}].text must be non-empty`);
    }
    const status =
      typeof item.status === "string" && VALID_STATUSES.has(item.status)
        ? (item.status as PlanStepInput["status"])
        : "pending";
    const dependsOn = Array.isArray(item.dependsOn)
      ? item.dependsOn.filter(
          (dep): dep is number => typeof dep === "number" && Number.isInteger(dep),
        )
      : undefined;
    return { id, text, status, dependsOn };
  });
};

/**
 * Tool handler for `update_plan`.
 *
 * @example
 * Agent calls `update_plan({ steps: [{id:1, text:"...", status:"in_progress"}, {id:2, text:"...", status:"pending"}] })`
 * to declare a two-step checklist and mark the first step active.
 */
export const updatePlanTool: ToolHandler = {
  schema: {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Declare or update your step checklist for this task. Call once to lay out steps for genuinely multi-step work, then again as steps move from pending to in_progress to done. Skip entirely for a direct answer or a single small edit.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                id: { type: "integer", description: "Unique positive integer id, stable across calls." },
                text: { type: "string", description: "Short imperative step description." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "done", "failed"],
                },
                dependsOn: {
                  type: "array",
                  items: { type: "integer" },
                  description: "Ids that must complete before this step can start.",
                },
              },
              required: ["id", "text", "status"],
            },
          },
          note: {
            type: "string",
            description: "Optional one-line note shown with the checklist, e.g. what changed since the last update.",
          },
        },
        required: ["steps"],
      },
    },
  },

  async execute(
    args: Record<string, unknown>,
    handlerContext: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    if (!handlerContext.planTools) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          "update_plan",
          args,
          "update_plan is not available in this context.",
        ),
        escalationCount: handlerContext.escalationCount,
      };
    }

    let steps: PlanStepInput[];
    try {
      steps = parseSteps(args.steps);
    } catch (error) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          "update_plan",
          args,
          `Invalid steps: ${error instanceof Error ? error.message : String(error)}`,
        ),
        escalationCount: handlerContext.escalationCount,
      };
    }

    const note = typeof args.note === "string" ? args.note.trim() : undefined;

    try {
      const result = await handlerContext.planTools.updatePlan(steps, note);
      if (result.decision === "stop") {
        return {
          done: true,
          summary: "Task skipped by user at plan review.",
          feedback: "",
          escalationCount: handlerContext.escalationCount,
          ok: true,
        };
      }
      if (result.decision === "revise") {
        return {
          done: false,
          summary: "",
          feedback: formatObservation(
            "update_plan",
            args,
            `User requested changes before implementing: ${result.feedback}`,
          ),
          escalationCount: handlerContext.escalationCount,
        };
      }
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          "update_plan",
          args,
          "Checklist recorded. Continue working.",
        ),
        escalationCount: handlerContext.escalationCount,
      };
    } catch (error) {
      return toolExecutionErrorResult("update_plan", args, error, handlerContext.escalationCount);
    }
  },
};
