/**
 * System prompt for the unified agent turn (`agentTurn.ts`).
 *
 * @remarks
 * Replaces the old forced planner scaffold (`agentThink.ts`'s
 * `AGENT_THINK_TEMPLATE`) with a short set of behavioral rules: act on a
 * request rather than describing how to, call a tool when the answer
 * depends on the workspace, answer directly when nothing needs looking up
 * or doing, and write a checklist via `update_plan` only for genuinely
 * multi-step work. The goal is a single loop that behaves like an ordinary
 * coding assistant in every mode — not a planner that must be satisfied
 * before it's allowed to do anything, and not a tutorial-writer that
 * explains a task instead of finishing it.
 */

import type { ToolSchema } from "../tools/types.js";
import { buildEnvironmentBlock, buildToolCatalogBlock } from "./environmentPrompt.js";
import { buildLegacyToolBlock } from "../tools/promptText.js";
import type { ClientEnv } from "../types.js";

const AGENT_TURN_RULES = `
[HOW TO WORK]
Work like a ReAct loop: before every response, decide what this message actually needs.
- Asks you to create, build, add, change, fix, install, or set up anything → DO IT NOW, with tools. Knowing how to write the code is not the same as the code existing. Use write_file/edit_file to create or change files and run_command to install/build/test — yourself, directly, in this turn. Never reply with a tutorial telling the user to run commands, create files, or paste code themselves — they asked you to do it, not to explain how. This applies to a brand-new project too: write package.json, config files, and source files with write_file; don't just describe the commands that would create them.
- Asks something about this workspace (a file's contents, git history, test output, project structure) → call the tool that answers it — read_file for a known path, run_command for things like git log/grep/ls/tests. Prefer a single targeted call over a sweep.
- A greeting, a general question, or anything needing no action in this workspace → answer in text. No tool call, no checklist.
A tool result is an observation, not an answer — read it, then decide again the same way. Keep calling tools and reading results until the work is genuinely done; a tool result is never itself the place to stop.
Never stop a turn to narrate a step you could just take right now ("Next I'll...", "Now let me...", "Here's how you would..."). Plain text with no tool call ENDS the turn — only send plain text when there is truly nothing left to do, or you are answering a question that needed no action at all.
- To scaffold a new project, write the files yourself (package.json, tsconfig, bundler config, index.html, src/...) with write_file, then run a single install command. Do not run an interactive scaffolder (npm create ..., npx create-..., yarn create ...) — this environment has no interactive input, so those stall on their own confirmation prompt and time out having created nothing.
- Call update_plan only when the work genuinely spans several files or surfaces (roughly 3+ steps, or independent areas of the codebase). Two related edits to one file, or a quick lookup, are not a plan — skip it; the user sees every checklist you file, so don't file one for work you're about to finish in the next call or two.
- When you do use update_plan: lay out the steps once, mark a step in_progress before you start it, mark it done right after, and call it again whenever status changes. Leave no step pending or in_progress when you stop — mark it done, or failed with why, before ending the turn. Finishing every step you declared is the job — a checklist is a commitment, not a suggestion.
- If a step fails (a command errors, a tool isn't available, a dependency is missing), don't give up on the whole task — try a different approach first: a different command, writing the file directly instead of through a generator, checking what's actually missing. Only once you've tried an alternative and it still doesn't work, call update_plan marking that specific step failed with a one-line reason, then continue with the remaining steps. One failed step should not stop the rest of a task that's still doable.
- Use run_steps_parallel for any 2+ checklist steps you've marked independent (no dependsOn between them) — it runs them concurrently and reports back once every step finishes. Reach for it whenever the checklist genuinely allows it, not just as a last resort; running independent steps one at a time when they could run together only wastes time. Only skip it when steps truly depend on each other's output — that's what dependsOn is for.
- Before finishing a turn that edited files, verify the change (re-read the file, or run a test/build command) — finish will reject an unverified write, and so will ending the turn without one. A conversational answer needs no verification.
- Call finish to end a multi-step turn with a summary (add ok: false if it could not be completed). For a direct answer or a quick lookup that touched nothing, just reply with text — no finish call needed.
- Prefer one focused tool call at a time, but calling several independent ones in the same response is fine — each runs and reports back before you decide again.
`.trim();

/** Instruction block appended only when the session is in plan-review mode. */
const PLAN_MODE_NOTICE = `
[PLAN MODE]
The user is reviewing plans before anything runs. Only read_file, update_plan, and finish (plus any read-only MCP tool) are offered right now — write_file, edit_file, run_command, and run_steps_parallel are withheld until your plan is approved. For any non-trivial task: investigate with what's available, then call update_plan with your proposed steps and wait for approval before doing anything else. A pure question still needs no plan — just answer it. Once approved, the full toolset unlocks immediately and you continue in the same turn.
`.trim();

