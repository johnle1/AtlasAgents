/**
 * <Summary>
 * What it does:
 *   Builds ANSI-styled banner lines for the CLI header display, including the logo,
 *   welcome message, version information, and model configuration details.
 *
 * How it fits in the system:
 *   Creates the visual header for the LoopyCode CLI that displays at the top of the
 *   terminal. The banner includes an ASCII art logo, welcome message, version number,
 * and advisor/agent model information. The output is styled with ANSI escape sequences
 * for colors and formatting.
 *
 * Dependencies:
 *   - Config — provides advisor and agent model configuration.
 *   - visibleLength — calculates visible string length accounting for ANSI codes.
 *   - themeManager — provides the current color theme.
 *   - ansi256 — provides foreground/background color functions.
 *   - logoArt — provides the logo grid, dimensions, and padding utilities.
 *
 * Dependants:
 *   - Banner — uses this to generate banner lines for display.
 *   - AppContext — uses this to refresh the banner when configuration changes.
 * </Summary>
 */

import type { Config } from "../../config.js";
import { visibleLength } from "../../diff/diffRenderer.js";
import { getTheme } from "../../theme/themeManager.js";
import { fg } from "../../theme/ansi256.js";
import { bg } from "../../theme/ansi256.js";
import {
  BANNER_BORDER_HEX,
  BANNER_INNER,
  LOGO_GRID,
  LOGO_ROW_WIDTH,
  bannerCenterPad,
} from "./logoArt.js";

/**
 * <Summary>
 * What it does:
 *   The welcome message displayed in the CLI banner.
 *
 * Used by:
 *   - buildBannerLines — uses this to create the welcome line in the banner.
 *
 * Produced by:
 *   - Constant definition — defined as a module-level constant.
 * </Summary>
 */
const WELCOME_TEXT = "Welcome back";

/**
 * <Summary>
 * What it does:
 *   Creates a single logo pixel (two spaces) with the specified background color.
 *
 * How it does it (step by step):
 *   1. Check if a color was provided.
 *   2. If no color, return two spaces (transparent pixel).
 *   3. If color provided, wrap two spaces in ANSI background color codes.
 *   4. Append ANSI reset code to reset color after the pixel.
 *
 * Parameters:
 * @param {string | null} pixelColor — The hex color string for the pixel background, or null for transparent.
 *
 * Returns:
 * @returns {string} — The ANSI-styled pixel string (two spaces with background color or transparent).
 *
 * Dependencies:
 *   - ansi256.bg — applies background color to text.
 *
 * Dependants:
 *   - logoRow — uses this to render each pixel in a logo row.
 * </Summary>
 */
const logoPixel = (pixelColor: string | null): string => {
  // ===== STEP 1: Check if color provided =====
  // Step 1a: If no color provided, return transparent pixel (two spaces)
  // Step 1b: This creates empty space in the logo grid
  if (!pixelColor) return "  ";

  // ===== STEP 2: Render colored pixel =====
  // Step 2a: Wrap two spaces in ANSI background color codes
  // Step 2b: Append ANSI reset code to reset color after the pixel
  // Step 2c: This creates a colored 2-character wide pixel in the logo
  return bg(pixelColor) + "  " + "\x1b[0m";
};

/**
 * <Summary>
 * What it does:
 *   Renders a single row of the logo from an array of pixel colors.
 *
 * How it does it (step by step):
 *   1. Map over each color in the row array.
 *   2. Convert each color to a styled pixel using logoPixel.
 *   3. Join all pixels together into a single string.
 *
 * Parameters:
 * @param {(string | null)[]} logoRowColors — Array of hex color strings (or null) for each pixel in the row.
 *
 * Returns:
 * @returns {string} — The complete rendered logo row as an ANSI-styled string.
 *
 * Dependencies:
 *   - logoPixel — renders individual pixels from colors.
 *
 * Dependants:
 *   - buildBannerLines — uses this to render each logo row for the banner.
 * </Summary>
 */
const logoRow = (logoRowColors: (string | null)[]): string => {
  // ===== STEP 1: Render logo row =====
  // Step 1a: Map over each color in the row array
  // Step 1b: Convert each color to a styled pixel using logoPixel
  // Step 1c: Join all pixels together into a single string
  return logoRowColors.map(logoPixel).join("");
};

