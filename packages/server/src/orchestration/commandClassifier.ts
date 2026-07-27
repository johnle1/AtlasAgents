/**
 * Helper functions for classifying shell commands and validating agent think blocks.
 *
 * @remarks
 * Used by Agent.run to classify commands by purpose (setup, verify, run-project)
 * and enforce safety rules. Commands are classified based on the agent's command
 * plan to prevent agents from running dangerous commands (like dev servers) in
 * the foreground. Also validates that agent think blocks contain required fields
 * for proper command planning.
 */

import type { CommandPlan } from "./types.js";
import type { CommandPurpose } from "./toolProtocol.js";

/**
 * Normalizes a shell command string for consistent comparison.
 *
 * @remarks
 * Trims leading/trailing whitespace, replaces multiple spaces with single spaces,
 * and converts to lowercase for case-insensitive matching. This normalization
 * ensures that commands like "npm test" and "NPM  TEST" are treated as equivalent.
 *
 * @param command - The raw shell command string
 *
 * @returns Normalized command string
 */
export const normalizeCommand = (command: string): string =>
  command.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Checks if a command matches a plan entry (exact or as prefix).
 *
 * @remarks
 * Normalizes both the command and entry for comparison. Returns true if they
 * match exactly or if the command starts with the entry followed by a space.
 * This prefix matching allows "npm test" to match "npm" (treats "npm " as prefix).
 *
 * @param command - The shell command to check
 * @param entry - The plan entry to match against
 *
 * @returns True if command matches entry exactly or as a prefix
 */
export const commandMatchesPlanEntry = (
  command: string,
  entry: string,
): boolean => {
  const normalizedCommand = normalizeCommand(command);
  const normalizedEntry = normalizeCommand(entry);

  if (normalizedEntry.length === 0) {
    return false;
  }

  return (
    normalizedCommand === normalizedEntry ||
    normalizedCommand.startsWith(`${normalizedEntry} `)
  );
};

/**
 * Checks if a command matches any entry in a list of plan entries.
 *
 * @remarks
 * Iterates through the entries array and uses commandMatchesPlanEntry to check
 * for matches. Returns true if any entry matches the command.
 *
 * @param command - The shell command to check
 * @param entries - Array of plan entries to match against
 *
 * @returns True if command matches any entry in the list
 */
const matchesAnyEntry = (command: string, entries: string[]): boolean =>
  entries.some((entry) => commandMatchesPlanEntry(command, entry));

/**
 * Infers the purpose of a command based on the agent's command plan.
 *
 * @remarks
 * Checks if the command matches run-project commands (indefinite processes like dev servers),
 * verify commands (test/validation commands), or defaults to setup (one-time
 * environment preparation). This classification is used to enforce safety rules
 * and prevent dangerous commands from running in the foreground.
 *
 * @param command - The shell command to classify
 * @param plan - The agent's command plan
 *
 * @returns The inferred purpose: "run-project", "verify", or "setup"
 */
export const inferPurpose = (
  command: string,
  plan: CommandPlan,
): CommandPurpose => {
  if (matchesAnyEntry(command, plan.runProjectCommands)) {
    return "run-project";
  }

  if (matchesAnyEntry(command, plan.verifyCommands)) {
    return "verify";
  }

  return "setup";
};

/**
 * Formats the command plan as a markdown block for display in agent prompts.
 *
 * @remarks
 * Formats each section (setup, verify, run-project) with its commands as
 * markdown bullet points. Empty sections display "(none)". The formatted block
 * is included in agent prompts to guide command execution.
 *
 * @param plan - The command plan to format
 *
 * @returns Formatted markdown block showing the command plan
 */
export const formatCommandPlanBlock = (plan: CommandPlan): string => {
  const formatList = (items: string[]): string =>
    items.length > 0
      ? items.map((command) => `  - ${command}`).join("\n")
      : "  (none)";

  return [
    "[Agent command plan]",
    "Setup:",
    formatList(plan.setupCommands),
    "Verify (exit pass/fail):",
    formatList(plan.verifyCommands),
    "Off-limits (run-project, background only):",
    formatList(plan.runProjectCommands),
  ].join("\n");
};

/**
 * Generates a warning message when a run-project command is called without background flag.
 *
 * @remarks
 * Constructs a message explaining why the command is blocked (it would freeze the agent)
 * and provides instructions for proper usage (add background flag or use verify commands).
 *
 * @param command - The blocked command string
 *
 * @returns Warning message explaining the block and how to fix it
 */
export const RUN_PROJECT_BLOCK_MESSAGE = (command: string): string =>
  [
    "This command runs forever and would freeze the agent:",
    `  ${command}`,
    "",
    "If the user asked you to start the project:",
    "  add background: true to this tool call.",
    "If you were trying to verify your work:",
    "  this command proves nothing about correctness.",
    "  Use a verify command (test, build, type-check)",
    "  or re-read the files you wrote.",
  ].join("\n");

/**
 * Generates a message requiring verification before finish can be called.
 *
 * @remarks
 * Lists the files that were written but not verified, and provides instructions
 * for acceptable verification methods (re-reading files or running verify commands).
 * Emphasizes that starting a server is not verification.
 *
 * @param paths - Set of file paths that need verification
 *
 * @returns Message explaining verification requirements
 */
export const VERIFY_REQUIRED_MESSAGE = (paths: Set<string>): string => {
  const pathList = [...paths].map((filePath) => `  ${filePath}`).join("\n");

  return [
    "You must verify your work before calling finish.",
    "",
    "Files written but not verified:",
    pathList,
    "",
    "To verify — choose one:",
    "  1. Re-read the files you wrote and confirm they satisfy the requirement",
    "  2. Run a verify command (test, build, type-check) that exits with code 0",
    "",
    "A server starting is NOT verification — it does not prove correctness.",
  ].join("\n");
};

/**
 * Error message when think block missing required run_command fields.
 *
 * @remarks
 * Displayed to agent when it calls run_command without proper think block
 * documentation. The agent must include purpose, exits, and risk fields in the
 * think block for run_command calls.
 */
export const RUN_COMMAND_THINK_MISSING_MESSAGE =
  "Your think block for run_command must include: purpose, exits, risk.\n" +
  "Re-think and call run_command again.";

/**
 * Validates that a think block contains required run_command fields.
 *
 * @remarks
 * Checks if the think block contains the required fields for run_command calls:
 * purpose (setup|verify|run-project), exits (yes|no), and risk. Uses
 * case-insensitive regex patterns to match field names and validate values.
 *
 * @param thinkText - The think block text to validate
 *
 * @returns True if all required fields are present and valid
 */
export const hasRunCommandThinkFields = (thinkText: string | null): boolean => {
  if (!thinkText) {
    return false;
  }

  return (
    /purpose:\s*(setup|verify|run-project)/i.test(thinkText) &&
    /exits:\s*(yes|no)/i.test(thinkText) &&
    /risk:/i.test(thinkText)
  );
};

/**
 * Validates that a think block contains the command plan section.
 *
 * @remarks
 * Checks for the required section headers in the think block: "setup commands:",
 * "verify commands:", and "off-limits". Uses case-insensitive regex patterns.
 *
 * @param thinkText - The think block text to validate
 *
 * @returns True if all command plan sections are present
 */
export const hasCommandPlanSection = (thinkText: string): boolean =>
  /setup\s+commands:/i.test(thinkText) &&
  /verify\s+commands:/i.test(thinkText) &&
  /off-limits/i.test(thinkText);
