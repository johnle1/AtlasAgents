/**
 * <Summary>
 * What it does:
 *   Handles task stream processing — routes frames and tokens into Ink history and the UI bridge.
 *
 * How it fits in the system:
 *   Manages the execution of user tasks through the RSocket connection. It handles streaming
 *   text tokens, status frames, and plan confirmations.
 *   This is the main bridge between the server-side task execution and the client-side UI.
 *
 * Dependencies:
 *   - Connection — provides the RSocket connection for task execution.
 *   - loadConfig — provides configuration for agent settings.
 *   - formatAdvisorThinkForDisplay — formats advisor think blocks for display.
 *   - agentStatus — manages task activity tracking.
 *   - uiBridge — provides UI bridge functions for display and state management.
 *   - spinnerSync — provides spinner state mapping.
 *
 * Dependants:
 *   - AppContext — calls this function to execute user tasks.
 * </Summary>
 */

import type { Connection } from "../connection/index.js";
import type { TaskFrame } from "../frames.js";
import { loadConfig } from "../config.js";
import { formatAdvisorThinkForDisplay } from "../renderer.js";
import { setTaskActive } from "../agentStatus.js";
import type { MaxAgentsParam } from "../taskModifiers.js";
import {
  appendHistory,
  clearAgentStatuses,
  requestApproval,
  requestPrompt,
  setAgentBoards,
  setAgentStatus,
  setBusy,
  setSpinner,
  setStreamingText,
  updateAgentActivity,
} from "./uiBridge.js";
import { spinnerForStatusFrame } from "./spinnerSync.js";
import type { PlanDecision } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Executes a user task through the RSocket connection with streaming and frame handling.
 *
 * How it does it (step by step):
 *   1. Append the user task to history with user variant.
 *   2. Set task as active and mark application as busy.
 *   3. Clear previous agent statuses and show advisor spinner.
 *   4. Initialize streaming buffer for token accumulation.
 *   5. Send task to server with token and frame callbacks.
 *   6. Handle tokens by updating streaming text buffer.
 *   7. Handle frames based on their kind (think, status, confirm-plan, etc.).
 *   8. Process plan confirmations with approval requests.
 *   9. Process file operation confirmations with diff display.
 *   10. Process command confirmations with approval requests.
 *   11. Handle error frames by displaying error messages.
 *   12. In finally block, clean up state and reset UI.
 *
 * Parameters:
 * @param {Connection} connection — The RSocket connection for server communication.
 * @param {string} task — The user task description to execute.
 * @param {MaxAgentsParam} maxAgents — The maximum number of agents to use (default from config).
 *
 * Returns:
 * @returns {Promise<void>} — Resolves when task execution completes.
 *
 * Dependencies:
 *   - Connection — sends task execution request to server.
 *   - uiBridge — manages UI state and display.
 *   - spinnerSync — provides spinner state mapping.
 *   - formatAdvisorThinkForDisplay — formats think blocks.
 *
 * Dependants:
 *   - AppContext — calls this function to execute user tasks.
 * </Summary>
 */
