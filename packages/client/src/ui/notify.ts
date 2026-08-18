/**
 * Opt-in desktop / terminal notifications (OSC 9 or BEL).
 *
 * @remarks
 * Off by default (`ui.notifications`). Fires only on edges — approval
 * requested, task completed — never per stream frame. Screen readers and
 * non-TTY stdout stay silent. Message text is stripped of ESC / BEL so a
 * model or tool cannot inject terminal sequences through a notification.
 */

import { loadConfig } from "../config/index.js";
import {
  isScreenReaderLikely,
  supportsOsc9Notifications,
} from "./terminalEnv.js";

/**
 * Notifies the user that something needs attention or a task finished.
 *
 * @remarks
 * No-op when:
 * - `config.ui.notifications` is falsy (the default)
 * - stdout is not a TTY
 * - {@link isScreenReaderLikely} is true
 *
 * Otherwise writes OSC 9 (`\x1b]9;message\x07`) on iTerm2 / WezTerm /
 * Ghostty / kitty, or a BEL (`\x07`) everywhere else.
 *
 * @param message - Short status text. ESC (`\\x1b`) and BEL (`\\x07`) bytes
 *   are stripped before writing.
 *
 * @example
 * ```ts
 * notifyUser("Action required");
 * notifyUser("Task complete");
 * ```
 */
export const notifyUser = (message: string): void => {
  const { ui } = loadConfig();
  if (!ui?.notifications) return;
  if (!process.stdout.isTTY) return;
  if (isScreenReaderLikely()) return;

  const sanitized = message.replace(/\x1b/g, "").replace(/\x07/g, "");

  if (supportsOsc9Notifications()) {
    process.stdout.write(`\x1b]9;${sanitized}\x07`);
    return;
  }

  process.stdout.write("\x07");
};
