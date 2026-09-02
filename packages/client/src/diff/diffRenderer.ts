/**
 * Terminal ANSI rendering for file diffs (chunks or plain text).
 *
 * @remarks
 * Consumes {@link DiffChunk} / display lines from `@atlasagents/shared`, detects
 * language via {@link detectLang}, highlights with {@link highlightLine}, and
 * paints add/remove backgrounds from the active UI theme. Used by
 * `printWrite` in the renderer and any confirm UI that shows a change preview.
 *
 * Added/removed lines pad to the terminal width so background colors extend to
 * the right edge (not just through the text length).
 */

import type { DiffChunk, DiffDisplayLine } from "@atlasagents/shared";
import { getDiffDisplayLines } from "@atlasagents/shared";
import { getTheme } from "../theme/themeManager.js";
import { detectLang } from "./langDetector.js";
import { highlightLine } from "./shikiHighlighter.js";

/** Matches CSI color/style sequences used when measuring visible width. */
const ANSI_ESCAPE_CODE_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * Indent columns assumed for write-preview diffs (`printWrite`).
 *
 * @remarks
 * Must stay aligned with how the history card indents the diff body so
 * {@link padToTerminal} fills to the true right edge.
 */
const PRINT_WRITE_INDENT = 4;

/**
 * Removes ANSI CSI sequences so length / layout math sees “real” characters.
 *
 * @param inputString - Text that may contain `\x1b[…m` codes.
 * @returns Plain text with escapes stripped.
 *
 * @example
 * ```ts
 * stripAnsi("\x1b[32mhi\x1b[0m"); // "hi"
 * ```
 */
export const stripAnsi = (inputString: string): string =>
  inputString.replace(ANSI_ESCAPE_CODE_REGEX, "");

/**
 * Returns the printable column count of a string that may include ANSI codes.
 *
 * @remarks
 * Essential for padding: `string.length` over-counts escape bytes and would
 * under-pad (or over-pad) colored lines.
 *
 * @param inputString - Possibly styled string.
 * @returns Length of {@link stripAnsi}`(inputString)`.
 *
 * @example
 * ```ts
 * visibleLength("\x1b[31mx\x1b[0m"); // 1
 * ```
 */
export const visibleLength = (inputString: string): number =>
  stripAnsi(inputString).length;

/**
 * Re-applies a background CSI after every ANSI reset inside highlighted text.
 *
 * @remarks
 * Shiki emits many `\x1b[0m` resets per line. Without re-injection, add/remove
 * background color would stop at the first reset and leave a striped look.
 * Empty `highlighted` returns just `backgroundColor` (blank but tinted cell).
 *
 * @param highlighted - Shiki ANSI for the line body.
 * @param backgroundColor - Theme add/remove background sequence (e.g. `diffBgAdded`).
 * @returns Highlighted text with background restored after each reset.
 *
 * @example
 * ```ts
 * injectBackground("\x1b[32mfoo\x1b[0mbar", "\x1b[42m");
 * → "\x1b[32mfoo\x1b[0m\x1b[42mbar"
 * ```
 */
export const injectBackground = (
  highlighted: string,
  backgroundColor: string,
): string => {
  if (highlighted.length === 0) {
    return backgroundColor;
  }

  // Split on full reset, then glue with reset+bg so later tokens keep the tint.
  return highlighted.split("\x1b[0m").join(`\x1b[0m${backgroundColor}`);
};

/** Plain display format: spaces + lineNum + `  + ` + text. */
const ADDED_LINE_REGEX = /^\s+(\d+)\s{2}\+\s(.*)$/;

/** Plain display format: spaces + lineNum + `  - ` + text. */
const REMOVED_LINE_REGEX = /^\s+(\d+)\s{2}-\s(.*)$/;

/** Plain display format: spaces + lineNum + four spaces + text (context). */
const CONTEXT_LINE_REGEX = /^\s+(\d+)\s{4}(.*)$/;

/**
 * Parses a line-number capture group; invalid values become `0`.
 *
 * @param value - Digit string from a regex group.
 * @returns Non-negative integer line number.
 */
const parseLineNum = (value: string): number => {
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? 0 : num;
};

/**
 * Parses one AtlasAgents plain-diff display row into a {@link DiffDisplayLine}.
 *
 * @remarks
 * Matches the textual layout produced by shared diff formatting (line number,
 * then `+` / `-` / spaces, then body). Returns `null` for headers (`@@`,
 * `+++`) or other non-row lines so callers can use {@link fallbackPlainLine}.
 *
 * @param line - Single raw display line (ANSI already stripped recommended).
 * @returns Structured line, or `null` if unrecognized.
 *
 * @example
 * ```ts
 * parseDisplayLine("  12  + const x = 1");
 * → { kind: "added", lineNum: 12, text: "const x = 1" }
 * ```
 */
export const parseDisplayLine = (line: string): DiffDisplayLine | null => {
  const addedMatch = line.match(ADDED_LINE_REGEX);
  if (addedMatch) {
    return {
      kind: "added",
      lineNum: parseLineNum(addedMatch[1] ?? "0"),
      text: addedMatch[2] ?? "",
    };
  }

  const removedMatch = line.match(REMOVED_LINE_REGEX);
  if (removedMatch) {
    return {
      kind: "removed",
      lineNum: parseLineNum(removedMatch[1] ?? "0"),
      text: removedMatch[2] ?? "",
    };
  }

  const contextMatch = line.match(CONTEXT_LINE_REGEX);
  if (contextMatch) {
    return {
      kind: "context",
      lineNum: parseLineNum(contextMatch[1] ?? "0"),
      text: contextMatch[2] ?? "",
    };
  }

  return null;
};

