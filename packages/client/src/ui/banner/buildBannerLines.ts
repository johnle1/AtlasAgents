/**
 * ANSI string builder for the LoopyCode CLI startup banner.
 *
 * @remarks
 * Produces one fully styled terminal line per array entry — including box-drawing
 * borders, centered welcome text, the pixel octopus from {@link LOGO_GRID}, and
 * advisor/agent model labels. Use this when you need raw ANSI strings (scripts,
 * logs, or a non-Ink renderer). Prefer the Ink `Banner` component
 * (`../components/Banner.tsx`) inside the interactive TUI so colors go through
 * Ink’s attribute system.
 *
 * Layout constants and art come from `logoArt.ts` so this builder and the React
 * banner stay visually aligned.
 *
 * @see {@link bannerCenterPad} for shared centering math.
 * @see {@link LOGO_GRID} for the pixel grid this paints via ANSI backgrounds.
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

/** Fixed greeting centered under the title; keep short enough to fit `BANNER_INNER`. */
const WELCOME_TEXT = "Welcome back";

/**
 * Renders one logo grid cell as a two-space “pixel” with optional background.
 *
 * @remarks
 * Transparent cells (`null`) are plain spaces so the surrounding banner padding
 * color shows through. Colored cells wrap `"  "` in an ANSI background then
 * hard-reset (`\x1b[0m`) so the next cell / border does not inherit the fill.
 *
 * @param pixelColor - Hex fill for the cell, or `null` for transparent.
 * @returns Two printable columns, possibly wrapped in ANSI sequences.
 */
const logoPixel = (pixelColor: string | null): string => {
  // Transparent cells must still occupy LOGO_PIXEL_WIDTH columns or the row
  // shifts and the box borders misalign.
  if (!pixelColor) return "  ";

  // Hard reset after each pixel — bg() alone does not restore prior fg/bold state
  // that later title/model segments may rely on.
  return bg(pixelColor) + "  " + "\x1b[0m";
};

/**
 * Joins one {@link LOGO_GRID} row into a single ANSI string of block pixels.
 *
 * @param logoRowColors - One scanline of hex-or-null cells (`LOGO_COLS` long).
 * @returns Concatenated pixels; visible width is {@link LOGO_ROW_WIDTH}.
 */
const logoRow = (logoRowColors: (string | null)[]): string =>
  logoRowColors.map(logoPixel).join("");

/**
 * Builds an empty interior row that preserves left/right borders.
 *
 * @remarks
 * Used as vertical padding between title, welcome, logo, and model sections
 * without collapsing the box frame.
 *
 * @param borderColor - ANSI foreground sequence for the `│` glyphs.
 * @param resetCode - Theme reset sequence applied after each border segment.
 * @returns One full-width blank line inside the banner box.
 */
const borderedBlank = (borderColor: string, resetCode: string): string =>
  `${borderColor}│${resetCode}${" ".repeat(BANNER_INNER)}${borderColor}│${resetCode}`;

