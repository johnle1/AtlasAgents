import { beginBlockOutput } from "../agentStatus.js";
import { getTheme } from "../theme/themeManager.js";
import { appendBlock } from "./sink.js";

/**
 * <Summary>
 * What it does:
 *   Defines the safety classification levels for shell commands.
 *
 * Used by:
 *   - printBash — uses this type to determine command styling.
 *   - commandClassifier — returns values of this type after command analysis.
 *
 * Produced by:
 *   - commandClassifier — returns the classification result as this type.
 * </Summary>
 */
export type BashClass = "safe" | "cautious" | "dangerous" | "background";

/**
 * <Summary>
 * What it does:
 *   The icon used to prefix bash/shell command operations in the output.
 *
 * Used by:
 *   - printBash — uses this icon to visually identify shell operations.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
const BASH_OPERATION_ICON = "$";

/**
 * <Summary>
 * What it does:
 *   Displays a shell command with appropriate coloring based on its safety classification.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Determine the appropriate color based on command classification.
 *   3. Use accent color for safe commands, secondary color for others.
 *   4. Build a styled line with the bash icon, operation label, and command.
 *   5. Append the styled line to the output block.
 *
 * Parameters:
 *   @param {string} command — The shell command to display.
 *   @param {BashClass} classification — The safety classification of the command.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the bash command.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - Command execution handlers — use this to display commands before execution.
 * </Summary>
 */
export const printBash = (command: string, classification: BashClass): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Determine appropriate color =====
  // Step 2a: Check if the command is classified as safe
  // Step 2b: Use accent color for safe commands to indicate they're trusted
  // Step 2c: Use secondary color for other classifications (cautious, dangerous, background)
  const commandColor =
    classification === "safe" ? theme.textAccent : theme.textSecondary;

  // ===== STEP 3: Build and display command line =====
  // Step 3a: Build the styled operation line with bash icon, operation label, and command
  // Step 3b: Apply the determined color to the operation text
  // Step 3c: Apply theme reset at the end to prevent color bleeding
  // Step 3d: Append the styled line to the output block for display
  appendBlock([
    `${commandColor}${BASH_OPERATION_ICON} Bash(${command})${theme.reset}`,
  ]);
};

/**
 * <Summary>
 * What it does:
 *   Displays the result of a safe shell command execution with duration timing.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Convert the duration from milliseconds to seconds.
 *   3. Build a styled line with exit code and execution duration.
 *   4. Append the styled line to the output block.
 *
 * Parameters:
 *   @param {number} exitCode — The exit code returned by the shell command.
 *   @param {number} durationMs — The execution duration in milliseconds.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the command result.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - Command execution handlers — use this to display safe command results.
 * </Summary>
 */
export const printBashResult = (exitCode: number, durationMs: number): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Convert duration to seconds =====
  // Step 2a: Convert the duration from milliseconds to seconds
  // Step 2b: Format to 1 decimal place for precision
  const durationSeconds = (durationMs / 1000).toFixed(1);

  // ===== STEP 3: Build and display result line =====
  // Step 3a: Build the styled result line with exit code and duration
  // Step 3b: Use success color for the arrow and timing information
  // Step 3c: Apply theme reset at the end to prevent color bleeding
  // Step 3d: Append the styled line to the output block for display
  appendBlock([
    `  ${theme.success}→ exit ${exitCode} · ${durationSeconds}s${theme.reset}`,
  ]);
};

/**
 * <Summary>
 * What it does:
 *   Displays a message indicating that a command was skipped by the user.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Build a styled line with a cross icon and skipped message.
 *   3. Append the styled line to the output block.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the skipped message.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - Command execution handlers — use this when user rejects command execution.
 * </Summary>
 */
export const printSkipped = (): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Build and display skipped message =====
  // Step 2a: Build the styled skipped message with a cross icon (✗)
  // Step 2b: Use error color to indicate the command was not executed
  // Step 2c: Apply theme reset at the end to prevent color bleeding
  // Step 2d: Append the styled line to the output block for display
  appendBlock([
    `  ${theme.error}✗${theme.reset}  Skipped — command was not run.`,
  ]);
};

/**
 * <Summary>
 * What it does:
 *   Displays a message indicating that a command was approved and is about to run.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Build a styled line with a checkmark icon and running message.
 *   3. Append the styled line to the output block.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the approval message.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - Command execution handlers — use this when user approves command execution.
 * </Summary>
 */
