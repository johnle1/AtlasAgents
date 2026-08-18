/**
 * Shared pixel-art logo geometry and colors for the AtlasAgents CLI startup banner.
 *
 * @remarks
 * Both render paths consume this module so the boxed layout stays identical:
 * - Ink React (`Banner.tsx`) — interactive TUI
 * - ANSI string lines (`buildBannerLines`) — plain terminal / non-Ink fallbacks
 *
 * **Layout model:** the banner is a fixed-width box (`BANNER_BOX_WIDTH` columns
 * including border glyphs). Content sits in `BANNER_INNER` printable columns
 * between the left and right `│` borders. The octopus logo is a
 * `LOGO_COLS` × N grid; each filled cell is drawn as `LOGO_PIXEL_WIDTH`
 * spaces with a background color so the logo reads as block pixels, not text.
 *
 * Hex color strings are theme-agnostic design tokens — callers pass them to
 * Ink `backgroundColor` / `color`, or to ANSI helpers like `bg()` / `fg()`.
 *
 * @example
 * ```ts
 * import {
 *   BANNER_INNER,
 *   LOGO_GRID,
 *   LOGO_ROW_WIDTH,
 *   bannerCenterPad,
 * } from "./logoArt.js";
 *
 * // Center the logo row inside the banner frame
 * const { left, right } = bannerCenterPad(LOGO_ROW_WIDTH);
 * const padded = " ".repeat(left) + renderLogoRow(LOGO_GRID[0]!) + " ".repeat(right);
 * // padded.length (visible) === BANNER_INNER
 * ```
 *
 * @see {@link bannerCenterPad} for centering content inside the boxed frame.
 */

/**
 * Total outer width of the banner box in terminal columns, including the
 * left/right border characters (`╭`/`│`/`╰` and matching closers).
 *
 * @remarks
 * Keep this in sync with any title-line dash math in callers. Changing it
 * without updating `titleDashes` / padding helpers will produce uneven borders.
 */
export const BANNER_BOX_WIDTH = 48;

/**
 * Printable column count inside the vertical borders.
 *
 * @remarks
 * Equals `BANNER_BOX_WIDTH - 4`: one column each for the left border, the gap
 * after it, the gap before the right border, and the right border itself in the
 * common `│…content…│` layout used by the banner. All centered/padded content
 * (welcome text, logo, model lines) must fit within this width.
 */
export const BANNER_INNER = BANNER_BOX_WIDTH - 4;

/**
 * Number of logo grid columns (block pixels) per row.
 *
 * @remarks
 * Each column becomes `LOGO_PIXEL_WIDTH` terminal cells when rendered, so the
 * on-screen logo width is `LOGO_COLS * LOGO_PIXEL_WIDTH` (= `LOGO_ROW_WIDTH`).
 */
export const LOGO_COLS = 6;

/**
 * Terminal cells painted per logo grid cell.
 *
 * @remarks
 * Two spaces with a background color form one “square” pixel. Using a single
 * space would make the logo look half as wide and overly tall relative to the
 * box; two spaces approximate a square in most monospace fonts.
 */
export const LOGO_PIXEL_WIDTH = 2;

/**
 * Visible width of one fully rendered logo row in terminal columns.
 *
 * @remarks
 * Use this (not raw grid length) when centering or measuring the logo for
 * padding — `bannerCenterPad(LOGO_ROW_WIDTH)`.
 */
export const LOGO_ROW_WIDTH = LOGO_COLS * LOGO_PIXEL_WIDTH;

/**
 * One logo grid cell: a hex background color, or `null` for a transparent cell.
 *
 * @remarks
 * `null` leaves the cell as plain spaces so the box background shows through.
 * Non-null values are CSS-style hex strings (e.g. `"#9955cc"`) accepted by Ink
 * and by this package’s ANSI color helpers.
 *
 * @example
 * ```ts
 * const eyeCell: LogoColor = "#e8e8e8";
 * const empty: LogoColor = null;
 * ```
 */
