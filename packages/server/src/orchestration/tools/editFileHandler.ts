/**
 * The `edit_file` tool: replaces an exact string match within a file the agent has already read.
 *
 * @remarks
 * Enforces a read-before-edit invariant: the model must have called
 * `read_file` on the target path this task before it can edit it. This
 * guards against edits anchored on stale or hallucinated file content — the
 * `old` string must be copied from a real, current read, not guessed. Like
 * `write_file`, edits go through the workspace's approval flow.
 */

import type {
  ToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./types.js";
import {
  formatObservation,
  toolExecutionErrorResult,
  userReviseMessage,
} from "./toolHandler.js";
import { stripMarkdownFence } from "../toolProtocol.js";

/**
 * Tool handler for `edit_file`.
 *
 * @example
 * Agent calls `read_file({ path: "src/App.tsx" })`, then
 * `edit_file({ path: "src/App.tsx", old: "export default App;", new: "..." })`
 * — the edit is rejected with a corrective message if `read_file` on that
 * path wasn't called first this task.
 */
export const editFileTool: ToolHandler = {
  schema: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact string in a file you have already read. The old string must match exactly once unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from workspace root" },
          old: { type: "string", description: "Exact text to find" },
          new: { type: "string", description: "Replacement text" },
          replace_all: {
            type: "boolean",
            description: "Replace all occurrences when true",
          },
        },
        required: ["path", "old", "new"],
      },
    },
  },

  async execute(
    editFileArgs: Record<string, unknown>,
    handlerContext: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    const path = String(editFileArgs.path ?? "");
    const oldText = String(editFileArgs.old ?? "");
    // Models occasionally wrap replacement text in markdown fences out of
    // habit; strip them since the raw text is what should land in the file.
    const newText = stripMarkdownFence(String(editFileArgs.new ?? ""));
    const replaceAll = editFileArgs.replace_all === true;
    const trackers = handlerContext.trackers;

    // GUARD: Reject edits to files not read this task. The `old` anchor must
    // come from a real, current read — otherwise the agent could be editing
    // against stale or hallucinated content, silently corrupting the file.
    if (!trackers.filesReadThisTask.has(path)) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          "edit_file",
          editFileArgs,
          `You must read_file("${path}") before edit_file. Anchors must come from the file as it exists now.`,
        ),
        escalationCount: handlerContext.escalationCount,
      };
    }

    const recorderContext = { recorder: handlerContext.recorder, taskId: handlerContext.taskId };

    try {
      handlerContext.emitSubagentStatus("writing", "◌", `Writing ${path}...`);
      const outcome = await handlerContext.workspace.editFile(
        path,
        oldText,
        newText,
        { replaceAll, ctx: recorderContext },
      );
      if (outcome.accepted) {
        trackers.filesWrittenThisTask.add(path);
      }
      // Three possible outcomes: accepted (show the diff), revised (user gave
      // a reason — pass it back so the agent can adjust), or a bare decline.
      const resultBody = outcome.accepted
        ? `accepted. Diff:\n${outcome.diff}`
        : outcome.feedback
          ? userReviseMessage(
              "accepting this edit",
              "Do not repeat the same edit",
              outcome.feedback,
            )
          : "user declined";
      return {
        done: false,
        summary: "",
        feedback: formatObservation("edit_file", editFileArgs, resultBody),
        escalationCount: handlerContext.escalationCount,
      };
    } catch (error) {
      return toolExecutionErrorResult("edit_file", editFileArgs, error, handlerContext.escalationCount);
    }
  },
};
