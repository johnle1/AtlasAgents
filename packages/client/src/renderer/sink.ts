/**
 * Low-level appenders that feed the Ink/CLI history bridge.
 *
 * @remarks
 * Higher-level `print*` helpers build ANSI-styled strings, then call these
 * sinks so scrollback stays a single history model (`appendHistory` /
 * `appendLog`). Prefer the themed printers for user-facing text unless you are
 * composing a custom block.
 */

import { appendHistory, appendLog } from "../ui/uiBridge.js";
import type { HistoryVariant } from "../ui/types.js";

/**
 * Appends a multi-line ANSI block to history (`kind: "block"`).
 *
 * @param lines - Already-styled display lines (may include ANSI escapes).
 * @throws {@link Error} When `lines` is not an array.
 *
 * @example
 * ```ts
 * appendBlock(["  hello", "  world"]);
 * ```
 */
export const appendBlock = (lines: string[]): void => {
  if (!Array.isArray(lines)) {
    throw new Error("appendBlock: lines must be an array");
  }
  appendHistory({ kind: "block", lines });
};

/**
 * Appends one text row to the log stream with a history variant for styling.
 *
 * @param text - Plain or ANSI-containing text for a single log row.
 * @param variant - Visual role; defaults to `"system"`.
 *
 * @example
 * ```ts
 * appendText("Connecting…", "system");
 * appendText("timeout", "error");
 * ```
 */
export const appendText = (
  text: string,
  variant: HistoryVariant = "system",
): void => {
  appendLog(text, variant);
};

/**
 * Appends a file-diff history entry (`kind: "diff"`).
 *
 * @remarks
 * `path` is the header label shown above the body (often
 * `"Updated src/foo.ts"`). `body` is the pre-rendered diff text from the diff
 * renderer.
 *
 * @param path - Non-empty header / file label for the diff card.
 * @param body - Diff body string (may include ANSI).
 * @throws {@link Error} When `path` is empty/non-string or `body` is not a string.
 *
 * @example
 * ```ts
 * appendDiff("Updated src/a.ts", "+ export const x = 1;\n");
 * ```
 */
export const appendDiff = (path: string, body: string): void => {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("appendDiff: path must be a non-empty string");
  }
  if (typeof body !== "string") {
    throw new Error("appendDiff: body must be a string");
  }
  appendHistory({ kind: "diff", path, body });
};

/**
 * Appends a block with optional leading/trailing blank lines for vertical rhythm.
 *
 * @remarks
 * Leading and trailing blanks **default on** (`!== false`). Pass
 * `{ leadingBlank: false }` / `{ trailingBlank: false }` to disable. Copies
 * `lines` before mutating so callers keep their originals.
 *
 * @param lines - Styled content lines (without required outer blanks).
 * @param options - Spacing toggles; both blanks default to enabled.
 *
 * @example
 * ```ts
 * appendStyledLines(buildConfigLines(config));
 * appendStyledLines(modelLines, { leadingBlank: true, trailingBlank: true });
 * ```
 */
export const appendStyledLines = (
  lines: string[],
  options?: { leadingBlank?: boolean; trailingBlank?: boolean },
): void => {
  // Copy so we never mutate the caller's array when adding spacer rows.
  const blockLines = [...lines];

  if (options?.leadingBlank !== false) {
    blockLines.unshift("");
  }

  if (options?.trailingBlank !== false) {
    blockLines.push("");
  }

  appendBlock(blockLines);
};
