/**
 * LoopyCode octopus pixel-art logo — shared by Ink Banner and ANSI banner lines.
 */

export const BANNER_BOX_WIDTH = 48;
export const BANNER_INNER = BANNER_BOX_WIDTH - 4;
export const LOGO_COLS = 6;
export const LOGO_PIXEL_WIDTH = 2;
export const LOGO_ROW_WIDTH = LOGO_COLS * LOGO_PIXEL_WIDTH;

export type LogoColor = string | null;

/** Left/right space counts to center `contentWidth` inside the banner box. */
export const bannerCenterPad = (
  contentWidth: number,
): { left: number; right: number } => {
  const left = Math.max(0, Math.floor((BANNER_INNER - contentWidth) / 2));
  const right = Math.max(0, BANNER_INNER - contentWidth - left);
  return { left, right };
};

/** Grid-based octopus logo (6×9 grid, smaller than 8×13) */
export const LOGO_GRID: LogoColor[][] = [
  // hat crown
  [null, null, "#3388ee", "#3388ee", null, null],
  // white band
  [null, null, "#ffffff", "#ffffff", null, null],
  // hat brim
  [null, "#3388ee", "#3388ee", "#3388ee", "#3388ee", null],
  // head
  ["#9955cc", "#9955cc", "#9955cc", "#9955cc", "#9955cc", "#9955cc"],
  // eyes
  ["#9955cc", "#e8e8e8", "#9955cc", "#9955cc", "#e8e8e8", "#9955cc"],
  // pupils
  ["#9955cc", "#110022", "#9955cc", "#9955cc", "#110022", "#9955cc"],
  // chin
  [null, "#9955cc", "#9955cc", "#9955cc", "#9955cc", null],
  // tentacles
  ["#9955cc", null, "#9955cc", null, "#9955cc", null],
  // curl
  [null, "#9955cc", null, "#9955cc", null, "#9955cc"],
];

/** Octopus logo colors matching the original design */
export const BANNER_BORDER_HEX = "#d97706";
export const LOGO_PURPLE_HEX = "#9955cc";
export const LOGO_EYE_WHITE_HEX = "#e8e8e8";
export const LOGO_PUPIL_HEX = "#110022";
export const LOGO_HAT_HEX = "#3388ee";
export const LOGO_BAND_HEX = "#ffffff";
