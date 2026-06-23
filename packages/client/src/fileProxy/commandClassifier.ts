import type { BashClass } from "../renderer.js";
import {
  DANGEROUS_TOKENS,
  SAFE_BASE_COMMANDS,
  SAFE_GIT_SUBCOMMANDS,
} from "./constants.js";

/**
 * <Summary>
 * What it does:
 *   Classifies a shell command as "safe", "dangerous", or "cautious" based on its content.
 *
 * How it does it (step by step):
 *   1. Normalize the command by converting to lowercase and trimming whitespace.
 *   2. Split the command into individual tokens (words separated by whitespace).
 *   3. Handle empty commands by returning "cautious" as a safe default.
 *   4. Extract the base command (first token) and check if it's a known safe command.
 *   5. For git commands, check if the subcommand is in the safe git subcommands list.
 *   6. Check for specific dangerous patterns like "chmod 777" (insecure permissions).
 *   7. Scan all tokens for dangerous flags and commands.
 *   8. Return "dangerous" if any dangerous pattern is found, "safe" if explicitly allowed,
 *     otherwise "cautious" as the default for unknown commands.
 *
 * Parameters:
 *   @param command - The shell command to classify (e.g., "git status", "rm -rf file.txt").
 *
 * Returns:
 *   @returns One of "safe", "dangerous", or "cautious" indicating the command's risk level.
 * </Summary>
 */
export const classifyCommand = (command: string): BashClass => {
  // ===== STEP 1: Normalize the command =====
  // Step 1a: Convert the command to lowercase for case-insensitive matching
  // Step 1b: Trim leading and trailing whitespace
  const normalizedCommand = command.toLowerCase().trim();

  // ===== STEP 2: Split command into tokens =====
  // Step 2a: Split the command by whitespace (one or more spaces/tabs)
  // Step 2b: Filter out empty tokens to handle multiple spaces
  const commandTokens = normalizedCommand
    .split(/\s+/)
    .filter((token) => token.length > 0);

  // ===== STEP 3: Handle empty commands =====
  // Step 3a: If the command has no tokens (empty string), return cautious as safe default
  if (commandTokens.length === 0) {
    return "cautious";
  }

  // ===== STEP 4: Extract base command =====
  // Step 4a: Get the first token which is the base command (e.g., "git" from "git status")
  // Step 4b: Use empty string as fallback (though length check above prevents this)
  const baseCommand = commandTokens[0] ?? "";

  // ===== STEP 5: Check for safe base commands =====
  // Step 5a: Check if the base command is in the set of known safe commands
  // Step 5b: If yes, return "safe" immediately (read-only commands like ls, cat, pwd)
  if (SAFE_BASE_COMMANDS.has(baseCommand)) {
    return "safe";
  }

  // ===== STEP 6: Check for safe git subcommands =====
  // Step 6a: Check if this is a git command (base command is "git")
  // Step 6b: Ensure there are at least 2 tokens (git + subcommand)
  // Step 6c: Check if the git subcommand (second token) is in the safe git subcommands set
  // Step 6d: Safe git commands are read-only like status, log, diff
  if (
    baseCommand === "git" &&
    commandTokens.length >= 2 &&
    SAFE_GIT_SUBCOMMANDS.has(commandTokens[1] ?? "")
  ) {
    return "safe";
  }

  // ===== STEP 7: Check for dangerous permission patterns =====
  // Step 7a: Check for chmod 777 which gives full read/write/execute permissions to everyone
  // Step 7b: This is a security risk as it allows any user to modify/execute the file
  if (normalizedCommand.includes("chmod 777")) {
    return "dangerous";
  }

  // ===== STEP 8: Scan for dangerous tokens =====
  // Step 8a: Iterate through all tokens in the command
  // Step 8b: Check if any token matches known dangerous commands or flags
  // Step 8c: Dangerous tokens include rm, --force, -rf, dd, mkfs, etc.
  for (const token of commandTokens) {
    if (DANGEROUS_TOKENS.has(token)) {
      return "dangerous";
    }
  }

  // ===== STEP 9: Default to cautious =====
  // Step 9a: If the command doesn't match safe or dangerous patterns, classify as cautious
  // Step 9b: This ensures unknown commands require user confirmation
  return "cautious";
};
