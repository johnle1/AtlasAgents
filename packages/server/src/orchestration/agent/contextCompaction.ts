/**
 * Bounds how much a turn's conversation history can grow before it is
 * compacted, and performs the compaction itself.
 *
 * @remarks
 * `runToolCallLoop` (`agentTurn.ts`) used to never bound `messages` at all —
 * a long multi-step turn (one `read_file` on an ordinary source file, or a
 * few verbose command outputs, is often enough on its own) could silently
 * outgrow a small local model's context window mid-turn. When that
 * happened, the provider truncated the PROMPT FROM THE FRONT, dropping the
 * system message that holds the tool catalog and behavior rules — the model
 * could no longer see that tools exist, started replying with plain text,
 * and the turn ended looking like it "gave up" after one or two steps.
 *
 * This module estimates usage, decides when to compact, and replaces the
 * compacted region with a short summary — produced by a separate, cheap,
 * tool-less model call so the summarization itself can't reintroduce the
 * problem. Summarization failing for any reason falls back to plain elision
 * (see `applyElisionFallback`); compaction must never be the thing that
 * ends a turn early.
 */

import { estimateTokensFromText } from "@atlasagents/shared";
import type { Message } from "../types.js";

/**
 * Conservative context-window assumption used for the compaction threshold
 * when the real window isn't known — e.g. an OpenAI-compatible provider,
 * where `orchestratorPipeline.ts` never resolves `num_ctx` (that's an
 * Ollama-only concept). Deliberately generous: this only governs when
 * compaction KICKS IN, not what's reported to the user as usage.
 */
export const DEFAULT_COMPACTION_BUDGET = 8192;

/** Compact once estimated usage crosses this fraction of the budget. */
const COMPACT_AT_FRACTION = 0.75;

/**
 * Messages (not exchanges) always kept untouched at the tail of the
 * conversation — 3 exchanges × up to 2 messages each (assistant + tool, or
 * assistant + user in legacy/text mode).
 */
const KEEP_RECENT_MESSAGES = 6;

/** Hard cap on the summary text itself, so compaction can never reintroduce the problem it exists to solve. */
const MAX_SUMMARY_CHARS = 2000;

/** Marker prefixing every compacted-region replacement message, so it's recognizable in history/logs. */
export const COMPACTION_MARKER = "[COMPACTED EARLIER WORK]";

/** Marker used when summarization itself fails and the fallback (plain elision) runs instead. */
export const ELISION_FALLBACK_TEXT = "[earlier tool results elided]";

/** Sums the rough token estimate (`@atlasagents/shared`'s 4-chars-per-token heuristic) of every message's content. */
export const estimateMessagesTokens = (messages: Message[]): number =>
  messages.reduce(
    (total, message) => total + estimateTokensFromText(message.content),
    0,
  );

/** True once estimated usage crosses the compaction threshold for the given budget. */
export const shouldCompact = (
  estimatedTokens: number,
  budget: number,
): boolean => estimatedTokens > budget * COMPACT_AT_FRACTION;

/**
 * Picks the `[start, end)` slice of `messages` eligible for compaction: the
 * "middle", excluding the leading seed (system prompt, any carried-over
 * conversation history, and the current task — see `conversationMemory.ts`)
 * and the trailing {@link KEEP_RECENT_MESSAGES} recent messages.
 *
 * @param protectedPrefixCount - How many messages at the start of
 *   `messages` make up the seed and must never be compacted — the caller's
 *   `messages.length` at the moment the loop started (before any tool-call
 *   turn appended to it). Was hardcoded to `2` (`[system, task]`) before
 *   cross-turn history existed; now varies with how much history was
 *   spliced in.
 * @returns `null` when there's no meaningful middle to compact — a turn
 *   short enough that recent-message protection already covers everything
 *   past the seed.
 */
export const selectCompactionRange = (
  messages: Message[],
  protectedPrefixCount: number,
): { start: number; end: number } | null => {
  const start = protectedPrefixCount;
  const end = Math.max(start, messages.length - KEEP_RECENT_MESSAGES);
  if (end <= start) {
    return null;
  }
  return { start, end };
};

/**
 * Builds the separate, tool-less sub-request that summarizes one
 * compaction range — never passed the live tool schemas, so this call
 * cannot itself trigger a tool call or otherwise interact with the turn.
 */
export const buildCompactionRequest = (middle: Message[]): Message[] => {
  const transcript = middle
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "Summarize this coding agent's own conversation history concisely, in prose, so the agent can continue its task with less context. Include: files read or written and their paths, commands run and whether they succeeded or failed, key findings, and the current state of the work. Omit raw file contents and full command output — describe them, don't reproduce them. Keep it under 1500 characters.",
    },
    { role: "user", content: transcript },
  ];
};

/**
 * Replaces `messages[range.start, range.end)` with one summary message,
 * mutating `messages` in place. Everything before `range.start` (system +
 * original task) and from `range.end` onward (recent exchanges) is
 * untouched.
 */
export const applyCompaction = (
  messages: Message[],
  range: { start: number; end: number },
  summary: string,
): void => {
  const bounded =
    summary.length > MAX_SUMMARY_CHARS
      ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…`
      : summary;
  messages.splice(range.start, range.end - range.start, {
    role: "user",
    content: `${COMPACTION_MARKER}\n${bounded}`,
  });
};

/**
 * Drop-oldest fallback used when the summarization call itself fails
 * (throws, or returns nothing usable) — must never itself fail, since
 * compaction failing is exactly the class of bug this module exists to fix.
 */
export const applyElisionFallback = (
  messages: Message[],
  range: { start: number; end: number },
): void => {
  messages.splice(range.start, range.end - range.start, {
    role: "user",
    content: ELISION_FALLBACK_TEXT,
  });
};