export const printBashApproved = (): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Build and display approval message =====
  // Step 2a: Build the styled approval message with a checkmark icon (✓)
  // Step 2b: Use success color to indicate the command was approved
  // Step 2c: Apply theme reset at the end to prevent color bleeding
  // Step 2d: Append the styled line to the output block for display
  appendBlock([`  ${theme.success}✓${theme.reset}  Running…`]);
};

/**
 * <Summary>
 * What it does:
 *   Displays the completion status of a command with its output (stdout/stderr).
 *
 * How it does it (step by step):
 *   1. Begin a block output section for formatted display.
 *   2. Get the current theme for text styling.
 *   3. Build the completion line with exit code and success icon.
 *   4. Trim whitespace from stdout and stderr outputs.
 *   5. If stdout has content, display up to 8 lines of output.
 *   6. If stderr has content, display up to 4 lines of error output (independent of stdout).
 *   7. If both are empty and exit code is 0, display no output message.
 *   8. Append all lines to the output block.
 *
 * Parameters:
 *   @param {number} exitCode — The exit code returned by the shell command.
 *   @param {string} stdout — The standard output from the command.
 *   @param {string} stderr — The standard error output from the command.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the command completion status.
 *
 * Dependencies:
 *   - beginBlockOutput — starts a formatted output section.
 *   - getTheme — provides theme colors for text styling.
 *   - appendBlock — displays the styled lines to the user.
 *
 * Dependants:
 *   - Command execution handlers — use this to display command completion results.
 * </Summary>
 */
export const printBashRan = (
  exitCode: number,
  stdout: string,
  stderr: string,
): void => {
  // ===== STEP 1: Begin formatted output section =====
  // Step 1a: Start a block output section for proper formatting and spacing
  beginBlockOutput();

  // ===== STEP 2: Get theme for styling =====
  // Step 2a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 3: Build completion line =====
  // Step 3a: Build the completion line with success icon and exit code
  const outputLines = [
    `  ${theme.success}✓${theme.reset}  Finished (exit ${exitCode}).`,
  ];

  // ===== STEP 4: Process output streams =====
  // Step 4a: Trim whitespace from stdout for cleaner display
  const stdoutTrimmed = stdout.trim();

  // Step 4b: Trim whitespace from stderr for cleaner display
  const stderrTrimmed = stderr.trim();

  // ===== STEP 5: Display stdout if present =====
  // Step 5a: Check if stdout has content after trimming
  if (stdoutTrimmed.length > 0) {
    // Step 5b: Split stdout into lines and display up to 8 lines
    // Step 5c: Limit to 8 lines to prevent overwhelming output
    // Step 5d: Apply secondary text color for the output content
    outputLines.push(
      `${theme.textSecondary}${stdoutTrimmed.split("\n").slice(0, 8).join("\n")}${theme.reset}`,
    );
  }
  // ===== STEP 6: Display stderr if present =====
  if (stderrTrimmed.length > 0) {
    outputLines.push(
      `${theme.textSecondary}${stderrTrimmed.split("\n").slice(0, 4).join("\n")}${theme.reset}`,
    );
  }
  // ===== STEP 7: Display no output message =====
  // Step 7a: If both stdout and stderr are empty and exit code is 0, show no output message
  if (stdoutTrimmed.length === 0 && stderrTrimmed.length === 0 && exitCode === 0) {
    outputLines.push(`${theme.textSecondary}  (no output)${theme.reset}`);
  }

  // ===== STEP 8: Display output lines =====
  // Step 8a: Append all styled lines to the output block for display
  appendBlock(outputLines);
};

/**
 * <Summary>
 * What it does:
 *   Displays a success message for a completed operation.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Build a styled line with a checkmark icon and the success message.
 *   3. Append the styled line to the output block.
 *
 * Parameters:
 *   @param {string} message — The success message to display.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the success message.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - File operation handlers — use this to display operation success messages.
 * </Summary>
 */
export const printSuccessOp = (message: string): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Build and display success message =====
  // Step 2a: Build the styled success message with a checkmark icon (✓)
  // Step 2b: Use success color to indicate the operation completed successfully
  // Step 2c: Apply theme reset at the end to prevent color bleeding
  // Step 2d: Append the styled line to the output block for display
  appendBlock([`  ${theme.success}✓${theme.reset}  ${message}`]);
};
