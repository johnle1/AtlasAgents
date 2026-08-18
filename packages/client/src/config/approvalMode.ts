/**
 * Permission-mode tokens shared by config persistence and the session UI.
 *
 * @remarks
 * Lives next to `Config` so `parsing.ts` can coerce disk values without
 * importing the Ink bridge (that import cycle would pull UI state into
 * `loadConfig`). The session singleton and Shift+Tab cycle stay in
 * `ui/bridge/allowlist.ts`. Footer icon/color table lives in
 * {@link APPROVAL_MODE_DISPLAY} (`types.ts`).
 */

import {
  APPROVAL_MODE_DISPLAY,
  type ApprovalModeDisplay,
} from "./types.js";

export type { ApprovalModeDisplay } from "./types.js";

/**
 * Session permission mode.
 *
 * @remarks
 * Shift+Tab cycles `default → accept_edits → plan`. `auto` and `bypass`
 * are set via `/set approval`. `bypass` is never written to disk.
 */
export type ApprovalMode =
  | "default"
  | "accept_edits"
  | "plan"
  | "auto"
  | "bypass";

/**
 * Modes that may be persisted in `config.json`.
 *
 * @remarks
 * Excludes `bypass` — that mode is session-only by design.
 */
export type PersistedApprovalMode = Exclude<ApprovalMode, "bypass">;

/** Shift+Tab cycle. `auto` / `bypass` are absent on purpose. */
export const CYCLE_MODES: readonly ApprovalMode[] = [
  "default",
  "accept_edits",
  "plan",
];

/**
 * Footer presentation for a mode token.
 *
 * @param mode - Wire token or unknown string.
 * @returns Label plus optional Ink color / bold. Unknown modes are shown as-is.
 *
 * @example
 * ```ts
 * approvalModeDisplay("plan"); // { label: "⏸ Plan", color: "#60A5FA" }
 * approvalModeDisplay("bypass"); // { label: "⚠ BYPASS", color: "#FF5555", bold: true }
 * ```
 */
export const approvalModeDisplay = (mode: string): ApprovalModeDisplay =>
  APPROVAL_MODE_DISPLAY[mode as ApprovalMode] ?? { label: mode };

/**
 * Footer / cheat-sheet label for a mode token.
 *
 * @param mode - Wire token or unknown string (unknown is shown as-is).
 * @returns Display label (`⏸ Plan`, `⚠ BYPASS`, …).
 *
 * @example
 * ```ts
 * formatApprovalModeLabel("accept_edits"); // "⏵ Accept Edits"
 * formatApprovalModeLabel("bypass"); // "⚠ BYPASS"
 * ```
 */
export const formatApprovalModeLabel = (mode: string): string =>
  approvalModeDisplay(mode).label;

/**
 * Parses a user- or config-supplied mode string.
 *
 * @remarks
 * Hyphens become underscores. Legacy `"auto_edit"` maps to
 * `"accept_edits"`. Unknown input returns `null`.
 *
 * @param raw - Trimmed or untrimmed token.
 * @returns A mode, or `null` when unrecognized.
 *
 * @example
 * ```ts
 * parseApprovalMode("accept-edits"); // "accept_edits"
 * parseApprovalMode("auto_edit"); // "accept_edits"
 * parseApprovalMode("nope"); // null
 * ```
 */
export const parseApprovalMode = (raw: string): ApprovalMode | null => {
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "auto_edit") {
    return "accept_edits";
  }
  if (
    normalized === "default" ||
    normalized === "accept_edits" ||
    normalized === "plan" ||
    normalized === "auto" ||
    normalized === "bypass"
  ) {
    return normalized;
  }
  return null;
};

/**
 * Coerces a stored config value to a persistable mode.
 *
 * @remarks
 * `bypass` and unknown values become `"default"` so a hand-edited
 * config.json cannot boot into promptless mode.
 *
 * @param raw - Value from disk (any JSON type).
 * @returns A persistable mode.
 */
export const parsePersistedApprovalMode = (
  raw: unknown,
): PersistedApprovalMode => {
  if (typeof raw !== "string") {
    return "default";
  }
  const parsed = parseApprovalMode(raw);
  if (parsed === null || parsed === "bypass") {
    return "default";
  }
  return parsed;
};