export const runTaskStream = async (
  connection: Connection,
  task: string,
  maxAgents: MaxAgentsParam = loadConfig().agentCap,
): Promise<void> => {
  // ===== STEP 1: Initialize task execution =====
  // Step 1a: Append the user task to history with user variant for display
  appendHistory({ kind: "text", text: `\n> ${task}`, variant: "user" });

  // Step 1b: Mark task as active in agent status tracking
  setTaskActive(true);

  // Step 1c: Mark application as busy to prevent duplicate submissions
  setBusy(true);

  // Step 1d: Clear previous agent statuses for clean state
  clearAgentStatuses();

  // Step 1e: Show advisor spinner to indicate thinking phase
  setSpinner({ active: true, label: "Advisor", mode: "thinking" });

  // Step 1f: Initialize streaming buffer for token accumulation
  let streamingBuffer = "";

  // ===== STEP 2: Execute task with streaming and frame handling =====
  try {
    // ===== STEP 2a: Send task to server =====
    // Step 2a-1: Send task execution request to the server via RSocket connection
    await connection.sendTask({
      task,
      maxAgents,
      onToken: (token) => {
        // ===== STEP 2a-2: Handle streaming tokens =====
        // Step 2a-2a: Clear spinner when tokens start streaming (advisor is done)
        setSpinner(null);

        // Step 2a-2b: Append token to streaming buffer
        streamingBuffer += token;

        // Step 2a-2c: Update streaming text display with current buffer
        setStreamingText(streamingBuffer);
      },
      onFrame: async (taskFrame: TaskFrame) => {
        // ===== STEP 2a-3: Handle think frames =====
        // Step 2a-3a: Check if frame is a think block (advisor reasoning)
        if (taskFrame.kind === "think") {
          // Step 2a-3b: Check if think output display is enabled in config
          if (loadConfig().showThinkOutput) {
            // Step 2a-3c: Format think block for display (with advisor formatting if applicable)
            const thinkBody = taskFrame.advisor
              ? formatAdvisorThinkForDisplay(taskFrame.text)
              : taskFrame.text;

            // Step 2a-3d: Append think block to history for display
            appendHistory({
              kind: "think",
              text: thinkBody,
              advisor: taskFrame.advisor,
            });
          }
        }
        // ===== STEP 2a-4: Handle status frames =====
        else if (taskFrame.kind === "status") {
          // Step 2a-4a: Calculate appropriate spinner state for this status frame
          const nextSpinnerState = spinnerForStatusFrame(taskFrame);

          // Step 2a-4b: Update spinner state if it changed (undefined means keep current)
          if (nextSpinnerState !== undefined) {
            setSpinner(nextSpinnerState);
          }

          // Step 2a-4c: Handle advisor status updates
          if (taskFrame.source === "advisor") {
            // Step 2a-4c-1: Update advisor status with icon, message, and stage
            setAgentStatus({
              id: "advisor",
              label: "Advisor",
              icon: taskFrame.icon,
              message: taskFrame.message,
              stage: taskFrame.stage,
            });

            // Step 2a-4c-2: Update agent boards if provided (agent task assignments)
            if (taskFrame.agentBoards !== undefined) {
              setAgentBoards(taskFrame.agentBoards);
            }
          }
          // Step 2a-4d: Handle agent activity updates
          else if (taskFrame.activity) {
            // Step 2a-4d-1: Update activity for the specific agent
            updateAgentActivity(taskFrame.source.agentId, taskFrame.activity);
          }
          // Step 2a-4e: Handle agent completion
          else if (taskFrame.stage === "done") {
            // Step 2a-4e-1: Clear activity for the completed agent
            updateAgentActivity(taskFrame.source.agentId, null);
          }
        }
        // ===== STEP 2a-5: Handle plan confirmation frames =====
        else if (taskFrame.kind === "confirm-plan") {
          // Step 2a-5a: Clear spinner for interactive approval
          setSpinner(null);

          // Step 2a-5b: Clear streaming text to hide plan construction
          setStreamingText(null);

          // Step 2a-5c: Flush any remaining streaming buffer to history
          if (streamingBuffer.length > 0) {
            appendHistory({
              kind: "text",
              text: streamingBuffer,
              variant: "assistant",
            });
            streamingBuffer = "";
          }

          // Step 2a-5d: Append plan details to history for user review
          appendHistory({
            kind: "plan",
            task: taskFrame.task,
            steps: taskFrame.steps,
            risks: taskFrame.risks,
            agents: taskFrame.agents,
            agentCount: taskFrame.agentCount,
            execution: taskFrame.execution,
            modeLabel: taskFrame.modeLabel,
          });

          // Step 2a-5e: Request user approval for plan execution
          let planDecision = (await requestApproval({
            type: "planReview",
            task: taskFrame.task,
            stepCount: taskFrame.steps.length,
            agentCount: taskFrame.agentCount,
            execution: taskFrame.execution,
            modeLabel: taskFrame.modeLabel,
          })) as PlanDecision;

          // Step 2a-5f: Initialize plan steps (may be edited by user)
          let planSteps = taskFrame.steps;

          // Step 2a-5g: Handle plan editing if user chose to edit
          if (planDecision === "edit") {
            // Step 2a-5g-1: Prompt user to edit the plan steps
            const editedSteps = await requestPrompt({
              type: "planEdit",
              initial: taskFrame.steps,
            });

            // Step 2a-5g-2: Use edited steps if array, otherwise keep original
            planSteps = Array.isArray(editedSteps)
              ? editedSteps
              : taskFrame.steps;

            // Step 2a-5g-3: Append success message for plan update
            appendHistory({
              kind: "text",
              text: `✓ Plan updated (${planSteps.length} steps).`,
              variant: "success",
            });
          }

          // Step 2a-5h: Send plan decision and (possibly edited) steps to server
          await connection.respondPlan(taskFrame.id, planDecision, planSteps);

          // Step 2a-5i: Show agent spinner for execution phase
          setSpinner({ active: true, label: "Agent", mode: "thinking" });
        }
        // ===== STEP 2a-6: Handle error frames =====
        else if (taskFrame.kind === "error") {
          // Step 2a-8a: Append error message to history with error variant
          appendHistory({
            kind: "text",
            text: taskFrame.message,
            variant: "error",
          });
        }
      },
    });

    // ===== STEP 3: Flush remaining streaming buffer =====
    // Step 3a: If there's remaining content in the streaming buffer, flush it
    if (streamingBuffer.length > 0) {
      appendHistory({
        kind: "text",
        text: streamingBuffer,
        variant: "assistant",
      });
    }

    // Step 3b: Add blank line for visual separation
    appendHistory({ kind: "text", text: "", variant: "system" });
  } finally {
    // ===== STEP 4: Cleanup state =====
    // Step 4a: Clear streaming text
    setStreamingText(null);

    // Step 4b: Clear spinner
    setSpinner(null);

    // Step 4c: Clear agent statuses
    clearAgentStatuses();

    // Step 4d: Mark application as not busy
    setBusy(false);

    // Step 4e: Mark task as inactive
    setTaskActive(false);
  }
};