/**
 * Builds the complete multi-line ANSI banner for the CLI header.
 *
 * @remarks
 * Line order is fixed for visual hierarchy:
 * 1. Top border with bold title + version
 * 2. Welcome text (centered)
 * 3. Pixel logo (centered)
 * 4. Advisor / agent model lines (left-labeled, padded to the right border)
 * 5. Bottom border
 *
 * Model names come from `configuration.advisorModel` / `configuration.agentModel`
 * and fall back to `"not set"` when missing so the layout never shows empty labels.
 *
 * **Padding note:** padding for model lines uses {@link visibleLength} on the
 * *un-accented* label string so ANSI color codes on the model name are not
 * counted as columns. If you style the label prefix differently, recompute
 * padding from the same visible source string.
 *
 * Does not throw; missing models degrade to placeholders.
 *
 * @param configuration - App config providing current advisor and agent model names.
 * @param version - Semver (or build) string shown after `LoopyCode CLI v`.
 * @returns Ordered ANSI-styled lines ready to print with `console.log` or similar.
 *
 * @example
 * ```ts
 * import { buildBannerLines } from "./buildBannerLines.js";
 * import type { Config } from "../../config.js";
 *
 * const configuration = {
 *   advisorModel: "llama3.2:3b",
 *   agentModel: "qwen2.5-coder:7b",
 * } as Config;
 *
 * for (const line of buildBannerLines(configuration, "0.4.0")) {
 *   console.log(line);
 * }
 * ```
 *
 * @example <caption>Missing models</caption>
 * ```ts
 * // Empty model fields render as "not set" without shrinking the box.
 * const lines = buildBannerLines({} as Config, "1.0.0");
 * // …includes "  Advisor: not set" and "  Agent: not set"
 * ```
 *
 * @see {@link LOGO_GRID} for the art painted into the logo section.
 * @see {@link bannerCenterPad} for centering welcome text and the logo.
 */
export const buildBannerLines = (
  configuration: Config,
  version: string,
): string[] => {
  const theme = getTheme();
  const borderColor = fg(BANNER_BORDER_HEX);
  const resetCode = theme.reset;

  const advisorModelName = configuration.advisorModel || "not set";
  const agentModelName = configuration.agentModel || "not set";

  const bannerLines: string[] = [];

  // Title sits after a fixed "╭──────" run; remaining inner width is filled with
  // ─ so the closing ╮ stays flush to BANNER_INNER regardless of version length.
  const titleText = ` LoopyCode CLI v${version} `;
  const titleDashes = "─".repeat(
    Math.max(0, BANNER_INNER - 6 - titleText.length),
  );

  bannerLines.push(
    `${borderColor}╭──────${resetCode}${theme.textBold}${titleText}${resetCode}${borderColor}${titleDashes}╮${resetCode}`,
  );

  bannerLines.push(borderedBlank(borderColor, resetCode));

  const welcomePadding = bannerCenterPad(WELCOME_TEXT.length);
  bannerLines.push(
    `${borderColor}│${resetCode}${" ".repeat(welcomePadding.left)}${theme.textBold}${WELCOME_TEXT}${resetCode}${" ".repeat(welcomePadding.right)}${borderColor}│${resetCode}`,
  );

  bannerLines.push(borderedBlank(borderColor, resetCode));

  // Center using rendered pixel width, not grid column count (each cell = 2 cols).
  const logoPadding = bannerCenterPad(LOGO_ROW_WIDTH);

  for (const logoRowColors of LOGO_GRID) {
    const renderedLogoLine = logoRow(logoRowColors);
    bannerLines.push(
      `${borderColor}│${resetCode}${" ".repeat(logoPadding.left)}${renderedLogoLine}${" ".repeat(logoPadding.right)}${borderColor}│${resetCode}`,
    );
  }

  bannerLines.push(borderedBlank(borderColor, resetCode));

  // Pad from the uncolored label so theme accent escapes do not inflate width.
  const advisorInfoLine = `  Advisor: ${advisorModelName}`;
  bannerLines.push(
    `${borderColor}│${resetCode}  Advisor: ${theme.textAccent}${advisorModelName}${resetCode}${" ".repeat(Math.max(0, BANNER_INNER - visibleLength(advisorInfoLine)))}${borderColor}│${resetCode}`,
  );

  const agentInfoLine = `  Agent: ${agentModelName}`;
  bannerLines.push(
    `${borderColor}│${resetCode}  Agent: ${theme.textAccent}${agentModelName}${resetCode}${" ".repeat(Math.max(0, BANNER_INNER - visibleLength(agentInfoLine)))}${borderColor}│${resetCode}`,
  );

  bannerLines.push(borderedBlank(borderColor, resetCode));

  bannerLines.push(`${borderColor}╰${"─".repeat(BANNER_INNER)}╯${resetCode}`);

  return bannerLines;
};
