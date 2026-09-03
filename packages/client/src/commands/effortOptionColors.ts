/**
 * Ink palette for `/effort`'s horizontal option bar — cool → hot by level.
 *
 * @remarks
 * Aligned 1:1 with {@link EFFORT_LEVELS} from `@atlasagents/shared`. Only the
 * highlighted label is tinted; unselected labels stay the terminal default.
 *
 * `low`/`medium` stay pure neon (electric cyan/green); `high`/`extra-high`
 * warm through amber/orange. `max` is violet rather than red — reads as
 * "off the intensity scale" instead of a stop/danger cue, and bookends the
 * gradient against `low`'s cyan instead of dead-ending on red.
 */

import { EFFORT_LEVELS } from "@atlasagents/shared";

/** Ink colors for each {@link EFFORT_LEVELS} entry, in the same order. */
export const EFFORT_OPTION_COLORS = [
  "#00D9FF",
  "#39FF14",
  "#FBBF24",
  "#FB923C",
  "#A855F7",
] as const;

if (EFFORT_OPTION_COLORS.length !== EFFORT_LEVELS.length) {
  throw new Error(
    "EFFORT_OPTION_COLORS must stay aligned with EFFORT_LEVELS",
  );
}