/**
 * <Summary>
 * What it does:
 *   Creates a blank banner line with border characters on both sides.
 *
 * How it does it (step by step):
 *   1. Construct the line with border, pipe, spacing, and reset codes.
 *   2. Calculate spacing to fill the banner inner width.
 *   3. Return the complete blank line string.
 *
 * Parameters:
 * @param {string} borderColor — The ANSI code for the border color.
 * @param {string} resetCode — The ANSI reset code to reset colors.
 *
 * Returns:
 * @returns {string} — A blank banner line with borders and spacing.
 *
 * Dependencies:
 *   - BANNER_INNER — provides the width of the banner content area.
 *
 * Dependants:
 *   - buildBannerLines — uses this to create blank spacer lines in the banner.
 * </Summary>
 */
const borderedBlank = (borderColor: string, resetCode: string): string =>
  // ===== STEP 1: Create blank bordered line =====
  // Step 1a: Construct the line with border color, pipe, spacing, and reset codes
  // Step 1b: Calculate spacing to fill the banner inner width (BANNER_INNER spaces)
  // Step 1c: Return the complete blank line string with borders on both sides
  `${borderColor}│${resetCode}${" ".repeat(BANNER_INNER)}${borderColor}│${resetCode}`;

/**
 * <Summary>
 * What it does:
 *   Builds the complete banner lines for the CLI header display.
 *
 * How it does it (step by step):
 *   1. Get the current theme and extract color codes.
 *   2. Retrieve model names from configuration (with defaults).
 *   3. Initialize the output lines array.
 *   4. Create the title line with version and border decoration.
 *   5. Add blank spacer line.
 *   6. Create the welcome message line (centered).
 *   7. Add blank spacer line.
 *   8. Render each row of the ASCII art logo (centered).
 *   9. Add blank spacer line.
 *   10. Create advisor model information line (right-aligned).
 *   11. Create agent model information line (right-aligned).
 *   12. Add blank spacer line.
 *   13. Create the bottom border line.
 *   14. Return the complete array of banner lines.
 *
 * Parameters:
 * @param {Config} configuration — The application configuration containing model information.
 * @param {string} version — The application version string to display in the title.
 *
 * Returns:
 * @returns {string[]} — Array of ANSI-styled banner lines ready for terminal display.
 *
 * Dependencies:
 *   - getTheme — provides the current color theme.
 *   - ansi256.fg — provides foreground color function.
 *   - logoArt constants — provides banner dimensions and logo grid.
 *   - borderedBlank — creates blank spacer lines.
 *   - logoRow — renders logo rows.
 *   - bannerCenterPad — calculates centering padding.
 *   - visibleLength — calculates visible string length.
 *
 * Dependants:
 *   - Banner — uses this to generate banner lines for display.
 *   - AppContext — uses this to refresh the banner when configuration changes.
 * </Summary>
 */
