/**
 * The REASON phase: a lightweight, tool-free model call that answers "what
 * should I do next?" as a structured record, run ahead of the real
 * tool-calling turn in `agentTurn.ts`.
 *
 * @remarks
 * This is the LLM half of the reason/act split described in
 * `terminationManager.ts`'s module doc: the reasoner decides what to do
 * next; `agentTurn.ts` and `terminationManager.ts` decide whether the loop
 * keeps running. Only the record's `conclude` field (or a verification
 * pass's revision of it) is ever shown to the user — see
 * {@link runReasoningPhase}'s `display` result.
 *
 * **Additive by design.** This module calls `ollama.chat` — a plain
 * completion, separate from the `chatWithTools` call that actually executes
 * tools — and never touches the tool-calling conversation (`messages` in
 * `agentTurn.ts`) at all. If that call throws for any reason other than
 * cancellation (a provider that doesn't implement `chat`, a transient
 * network failure, an unparseable response), {@link runReasoningPhase}
 * returns `null` and the caller proceeds straight to acting, exactly as if
 * this module didn't exist. Reasoning is a value-add side channel, never
 * the thing standing between the user and the agent actually doing work.
 *
 * **Verification is reserved for finishing, not every step.** Every
 * REASON cycle either reaches `exit: true` or hits its effort level's
 * refinement-round cap (see {@link EFFORT_CONFIG}) before the loop acts;
 * either way it always acts — a capped-out `exit: false` decision is
 * accepted and carried out, never treated as a reason to stop the turn (see
 * `terminationManager.ts`'s module doc — that "no give-up" contract governs
 * *task* progress, not how many times this module may re-deliberate the
 * *same* decision). The two hidden "did I miss something?" passes only run
 * when the accepted decision's `action` names `finish` — see
 * {@link runReasoningPhase}. Paying for two extra calls makes sense right
 * before the turn ends; paying it before every intermediate `read_file`
 * does not.
 */

import type { EffortLevel } from "../../config/types.js";
import type { IOllamaClient } from "../interfaces.js";
import type { Message } from "../types.js";
import { AbortError } from "../../errors/index.js";
import {
  buildReasonSystemText,
  buildReasonVerifySystemText,
} from "./agentPrompt.js";

/**
 * Per-{@link EffortLevel} knobs for this phase — see `config/types.ts`'s
 * `EFFORT_LEVELS` doc comment for the user-facing table this implements.
 * `"low"` is never looked up here in practice: `agentTurn.ts` skips calling
 * `runReasoningPhase` at all for `"low"` (no REASON phase, 1 model call per
 * iteration), so its entry below is a defensive fallback only.
 */
const EFFORT_CONFIG: Record<
  EffortLevel,
  { maxRefinementRounds: number; verificationPasses: number }
> = {
  low: { maxRefinementRounds: 0, verificationPasses: 0 },
  medium: { maxRefinementRounds: 1, verificationPasses: 1 },
  high: { maxRefinementRounds: 2, verificationPasses: 2 },
  "extra-high": { maxRefinementRounds: 4, verificationPasses: 2 },
  max: { maxRefinementRounds: 6, verificationPasses: 2 },
};

/** One REASON-phase decision record — see `agentPrompt.ts`'s `REASON_RULES` for the field contract the model is asked to follow. */
export type ReasonRecord = {
  /** Whether the model already knows how to do this without looking anything up. */
  know: boolean;
  /** How the model would find out, when `know` is `false`; `"-"` otherwise. */
  find: string;
  /** The next action in a few words — a tool name plus a short target, or `"answer"`. */
  action: string;
  /** What the model flagged as a risk or gap in this decision. */
  risk: string;
  /** `true` once the model is ready to stop reasoning and act. */
  exit: boolean;
  /** The one sentence a user may see — `null` when the model gave none, or a verification pass found nothing to add. */
  conclude: string | null;
};

/** Result of a full reasoning phase — the accepted decision, plus text to show the user, if any. */
export type ReasonOutcome = {
  record: ReasonRecord;
  /** Text for `emitToken`, or `null` when nothing should be shown (the common case: no verification ran, or verification found nothing). */
  display: string | null;
};

