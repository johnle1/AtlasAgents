/**
 * System prompt for the unified agent turn (`agentTurn.ts`).
 *
 * @remarks
 * Replaces the old forced planner scaffold (`agentThink.ts`'s
 * `AGENT_THINK_TEMPLATE`) with a short set of behavioral rules: answer
 * directly when nothing needs looking up, call a tool when the answer
 * depends on the workspace, and write a checklist via `update_plan` only for
 * genuinely multi-step work. The goal is a single loop that behaves like an
 * ordinary coding assistant in every mode — not a planner that must be
 * satisfied before it's allowed to do anything.
 */

import type { ToolSchema } from "../tools/types.js";
import { buildEnvironmentBlock, buildToolCatalogBlock } from "./environmentPrompt.js";
import { buildLegacyToolBlock } from "../tools/promptText.js";
import type { ClientEnv } from "../types.js";

const AGENT_TURN_RULES = `
[HOW TO WORK]
- If the message is conversational or doesn't depend on this workspace (a greeting, a general question, explaining a concept), just answer directly. No tool calls, no checklist.
- If the answer depends on this workspace (a file's contents, git history, test output, project structure), call the one tool that gets it — read_file for a known path, run_command for things like git log/grep/ls/tests. Prefer a single targeted call over a sweep.
- Call update_plan only when the work is genuinely multi-step (roughly 3+ steps, or several independent surfaces). Skip it for a question or a single small edit — most turns need no plan at all.
- When you do use update_plan: lay out the steps once, mark a step in_progress before you start it, mark it done right after, and call it again whenever status changes. The user sees your checklist update live.
- Use run_steps_parallel only for steps you have marked independent (no dependsOn between them) in the checklist — it runs them concurrently and reports back once every step finishes. Most work does not need this; do it yourself in-loop by default.
- Before finishing a turn that edited files, verify the change (re-read the file, or run a test/build command) — finish will reject an unverified write. A conversational answer needs no verification.
- Call finish to end a multi-step turn with a summary (add ok: false if it could not be completed). For a direct answer or a quick lookup, just reply with text — no finish call needed.
- One tool call per turn, then stop and wait for its result.
`.trim();

/** Instruction block appended only when the session is in plan-review mode. */
const PLAN_MODE_NOTICE = `
[PLAN MODE]
The user is reviewing plans before anything runs. You may read_file and search freely to investigate, but write_file, edit_file, run_command, and run_steps_parallel are not offered until your plan is approved. For any non-trivial task: investigate, then call update_plan with your proposed steps and wait for approval before doing anything else. A pure question still needs no plan — just answer it.
`.trim();

/**
 * Rules for one concurrent step dispatched by `run_steps_parallel`.
 *
 * @remarks
 * Deliberately much shorter than {@link AGENT_TURN_RULES} — a step is one
 * declared-independent unit of work, not a full conversational turn, so it
 * skips the "answer directly" framing, the checklist rules (the checklist
 * belongs to the parent turn, not to one of its steps), and carried-over
 * plan handling.
 */
const WORKER_TURN_RULES = `
[HOW TO WORK]
- Use tools as needed to complete the step described below. Other independent steps may be running concurrently — work only on the step you were given.
- Before finishing a step that edited files, verify the change (re-read the file, or run a test/build command).
- Call finish with a concise summary once the step is complete, or with ok: false and a short explanation if it cannot be completed.
- One tool call per turn, then stop and wait for its result.
`.trim();

/**
 * Builds the complete system prompt for one unified agent turn.
 *
 * @param params.skillContent - Selected skill markdown (may be empty).
 * @param params.contextHeader - Memory/preference context (may be empty).
 * @param params.clientEnv - Client platform info for the environment block.
 * @param params.toolSchemas - Live tool registry schemas for the catalog/teaching block.
 * @param params.configuredSupportsTools - Whether the model uses Ollama's
 *   native tool-calling API. When `false`, the model has no other way to
 *   learn the `<<TOOL>>{...}<<END>>` wire syntax it must emit — this swaps
 *   the plain catalog for {@link buildLegacyToolBlock}'s full teaching block
 *   (same one `subagentMessageBuilder.ts` uses), which also lists every
 *   tool, so the two are not both included.
 * @param params.resumeBlock - Optional carried-over plan summary when resuming
 *   after a model switch (see `agentTurn.ts`), inserted right after context.
 * @param params.planModeActive - Whether the session is in plan-review mode
 *   (`approvalMode === "plan"`) — adds a notice explaining that mutating
 *   tools are withheld until `update_plan` is approved (the actual
 *   enforcement is the tool list itself; this just explains why).
 * @returns Complete system prompt string.
 */
export const buildAgentTurnSystemText = (params: {
  skillContent: string;
  contextHeader: string;
  clientEnv: ClientEnv | undefined;
  toolSchemas: ToolSchema[];
  configuredSupportsTools: boolean;
  resumeBlock?: string;
  planModeActive?: boolean;
}): string => {
  const {
    skillContent,
    contextHeader,
    clientEnv,
    toolSchemas,
    configuredSupportsTools,
    resumeBlock,
    planModeActive,
  } = params;
  const parts: string[] = [
    "You are Atlas, an expert coding assistant working directly in the user's workspace.",
  ];
  if (skillContent.trim().length > 0) {
    parts.push(skillContent.trim());
  }
  if (contextHeader.trim().length > 0) {
    parts.push(contextHeader.trim());
  }
  if (resumeBlock && resumeBlock.trim().length > 0) {
    parts.push(resumeBlock.trim());
  }
  parts.push(buildEnvironmentBlock(clientEnv));
  parts.push(
    configuredSupportsTools
      ? buildToolCatalogBlock(toolSchemas)
      : buildLegacyToolBlock(toolSchemas),
  );
  parts.push(AGENT_TURN_RULES);
  if (planModeActive) {
    parts.push(PLAN_MODE_NOTICE);
  }
  return parts.join("\n\n");
};

/**
 * Builds the system prompt for one concurrent step dispatched by
 * `run_steps_parallel` (see `agentTurn.ts`'s `runWorkerStep`).
 *
 * @remarks
 * No skill content, memory context, or resume block — those belong to the
 * parent turn. A step gets only the environment, its own tool catalog
 * (narrower than the parent's — see `createWorkerToolRegistry`), and a
 * short rule set for completing one focused unit of work.
 *
 * @param params.clientEnv - Client platform info for the environment block.
 * @param params.toolSchemas - The worker registry's schemas for the catalog/teaching block.
 * @param params.configuredSupportsTools - Same meaning as in {@link buildAgentTurnSystemText}.
 * @returns Complete system prompt string for one concurrent step.
 */
export const buildWorkerSystemText = (params: {
  clientEnv: ClientEnv | undefined;
  toolSchemas: ToolSchema[];
  configuredSupportsTools: boolean;
}): string => {
  const { clientEnv, toolSchemas, configuredSupportsTools } = params;
  return [
    "You are Atlas, completing one focused step of a larger task in the user's workspace.",
    buildEnvironmentBlock(clientEnv),
    configuredSupportsTools
      ? buildToolCatalogBlock(toolSchemas)
      : buildLegacyToolBlock(toolSchemas),
    WORKER_TURN_RULES,
  ].join("\n\n");
};
