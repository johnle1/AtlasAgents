/**
 * Single source of truth for keyboard shortcuts shown in the `?` cheat-sheet.
 *
 * @remarks
 * Each `id` that {@link createKeyHandler} consumes must match an entry in
 * {@link HANDLED_KEYS}. `enter` is documented here even though the input box
 * binds it, so the overlay lists every key a user actually presses.
 *
 * Keep this list in lockstep with `keyHandler.ts` — `shortcutCatalog.test.ts`
 * diffs the two.
 */

/**
 * One row in the shortcuts overlay and the README keyboard table.
 */
export type ShortcutEntry = {
  /**
   * Stable id. Handler-owned ids match {@link HANDLED_KEYS}
   * (`"escape"`, `"ctrl+c"`, …). `"enter"` is input-box-owned.
   */
  id: string;
  /** Keys as shown to the user (`"Ctrl+C"`, `"↑"`). */
  keys: string;
  /** What the shortcut does. */
  action: string;
};

/**
 * Bound keyboard shortcuts for the Ink CLI.
 *
 * @remarks
 * Order is the overlay display order. Keep descriptions short — the panel
 * is a cheat-sheet, not a manual.
 */
export const SHORTCUT_CATALOG: ShortcutEntry[] = [
  {
    id: "escape",
    keys: "Esc",
    action: "Cancel running task / clear input",
  },
  {
    id: "ctrl+c",
    keys: "Ctrl+C",
    action: "Cancel task / clear input / quit",
  },
  {
    id: "ctrl+l",
    keys: "Ctrl+L",
    action: "Clear the screen",
  },
  {
    id: "ctrl+o",
    keys: "Ctrl+O",
    action: "Expand truncated directory listing",
  },
  {
    id: "ctrl+j",
    keys: "Ctrl+J",
    action: "Insert newline",
  },
  {
    id: "ctrl+d",
    keys: "Ctrl+D",
    action: "Delete character under cursor",
  },
  {
    id: "ctrl+a",
    keys: "Ctrl+A",
    action: "Move cursor to start of line",
  },
  {
    id: "ctrl+e",
    keys: "Ctrl+E",
    action: "Move cursor to end of line",
  },
  {
    id: "shift+enter",
    keys: "Shift+Enter",
    action: "Insert newline",
  },
  {
    id: "alt+enter",
    keys: "Alt+Enter",
    action: "Insert newline",
  },
  {
    id: "alt+m",
    keys: "Alt+M",
    action: "Toggle raw markdown source",
  },
  {
    id: "shift+tab",
    keys: "Shift+Tab",
    action: "Cycle approval mode (default / accept-edits / plan)",
  },
  {
    id: "tab",
    keys: "Tab",
    action: "Accept autocomplete suggestion",
  },
  {
    id: "up",
    keys: "↑",
    action: "Previous history / previous suggestion",
  },
  {
    id: "down",
    keys: "↓",
    action: "Next history / next suggestion",
  },
  {
    id: "enter",
    keys: "Enter",
    action: "Submit input / queue while busy",
  },
  {
    id: "?",
    keys: "?",
    action: "Toggle this shortcuts cheat-sheet",
  },
];
