/**
 * Splits a growing markdown buffer into a stable (closed) prefix and an
 * unstable tail so re-lexing cannot flicker committed blocks.
 *
 * @remarks
 * An odd number of fence openers (` ``` ` at line start) means the last
 * fence is still open — everything from that opener is the tail and is
 * rendered as plain text until the closer arrives.
 */

export type StableMarkdownSplit = {
  /** Closed markdown that is safe to lex and render. */
  stable: string;
  /** Incomplete suffix (open fence, or empty). */
  tail: string;
};

const FENCE_AT_LINE_START = /^ {0,3}```/gm;

/**
 * Splits `source` so an unclosed code fence is not lexed as a finished block.
 *
 * @param source - Growing markdown buffer (streaming or complete).
 * @returns `{ stable, tail }`. Empty input yields two empty strings.
 *
 * @example
 * ```ts
 * splitStableMarkdown("# Hi\n\n```js\nconst x");
 * // { stable: "# Hi\n\n", tail: "```js\nconst x" }
 * ```
 */
export const splitStableMarkdown = (source: string): StableMarkdownSplit => {
  if (source.length === 0) {
    return { stable: "", tail: "" };
  }
  const fences = [...source.matchAll(FENCE_AT_LINE_START)];
  if (fences.length % 2 === 1) {
    const last = fences[fences.length - 1];
    const index = last?.index ?? 0;
    return { stable: source.slice(0, index), tail: source.slice(index) };
  }
  return { stable: source, tail: "" };
};
