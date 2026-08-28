/**
 * The `run_steps_parallel` tool: dispatches a batch of independent checklist
 * steps to the hidden subagent worker pool.
 *
 * @remarks
 * This is the *only* way the unified agent loop uses subagents — it is a
 * capability the agent chooses for genuinely independent steps, never
 * something the user configures or sees directly. There is no per-agent
 * board or progress UI for it; the client only sees the checklist entries
 * for the given step ids move to `done` (or `failed`) once the batch
 * finishes, via the same `update_plan` snapshot mechanism.
 */

import type {
  ToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./types.js";
import { formatObservation, toolExecutionErrorResult } from "./toolHandler.js";

/** Coerces the raw `stepIds` argument into a validated `number[]`, or throws. */
const parseStepIds = (raw: unknown): number[] => {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error("stepIds must be an array of at least 2 ids");
  }
  const ids = raw.map((value, index) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`stepIds[${index}] must be a positive integer`);
    }
    return value;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("stepIds must not contain duplicates");
  }
  return ids;
};

/**
 * Tool handler for `run_steps_parallel`.
 *
 * @example
 * Agent calls `run_steps_parallel({ stepIds: [2, 3] })` after `update_plan`
 * declared steps 2 and 3 as independent (no `dependsOn` between them) — both
 * run concurrently via the hidden subagent pool.
 */
export const runStepsParallelTool: ToolHandler = {
  schema: {
    type: "function",
    function: {
      name: "run_steps_parallel",
      description:
        "Run 2+ independent checklist steps concurrently via hidden background workers. Only for steps with no dependency between them (declared via update_plan). Blocks until all finish; the checklist reflects the result.",
      parameters: {
        type: "object",
        properties: {
          stepIds: {
            type: "array",
            minItems: 2,
            items: { type: "integer" },
            description: "Ids of checklist steps to run concurrently (must be independent of each other).",
          },
        },
        required: ["stepIds"],
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
          "run_steps_parallel",
          args,
          "run_steps_parallel is not available in this context.",
        ),
        escalationCount: handlerContext.escalationCount,
      };
    }

    let stepIds: number[];
    try {
      stepIds = parseStepIds(args.stepIds);
    } catch (error) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          "run_steps_parallel",
          args,
          `Invalid stepIds: ${error instanceof Error ? error.message : String(error)}`,
        ),
        escalationCount: handlerContext.escalationCount,
      };
    }

    try {
      handlerContext.emitSubagentStatus(
        "running",
        "◌",
        `Running ${stepIds.length} steps in parallel...`,
      );
      const result = await handlerContext.planTools.runStepsParallel(stepIds);
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          "run_steps_parallel",
          args,
          result.summary,
        ),
        escalationCount: handlerContext.escalationCount,
      };
    } catch (error) {
      return toolExecutionErrorResult(
        "run_steps_parallel",
        args,
        error,
        handlerContext.escalationCount,
      );
    }
  },
};