const FIELD_NAMES = ["know", "find", "action", "risk", "exit", "conclude"] as const;

/**
 * Tolerantly extracts one field's value from a reasoning record's raw text.
 *
 * @remarks
 * Captures from `name:` up to the next recognized field label or the end of
 * the text — mirrors the field-boundary approach `toolProtocol.ts` already
 * uses for the legacy think-block schema, sized down for this record's
 * smaller field set. Case-insensitive so a model that capitalizes labels
 * differently still parses.
 */
const extractField = (text: string, name: (typeof FIELD_NAMES)[number]): string | null => {
  const boundary = FIELD_NAMES.join("|");
  const pattern = new RegExp(
    `^[ \\t]*${name}[ \\t]*:[ \\t]*([\\s\\S]*?)(?=\\r?\\n[ \\t]*(?:${boundary})[ \\t]*:|$)`,
    "im",
  );
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
};

/** Parses a `yes|no` / `true|false` field, tolerating case and a leading letter only (e.g. "y", "T"). */
const parseBool = (raw: string | null, fallback: boolean): boolean => {
  if (raw === null) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.startsWith("y") || normalized.startsWith("t")) {
    return true;
  }
  if (normalized.startsWith("n") || normalized.startsWith("f")) {
    return false;
  }
  return fallback;
};

/**
 * Parses a model's raw REASON-phase response into a {@link ReasonRecord}.
 *
 * @remarks
 * Tolerant by design, matching the rest of this module's philosophy: a
 * missing or unparseable `exit` defaults to `true` (act now, don't stall the
 * loop waiting for a format the model isn't following), and a missing
 * `conclude` becomes `null` (nothing shown) rather than an empty string. A
 * response with no recognizable fields at all still returns a valid record
 * — `exit: true`, everything else empty — so a model that ignores the
 * schema entirely just skips straight to acting with no reasoning display,
 * never breaks the loop.
 *
 * @param raw - The model's complete response text.
 */
export const parseReasonRecord = (raw: string): ReasonRecord => {
  // Some models wrap the record in a <reason>...</reason> block despite the
  // prompt not requiring one; unwrap it if present, otherwise parse the
  // whole response as-is.
  const tagMatch = raw.match(/<reason>([\s\S]*?)(?:<\/reason>|$)/i);
  const body = tagMatch ? (tagMatch[1] ?? "") : raw;

  const conclude = extractField(body, "conclude");
  return {
    know: parseBool(extractField(body, "know"), false),
    find: extractField(body, "find") ?? "-",
    action: extractField(body, "action") ?? "",
    risk: extractField(body, "risk") ?? "",
    exit: parseBool(extractField(body, "exit"), true),
    conclude: conclude && conclude.toLowerCase() !== "null" ? conclude : null,
  };
};

/** Renders a record back to the same field-per-line text, so a follow-up call can be shown "your previous decision" verbatim. */
const formatRecordForRefinement = (record: ReasonRecord): string =>
  [
    `know: ${record.know ? "yes" : "no"}`,
    `find: ${record.find}`,
    `action: ${record.action}`,
    `risk: ${record.risk}`,
    `exit: ${record.exit ? "true" : "false"}`,
    `conclude: ${record.conclude ?? "null"}`,
  ].join("\n");

/** Whether an accepted decision's action names finishing the turn — the only trigger for the two verification passes. */
const isFinishingAction = (action: string): boolean =>
  /\bfinish\b/i.test(action);

export type RunReasoningPhaseParams = {
  ollama: IOllamaClient;
  model: string;
  signal: AbortSignal;
  /**
   * What the reasoner reasons about — a short description of the task and
   * where the loop currently stands. Not the full tool-calling conversation:
   * the reasoner is a lightweight side channel, not a participant in that
   * conversation (see module remarks), so this is deliberately compact.
   */
  contextText: string;
  /** Forwarded verbatim to every `ollama.chat` call this phase makes — see `agentTurn.ts`'s `numCtx`/`keepAlive`. */
  numCtx: number | undefined;
  keepAlive: string | number;
  /** How much this phase re-deliberates before acting — see {@link EFFORT_CONFIG}. */
  effort: EffortLevel;
};

