/**
 * Module-level handle so the global key handler can expand paste
 * placeholders back to their full text without owning the paste map.
 *
 * @remarks
 * {@link MultilineInput} registers its placeholder-expansion function on
 * mount and clears it on unmount. {@link createKeyHandler} calls
 * {@link requestExpand} before queueing a message typed while busy, so the
 * agent sees the verbatim clipboard text instead of a `[Pasted text #N]`
 * token. Mirrors {@link registerNewlineHandle} / {@link requestNewline} in
 * `newlineHandle.ts`.
 */

type ExpandHandle = (display: string) => string;

let expandHandle: ExpandHandle | null = null;

/**
 * Registers the prompt's placeholder-expansion implementation.
 *
 * @param handle - Function that expands placeholders in `display` back to
 *   their full text, or `null` to unregister (call from cleanup).
 * @returns A disposer that unregisters only if `handle` is still current.
 *
 * @example
 * ```ts
 * useEffect(
 *   () => registerExpandHandle((text) => expandPlaceholders(text, pastes)),
 *   [pastes],
 * );
 * ```
 */
export const registerExpandHandle = (
  handle: ExpandHandle | null,
): (() => void) => {
  expandHandle = handle;
  return () => {
    if (expandHandle === handle) {
      expandHandle = null;
    }
  };
};

/**
 * Expands paste placeholders in `display`, if the input is mounted.
 *
 * @param display - Prompt text as shown, possibly containing placeholders.
 * @returns The expanded text, or `display` unchanged when the prompt is
 *   unmounted (busy `…` placeholder, overlays).
 */
export const requestExpand = (display: string): string =>
  expandHandle ? expandHandle(display) : display;