export const buildBannerLines = (
  configuration: Config,
  version: string,
): string[] => {
  // ===== STEP 1: Get theme and color codes =====
  // Step 1a: Get the current color theme for styling
  const theme = getTheme();

  // Step 1b: Get the border color code for banner borders
  const borderColor = fg(BANNER_BORDER_HEX);

  // Step 1c: Get the ANSI reset code to reset colors
  const resetCode = theme.reset;

  // ===== STEP 2: Get model information =====
  // Step 2a: Get the advisor model name from configuration, default to "not set"
  const advisorModelName = configuration.advisorModel || "not set";

  // Step 2b: Get the agent model name from configuration, default to "not set"
  const agentModelName = configuration.agentModel || "not set";

  // ===== STEP 3: Initialize output lines =====
  // Step 3a: Initialize an empty array to store all banner lines
  const bannerLines: string[] = [];

  // ===== STEP 4: Create title line =====
  // Step 4a: Create the title string with version number
  const titleText = ` LoopyCode CLI v${version} `;

  // Step 4b: Calculate the number of dashes needed to fill the title line
  // Step 4c: Subtract fixed widths (6 for "╭──────" and title length) from BANNER_INNER
  // Step 4d: Use Math.max to ensure we don't get negative dashes
  const titleDashes = "─".repeat(
    Math.max(0, BANNER_INNER - 6 - titleText.length),
  );

  // Step 4e: Create the top border line with title and decoration
  // Step 4f: Include border color, bold text for title, and dashes for visual balance
  bannerLines.push(
    `${borderColor}╭──────${resetCode}${theme.textBold}${titleText}${resetCode}${borderColor}${titleDashes}╮${resetCode}`,
  );

  // ===== STEP 5: Add blank spacer line =====
  // Step 5a: Add a blank line with borders to create visual separation
  bannerLines.push(borderedBlank(borderColor, resetCode));

  // ===== STEP 6: Create welcome message line =====
  // Step 6a: Calculate the padding needed to center the welcome text
  const welcomePadding = bannerCenterPad(WELCOME_TEXT.length);

  // Step 6b: Create the welcome line with centered text and borders
  // Step 6c: Include left padding, bold welcome text, and right padding
  bannerLines.push(
    `${borderColor}│${resetCode}${" ".repeat(welcomePadding.left)}${theme.textBold}${WELCOME_TEXT}${resetCode}${" ".repeat(welcomePadding.right)}${borderColor}│${resetCode}`,
  );

  // ===== STEP 7: Add blank spacer line =====
  // Step 7a: Add a blank line with borders to create visual separation
  bannerLines.push(borderedBlank(borderColor, resetCode));

  // ===== STEP 8: Render ASCII art logo =====
  // Step 8a: Calculate the padding needed to center the logo
  const logoPadding = bannerCenterPad(LOGO_ROW_WIDTH);

  // Step 8b: Iterate over each row in the logo grid
  for (const logoRowColors of LOGO_GRID) {
    // Step 8c: Render the current logo row from the color array
    const renderedLogoLine = logoRow(logoRowColors);

    // Step 8d: Create the banner line with the rendered logo row
    // Step 8e: Include left padding, logo row, and right padding
    bannerLines.push(
      `${borderColor}│${resetCode}${" ".repeat(logoPadding.left)}${renderedLogoLine}${" ".repeat(logoPadding.right)}${borderColor}│${resetCode}`,
    );
  }

  // ===== STEP 9: Add blank spacer line =====
  // Step 9a: Add a blank line with borders to create visual separation
  bannerLines.push(borderedBlank(borderColor, resetCode));

  // ===== STEP 10: Create advisor model line =====
  // Step 10a: Create the advisor model information string
  const advisorInfoLine = `  Advisor: ${advisorModelName}`;

  // Step 10b: Create the advisor model line with right-aligned padding
  // Step 10c: Use visibleLength to account for ANSI color codes in the model name
  // Step 10d: Calculate padding to right-align the text within the banner
  bannerLines.push(
    `${borderColor}│${resetCode}  Advisor: ${theme.textAccent}${advisorModelName}${resetCode}${" ".repeat(Math.max(0, BANNER_INNER - visibleLength(advisorInfoLine)))}${borderColor}│${resetCode}`,
  );

  // ===== STEP 11: Create agent model line =====
  // Step 11a: Create the agent model information string
  const agentInfoLine = `  Agent: ${agentModelName}`;

  // Step 11b: Create the agent model line with right-aligned padding
  // Step 11c: Use visibleLength to account for ANSI color codes in the model name
  // Step 11d: Calculate padding to right-align the text within the banner
  bannerLines.push(
    `${borderColor}│${resetCode}  Agent: ${theme.textAccent}${agentModelName}${resetCode}${" ".repeat(Math.max(0, BANNER_INNER - visibleLength(agentInfoLine)))}${borderColor}│${resetCode}`,
  );

  // ===== STEP 12: Add blank spacer line =====
  // Step 12a: Add a blank line with borders to create visual separation
  bannerLines.push(borderedBlank(borderColor, resetCode));

  // ===== STEP 13: Create bottom border line =====
  // Step 13a: Create the bottom border line with decoration
  // Step 13b: Use BANNER_INNER width for the horizontal border line
  bannerLines.push(`${borderColor}╰${"─".repeat(BANNER_INNER)}╯${resetCode}`);

  // ===== STEP 14: Return complete banner =====
  // Step 14a: Return the complete array of banner lines
  return bannerLines;
};
