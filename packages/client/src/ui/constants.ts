/**
 * Shared UI tuning constants for input history and slash-command autocomplete.
 */

/**
 * Maximum number of submitted commands kept in in-memory arrow-key history.
 *
 * @remarks
 * Matches the on-disk cap in {@link saveHistory}. Older entries are dropped
 * from the tail when the limit is exceeded.
 */
export const MAX_INPUT_HISTORY = 1_000;

/**
 * Number of slash-command suggestions visible in the autocomplete popup.
 */
export const AUTOCOMPLETE_VISIBLE_COUNT = 5;

/**
 * Index within the visible window that triggers scrolling the suggestion list.
 *
 * @remarks
 * Set to `AUTOCOMPLETE_VISIBLE_COUNT - 1` so the list scrolls when the
 * selection reaches the last visible row, keeping the highlight in view
 * without jumping on every arrow press.
 */
export const AUTOCOMPLETE_SCROLL_TRIGGER_OFFSET =
  AUTOCOMPLETE_VISIBLE_COUNT - 1;
