/**
 * Incremental parsing and frame emission for model "thinking" blocks.
 *
 * @remarks
 * Both the lead agent and subagents embed reasoning in a tagged block
 * (`<agent-think>…</agent-think>`, `<redacted_thinking>…</redacted_thinking>`)
 * somewhere in the model's raw output — sometimes in the regular content
 * channel, sometimes in a provider's separate reasoning channel. Historically
 * that block was only visible once the *entire* response finished, because
 * extraction used a regex that requires the closing tag
 * (see `extractAgentThink` / `extractThinking`).
 *
 * This module lets callers observe that same block as it streams in:
 * - {@link createThinkTagScanner} finds text inside a think tag as raw model
 *   output arrives piece by piece, holding back any tail that might still
 *   grow into a tag across a chunk boundary. Text outside a tag is discarded,
 *   so untagged chain-of-thought stays invisible — exactly as it is today.
 * - {@link createThinkFrameEmitter} turns scanner output into
 *   `think-start`/`think-delta`/`think-end` wire frames, coalescing small
 *   deltas to limit frame volume.
 *
 * Neither export talks to a specific provider or agent — callers feed them
 * from whichever channel(s) apply and decide their own tag names.
 */

import type { SubagentStatusSource, TaskFrame } from "../transport/frames.js";

/** Result of feeding raw model output through a {@link ThinkTagScanner}. */
export type ThinkTagScanner = {
  /**
   * Feed the next raw chunk of model output.
   *
   * @param chunk - Raw text as it arrives (content or reasoning channel).
   * @returns Newly-available text found INSIDE a think tag, or `""` if this
   *   chunk didn't complete or extend a visible slice.
   */
  push: (chunk: string) => string;
  /**
   * Signals the end of the model turn. If a tag was opened but never closed,
   * returns the held-back tail so it isn't silently lost. Resets all state,
   * so the scanner is safe to reuse for the next turn.
   */
  flush: () => string;
};

/**
 * Creates a stateful scanner that extracts text between opening and closing
 * think tags from a stream of raw text chunks, one or more characters at a
 * time.
 *
 * @remarks
 * Matches case-insensitively, mirroring the existing whole-string regexes
 * (`AGENT_THINK_RE`, the `redacted_thinking` regex in `toolProtocol.ts`) that
 * this scanner is a streaming counterpart to. Supports multiple tag names so
 * a single scanner instance can recognize more than one think tag if needed,
 * though every current call site passes exactly one.
 *
 * Nesting is not supported — the first opening tag transitions into "inside",
 * and the first closing tag transitions back out, same as the non-greedy
 * `[\s\S]*?` regexes it replaces. Multiple sequential blocks in one turn are
 * concatenated into the same output stream.
 *
 * @param tagNames - Bare tag names (e.g. `"agent-think"`), without angle
 *   brackets. Each is matched as `<name>` / `</name>`.
 *
 * @example
 * ```ts
 * const scanner = createThinkTagScanner(["agent-think"]);
 * scanner.push("<agent-th");       // ""  (held back — could still be a tag)
 * scanner.push("ink>hello ");      // "hello "
 * scanner.push("world</agent-th"); // "world"
 * scanner.push("ink>ignored");     // ""  (outside the tag, discarded)
 * scanner.flush();                 // ""  (nothing left open)
 * ```
 */
export const createThinkTagScanner = (
  tagNames: readonly string[],
): ThinkTagScanner => {
  const openTags = tagNames.map((name) => `<${name.toLowerCase()}>`);
  const closeTags = tagNames.map((name) => `</${name.toLowerCase()}>`);
  const longestTagLength = Math.max(
    1,
    ...openTags.map((tag) => tag.length),
    ...closeTags.map((tag) => tag.length),
  );

  let buffer = "";
  let inside = false;

  // Finds the earliest occurrence of any needle in an already-lowercased
  // haystack, returning its position and matched length (or null).
  const findEarliest = (
    haystackLower: string,
    needles: readonly string[],
  ): { index: number; length: number } | null => {
    let best: { index: number; length: number } | null = null;
    for (const needle of needles) {
      const index = haystackLower.indexOf(needle);
      if (index === -1) {
        continue;
      }
      if (best === null || index < best.index) {
        best = { index, length: needle.length };
      }
    }
    return best;
  };

  // How many trailing characters of `text` could still grow into one of
  // `tags` if more input arrives — the partial-tag hold-back. Bounded by
  // `longestTagLength - 1`, so latency and memory are both O(tag length),
  // independent of how much text has been scanned.
  const heldSuffixLength = (
    text: string,
    tags: readonly string[],
  ): number => {
    const maxHold = Math.min(text.length, longestTagLength - 1);
    for (let length = maxHold; length > 0; length -= 1) {
      const suffix = text.slice(text.length - length).toLowerCase();
      if (tags.some((tag) => tag.startsWith(suffix))) {
        return length;
      }
    }
    return 0;
  };

  const push = (chunk: string): string => {
    buffer += chunk;
    let out = "";

    // A single chunk can contain multiple tag transitions (e.g. a whole
    // "<tag>text</tag>" arriving at once), so drain until neither branch
    // makes progress.
    for (;;) {
      const bufferLower = buffer.toLowerCase();

      if (!inside) {
        const match = findEarliest(bufferLower, openTags);
        if (match === null) {
          const hold = heldSuffixLength(buffer, openTags);
          buffer = hold > 0 ? buffer.slice(buffer.length - hold) : "";
          break;
        }
        inside = true;
        buffer = buffer.slice(match.index + match.length);
        continue;
      }

      const match = findEarliest(bufferLower, closeTags);
      if (match === null) {
        const hold = heldSuffixLength(buffer, closeTags);
        out += buffer.slice(0, buffer.length - hold);
        buffer = hold > 0 ? buffer.slice(buffer.length - hold) : "";
        break;
      }
      out += buffer.slice(0, match.index);
      inside = false;
      buffer = buffer.slice(match.index + match.length);
    }

    return out;
  };

  const flush = (): string => {
    const tail = inside ? buffer : "";
    buffer = "";
    inside = false;
    return tail;
  };

  return { push, flush };
};

