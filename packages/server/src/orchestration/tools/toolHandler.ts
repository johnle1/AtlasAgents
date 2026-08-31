/**
 * Shared helpers for the agent tool registry.
 *
 * @remarks
 * Every tool a subagent can call (`read_file`, `write_file`, `run_command`,
 * `escalate`, `finish`, TokenSave tools, etc.) implements the `ToolHandler`
 * interface (defined in `./types.js`): a JSON schema describing the tool to
 * the model, plus an `execute` function that receives parsed arguments and a
 * shared `ToolHandlerContext`. This module provides the small set of
 * formatting/error helpers every handler uses to build consistent feedback
 * text and error results.
 */

import { AbortError } from "../../errors/index.js";
import type { ToolExecutionResult } from "./types.js";

/**
 * Formats the feedback shown to the agent when the user declines a tool
 * result with a free-text reason (rather than a plain skip).
 *
 * @remarks
 * Used by handlers whose effects go through an interactive approval step
 * (`edit_file`, `write_file`, `run_command`). When the user picks "Revise"
 * and types a reason, this wraps that reason into agent-facing feedback that
 * both quotes the user's words and instructs the agent not to blindly repeat
 * the same action.
 *
 * @param action - Present-tense phrase for what was declined, e.g. `"accepting this edit"`.
 * @param repeatWarning - Instruction not to repeat the declined action, e.g. `"Do not repeat the same edit"`.
 * @param userFeedback - The user's free-text revise reason.
 * @returns Two-line feedback string: the quoted user reason, then the repeat warning.
 *
 * @example
 * ```ts
 * userReviseMessage("accepting this edit", "Do not repeat the same edit", "wrong file");
 * "User requested changes instead of accepting this edit: \"wrong file\"\nDo not repeat the same edit — revise your approach based on this feedback."
 * ```
 */
export const userReviseMessage = (
  action: string,
  repeatWarning: string,
  userFeedback: string,
): string =>
  [
    `User requested changes instead of ${action}: "${userFeedback}"`,
    `${repeatWarning} — revise your approach based on this feedback.`,
  ].join("\n");

/**
 * Total characters kept from a tool observation body before truncation
 * kicks in — split between {@link OBSERVATION_HEAD_CHARS} and
 * {@link OBSERVATION_TAIL_CHARS}.
 *
 * @remarks
 * A single `read_file` on an ordinary source file, or a verbose command's
 * stdout, can otherwise land in `messages` in full — easily enough on its
 * own to exhaust a small local model's context window (commonly 4096
 * tokens) before the agent loop's own conversation-level compaction ever
 * gets a chance to run. This cap is unconditional and independent of the
 * model's actual window size, so it always bounds the worst case.
 */
const MAX_OBSERVATION_CHARS = 4000;
/** Chars kept from the start of an oversized observation body. */
const OBSERVATION_HEAD_CHARS = 2800;
/** Chars kept from the end — errors, exit codes, and summaries commonly land here. */
const OBSERVATION_TAIL_CHARS = 1000;

/**
 * Truncates an oversized tool-result body to a head+tail window, eliding the
 * middle rather than dropping the whole thing or cutting it off blind.
 *
 * @remarks
 * Keeps more from the head (where identifying structure — imports, a
 * function's opening, a command's first lines — usually lives) than the
 * tail, but the tail is always kept too, not dropped, since errors and exit
 * status commonly appear at the end.
 *
 * @param content - The raw tool-result body.
 * @returns `content` unchanged if it's within budget, otherwise a
 *   head+elision+tail string of bounded length.
 */
export const truncateObservationBody = (content: string): string => {
  if (content.length <= MAX_OBSERVATION_CHARS) {
    return content;
  }
  const head = content.slice(0, OBSERVATION_HEAD_CHARS);
  const tail = content.slice(content.length - OBSERVATION_TAIL_CHARS);
  const elidedChars = content.length - OBSERVATION_HEAD_CHARS - OBSERVATION_TAIL_CHARS;
  return `${head}\n…[${elidedChars} chars elided]…\n${tail}`;
};

/**
 * Formats a tool's result as observation text appended to conversation history.
 *
 * @remarks
 * Every handler funnels its `feedback` field through this so the agent sees a
 * consistent shape: the tool name and echoed arguments (so the agent can
 * confirm what it called), followed by the actual result content — capped via
 * {@link truncateObservationBody} so one oversized result can't blow the
 * context budget on its own.
 *
 * @param name - Tool name, e.g. `"read_file"`.
 * @param args - The arguments the agent passed, echoed back for context.
 * @param content - The tool's result body (file contents, command output, error message, etc.).
 * @returns A single string ready to append as feedback to the conversation.
 */
export const formatObservation = (
  name: string,
  args: Record<string, unknown>,
  content: string,
): string =>
  `[${name}] ${JSON.stringify({ tool: name, ...args })}\n${truncateObservationBody(content)}`;

/**
 * Converts a caught error into a {@link ToolExecutionResult} the agent can see and react to.
 *
 * @remarks
 * {@link AbortError} is re-thrown rather than converted — cancellation must
 * propagate up to the orchestrator, not be swallowed as agent-visible
 * feedback. Every other error is stringified and returned as `feedback` so
 * the agent can adjust its next tool call instead of the run crashing.
 *
 * @param toolName - Name of the tool that threw.
 * @param args - Arguments passed to the failing call, echoed back for context.
 * @param error - The caught error (any type, since `catch` clauses are typed `unknown`).
 * @param escalationCount - Current escalation count, passed through unchanged.
 * @returns A non-done result whose feedback describes the error.
 * @throws {@link AbortError} if `error` is an `AbortError` (cancellation, not a tool failure).
 */
export const toolExecutionErrorResult = (
  toolName: string,
  args: Record<string, unknown>,
  error: unknown,
  escalationCount: number,
): ToolExecutionResult => {
  if (error instanceof AbortError) {
    throw error;
  }
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    done: false,
    summary: "",
    feedback: formatObservation(toolName, args, errorMessage),
    escalationCount,
  };
};
