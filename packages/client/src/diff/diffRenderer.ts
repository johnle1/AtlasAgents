/**
 * <Summary>
 * What it does:
 *   Renders diff output with syntax highlighting and colors for display in
 *   the terminal, supporting both structured diff chunks and raw diff text.
 *
 * How it fits in the system:
 *   Sits between the diff generation layer (which produces DiffChunk objects)
 *   and the terminal display layer (renderer). Centralises all diff rendering
 *   logic so changes to display format only require updates to this module.
 *
 * Dependencies:
 *   - @loopycode/shared — DiffChunk, DiffDisplayLine types and getDiffDisplayLines.
 *   - themeManager — getTheme for terminal color scheme.
 *   - langDetector — detectLang for syntax highlighting language detection.
 *   - shikiHighlighter — highlightLine for syntax highlighting.
 *
 * Dependants:
 *   - LocalFileProxy — uses renderDiff for file change previews.
 *   - Renderer — uses renderDiffFromChunks for displaying edit changes.
 * </Summary>
 */
import type { DiffChunk, DiffDisplayLine } from "@loopycode/shared";
import { getDiffDisplayLines } from "@loopycode/shared";
import { getTheme } from "../theme/themeManager.js";
import { detectLang } from "./langDetector.js";
import { highlightLine } from "./shikiHighlighter.js";