/**
 * Pads a styled line with spaces so add/remove backgrounds reach the terminal edge.
 *
 * @param line - Already-colored line content (may include ANSI).
 * @param indentCols - Columns already consumed by outer UI indent.
 * @returns Line plus trailing spaces and a theme reset.
 */
const padToTerminal = (line: string, indentCols: number): string => {
  const theme = getTheme();
  // Columns can be undefined in non-TTY tests — 80 keeps padding stable.
  const terminalColumns = process.stdout.columns ?? 80;

  const paddingCount = Math.max(
    0,
    terminalColumns - indentCols - visibleLength(line),
  );

  // Spaces inherit the active background; reset clears it for the next row.
  return line + " ".repeat(paddingCount) + theme.reset;
};

/**
 * Renders one structured display line with optional Shiki highlighting.
 *
 * @remarks
 * Context lines skip Shiki (cheaper; gray theme color only). Added/removed
 * lines highlight, inject add/remove backgrounds, and pad to width.
 *
 * @param line - Parsed display line.
 * @param language - Shiki language id.
 * @param shikiTheme - Active Shiki theme name.
 * @param indentCols - Outer indent for padding math.
 * @returns Final ANSI row string.
 */
const renderDisplayLine = async (
  line: DiffDisplayLine,
  language: string,
  shikiTheme: string,
  indentCols: number,
): Promise<string> => {
  const theme = getTheme();
  const paddedLineNumber = String(line.lineNum).padStart(4);

  if (line.kind === "context") {
    const plainLine = `${theme.diffContext}  ${paddedLineNumber}    ${line.text}${theme.reset}`;
    return padToTerminal(plainLine, indentCols);
  }

  const backgroundColor =
    line.kind === "added" ? theme.diffBgAdded : theme.diffBgRemoved;
  const lineMarker = line.kind === "added" ? "+" : "-";

  const highlightedText = await highlightLine(line.text, language, shikiTheme);
  const textWithBackground = injectBackground(highlightedText, backgroundColor);

  const prefixPart = `${theme.textSecondary}  ${paddedLineNumber}  ${theme.reset}`;
  // Background starts before the +/- marker so the gutter tint matches the body.
  const contentPart = `${backgroundColor}${lineMarker} ${textWithBackground}`;

  return padToTerminal(prefixPart + contentPart, indentCols);
};

/**
 * Colors an unparseable diff line using cheap heuristics (no Shiki).
 *
 * @param line - Raw line that {@link parseDisplayLine} rejected.
 * @returns Themed ANSI string.
 */
const fallbackPlainLine = (line: string): string => {
  const theme = getTheme();

  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("@@")
  ) {
    return `${theme.textSecondary}${line}${theme.reset}`;
  }

  if (line.includes("  + ")) {
    return `${theme.diffAdded}${line}${theme.reset}`;
  }

  if (line.includes("  - ")) {
    return `${theme.diffRemoved}${line}${theme.reset}`;
  }

  return `${theme.diffContext}${line}${theme.reset}`;
};

/**
 * Renders structured diff chunks to a multi-line ANSI string for write preview.
 *
 * @remarks
 * Expands chunks with {@link getDiffDisplayLines}, detects language from
 * `filePath`, and uses {@link PRINT_WRITE_INDENT} so padding matches the
 * `printWrite` history card. Each line is highlighted asynchronously.
 *
 * @param filePath - Path used only for language detection / theming context.
 * @param chunks - Diff chunks from `@atlasagents/shared` (`computeDiff`, etc.).
 * @returns Newline-joined ANSI body (no trailing requirement).
 *
 * @example
 * ```ts
 * const body = await renderDiffFromChunks("src/a.ts", chunks);
 * appendDiff(`Updated ${path}`, body);
 * ```
 */
export const renderDiffFromChunks = async (
  filePath: string,
  chunks: DiffChunk[],
): Promise<string> => {
  const displayLines = getDiffDisplayLines(chunks);
  const language = detectLang(filePath);
  const shikiTheme = getTheme().shikiTheme;

  const renderedLines: string[] = [];
  for (const displayLine of displayLines) {
    renderedLines.push(
      await renderDisplayLine(
        displayLine,
        language,
        shikiTheme,
        PRINT_WRITE_INDENT,
      ),
    );
  }

  return renderedLines.join("\n");
};

/**
 * Renders a preformatted plain-diff string (e.g. confirm preview) to ANSI.
 *
 * @remarks
 * Strips existing ANSI first (so nested colors do not confuse parsers), then
 * either highlights via {@link parseDisplayLine} or falls back to
 * {@link fallbackPlainLine}. Uses a smaller indent (`2`) typical of confirm
 * prompts rather than the write-card indent.
 *
 * @param filePath - Path for {@link detectLang}.
 * @param diffText - Multi-line plain diff display text.
 * @returns Newline-joined ANSI string.
 *
 * @example
 * ```ts
 * const ansi = await renderDiff("src/a.ts", plainDiffText);
 * ```
 */
export const renderDiff = async (
  filePath: string,
  diffText: string,
): Promise<string> => {
  const language = detectLang(filePath);
  const shikiTheme = getTheme().shikiTheme;
  const renderedLines: string[] = [];
  // Confirm UIs nest the diff two columns in — keep pad math in sync.
  const confirmIndent = 2;

  for (const rawLine of stripAnsi(diffText).split("\n")) {
    if (rawLine.length === 0) {
      renderedLines.push("");
      continue;
    }

    const parsedLine = parseDisplayLine(rawLine);
    if (parsedLine) {
      renderedLines.push(
        await renderDisplayLine(
          parsedLine,
          language,
          shikiTheme,
          confirmIndent,
        ),
      );
    } else {
      renderedLines.push(fallbackPlainLine(rawLine));
    }
  }

  return renderedLines.join("\n");
};