/** Emits streaming think frames for one model turn, one turn at a time. */
export type ThinkFrameEmitter = {
  /** Feed one slice of already-extracted think text (from a scanner). */
  delta: (text: string) => void;
  /**
   * Ends the current turn, emitting `think-end` with `finalText` (if a
   * `think-start` was ever opened for this turn).
   *
   * @param finalText - The complete, cleaned think text for this turn (after
   *   whole-block extraction), or `null` if no think block was found at all.
   *
   *   Safe to call again with `null` after a normal close (e.g. once from a
   *   `finally` block as an abort/error safety net) — every real caller in
   *   this codebase uses exactly that pattern, and it's a true no-op the
   *   second time. It is NOT safe to call again with the same non-null text:
   *   after a close, `id`/`streamed` reset for the next turn, so a second
   *   call can't tell "repeat close of this turn" apart from "a new turn
   *   that happens to have no deltas of its own" — the two look identical
   *   from this function's internal state. Resolving that ambiguity would
   *   need the caller to mark turn boundaries explicitly; until a caller
   *   actually needs to re-close with real text, don't rely on it.
   */
  finish: (finalText: string | null) => void;
};

let nextThinkStreamId = 0;

/**
 * Creates an emitter that turns scanner deltas into `think-start` /
 * `think-delta` / `think-end` wire frames, coalescing small deltas to limit
 * frame volume.
 *
 * @remarks
 * Coalescing here is a **wire-economy** floor only, deliberately small — the
 * client re-coalesces again against its own live terminal width before
 * repainting, which this emitter has no visibility into. Reusable across
 * turns: call `finish()` to close one turn, then `delta()`/`finish()` again
 * for the next — each turn gets a fresh id.
 *
 * If `finish()` is called with non-null text but no `delta()` calls opened a
 * stream this turn (e.g. a think block found only by the whole-response
 * regex extraction, not by the incremental scanner), it opens one just to
 * close it immediately, so the text is never dropped.
 *
 * @param params.emit - Sink for wire frames (e.g. the per-connection RSocket emitter).
 * @param params.agent - `true` for the lead agent, `false` for a subagent.
 * @param params.source - Which subagent this stream belongs to, so concurrent
 *   subagent think streams (which all share one `emit`) can be told apart and
 *   labelled. Omit for the lead agent.
 * @param params.coalesceChars - Characters buffered before a `think-delta` is
 *   sent, unless a newline flushes it earlier. @defaultValue 16
 *
 * @example
 * ```ts
 * const thinkFrames = createThinkFrameEmitter({ emit, agent: false, source: agentSource });
 * const scanner = createThinkTagScanner([THINK_BLOCK]);
 * for await (const token of chatStream) {
 *   thinkFrames.delta(scanner.push(token));
 * }
 * thinkFrames.delta(scanner.flush());
 * thinkFrames.finish(extractThinking(fullResponse));
 * ```
 */
export const createThinkFrameEmitter = (params: {
  emit: (frame: TaskFrame) => void;
  agent: boolean;
  source?: SubagentStatusSource;
  coalesceChars?: number;
}): ThinkFrameEmitter => {
  const { emit, agent, source } = params;
  const coalesceChars = params.coalesceChars ?? 16;

  let id: string | null = null;
  let pending = "";

  const open = (): string => {
    if (id === null) {
      nextThinkStreamId += 1;
      id = `think-${nextThinkStreamId}`;
      emit({ kind: "think-start", id, agent, source });
    }
    return id;
  };

  const flushPending = (): void => {
    if (pending.length === 0) {
      return;
    }
    emit({ kind: "think-delta", id: open(), text: pending });
    pending = "";
  };

  const delta = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    pending += text;
    if (pending.includes("\n") || pending.length >= coalesceChars) {
      flushPending();
    }
  };

  const finish = (finalText: string | null): void => {
    flushPending();

    if (id === null) {
      if (finalText === null) {
        return;
      }
      open();
    }
    emit({
      kind: "think-end",
      id: id as string,
      ...(finalText !== null ? { text: finalText } : {}),
    });

    id = null;
    pending = "";
  };

  return { delta, finish };
};
