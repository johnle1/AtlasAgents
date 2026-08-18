/**
 * Pure footer line builder for the persistent status bar.
 *
 * @remarks
 * Format: `cwd · git-branch · agent-model · approval-mode · remaining-%`.
 * A missing branch is omitted (not shown as `null`). A missing usage
 * sample renders `—` so the bar never shows `NaN%`. Truncation is a
 * hard ellipsis at `width` so a narrow terminal cannot wrap the footer.
 * The approval-mode segment carries icon + color metadata for Ink;
 * {@link buildFooterLine} joins plain text only (tests / truncation).
 */

import {
  approvalModeDisplay,
  type ApprovalMode,
  type ApprovalModeDisplay,
} from "../../config/approvalMode.js";

/**
 * Inputs for {@link buildFooterLine} / {@link buildFooterSegments}.
 */
export type FooterLineInput = {
  /** Display cwd (already `~`-abbreviated). */
  cwd: string;
  /** Current git branch, or `null` when detached / not a repo. */
  branch: string | null;
  /** Agent model tag shown in the bar. */
  model: string;
  /** Session approval mode (WS4). */
  approvalMode: ApprovalMode | string;
  /**
   * Remaining context as a 0–100 percentage, or `null` before the first
   * `usage` frame arrives.
   */
  contextPct: number | null;
  /** Terminal columns available for the footer. */
  width: number;
};

/**
 * One footer segment. Mode segments carry Ink color / bold styling.
 */
export type FooterSegment =
  | { kind: "text"; text: string }
  | ({ kind: "mode"; text: string } & Pick<
      ApprovalModeDisplay,
      "color" | "bold"
    >);

/**
 * Remaining context as a percentage of the window.
 *
 * @param usedTokens - Tokens consumed so far (already clamped by the client).
 * @param contextWindow - Resolved context window.
 * @returns Integer 0–100. Non-positive windows yield 0.
 *
 * @example
 * ```ts
 * remainingContextPct(2500, 10_000); // 75
 * ```
 */
export const remainingContextPct = (
  usedTokens: number,
  contextWindow: number,
): number => {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return 0;
  }
  if (!Number.isFinite(usedTokens)) {
    return 0;
  }
  const remaining = ((contextWindow - usedTokens) / contextWindow) * 100;
  return Math.max(0, Math.min(100, Math.round(remaining)));
};

const formatContextPct = (pct: number | null): string =>
  pct === null || !Number.isFinite(pct) ? "—" : `${Math.round(pct)}%`;

/**
 * Builds ordered footer segments (cwd · branch · model · mode · %).
 *
 * @param input - Footer fields (width is ignored; truncation is the caller's job).
 * @returns Segments ready for Ink or plain joining.
 */
export const buildFooterSegments = (
  input: Omit<FooterLineInput, "width">,
): FooterSegment[] => {
  const mode = approvalModeDisplay(String(input.approvalMode));
  const segments: FooterSegment[] = [{ kind: "text", text: input.cwd }];
  if (input.branch) {
    segments.push({ kind: "text", text: input.branch });
  }
  segments.push({ kind: "text", text: input.model });
  segments.push({
    kind: "mode",
    text: mode.label,
    color: mode.color,
    bold: mode.bold,
  });
  segments.push({ kind: "text", text: formatContextPct(input.contextPct) });
  return segments;
};

const joinSegmentTexts = (segments: FooterSegment[]): string =>
  segments.map((segment) => segment.text).join(" · ");

const truncateLine = (line: string, width: number): string => {
  if (width === 0) {
    return "";
  }
  if (line.length <= width) {
    return line;
  }
  if (width === 1) {
    return "…";
  }
  return `${line.slice(0, width - 1)}…`;
};

/**
 * Builds the single-line footer string.
 *
 * @param input - Segments plus terminal width.
 * @returns Joined line, truncated with `…` when longer than `width`.
 *
 * @example
 * ```ts
 * buildFooterLine({
 *   cwd: "~/src",
 *   branch: "main",
 *   model: "gemma3:12b",
 *   approvalMode: "default",
 *   contextPct: 75,
 *   width: 80,
 * });
 * // "~/src · main · gemma3:12b · default · 75%"
 * ```
 */
export const buildFooterLine = (input: FooterLineInput): string => {
  const line = joinSegmentTexts(buildFooterSegments(input));
  return truncateLine(line, Math.max(0, input.width));
};

/**
 * Whether the full (untruncated) footer fits in `width`.
 *
 * @remarks
 * When false, {@link FooterBar} falls back to a single dim truncated
 * line so a mid-glyph slice cannot break Ink color spans.
 */
export const footerFitsWidth = (input: FooterLineInput): boolean => {
  const line = joinSegmentTexts(buildFooterSegments(input));
  return line.length <= Math.max(0, input.width);
};
