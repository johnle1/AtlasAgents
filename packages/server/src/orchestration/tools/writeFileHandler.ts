/**
 * The `write_file` tool: creates a new file or fully overwrites an existing one.
 *
 * @remarks
 * Unlike `edit_file`, this replaces the entire file content and does not
 * require a prior `read_file` call — it's meant for new files or complete
 * rewrites, where there's no existing content to anchor against. The write
 * goes through the workspace's approval flow, so the user can accept, skip,
 * or revise it before it lands on disk.
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
 * Tool handler for `write_file`.
 *
 * @example
 * Agent calls `write_file({ path: "src/Clock.tsx", content: "..." })` →
 * on approval, `path` is recorded in `trackers.filesWrittenThisTask`, which
 * the `finish` tool later checks was verified before allowing completion.
 */
export const writeFileTool: ToolHandler = {
  schema: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write full content to a file. Use only for new files or full rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path from workspace root",
          },
          content: {
            type: "string",
            description: "Full file content to write",
          },
        },
        required: ["path", "content"],
      },
    },
  },

  async execute(
    writeFileArgs: Record<string, unknown>,
    handlerContext: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    const path = String(writeFileArgs.path ?? "");
    // Models occasionally wrap file content in markdown fences (```tsx ... ```)
    // out of habit; strip them since the raw content is what should land on disk.
    const content = stripMarkdownFence(String(writeFileArgs.content ?? ""));
    const recorderContext = { recorder: handlerContext.recorder, taskId: handlerContext.taskId };
    const trackers = handlerContext.trackers;

    try {
      handlerContext.emitSubagentStatus("writing", "◌", `Writing ${path}...`);
      const outcome = await handlerContext.workspace.writeFile(path, content, recorderContext);
      if (outcome.accepted) {
        trackers.filesWrittenThisTask.add(path);
      }
      // Three possible outcomes: accepted (show the diff), revised (user gave
      // a reason — pass it back so the agent can adjust), or a bare decline.
      const resultBody = outcome.accepted
        ? `accepted. Diff:\n${outcome.diff}`
        : outcome.feedback
          ? userReviseMessage(
              "accepting this write",
              "Do not repeat the same write",
              outcome.feedback,
            )
          : "user declined";
      return {
        done: false,
        summary: "",
        feedback: formatObservation("write_file", writeFileArgs, resultBody),
        escalationCount: handlerContext.escalationCount,
      };
    } catch (error) {
      return toolExecutionErrorResult("write_file", writeFileArgs, error, handlerContext.escalationCount);
    }
  },
};
