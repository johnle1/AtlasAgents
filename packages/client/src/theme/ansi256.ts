/**
 * Hex → ANSI color helpers with truecolor / 256-color fallback.
 *
 * @remarks
 * Theme definitions often store design-token hex colors. {@link fg} / {@link bg}
 * pick 24-bit CSI (`38;2` / `48;2`) when {@link supportsTrueColor} is true,
 * otherwise the nearest xterm 256-color index (`38;5` / `48;5`).
 */

import { colorDisabled } from "../ui/terminalEnv.js";

/**
 * Discrete RGB levels used by the 6×6×6 ANSI color cube (indices 16–231).
 *
 * @remarks
 * Standard xterm quantization: each channel snaps to one of these six values
 * before computing `16 + 36*r + 6*g + b`.
 */
const COLOR_STEPS = [0, 95, 135, 175, 215, 255] as const;

/**
 * Parses `#RRGGBB` or `RRGGBB` into 0–255 channel values.
 *
 * @param hex - Six hex digits, optionally prefixed with `#`.
 * @returns `[r, g, b]` integers (invalid digits become `NaN` via `parseInt`).
 */
const parseHexRgb = (hex: string): [number, number, number] => {
  const hexString = hex.replace("#", "");
  return [
    parseInt(hexString.slice(0, 2), 16),
    parseInt(hexString.slice(2, 4), 16),
    parseInt(hexString.slice(4, 6), 16),
  ];
};

/**
 * Detects whether the process likely supports 24-bit RGB ANSI colors.
 *
 * @remarks
 * Checks `COLORTERM` for `truecolor` / `24bit`, or `TERM` for substrings
 * `direct` / `truecolor` (common on modern VTE / iTerm / VS Code terminals).
 * Heuristic only — some capable hosts omit these variables.
 *
 * @returns `true` when env vars suggest truecolor support.
 *
 * @example
 * ```ts
 * if (supportsTrueColor()) {
 *   // Prefer \x1b[38;2;R;G;Bm
 * }
 * ```
 */
export const supportsTrueColor = (): boolean => {
  const colorTermVariable = process.env.COLORTERM ?? "";
  if (colorTermVariable === "truecolor" || colorTermVariable === "24bit") {
    return true;
  }

  const termVariable = process.env.TERM ?? "";
  return termVariable.includes("direct") || termVariable.includes("truecolor");
};

/**
 * Builds a 24-bit truecolor **foreground** CSI from a hex color.
 *
 * @param hex - `#RRGGBB` or `RRGGBB`.
 * @returns Escape like `\x1b[38;2;255;87;51m`.
 *
 * @example
 * ```ts
 * hexToTrueColor("#FF5733"); // "\x1b[38;2;255;87;51m"
 * ```
 */
export const hexToTrueColor = (hex: string): string => {
  const [red, green, blue] = parseHexRgb(hex);
  return `\x1b[38;2;${red};${green};${blue}m`;
};

/**
 * Builds a 24-bit truecolor **background** CSI from a hex color.
 *
 * @param hex - `#RRGGBB` or `RRGGBB`.
 * @returns Escape like `\x1b[48;2;255;87;51m`.
 *
 * @example
 * ```ts
 * hexToTrueColorBg("#112233"); // "\x1b[48;2;17;34;51m"
 * ```
 */
export const hexToTrueColorBg = (hex: string): string => {
  const [red, green, blue] = parseHexRgb(hex);
  return `\x1b[48;2;${red};${green};${blue}m`;
};

/**
 * Finds the index (0–5) of the {@link COLOR_STEPS} entry nearest to `value`.
 *
 * @param value - Channel intensity in 0–255.
 * @returns Step index used in the 6×6×6 cube formula.
 */
const nearestStepIndex = (value: number): number => {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let stepIndex = 0; stepIndex < COLOR_STEPS.length; stepIndex++) {
    const distance = Math.abs(COLOR_STEPS[stepIndex]! - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = stepIndex;
    }
  }

  return bestIndex;
};

/**
 * Maps a hex color to the nearest xterm-256 **foreground** CSI.
 *
 * @remarks
 * Quantizes to the 6×6×6 cube (`16 + 36r + 6g + b`). When chroma
 * (`max−min`) is below `24`, also considers the gray ramp (232–255) so near-
 * neutrals do not pick a tinted cube cell. Chooses gray vs cube by Euclidean
 * RGB distance.
 *
 * @param hex - `#RRGGBB` or `RRGGBB`.
 * @returns Escape like `\x1b[38;5;208m`.
 *
 * @example
 * ```ts
 * hexToAnsi256("#808080"); // gray-ramp or cube — nearest 256 index
 * ```
 */