/** Regular expression to match ANSI escape codes for terminal colors. */
const ANSI_ESCAPE_CODE_REGEX = /\x1b\[[0-9;]*m/g;

/** Indent column count for print/write operations (4 spaces). */
const PRINT_WRITE_INDENT = 4;

/**
 * <Summary>
 * What it does:
 *   Removes ANSI escape codes from a string to get the plain text without
 *   terminal color formatting.
 *
 * How it does it (step by step):
 *   1. Uses regex to find all ANSI escape code sequences.
 *   2. Replaces all matches with empty string.
 *   3. Returns the cleaned string.
 *
 * Parameters:
 *   @param {string} inputString — The string that may contain ANSI codes.
 *
 * Returns:
 *   @returns {string} — The string with all ANSI escape codes removed.
 *
 * Dependencies:
 *   - ANSI_ESCAPE_CODE_REGEX — pattern to match ANSI escape codes.
 *
 * Dependants:
 *   - visibleLength — uses this to calculate visible string length.
 *   - renderDiff — uses this to clean diff text before parsing.
 * </Summary>
 */
export const stripAnsi = (inputString: string): string =>
  inputString.replace(ANSI_ESCAPE_CODE_REGEX, "");

/**
 * <Summary>
 * What it does:
 *   Calculates the visible length of a string by removing ANSI escape codes
 *   and counting the remaining characters.
 *
 * How it does it (step by step):
 *   1. Calls stripAnsi to remove all ANSI escape codes from the string.
 *   2. Returns the length of the cleaned string.
 *
 * Parameters:
 *   @param {string} inputString — The string that may contain ANSI codes.
 *
 * Returns:
 *   @returns {number} — The visible character count (without ANSI codes).
 *
 * Dependencies:
 *   - stripAnsi — removes ANSI escape codes from string.
 *
 * Dependants:
 *   - padToTerminal — uses this to calculate padding needed.
 * </Summary>
 */
export const visibleLength = (inputString: string): number =>
  stripAnsi(inputString).length;

/**
 * <Summary>
 * What it does:
 *   Injects a background color code after each ANSI reset code in a
 *   syntax-highlighted string to maintain background color across segments.
 *
 * How it does it (step by step):
 *   1. Checks if the highlighted string is empty.
 *   2. If empty, returns just the background color code.
 *   3. Otherwise, splits the string on ANSI reset codes.
 *   4. Joins the segments back together, inserting the background code after each reset.
 *   5. Returns the modified string with background codes injected.
 *
 * Parameters:
 *   @param {string} highlighted — The syntax-highlighted string with ANSI codes.
 *   @param {string} backgroundColor — The ANSI background color code to inject.
 *
 * Returns:
 *   @returns {string} — The string with background color codes injected.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - renderDisplayLine — uses this to add background color to highlighted lines.
 * </Summary>
 */
export const injectBackground = (
  highlighted: string,
  backgroundColor: string,
): string => {
  // ===== STEP 1: Handle Empty String =====
  // Step 1a: If the highlighted string is empty, return just the background color
  if (highlighted.length === 0) {
    return backgroundColor;
  }

  // ===== STEP 2: Inject Background After Reset Codes =====
  // Step 2a: Split the string on ANSI reset codes (\x1b[0m)
  // Step 2b: Join segments back together, inserting background code after each reset
  // This ensures the background color persists across syntax-highlighted segments
  return highlighted.split("\x1b[0m").join(`\x1b[0m${backgroundColor}`);
};

/** Regular expression to match added lines in diff output (line number, +, content). */
const ADDED_LINE_REGEX = /^\s+(\d+)\s{2}\+\s(.*)$/;

/** Regular expression to match removed lines in diff output (line number, -, content). */
const REMOVED_LINE_REGEX = /^\s+(\d+)\s{2}-\s(.*)$/;

/** Regular expression to match context lines in diff output (line number, spaces, content). */
const CONTEXT_LINE_REGEX = /^\s+(\d+)\s{4}(.*)$/;

const parseLineNum = (value: string): number => {
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? 0 : num;
};

/**
 * <Summary>
 * What it does:
 *   Parses a single line of diff output to extract line number, kind (added,
 *   removed, or context), and text content.
 *
 * How it does it (step by step):
 *   1. Attempts to match the line against the added line regex.
 *   2. If match, extracts line number and text, returns DiffDisplayLine with kind="added".
 *   3. If no match, attempts to match against removed line regex.
 *   4. If match, extracts line number and text, returns DiffDisplayLine with kind="removed".
 *   5. If no match, attempts to match against context line regex.
 *   6. If match, extracts line number and text, returns DiffDisplayLine with kind="context".
 *   7. If no regex matches, returns null (line is not a valid diff line).
 *
 * Parameters:
 *   @param {string} line — The raw diff line to parse.
 *
 * Returns:
 *   @returns {DiffDisplayLine | null} — Parsed line data, or null if not a valid diff line.
 *
 * Dependencies:
 *   - ADDED_LINE_REGEX — pattern for added lines.
 *   - REMOVED_LINE_REGEX — pattern for removed lines.
 *   - CONTEXT_LINE_REGEX — pattern for context lines.
 *
 * Dependants:
 *   - renderDiff — uses this to parse each line of raw diff text.
 *   - renderDiffFromChunks — uses this indirectly via getDiffDisplayLines.
 * </Summary>
 */
export const parseDisplayLine = (line: string): DiffDisplayLine | null => {
  // ===== STEP 1: Try to Match Added Line =====
  // Step 1a: Attempt to match the line against the added line pattern
  const addedMatch = line.match(ADDED_LINE_REGEX);
  if (addedMatch) {
    // Step 1b: Return parsed added line with line number and text
    return {
      kind: "added",
      lineNum: parseLineNum(addedMatch[1] ?? "0"),
      text: addedMatch[2] ?? "",
    };
  }

  // ===== STEP 2: Try to Match Removed Line =====
  // Step 2a: Attempt to match the line against the removed line pattern
  const removedMatch = line.match(REMOVED_LINE_REGEX);
  if (removedMatch) {
    // Step 2b: Return parsed removed line with line number and text
    return {
      kind: "removed",
      lineNum: parseLineNum(removedMatch[1] ?? "0"),
      text: removedMatch[2] ?? "",
    };
  }

  // ===== STEP 3: Try to Match Context Line =====
  // Step 3a: Attempt to match the line against the context line pattern
  const contextMatch = line.match(CONTEXT_LINE_REGEX);
  if (contextMatch) {
    // Step 3b: Return parsed context line with line number and text
    return {
      kind: "context",
      lineNum: parseLineNum(contextMatch[1] ?? "0"),
      text: contextMatch[2] ?? "",
    };
  }

  // ===== STEP 4: No Match Found =====
  // Step 4a: Return null if line doesn't match any diff pattern
  return null;
};

/**
 * <Summary>
 * What it does:
 *   Pads a line with spaces to fill the terminal width, ensuring the line
 *   extends to the right edge of the terminal for consistent background coloring.
 *
 * How it does it (step by step):
 *   1. Gets the current terminal color theme.
 *   2. Gets the terminal width (defaults to 80 if unavailable).
 *   3. Calculates padding needed: terminal width minus indent minus visible line length.
 *   4. Ensures padding is non-negative (handles cases where line exceeds width).
 *   5. Appends the calculated spaces and a reset code to the line.
 *   6. Returns the padded line.
 *
 * Parameters:
 *   @param {string} line — The line to pad.
 *   @param {number} indentCols — The number of columns used for indentation.
 *
 * Returns:
 *   @returns {string} — The line padded with spaces to terminal width.
 *
 * Dependencies:
 *   - getTheme — retrieves terminal color theme for reset code.
 *   - visibleLength — calculates visible character count of line.
 *
 * Dependants:
 *   - renderDisplayLine — uses this to pad lines for background coloring.
 * </Summary>
 */
const padToTerminal = (line: string, indentCols: number): string => {
  // ===== STEP 1: Get Terminal Configuration =====
  // Step 1a: Get the current terminal color theme
  const theme = getTheme();

  // Step 1b: Get terminal width (default to 80 if process.stdout.columns is unavailable)
  const terminalColumns = process.stdout.columns ?? 80;

  // ===== STEP 2: Calculate Padding =====
  // Step 2a: Calculate padding needed to fill terminal width
  // Formula: terminal width - indent columns - visible line length
  // Step 2b: Ensure padding is non-negative (handles lines that exceed terminal width)
  const paddingCount = Math.max(
    0,
    terminalColumns - indentCols - visibleLength(line),
  );

  // ===== STEP 3: Apply Padding =====
  // Step 3a: Append spaces and reset code to the line
  // The spaces fill to terminal edge, reset code clears background color
  return line + " ".repeat(paddingCount) + theme.reset;
};

/**
 * <Summary>
 * What it does:
 *   Renders a single parsed diff line with syntax highlighting, colors,
 *   and line numbers for terminal display.
 *
 * How it does it (step by step):
 *   1. Gets the terminal color theme.
 *   2. Pads the line number to 4 characters for consistent alignment.
 *   3. If the line is context (unchanged), renders with context color and no highlighting.
 *   4. If the line is added or removed:
 *      a. Selects the appropriate background color (green for added, red for removed).
 *      b. Selects the appropriate marker (+ or -).
 *      c. Syntax-highlights the line text using Shiki.
 *      d. Injects the background color into the highlighted text.
 *      e. Builds the prefix with line number and the content with marker and highlighted text.
 *      f. Pads the combined line to terminal width.
 *   5. Returns the rendered line string.
 *
 * Parameters:
 *   @param {DiffDisplayLine} line — The parsed diff line to render.
 *   @param {string} language — The programming language for syntax highlighting.
 *   @param {string} shikiTheme — The Shiki theme name for syntax highlighting.
 *   @param {number} indentCols — The number of columns used for indentation.
 *
 * Returns:
 *   @returns {Promise<string>} — The rendered line with colors and syntax highlighting.
 *
 * Dependencies:
 *   - getTheme — retrieves terminal color scheme.
 *   - highlightLine — syntax-highlights the line text.
 *   - injectBackground — adds background color to highlighted text.
 *   - padToTerminal — pads line to terminal width.
 *
 * Dependants:
 *   - renderDiff — calls this for each parsed line in raw diff text.
 *   - renderDiffFromChunks — calls this for each line in structured diff chunks.
 * </Summary>
 */
const renderDisplayLine = async (
  line: DiffDisplayLine,
  language: string,
  shikiTheme: string,
  indentCols: number,
): Promise<string> => {
  // ===== STEP 1: Get Theme and Format Line Number =====
  // Step 1a: Get the current terminal color theme
  const theme = getTheme();

  // Step 1b: Pad line number to 4 characters for consistent alignment
  const paddedLineNumber = String(line.lineNum).padStart(4);

  // ===== STEP 2: Handle Context Lines (Unchanged) =====
  // Step 2a: Check if this is a context line (unchanged)
  if (line.kind === "context") {
    // Step 2b: Render with context color, no syntax highlighting needed
    const plainLine = `${theme.diffContext}  ${paddedLineNumber}    ${line.text}${theme.reset}`;

    // Step 2c: Pad to terminal width and return
    return padToTerminal(plainLine, indentCols);
  }

  // ===== STEP 3: Handle Added or Removed Lines =====
  // Step 3a: Select background color based on line kind
  const backgroundColor =
    line.kind === "added" ? theme.diffBgAdded : theme.diffBgRemoved;

  // Step 3b: Select marker based on line kind
  const lineMarker = line.kind === "added" ? "+" : "-";

  // Step 3c: Syntax-highlight the line text using Shiki
  const highlightedText = await highlightLine(line.text, language, shikiTheme);

  // Step 3d: Inject background color into the highlighted text
  const textWithBackground = injectBackground(highlightedText, backgroundColor);

  // Step 3e: Build the prefix part (line number with secondary color)
  const prefixPart = `${theme.textSecondary}  ${paddedLineNumber}  ${theme.reset}`;

  // Step 3f: Build the content part (marker and highlighted text with background)
  const contentPart = `${backgroundColor}${lineMarker} ${textWithBackground}`;

  // Step 3g: Combine parts, pad to terminal width, and return
  return padToTerminal(prefixPart + contentPart, indentCols);
};

/**
 * <Summary>
 * What it does:
 *   Renders a diff line that couldn't be parsed by parseDisplayLine using
 *   simple heuristics to apply appropriate colors based on line content.
 *
 * How it does it (step by step):
 *   1. Gets the terminal color theme.
 *   2. Checks if line starts with diff metadata markers (+++, ---, @@).
 *   3. If metadata, renders with secondary text color.
 *   4. Checks if line contains "  + " indicating added content.
 *   5. If added, renders with diff added color.
 *   6. Checks if line contains "  - " indicating removed content.
 *   7. If removed, renders with diff removed color.
 *   8. Otherwise, renders with diff context color (default).
 *   9. Returns the colored line.
 *
 * Parameters:
 *   @param {string} line — The raw diff line that couldn't be parsed.
 *
 * Returns:
 *   @returns {string} — The line with appropriate color applied.
 *
 * Dependencies:
 *   - getTheme — retrieves terminal color scheme.
 *
 * Dependants:
 *   - renderDiff — uses this for lines that don't match diff patterns.
 * </Summary>
 */
const fallbackPlainLine = (line: string): string => {
  // ===== STEP 1: Get Theme =====
  // Step 1a: Get the current terminal color theme
  const theme = getTheme();

  // ===== STEP 2: Handle Diff Metadata Lines =====
  // Step 2a: Check if line starts with diff metadata markers
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("@@")
  ) {
    // Step 2b: Render with secondary text color for metadata
    return `${theme.textSecondary}${line}${theme.reset}`;
  }

  // ===== STEP 3: Handle Added Lines =====
  // Step 3a: Check if line contains "  + " pattern (added content)
  if (line.includes("  + ")) {
    // Step 3b: Render with diff added color (green)
    return `${theme.diffAdded}${line}${theme.reset}`;
  }

  // ===== STEP 4: Handle Removed Lines =====
  // Step 4a: Check if line contains "  - " pattern (removed content)
  if (line.includes("  - ")) {
    // Step 4b: Render with diff removed color (red)
    return `${theme.diffRemoved}${line}${theme.reset}`;
  }

  // ===== STEP 5: Default to Context Color =====
  // Step 5a: Render with diff context color (default/gray)
  return `${theme.diffContext}${line}${theme.reset}`;
};

