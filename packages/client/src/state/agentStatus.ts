/**
 * Coordinates agent activity spinners and terminal output with the Ink UI.
 *
 * @remarks
 * The LoopyCode client renders a live spinner while an agent or subagent is
 * working. This module is the thin bridge between task lifecycle code
 * (file proxy, renderers) and the Ink spinner in {@link ./ui/uiBridge.js | uiBridge}.
 *
 * Spinners only appear when **both** conditions hold:
 * - A task is marked active via {@link setTaskActive}.
 * - The Ink UI is running ({@link ./ui/uiBridge.js | isInkActive}).
 *
 * Call {@link beginBlockOutput} before printing multi-line tool results so
 * the spinner is cleared and the terminal cursor moves to a fresh line.
 *
 * @example
 * ```ts
 * import { setTaskActive, startWorking, stopAnimated, beginBlockOutput } from "./agentStatus.js";
 *
 * setTaskActive(true);
 * startWorking("Reading files");
 * // ... agent runs ...
 * beginBlockOutput();
 * console.log("diff output here");
 * stopAnimated();
 * setTaskActive(false);
 * ```
 */

import {
  getTaskActive,
  isInkActive,
  setSpinner,
  setTaskActive as setTaskActiveBridge,
} from "../ui/uiBridge.js";
import type { SpinnerState } from "../ui/types.js";

/**
 * Returns whether a server task is currently executing on the client.
 *
 * @returns `true` while a task is in progress; `false` when idle.
 *
 * @example
 * ```ts
 * if (isTaskActive()) {
 *   startWorking("Agent");
 * }
 * ```
 */
export const isTaskActive = (): boolean => getTaskActive();

/**
 * Marks whether a server task is currently executing.
 *
 * @remarks
 * Spinner helpers ({@link startThinking}, {@link startWorking}) no-op when
 * this flag is `false`, so callers can safely invoke them without checking
 * task state first.
 *
 * @param active - Pass `true` when a task starts and `false` when it finishes
 *   or is cancelled.
 *
 * @example
 * ```ts
 * setTaskActive(true);
 * startWorking("Agent");
 * // task completes
 * setTaskActive(false);
 * ```
 */
export const setTaskActive = (active: boolean): void => {
  setTaskActiveBridge(active);
};

/**
 * Clears the active Ink spinner, if any.
 *
 * @remarks
 * Safe to call when no spinner is showing or when Ink is not active.
 * Does not change the task-active flag — pair with {@link setTaskActive}
 * when a task ends.
 *
 * @example
 * ```ts
 * stopAnimated();
 * ```
 */
export const stopAnimated = (): void => {
  if (isInkActive()) {
    setSpinner(null);
  }
};

/**
 * Shows a spinner with the given mode and label when a task is active.
 *
 * @remarks
 * No-op when the task is inactive or Ink is not running. Replaces any
 * existing spinner rather than stacking multiple spinners.
 */
const startAnimated = (mode: SpinnerState["mode"], label: string): void => {
  if (!getTaskActive()) return;
  if (isInkActive()) {
    setSpinner({ active: true, label, mode });
  }
};

/**
 * Shows a "thinking" spinner, typically while the agent is planning.
 *
 * @param nextLabel - Text shown beside the spinner. Defaults to `"Agent"`.
 *
 * @example
 * ```ts
 * setTaskActive(true);
 * startThinking("Agent");
 * ```
 */
export const startThinking = (nextLabel = "Agent"): void => {
  startAnimated("thinking", nextLabel);
};

/**
 * Shows a "working" spinner, typically while a subagent runs tools.
 *
 * @param nextLabel - Text shown beside the spinner. Defaults to `"Subagent"`.
 *
 * @example
 * ```ts
 * setTaskActive(true);
 * startWorking("Running tests");
 * ```
 */
export const startWorking = (nextLabel = "Subagent"): void => {
  startAnimated("working", nextLabel);
};

/**
 * Prepares the terminal for block output after an animated spinner.
 *
 * @remarks
 * Stops any active spinner first. When Ink is **not** active (plain stdout
 * mode), writes a leading newline so the next `console.log` does not append
 * to the spinner line.
 *
 * @example
 * ```ts
 * beginBlockOutput();
 * console.log(fileDiff);
 * ```
 */
export const beginBlockOutput = (): void => {
  stopAnimated();
  // Plain stdout has no Ink frame — newline avoids appending to the prior line.
  if (!isInkActive()) {
    process.stdout.write("\n");
  }
};
