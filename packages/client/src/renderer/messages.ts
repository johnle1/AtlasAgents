import { getTheme } from "../theme/themeManager.js";
import { appendBlock, appendText } from "./sink.js";

/**
 * <Summary>
 * What it does:
 *   Displays a plain text line as a system message.
 *
 * How it does it (step by step):
 *   1. Append the text to the output sink with "system" category.
 *
 * Parameters:
 *   @param {string} text — The text message to display.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the text line.
 *
 * Dependencies:
 *   - appendText — displays the text to the output sink.
 *
 * Dependants:
 *   - System message functions — use this to display plain system messages.
 * </Summary>
 */
export const printLine = (text: string): void => {
  // ===== STEP 1: Display text line =====
  // Step 1a: Append the text to the output sink with "system" category
  // Step 1b: The system category determines how the text is formatted and handled
  appendText(text, "system");
};

/**
 * <Summary>
 * What it does:
 *   Displays an error message with error styling and icon.
 *
 * How it does it (step by step):
 *   1. Get the current theme for error styling.
 *   2. Build a styled error line with "error:" label and the error message.
 *   3. Append the styled line to the output block.
 *
 * Parameters:
 *   @param {string} message — The error message to display.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the error message.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for error styling.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - Error handling functions — use this to display error messages to users.
 * </Summary>
 */
export const printError = (message: string): void => {
  // ===== STEP 1: Get theme for error styling =====
  // Step 1a: Get the current theme for error color and styling
  const theme = getTheme();

  // ===== STEP 2: Build and display error line =====
  // Step 2a: Build a styled error line with "error:" label in error color
  // Step 2b: Apply theme reset at the end to prevent color bleeding
  // Step 2c: Append the styled line to the output block for display
  appendBlock([`${theme.error}  error:${theme.reset} ${message}`]);
};

/**
 * <Summary>
 * What it does:
 *   Displays a success message with success styling and checkmark icon.
 *
 * How it does it (step by step):
 *   1. Get the current theme for success styling.
 *   2. Build a styled success line with checkmark icon and the success message.
 *   3. Append the styled line to the output block.
 *
 * Parameters:
 *   @param {string} message — The success message to display.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the success message.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for success styling.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - Success notification functions — use this to display success messages to users.
 * </Summary>
 */
export const printSuccess = (message: string): void => {
  // ===== STEP 1: Get theme for success styling =====
  // Step 1a: Get the current theme for success color and styling
  const theme = getTheme();

  // ===== STEP 2: Build and display success line =====
  // Step 2a: Build a styled success line with checkmark icon (✓) in success color
  // Step 2b: Apply theme reset at the end to prevent color bleeding
  // Step 2c: Append the styled line to the output block for display
  appendBlock([`${theme.success}  ✓${theme.reset} ${message}`]);
};
