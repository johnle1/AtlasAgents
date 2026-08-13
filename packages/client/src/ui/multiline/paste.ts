/**
 * Paste detection, collapse-to-placeholder, and expand-on-submit.
 *
 * @remarks
 * Large pastes (bracketed paste arrives as one `onChange` with a length
 * delta &gt; 1) collapse to an atomic `[Pasted text #N: X lines]` token so
 * the prompt stays readable. The original text is kept beside the token
 * and spliced back in on submit — the agent always sees the verbatim paste.
 *
 * Placeholder tokens are atomic: one backspace that lands on the token
 * removes the whole thing (see {@link placeholderRangeAt}).
 *
 * @example
 * ```ts
 * const pasted = hugeClipboard;
 * const collapsed = collapsePaste(pasted, PASTE_CHAR_THRESHOLD, 1);
 * const submitted = expandPlaceholders(collapsed.display, [
 *   { placeholder: collapsed.placeholder, fullText: collapsed.fullText },
 * ]);
 * submitted === pasted; // true
 * ```
 */

/**
 * Pastes longer than this many characters collapse to a placeholder.
 *
 * @remarks
 * Single-character typing is never a paste ({@link detectPaste} requires a
 * length delta &gt; 1), so a short typed word is never collapsed even if
 * this threshold is later lowered.
 */
export const PASTE_CHAR_THRESHOLD = 150;

/**
 * One collapsed paste sitting in the prompt.
 */
export type PasteMapping = {
  /** Display token, e.g. `[Pasted text #1: 8 lines]`. */
  placeholder: string;
  /** Original clipboard text, restored on submit. */
  fullText: string;
};

/**
 * Result of {@link collapsePaste}.
 */
export type CollapsedPaste = {
  /** What the prompt should show (placeholder or original, if under threshold). */
  display: string;
  /** Token used as the map key; equals `display` when collapsed. */
  placeholder: string;
  /** Verbatim pasted text. */
  fullText: string;
};

/**
 * Heuristic: a single change that grew the buffer by more than one
 * character is treated as a paste (bracketed paste or a multi-char drop).
 *
 * @param previous - Prompt text before the change.
 * @param next - Prompt text after the change.
 * @returns `true` when `next` is more than one character longer than `previous`.
 */
export const detectPaste = (previous: string, next: string): boolean =>
  next.length - previous.length > 1;

const lineCountOf = (text: string): number => {
  if (text.length === 0) return 0;
  return text.split("\n").length;
};

/**
 * Collapses `pastedText` to a numbered placeholder when it exceeds `threshold`.
 *
 * @param pastedText - Newly inserted clipboard text (not the whole prompt).
 * @param threshold - Character count above which collapse happens.
 * @param id - 1-based paste number shown in the token (`#1`, `#2`, …).
 * @returns Display token plus the original text for later expansion.
 *
 * @example
 * ```ts
 * collapsePaste("x".repeat(200), 150, 1);
 * // { display: "[Pasted text #1: 1 line]", ... }
 * ```
 */
export const collapsePaste = (
  pastedText: string,
  threshold: number,
  id: number,
): CollapsedPaste => {
  if (pastedText.length <= threshold) {
    return {
      display: pastedText,
      placeholder: pastedText,
      fullText: pastedText,
    };
  }
  const lines = lineCountOf(pastedText);
  const unit = lines === 1 ? "line" : "lines";
  const placeholder = `[Pasted text #${id}: ${lines} ${unit}]`;
  return { display: placeholder, placeholder, fullText: pastedText };
};

/**
 * Replaces every known placeholder token in `display` with its full text.
 *
 * @param display - Prompt as shown (may contain one or more tokens).
 * @param pastes - Placeholder → original text mappings.
 * @returns Text the agent should receive. Unknown tokens are left as-is.
 */
export const expandPlaceholders = (
  display: string,
  pastes: readonly PasteMapping[],
): string =>
  pastes.reduce(
    (text, { placeholder, fullText }) =>
      placeholder === fullText ? text : text.split(placeholder).join(fullText),
    display,
  );

/**
 * Byte-offset span of a placeholder the caret is on or immediately after.
 *
 * @remarks
 * Used to make backspace atomic: if the caret sits inside or just after a
 * token, delete the whole token in one keystroke.
 *
 * @param display - Prompt as shown.
 * @param cursorOffset - Caret offset in `display` (`0` = before first char).
 * @param placeholders - Tokens currently in the prompt.
 * @returns Inclusive-start exclusive-end span, or `null` if the caret is free.
 */
export const placeholderRangeAt = (
  display: string,
  cursorOffset: number,
  placeholders: readonly string[],
): { start: number; end: number; placeholder: string } | null => {
  for (const placeholder of placeholders) {
    if (placeholder.length === 0) continue;
    let from = 0;
    while (from <= display.length) {
      const start = display.indexOf(placeholder, from);
      if (start < 0) break;
      const end = start + placeholder.length;
      if (cursorOffset > start && cursorOffset <= end) {
        return { start, end, placeholder };
      }
      from = start + 1;
    }
  }
  return null;
};