export const hexToAnsi256 = (hex: string): string => {
  const [red, green, blue] = parseHexRgb(hex);
  const maxComponent = Math.max(red, green, blue);
  const minComponent = Math.min(red, green, blue);
  const chroma = maxComponent - minComponent;

  const redIndex = nearestStepIndex(red);
  const greenIndex = nearestStepIndex(green);
  const blueIndex = nearestStepIndex(blue);
  const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;

  const cubeRed = COLOR_STEPS[redIndex]!;
  const cubeGreen = COLOR_STEPS[greenIndex]!;
  const cubeBlue = COLOR_STEPS[blueIndex]!;
  const cubeDistance = Math.sqrt(
    (red - cubeRed) ** 2 + (green - cubeGreen) ** 2 + (blue - cubeBlue) ** 2,
  );

  // Low-chroma: gray ramp often beats a weakly tinted cube cell.
  if (chroma < 24) {
    // ITU-R BT.601 luma weights for perceived brightness.
    const grayValue = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);

    let grayRampIndex = 232;
    let grayRampDistance = Infinity;

    // xterm gray ramp: 24 steps from ~8 to ~238 (index 232–255).
    for (let stepIndex = 0; stepIndex < 24; stepIndex++) {
      const grayValueAtStep = 8 + stepIndex * 10;
      const distance = Math.abs(grayValue - grayValueAtStep);
      if (distance < grayRampDistance) {
        grayRampDistance = distance;
        grayRampIndex = 232 + stepIndex;
      }
    }

    const grayRGBValue = 8 + (grayRampIndex - 232) * 10;
    const grayRGBDistance = Math.sqrt(3 * (grayValue - grayRGBValue) ** 2);

    const finalIndex =
      grayRGBDistance < cubeDistance ? grayRampIndex : cubeIndex;
    return `\x1b[38;5;${finalIndex}m`;
  }

  return `\x1b[38;5;${cubeIndex}m`;
};

/**
 * Maps a hex color to the nearest xterm-256 **background** CSI.
 *
 * @remarks
 * Same quantization as {@link hexToAnsi256} but emits `48;5` instead of `38;5`.
 *
 * @param hex - `#RRGGBB` or `RRGGBB`.
 * @returns Escape like `\x1b[48;5;22m`.
 *
 * @example
 * ```ts
 * hexToAnsi256Bg("#003300");
 * ```
 */
export const hexToAnsi256Bg = (hex: string): string => {
  const [red, green, blue] = parseHexRgb(hex);
  const maxComponent = Math.max(red, green, blue);
  const minComponent = Math.min(red, green, blue);
  const chroma = maxComponent - minComponent;

  const redIndex = nearestStepIndex(red);
  const greenIndex = nearestStepIndex(green);
  const blueIndex = nearestStepIndex(blue);
  const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;

  const cubeRed = COLOR_STEPS[redIndex]!;
  const cubeGreen = COLOR_STEPS[greenIndex]!;
  const cubeBlue = COLOR_STEPS[blueIndex]!;
  const cubeDistance = Math.sqrt(
    (red - cubeRed) ** 2 + (green - cubeGreen) ** 2 + (blue - cubeBlue) ** 2,
  );

  if (chroma < 24) {
    const grayValue = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);

    let grayRampIndex = 232;
    let grayRampDistance = Infinity;

    for (let stepIndex = 0; stepIndex < 24; stepIndex++) {
      const grayValueAtStep = 8 + stepIndex * 10;
      const distance = Math.abs(grayValue - grayValueAtStep);
      if (distance < grayRampDistance) {
        grayRampDistance = distance;
        grayRampIndex = 232 + stepIndex;
      }
    }

    const grayRGBValue = 8 + (grayRampIndex - 232) * 10;
    const grayRGBDistance = Math.sqrt(3 * (grayValue - grayRGBValue) ** 2);

    const finalIndex =
      grayRGBDistance < cubeDistance ? grayRampIndex : cubeIndex;
    return `\x1b[48;5;${finalIndex}m`;
  }

  return `\x1b[48;5;${cubeIndex}m`;
};

/**
 * Best available **foreground** escape for a hex color on this terminal.
 *
 * @param hex - `#RRGGBB` or `RRGGBB`.
 * @returns Truecolor CSI when supported, otherwise 256-color approximation.
 *   Empty string when {@link colorDisabled} is true.
 *
 * @example
 * ```ts
 * process.stdout.write(`${fg("#58a6ff")}Hello${"\x1b[0m"}`);
 * ```
 */
export const fg = (hex: string): string => {
  if (colorDisabled()) return "";
  return supportsTrueColor() ? hexToTrueColor(hex) : hexToAnsi256(hex);
};

/**
 * Best available **background** escape for a hex color on this terminal.
 *
 * @param hex - `#RRGGBB` or `RRGGBB`.
 * @returns Truecolor CSI when supported, otherwise 256-color approximation.
 *   Empty string when {@link colorDisabled} is true.
 *
 * @example
 * ```ts
 * process.stdout.write(`${bg("#003300")}  ${"\x1b[0m"}`);
 * ```
 */
export const bg = (hex: string): string => {
  if (colorDisabled()) return "";
  return supportsTrueColor() ? hexToTrueColorBg(hex) : hexToAnsi256Bg(hex);
};