export type LogoColor = string | null;

/**
 * Computes left/right space padding to center content of a known visible width
 * inside the banner’s inner area.
 *
 * @remarks
 * Prefer this over ad-hoc `Math.floor` in callers so Ink and ANSI banners stay
 * pixel-aligned. Extra columns from an odd remainder go to the **right** pad
 * (`left` is floored; `right` absorbs the leftover). If `contentWidth` already
 * exceeds `BANNER_INNER`, both pads are clamped to `0` — the content may then
 * overflow the frame; callers should keep content within `BANNER_INNER`.
 *
 * @param contentWidth - Visible (un-styled) width of the content to center, in
 *   terminal columns. Prefer character counts for plain text, or
 *   `LOGO_ROW_WIDTH` for the logo — do **not** include ANSI escape lengths.
 * @returns Object with non-negative `left` and `right` space counts that sum to
 *   `max(0, BANNER_INNER - contentWidth)` when content fits.
 *
 * @example
 * ```ts
 * const pad = bannerCenterPad(12);
 * // For BANNER_INNER === 44: { left: 16, right: 16 }
 *
 * const logoPad = bannerCenterPad(LOGO_ROW_WIDTH);
 * console.log(" ".repeat(logoPad.left) + logoRow + " ".repeat(logoPad.right));
 * ```
 */
export const bannerCenterPad = (
  contentWidth: number,
): { left: number; right: number } => {
  // Floor left so any odd leftover column lands on the right — keeps left edges
  // stable when content width changes by one cell.
  const left = Math.max(0, Math.floor((BANNER_INNER - contentWidth) / 2));
  const right = Math.max(0, BANNER_INNER - contentWidth - left);
  return { left, right };
};

/**
 * Row-major pixel grid for the AtlasAgents octopus mascot (6 columns × 9 rows).
 *
 * @remarks
 * Each inner array is one horizontal scanline of {@link LogoColor} cells.
 * Top rows form the blue hat and white band; middle rows are the purple head
 * and eyes; bottom rows are the tentacles. The grid is intentionally smaller
 * than earlier 8×13 drafts so it fits comfortably inside `BANNER_INNER` with
 * centering padding.
 *
 * Row annotations in the array mark anatomical regions for designers editing
 * colors — they are not used at runtime.
 *
 * @example
 * ```ts
 * for (const row of LOGO_GRID) {
 *   // Ink: map each cell to <Text backgroundColor={color ?? undefined}>{"  "}</Text>
 *   // ANSI: map each cell via bg(color) + "  " + reset
 * }
 * ```
 */
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

/**
 * Amber/orange hex used for the banner’s box-drawing borders (`╭`, `│`, `─`, `╰`).
 *
 * @remarks
 * Distinct from logo purple so the frame reads as chrome around the mascot,
 * not as part of the octopus body.
 */
export const BANNER_BORDER_HEX = "#d97706";

/**
 * Primary body / tentacle purple for the octopus logo.
 *
 * @remarks
 * Matches cells hardcoded in {@link LOGO_GRID}; exported so Ink or theming
 * code can reuse the same token without scraping the grid.
 */
export const LOGO_PURPLE_HEX = "#9955cc";

/** Sclera (eye white) hex used in the eye row of {@link LOGO_GRID}. */
export const LOGO_EYE_WHITE_HEX = "#e8e8e8";

/** Pupil hex used in the pupil row of {@link LOGO_GRID}. */
export const LOGO_PUPIL_HEX = "#110022";

/** Hat crown / brim blue hex used in the top rows of {@link LOGO_GRID}. */
export const LOGO_HAT_HEX = "#3388ee";

/** Hat band (white stripe) hex used under the hat crown in {@link LOGO_GRID}. */
export const LOGO_BAND_HEX = "#ffffff";
