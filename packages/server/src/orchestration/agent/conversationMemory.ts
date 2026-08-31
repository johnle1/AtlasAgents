/**
 * Cross-turn conversation memory for the unified agent loop.
 *
 * @remarks
 * `runAgentTurn` seeds `messages` fresh as `[system, task]` on every single
 * turn (see `agentTurn.ts`) — nothing about a previous exchange carries
 * over. That's what makes a follow-up like "implement that plan for me"
 * land with no plan to see: the agent's own prior answer was never in its
 * context to begin with.
 *
 * This module stores a short, bounded history of past exchanges on the
 * connection (`PerConnection.conversation`, alongside the existing
 * `activePlan`) and turns it back into seed messages for the next turn.
 * Deliberately shallow — just the user's message and the agent's final
 * answer per turn, not the tool calls/results in between — so a handful of
 * past turns costs a bounded, predictable amount of context rather than
 * competing with the compaction budget for the CURRENT turn's own work
 * (see `contextCompaction.ts`).
 */

import type { Message } from "../types.js";

/** One past turn's user message and the agent's final answer. */
export type ConversationExchange = {
  user: string;
  assistant: string;
};

/** How many past exchanges are carried into the next turn. */
const MAX_EXCHANGES = 6;

/** Hard cap on a single stored answer's length, so one verbose past turn can't crowd out everything else. */
const MAX_STORED_ANSWER_CHARS = 1500;

/**
 * Appends one completed turn to the connection's exchange history,
 * trimming to {@link MAX_EXCHANGES} and capping the answer length.
 *
 * @param prior - The connection's existing history (may be empty).
 * @param user - The task text this turn was given.
 * @param assistant - The turn's final answer (whatever `runAgentTurn`
 *   returned as `content` — a direct answer or a `finish` summary).
 * @returns The updated history, ready to store back on `PerConnection`.
 */
export const recordExchange = (
  prior: ConversationExchange[],
  user: string,
  assistant: string,
): ConversationExchange[] => {
  const boundedAssistant =
    assistant.length > MAX_STORED_ANSWER_CHARS
      ? `${assistant.slice(0, MAX_STORED_ANSWER_CHARS)}…`
      : assistant;
  const next = [...prior, { user, assistant: boundedAssistant }];
  return next.length > MAX_EXCHANGES ? next.slice(next.length - MAX_EXCHANGES) : next;
};

/**
 * Converts stored exchanges into seed `messages` — one user/assistant pair
 * per exchange, in order, ready to splice between the system message and
 * the current turn's task.
 *
 * @param exchanges - History as stored on `PerConnection.conversation`.
 * @returns Alternating user/assistant messages, oldest first. Empty when
 *   `exchanges` is empty or undefined.
 */
export const toHistoryMessages = (
  exchanges: ConversationExchange[] | undefined,
): Message[] =>
  (exchanges ?? []).flatMap((exchange) => [
    { role: "user" as const, content: exchange.user },
    { role: "assistant" as const, content: exchange.assistant },
  ]);
