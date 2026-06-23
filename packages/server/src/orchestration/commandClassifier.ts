/**
 * <Summary>
 * What it does:
 *   Helper functions for classifying shell commands by purpose (setup, verify, run-project)
 *   and validating agent think blocks for proper command planning.
 *
 * How it fits in the system:
 *   Used by Agent.run to classify commands and enforce safety rules. Commands are
 *   classified based on the advisor's command plan to prevent agents from running
 *   dangerous commands (like dev servers) in the foreground.
 * </Summary>
 */

import type { CommandPlan } from "./types.js";
import type { CommandPurpose } from "./toolProtocol.js";

/**
 * <Summary>
 * What it does:
 *   Normalizes a shell command string for consistent comparison.
 *
 * How it does it (step by step):
 *   1. Trim leading/trailing whitespace.
 *   2. Replace multiple spaces with single spaces.
 *   3. Convert to lowercase for case-insensitive matching.
 *
 * Parameters:
 *   @param command - The raw shell command string.
 *
 * Returns:
 *   {string} — Normalized command string.
 * </Summary>
 */
export const normalizeCommand = (command: string): string =>
  // Step 1-3: Normalize the command string
  // Trim removes leading/trailing whitespace
  // Regex replaces multiple spaces with single space
  // toLowerCase enables case-insensitive matching
  command.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * <Summary>
 * What it does:
 *   Checks if a command matches a plan entry (exact or as prefix).
 *
 * How it does it (step by step):
 *   1. Normalize both the command and the entry.
 *   2. If the entry is empty after normalization, return false.
 *   3. Check for exact match or prefix match (entry followed by space).
 *
 * Parameters:
 *   @param command - The shell command to check.
 *   @param entry - The plan entry to match against.
 *
 * Returns:
 *   {boolean} — True if command matches entry exactly or as a prefix.
 * </Summary>
 */
export const commandMatchesPlanEntry = (
  command: string,
  entry: string,
): boolean => {
  // Step 1: Normalize both the command and the entry
  const normalizedCommand = normalizeCommand(command);
  const normalizedEntry = normalizeCommand(entry);

  // Step 2: If the entry is empty after normalization, return false
  if (normalizedEntry.length === 0) {
    return false;
  }

  // Step 3: Check for exact match or prefix match (entry followed by space)
  // Prefix match allows "npm test" to match "npm" (treats "npm " as prefix)
  return (
    normalizedCommand === normalizedEntry ||
    normalizedCommand.startsWith(`${normalizedEntry} `)
  );
};

/**
 * <Summary>
 * What it does:
 *   Checks if a command matches any entry in a list of plan entries.
 *
 * How it does it (step by step):
 *   1. Iterate through each entry in the entries array.
 *   2. Use commandMatchesPlanEntry to check for match.
 *   3. Return true if any entry matches.
 *
 * Parameters:
 *   @param command - The shell command to check.
 *   @param entries - Array of plan entries to match against.
 *
 * Returns:
 *   {boolean} — True if command matches any entry in the list.
 * </Summary>
 */
const matchesAnyEntry = (command: string, entries: string[]): boolean =>
  // Step 1-3: Check if command matches any entry in the list
  // some() returns true if any entry matches the command
  entries.some((entry) => commandMatchesPlanEntry(command, entry));

/**
 * <Summary>
 * What it does:
 *   Infers the purpose of a command based on the advisor's command plan.
 *
 * How it does it (step by step):
 *   1. Check if command matches run-project commands.
 *   2. Check if command matches verify commands.
 *   3. Default to setup if no other match.
 *
 * Parameters:
 *   @param command - The shell command to classify.
 *   @param plan - The advisor's command plan.
 *
 * Returns:
 *   {CommandPurpose} — The inferred purpose: "run-project", "verify", or "setup".
 * </Summary>
 */
export const inferPurpose = (
  command: string,
  plan: CommandPlan,
): CommandPurpose => {
  // Step 1: Check if command matches run-project commands
  // These are commands that run indefinitely (dev servers, etc.)
  if (matchesAnyEntry(command, plan.runProjectCommands)) {
    return "run-project";
  }

  // Step 2: Check if command matches verify commands
  // These are commands that test/validate the work
  if (matchesAnyEntry(command, plan.verifyCommands)) {
    return "verify";
  }

  // Step 3: Default to setup if no other match
  // Setup commands are one-time operations that prepare the environment
  return "setup";
};