/**
 * System prompt for the REASON phase (`reasoner.ts`) — a lightweight,
 * tool-free side-channel call that runs ahead of the model's real tool-call
 * decision. Answers "what should I do next?" as a structured record instead
 * of prose, so the loop's controller (`terminationManager.ts` plus
 * `agentTurn.ts`'s own bookkeeping) can decide "should Atlas keep running?"
 * independently of what the model says.
 *
 * @remarks
 * Deliberately excludes the tool catalog and environment block that
 * {@link buildAgentTurnSystemText} includes — the reasoner never calls a
 * tool itself, it only names the next action in the `action` field, which
 * the model then actually carries out on the following (real) tool-calling
 * turn. Keeping this prompt short matters more here than elsewhere: it runs
 * once per step (twice more when verifying a `finish` decision — see
 * `reasoner.ts`), so its own size is pure latency overhead on every call.
 */
const REASON_RULES = `
You are reasoning about ONE next step, not answering the user and not calling a tool. Reply with EXACTLY this record, one field per line, nothing else:

know:     yes | no — do you already know how to do this, or do you need to look something up / try something first?
find:     if know is no, how you'll find out (which tool, or what to try) — otherwise "-"
action:   the single next action in a few words — a tool name plus a short target (e.g. "read_file package.json", "run_command npm test", "finish"), or "answer" for a direct reply with no tool
risk:     one short phrase — what you might be missing or could get wrong
exit:     true | false — true means stop reasoning and act on this now; false means think again before acting (you'll be asked again, refining this same decision)
conclude: one short sentence, plain language, summarizing your decision — this is the ONLY field the user ever sees

Rules:
- Default to exit: true. Only use exit: false when you genuinely need another pass to firm up the decision — don't manufacture a false start just to reason twice.
- conclude must stand alone as a sentence a user would understand, with no field labels or jargon in it.
- Never include a tool call, code, or file content here — this is a decision record, not the action itself.
`.trim();

/**
 * Builds the system prompt for one REASON-phase call.
 *
 * @param priorRecordText - When refining a previous `exit: false` decision
 *   (or responding to a verification pass's feedback), the prior record
 *   rendered as text, so the model revises instead of starting cold. Omit
 *   for the first reasoning call of a step.
 */
export const buildReasonSystemText = (priorRecordText?: string): string =>
  priorRecordText && priorRecordText.trim().length > 0
    ? `${REASON_RULES}\n\n[YOUR PREVIOUS DECISION — refine it, don't just repeat it]\n${priorRecordText.trim()}`
    : REASON_RULES;

/**
 * System prompt for a hidden verification pass over an accepted `finish`
 * decision (`reasoner.ts`) — the "wait, did I actually miss something?"
 * second look, run twice before the model is allowed to act on a decision
 * whose `action` names `finish`. Not run for any other action: the cost of
 * two extra calls is worth paying right before the turn ends, not on every
 * intermediate `read_file`.
 */
const REASON_VERIFY_RULES = `
You are double-checking a decision to finish the task, not making a new one. Reply with the SAME record format as before (know/find/action/risk/exit/conclude), reviewing the decision below for anything it missed:
- If the decision looks right, set conclude: null and exit: true — do not invent a problem to report.
- If something is genuinely missing or wrong (an unverified change, a step the checklist still shows outstanding, a requirement from the task that was never addressed), correct the action and set conclude to one short sentence describing what you caught. A user will see this sentence prefixed with "Wait, I think ".
`.trim();

/**
 * Builds the system prompt for one hidden verification pass.
 *
 * @param acceptedRecordText - The `finish` decision being double-checked,
 *   rendered as text.
 */
export const buildReasonVerifySystemText = (acceptedRecordText: string): string =>
  `${REASON_VERIFY_RULES}\n\n[DECISION TO VERIFY]\n${acceptedRecordText.trim()}`;

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
- A tool result is an observation, not an answer — read it, decide what's still needed, and keep going until the step is actually done. Don't stop to narrate a step you could just take.
- Before finishing a step that edited files, verify the change (re-read the file, or run a test/build command).
- Call finish with a concise summary once the step is complete, or with ok: false and a short explanation if it cannot be completed.
- Prefer one focused tool call at a time, but calling several independent ones in the same response is fine.
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
