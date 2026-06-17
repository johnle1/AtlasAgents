import { spawn } from "node:child_process";
import { beginBlockOutput } from "../../agentStatus.js";
import { getTheme } from "../../theme/themeManager.js";
import {
  printBash,
  printBashApproved,
  printBashRan,
  printBashResult,
  printSkipped,
  type BashClass,
} from "../../renderer.js";
import { requestApproval } from "../../ui/uiBridge.js";
import type { DispatchContext } from "../types.js";
import { logger } from "../../utils/logger.js";

/**
 * <Summary>
 * What it does:
 *   Classifies a shell command's safety level without executing it.
 *
 * How it does it (step by step):
 *   1. Extract the command string from the request body (default to empty string if not provided).
 *   2. Call the classifyCommand utility from the context to assess the command's safety.
 *   3. Return the classification result in a standardized response format.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing the classifyCommand utility.
 *   @param {Record<string, unknown>} requestBody — The request body containing the command to classify.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object containing the classification result (safe, dangerous, or cautious).
 *
 * Dependencies:
 *   - context.classifyCommand — performs the actual command safety analysis.
 *
 * Dependants:
 *   - dispatch system — routes command.classify requests to this handler.
 *   - UI components — use this to assess command safety before execution.
 * </Summary>
 */
export const handleCommandClassify = (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> =>
  Promise.resolve({
    // ===== STEP 1: Extract and classify command =====
    // Step 1a: Extract command from request body, default to empty string if not provided
    // Step 1b: Use the context's classifyCommand utility to assess safety level
    classification: context.classifyCommand(String(requestBody.command ?? "")),
  });

/**
 * <Summary>
 * What it does:
 *   Executes a shell command after appropriate safety checks and user approval.
 *
 * How it does it (step by step):
 *   1. Extract the command string from the request body.
 *   2. Determine if the command should be forced to run in background mode.
 *   3. Classify the command (or use "background" if forced background mode).
 *   4. Print the command to the console with its classification.
 *   5. Handle background command execution with user approval.
 *   6. Handle non-safe commands with user approval and danger warnings.
 *   7. Execute safe and approved non-background commands via runShell.
 *   8. Print the appropriate result based on command classification.
 *   9. Return the shell execution results.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing utilities for command execution.
 *   @param {Record<string, unknown>} requestBody — The request body containing the command and execution options.
 *
 * Returns:
 *   @returns {Promise<unknown>} — The shell execution results (stdout, stderr, exitCode) or skip results.
 *
 * Dependencies:
 *   - context.classifyCommand — assesses command safety level.
 *   - context.runShell — executes the shell command.
 *   - context.currentDir — provides working directory for background processes.
 *   - requestApproval — prompts user for command execution approval.
 *   - Renderer functions — display command status and results to user.
 *   - getTheme — provides theme colors for warning messages.
 *   - beginBlockOutput — formats output for dangerous commands.
 *
 * Dependants:
 *   - dispatch system — routes command.run requests to this handler.
 * </Summary>
 */
export const handleCommandRun = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract command parameters =====
  // Step 1a: Extract the command string from the request body, default to empty string
  const command = String(requestBody.command ?? "");

  // ===== STEP 2: Check for background execution mode =====
  // Step 2a: Determine if the command should be forced to run in background mode
  // Step 2b: Background mode is used for long-running processes like servers
  const forceBackgroundExecution = requestBody.background === true;

  // ===== STEP 3: Classify command =====
  // Step 3a: Classify the command based on its safety level
  // Step 3b: If forced background mode, use "background" classification instead of analyzing the command
  const commandClassification: BashClass = forceBackgroundExecution
    ? "background"
    : context.classifyCommand(command);

  // ===== STEP 4: Display command to user =====
  // Step 4a: Print the command to the console with its classification for user awareness
  printBash(command, commandClassification);

  // ===== STEP 5: Handle background command execution =====
  // Step 5a: Check if this is a background command execution
  if (commandClassification === "background") {
    // ===== STEP 5a-1: Request user approval =====
    // Step 5a-1a: Prompt the user to approve running the command in background
    const userApproved = (await requestApproval({
      type: "runSkip",
      command,
    })) as boolean;

    // ===== STEP 5a-2: Handle user rejection =====
    // Step 5a-2a: If user didn't approve, print skipped message and return early
    if (!userApproved) {
      printSkipped();
      return {
        stdout: "",
        stderr: "skipped by user — command was not executed",
        exitCode: -1,
      };
    }

    // ===== STEP 5a-3: Print approval confirmation =====
    printBashApproved();

    // ===== STEP 5a-4: Parse command into executable and arguments =====
    // Step 5a-4a: Trim the command and split by whitespace to get parts
    const commandParts = command.trim().split(/\s+/);

    // ===== STEP 5a-5: Validate command has executable =====
    // Step 5a-5a: Check if the command is empty or has no executable part
    if (commandParts.length === 0 || !commandParts[0]) {
      return {
        stdout: "",
        stderr: "empty command",
        exitCode: 1,
      };
    }

    // ===== STEP 5a-6: Spawn background process =====
    // Step 5a-6a: Create the child process variable for spawning
    let spawnedProcess;

    try {
      // Step 5a-6b: Spawn the command as a detached background process
      // Step 5a-6c: detached: true allows the process to continue running independently
      // Step 5a-6d: stdio: "ignore" prevents the parent from handling I/O
      // Step 5a-6e: cwd sets the working directory for the background process
      spawnedProcess = spawn(commandParts[0], commandParts.slice(1), {
        detached: true,
        stdio: "ignore",
        cwd: context.currentDir,
      });
    } catch (error) {
      // ===== STEP 5a-7: Handle spawn errors =====
      // Step 5a-7a: Extract error message from Error object or convert to string
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        stdout: "",
        stderr: `Failed to spawn command: ${errorMessage}`,
        exitCode: 1,
      };
    }

    // ===== STEP 5a-8: Detach process from parent =====
    // Step 5a-8a: Unref the child process so it can run independently
    // Step 5a-8b: This allows the parent to exit without killing the background process
    spawnedProcess.unref();

    // ===== STEP 5a-9: Create status message =====
    // Step 5a-9a: Create message indicating background process started with PID
    const statusMessage = `Started in background (PID ${spawnedProcess.pid}). Check your terminal for output.`;

    // ===== STEP 5a-10: Display background process result =====
    // Step 5a-10a: Print the result message to inform user of background process
    printBashRan(0, statusMessage, "");

    // ===== STEP 5a-11: Return background process result =====
    // Step 5a-11a: Return the status message as stdout, empty stderr, and success exit code
    return { stdout: statusMessage, stderr: "", exitCode: 0 };
  }

  // ===== STEP 6: Handle non-safe commands (dangerous and cautious) =====
  // Step 6a: Check if the command is not classified as safe
  if (commandClassification !== "safe") {
    // ===== STEP 6a-1: Display danger warning for dangerous commands =====
    // Step 6a-1a: If the command is dangerous, show a prominent warning
    if (commandClassification === "dangerous") {
      // Step 6a-1b: Begin a block output section for formatted display
      beginBlockOutput();

      // Step 6a-1c: Add spacing before the warning
      logger.blank();

      // Step 6a-1d: Get the current theme for colored warning message
      {
        const theme = getTheme();
        // Step 6a-1e: Print warning with theme colors for visibility
        logger.info(`  ${theme.warning}⚠${theme.reset}  Dangerous command.`);
      }

      // Step 6a-1f: Add spacing after the warning
      logger.blank();
    }

    // ===== STEP 6a-2: Request user approval =====
    // Step 6a-2a: Prompt the user to approve the potentially unsafe command
    const userApproved = (await requestApproval({
      type: "runSkip",
      command,
    })) as boolean;

    // ===== STEP 6a-3: Handle user rejection =====
    // Step 6a-3a: If user didn't approve, print skipped message and return early
    if (!userApproved) {
      printSkipped();
      return {
        stdout: "",
        stderr: "skipped by user — command was not executed",
        exitCode: -1,
      };
    }

    // ===== STEP 6a-4: Print approval confirmation =====
    printBashApproved();
  }

  // ===== STEP 7: Execute safe or approved commands =====
  // Step 7a: Record the start time for execution duration tracking
  const startTime = Date.now();

  // Step 7b: Execute the command via the context's runShell utility
  // Step 7c: This handles stdout/stderr capture and timeout management
  const executionResult = await context.runShell(command);

  // ===== STEP 8: Display execution results =====
  // Step 8a: If the command was classified as safe, show timing information
  if (commandClassification === "safe") {
    // Step 8a-1: Print the result with execution duration
    printBashResult(executionResult.exitCode, Date.now() - startTime);
  } else {
    // Step 8b: If the command was dangerous or cautious, show full output
    // Step 8b-1: Print the result with stdout and stderr
    printBashRan(
      executionResult.exitCode,
      executionResult.stdout,
      executionResult.stderr,
    );
  }

  // ===== STEP 9: Return execution results =====
  // Step 9a: Return the complete shell execution results
  return executionResult;
};