/**
 * <Summary>
 * What it does:
 *   Formats the command plan as a markdown block for display in agent prompts.
 *
 * How it does it (step by step):
 *   1. Define helper function to format command lists.
 *   2. Format each section (setup, verify, run-project) with its commands.
 *   3. Return the complete markdown block.
 *
 * Parameters:
 *   @param plan - The command plan to format.
 *
 * Returns:
 *   {string} — Formatted markdown block showing the command plan.
 * </Summary>
 */
export const formatCommandPlanBlock = (plan: CommandPlan): string => {
  /**
   * Helper function to format a list of commands as markdown bullet points.
   *
   * @param items - Array of command strings.
   * @returns Formatted bullet list or "(none)" if empty.
   */
  const formatList = (items: string[]): string =>
    items.length > 0
      ? items.map((command) => `  - ${command}`).join("\n")
      : "  (none)";

  // Step 1-3: Format each section and combine into markdown block
  return [
    "[Advisor command plan]",
    "Setup:",
    formatList(plan.setupCommands),
    "Verify (exit pass/fail):",
    formatList(plan.verifyCommands),
    "Off-limits (run-project, background only):",
    formatList(plan.runProjectCommands),
  ].join("\n");
};

/**
 * <Summary>
 * What it does:
 *   Generates a warning message when a run-project command is called without background flag.
 *
 * How it does it (step by step):
 *   1. Construct the message explaining why the command is blocked.
 *   2. Provide instructions for proper usage (background flag or verify commands).
 *   3. Return the formatted message string.
 *
 * Parameters:
 *   @param command - The blocked command string.
 *
 * Returns:
 *   {string} — Warning message explaining the block and how to fix it.
 * </Summary>
 */
export const RUN_PROJECT_BLOCK_MESSAGE = (command: string): string =>
  // Step 1-3: Construct warning message with instructions
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
 * <Summary>
 * What it does:
 *   Generates a message requiring verification before finish can be called.
 *
 * How it does it (step by step):
 *   1. List the files that were written but not verified.
 *   2. Provide instructions for acceptable verification methods.
 *   3. Return the formatted message string.
 *
 * Parameters:
 *   @param paths - Set of file paths that need verification.
 *
 * Returns:
 *   {string} — Message explaining verification requirements.
 * </Summary>
 */
export const VERIFY_REQUIRED_MESSAGE = (paths: Set<string>): string => {
  // Format the file list as a bullet-point list
  const pathList = [...paths].map((filePath) => `  ${filePath}`).join("\n");

  // Step 1-3: Construct verification requirement message
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
 * <Summary>
 * What it does:
 *   Error message when think block missing required run_command fields.
 *
 * How it fits in the system:
 *   Displayed to agent when it calls run_command without proper think block
 *   documentation (purpose, exits, risk fields are required).
 * </Summary>
 */
export const RUN_COMMAND_THINK_MISSING_MESSAGE =
  "Your think block for run_command must include: purpose, exits, risk.\n" +
  "Re-think and call run_command again.";

/**
 * <Summary>
 * What it does:
 *   Validates that a think block contains required run_command fields.
 *
 * How it does it (step by step):
 *   1. Check if thinkText exists and is non-empty.
 *   2. Check for purpose field with valid value (setup|verify|run-project).
 *   3. Check for exits field with valid value (yes|no).
 *   4. Check for risk field presence.
 *
 * Parameters:
 *   @param thinkText - The think block text to validate.
 *
 * Returns:
 *   {boolean} — True if all required fields are present and valid.
 * </Summary>
 */
export const hasRunCommandThinkFields = (thinkText: string | null): boolean => {
  // Step 1: Check if thinkText exists and is non-empty
  if (!thinkText) {
    return false;
  }

  // Step 2-4: Check for required fields using regex patterns
  // Case-insensitive regex to match field names and validate values
  return (
    /purpose:\s*(setup|verify|run-project)/i.test(thinkText) &&
    /exits:\s*(yes|no)/i.test(thinkText) &&
    /risk:/i.test(thinkText)
  );
};

/**
 * <Summary>
 * What it does:
 *   Validates that a think block contains the command plan section.
 *
 * How it does it (step by step):
 *   1. Check for "setup commands:" section header.
 *   2. Check for "verify commands:" section header.
 *   3. Check for "off-limits" keyword.
 *
 * Parameters:
 *   @param thinkText - The think block text to validate.
 *
 * Returns:
 *   {boolean} — True if all command plan sections are present.
 * </Summary>
 */
export const hasCommandPlanSection = (thinkText: string): boolean =>
  // Step 1-3: Check for required section headers using case-insensitive regex
  /setup\s+commands:/i.test(thinkText) &&
  /verify\s+commands:/i.test(thinkText) &&
  /off-limits/i.test(thinkText);