/**
 * <Summary>
 * What it does:
 *   Renders a diff from structured DiffChunk objects with syntax highlighting
 *   and colors for terminal display.
 *
 * How it does it (step by step):
 *   1. Converts DiffChunk array to DiffDisplayLine array using shared utility.
 *   2. Detects the programming language from the file path.
 *   3. Gets the Shiki theme name from the current theme.
 *   4. Iterates through each display line.
 *   5. Renders each line with syntax highlighting and colors.
 *   6. Joins all rendered lines with newlines.
 *   7. Returns the complete rendered diff string.
 *
 * Parameters:
 *   @param {string} filePath — The file path for language detection.
 *   @param {DiffChunk[]} chunks — Array of diff chunks to render.
 *
 * Returns:
 *   @returns {Promise<string>} — The fully rendered diff with colors and syntax highlighting.
 *
 * Dependencies:
 *   - getDiffDisplayLines — converts chunks to display lines.
 *   - detectLang — determines programming language from file path.
 *   - getTheme — retrieves Shiki theme name.
 *   - renderDisplayLine — renders each individual line.
 *
 * Dependants:
 *   - Renderer — uses this to display edit changes in the CLI.
 * </Summary>
 */
export const renderDiffFromChunks = async (
  filePath: string,
  chunks: DiffChunk[],
): Promise<string> => {
  // ===== STEP 1: Convert Chunks to Display Lines =====
  // Step 1a: Convert structured DiffChunk array to DiffDisplayLine array
  const displayLines = getDiffDisplayLines(chunks);

  // ===== STEP 2: Detect Language and Get Theme =====
  // Step 2a: Detect programming language from file extension
  const language = detectLang(filePath);

  // Step 2b: Get Shiki theme name from current terminal theme
  const shikiTheme = getTheme().shikiTheme;

  // ===== STEP 3: Render Each Line =====
  // Step 3a: Initialize array to hold rendered lines
  const renderedLines: string[] = [];

  // Step 3b: Iterate through each display line
  for (const displayLine of displayLines) {
    // Step 3c: Render the line with syntax highlighting and colors
    // Step 3d: Use PRINT_WRITE_INDENT (4) for indentation
    renderedLines.push(
      await renderDisplayLine(
        displayLine,
        language,
        shikiTheme,
        PRINT_WRITE_INDENT,
      ),
    );
  }

  // ===== STEP 4: Combine Lines =====
  // Step 4a: Join all rendered lines with newlines
  return renderedLines.join("\n");
};

