/**
 * Module-level handle so the global key handler can insert a newline at
 * the multiline prompt's caret without owning buffer state.
 *
 * @remarks
 * {@link MultilineInput} registers its insert-newline function on mount
 * and clears it on unmount. {@link createKeyHandler} calls
 * {@link requestNewline} for Ctrl+J / Shift+Enter / Alt+Enter.
 */

type NewlineHandle = () => void;

let newlineHandle: NewlineHandle | null = null;

/**
 * Registers the prompt's insert-newline implementation.
 *
 * @param handle - Function that inserts a newline at the caret, or `null`
 *   to unregister (call from the component's cleanup).
 * @returns A disposer that unregisters only if `handle` is still current.
 *
 * @example
 * ```ts
 * useEffect(() => registerNewlineHandle(() => dispatch({ type: "newline" })), []);
 * ```
 */
export const registerNewlineHandle = (
  handle: NewlineHandle | null,
): (() => void) => {
  newlineHandle = handle;
  return () => {
    if (newlineHandle === handle) {
      newlineHandle = null;
    }
  };
};

/**
 * Inserts a newline at the prompt caret, if the input is mounted.
 *
 * @remarks
 * No-op when the prompt is unmounted (busy `…` placeholder, overlays).
 */
export const requestNewline = (): void => {
  newlineHandle?.();
};
