/**
 * The `read_file` tool: lets a subagent read a file's full content from the workspace.
 *
 * @remarks
 * Reading a file is a prerequisite for editing it — `edit_file` refuses to
 * run against a path that hasn't been read this task, since its exact-match
 * anchors must come from current file content, not the model's memory of it.
 * Reading a file that was previously written by this same task also counts
 * as verification (see `filesVerifiedThisTask`), satisfying the `finish`
 * tool's require-verification check without needing a separate test run.
 */

import type {
  ToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./types.js";
import { formatObservation, toolExecutionErrorResult } from "./toolHandler.js";

/**
 * Tool handler for `read_file`.
 *
 * @example
 * Agent calls `read_file({ path: "src/App.tsx" })` → feedback contains the
 * full file content, and `path` is recorded in `trackers.filesReadThisTask`
 * so a later `edit_file` on the same path is permitted.
 */
export const readFileTool: ToolHandler = {
  schema: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full content of a file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path from workspace root",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(
    readFileArgs: Record<string, unknown>,
    handlerContext: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    const path = String(readFileArgs.path ?? "");
    const recorderContext = { recorder: handlerContext.recorder, taskId: handlerContext.taskId };
    const trackers = handlerContext.trackers;

    try {
      handlerContext.emitSubagentStatus("reading", "◌", `Reading ${path}...`);
      const fileContent = await handlerContext.workspace.readFile(path, recorderContext);
      trackers.filesReadThisTask.add(path);

      // Reading back a file this task already wrote counts as verification —
      // the agent has seen its own change land, without needing a test run.
      if (trackers.filesWrittenThisTask.has(path)) {
        trackers.filesVerifiedThisTask.add(path);
      }

      return {
        done: false,
        summary: "",
        feedback: formatObservation("read_file", readFileArgs, fileContent),
        escalationCount: handlerContext.escalationCount,
      };
    } catch (error) {
      return toolExecutionErrorResult("read_file", readFileArgs, error, handlerContext.escalationCount);
    }
  },
};