/**
 * <Summary>
 * What it does:
 *   Renders a diff from raw diff text string with syntax highlighting and
 *   colors for terminal display, used for file change previews.
 *
 * How it does it (step by step):
 *   1. Detects the programming language from the file path.
 *   2. Gets the Shiki theme name from the current theme.
 *   3. Strips ANSI codes from the raw diff text.
 *   4. Splits the cleaned text into individual lines.
 *   5. Iterates through each line.
 *   6. If line is empty, adds empty string to output.
 *   7. Otherwise, attempts to parse the line as a diff display line.
 *   8. If parse succeeds, renders with syntax highlighting and colors.
 *   9. If parse fails, renders using fallback plain line coloring.
 *   10. Joins all rendered lines with newlines.
 *   11. Returns the complete rendered diff string.
 *
 * Parameters:
 *   @param {string} filePath — The file path for language detection.
 *   @param {string} diffText — The raw diff text string to render.
 *
 * Returns:
 *   @returns {Promise<string>} — The fully rendered diff with colors and syntax highlighting.
 *
 * Dependencies:
 *   - detectLang — determines programming language from file path.
 *   - getTheme — retrieves Shiki theme name.
 *   - stripAnsi — removes ANSI codes from diff text.
 *   - parseDisplayLine — parses individual diff lines.
 *   - renderDisplayLine — renders parsed lines with syntax highlighting.
 *   - fallbackPlainLine — renders unparsable lines with simple coloring.
 *
 * Dependants:
 *   - LocalFileProxy — uses this for file change previews before user approval.
 * </Summary>
 */