/** One `ollama.chat` call for the REASON phase, tolerant of any failure — see module remarks on why this is additive, never load-bearing. */
const callReasoner = async (
  params: RunReasoningPhaseParams,
  systemText: string,
): Promise<ReasonRecord | null> => {
  const { ollama, model, signal, contextText, numCtx, keepAlive } = params;
  const messages: Message[] = [
    { role: "system", content: systemText },
    { role: "user", content: contextText },
  ];
  try {
    const raw = await ollama.chat(model, messages, {
      temperature: 0,
      signal,
      numCtx,
      keepAlive,
    });
    return parseReasonRecord(raw);
  } catch (error) {
    if (error instanceof AbortError) {
      throw error;
    }
    return null;
  }
};

/**
 * Reasons until the model sets `exit: true` or the effort level's
 * `maxRefinementRounds` is reached, refining the same decision on every
 * `exit: false` reply in between.
 *
 * @remarks
 * Hitting the cap does not abandon the decision — it accepts whatever the
 * model most recently returned (even with `exit: false`) and the loop acts
 * on it. This bounds *redundant re-deliberation of one decision*, not task
 * progress: it is a deliberately different kind of limit from the old
 * per-turn give-up counters this phase replaced (see `terminationManager.ts`),
 * which ended the whole turn. A capped-out reasoning round never ends
 * anything — the next iteration reasons fresh regardless.
 *
 * @returns The accepted (or capped-out) record, or `null` the moment
 *   reasoning becomes unavailable (see {@link callReasoner}) — including on
 *   the very first call.
 */
const reasonUntilExit = async (
  params: RunReasoningPhaseParams,
  maxRefinementRounds: number,
  seed?: ReasonRecord,
): Promise<ReasonRecord | null> => {
  let priorRecordText = seed ? formatRecordForRefinement(seed) : undefined;
  let round = 0;
  for (;;) {
    const record = await callReasoner(
      params,
      buildReasonSystemText(priorRecordText),
    );
    if (!record) {
      return null;
    }
    if (record.exit || round >= maxRefinementRounds) {
      return record;
    }
    priorRecordText = formatRecordForRefinement(record);
    round += 1;
  }
};

/**
 * Runs one full REASON phase: reasons to an accepted decision, then — only
 * when that decision's action is to finish the turn — runs the effort
 * level's hidden verification passes over it before returning.
 *
 * @returns `null` when reasoning is unavailable at any point (the caller
 *   should proceed straight to acting with no display); otherwise the
 *   accepted record plus any text to show the user.
 */
export const runReasoningPhase = async (
  params: RunReasoningPhaseParams,
): Promise<ReasonOutcome | null> => {
  const { maxRefinementRounds, verificationPasses } = EFFORT_CONFIG[params.effort];

  let record = await reasonUntilExit(params, maxRefinementRounds);
  if (!record) {
    return null;
  }
  let display = record.conclude;

  if (!isFinishingAction(record.action)) {
    return { record, display };
  }

  // Hidden verification passes over the finish decision. Neither is shown
  // to the user unless it revises the decision (non-null `conclude`), in
  // which case that revision REPLACES the display, prefixed so the user
  // can tell it apart from the original conclusion — see agentPrompt.ts's
  // REASON_VERIFY_RULES.
  for (let pass = 0; pass < verificationPasses; pass += 1) {
    const verdict = await callReasoner(
      params,
      buildReasonVerifySystemText(formatRecordForRefinement(record)),
    );
    if (!verdict) {
      break;
    }
    if (verdict.conclude !== null) {
      display = `Wait, I think ${verdict.conclude}`;
    }
    if (!verdict.exit) {
      // The verification pass itself wants more reasoning before this can
      // be trusted — go refine it, then re-run verification on the result.
      const refined = await reasonUntilExit(params, maxRefinementRounds, verdict);
      if (!refined) {
        break;
      }
      record = refined;
      display = record.conclude ?? display;
      continue;
    }
    if (verdict.action.trim().length > 0) {
      record = { ...record, action: verdict.action };
    }
  }

  return { record, display };
};