export const renderDiff = async (
  filePath: string,
  diffText: string,
): Promise<string> => {
  // ===== STEP 1: Detect Language and Get Theme =====
  // Step 1a: Detect programming language from file extension
  const language = detectLang(filePath);

  // Step 1b: Get Shiki theme name from current terminal theme
  const shikiTheme = getTheme().shikiTheme;

  // ===== STEP 2: Initialize Output =====
  // Step 2a: Initialize array to hold rendered lines
  const renderedLines: string[] = [];

  // Step 2b: Set indent for confirm prompts (2 columns)
  const confirmIndent = 2;

  // ===== STEP 3: Process Each Line =====
  // Step 3a: Strip ANSI codes from raw diff text
  // Step 3b: Split cleaned text into individual lines
  for (const rawLine of stripAnsi(diffText).split("\n")) {
    // ===== STEP 3c: Handle Empty Lines =====
    // Step 3c-i: If line is empty, add empty string to output
    if (rawLine.length === 0) {
      renderedLines.push("");
      continue;
    }

    // ===== STEP 3d: Try to Parse Line =====
    // Step 3d-i: Attempt to parse the line as a diff display line
    const parsedLine = parseDisplayLine(rawLine);

    // Step 3d-ii: If parse succeeded, render with syntax highlighting
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
      // Step 3d-iii: If parse failed, use fallback plain line coloring
      renderedLines.push(fallbackPlainLine(rawLine));
    }
  }

  // ===== STEP 4: Combine Lines =====
  // Step 4a: Join all rendered lines with newlines
  return renderedLines.join("\n");
};
