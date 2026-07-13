/**
 * Task stream controller for connecting remote agent tasks to the Ink UI.
 *
 * @remarks
 * Orchestrates sending agent task inputs over the RSocket connection, handling incremental
 * streaming text updates, rendering intermediary agent think blocks, updating state boards,
 * and dispatching user interactive confirmation overlays.
 */

import type { Connection } from "../connection/index.js";
import type { TaskFrame } from "../frames.js";
import { loadConfig } from "../config.js";
import {
  formatAdvisorThinkForDisplay,
  formatAgentThinkForDisplay,
} from "../renderer.js";
import {
  formatModeNotice,
  parseTaskModifiers,
  type MaxAgentsParam,
} from "../taskModifiers.js";
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
  setTaskActive,
  updateAgentActivity,
} from "./uiBridge.js";
import { spinnerForStatusFrame } from "./spinnerSync.js";
import type { PlanDecision } from "./types.js";

/**
 * Initiates execution of a remote task, streaming and routing lifecycle status frames to the Ink UI.
 *
 * @param connection - The active connection client.
 * @param rawTask - The raw text of the task input, possibly containing modifier flags (e.g. ::focus).
 * @returns Resolves when the stream has closed and execution has completed.
 */
export const runTaskStream = async (
  connection: Connection,
  rawTask: string,
): Promise<void> => {
  // Parse task modifiers (e.g., ::focus, ::max-agents) from raw input
  const modifiers = parseTaskModifiers(rawTask);
  const task = modifiers.clean;
  const maxAgents: MaxAgentsParam = modifiers.maxAgents;
  const modeNotice = formatModeNotice(modifiers);

  // Display the user's task in the history with user variant styling
  appendHistory({ kind: "text", text: `\n> ${task}`, variant: "user" });

  // Show mode notice if any modifiers were detected (e.g., focus mode)
  if (modeNotice) {
    appendHistory({ kind: "text", text: modeNotice, variant: "secondary" });
  }

  // Initialize UI state: mark task as active, show busy indicator
  setTaskActive(true);
  setBusy(true);
  // Clear any previous agent status displays from prior tasks
  clearAgentStatuses();
  // Show initial spinner indicating advisor is thinking
  setSpinner({ active: true, label: "Advisor", mode: "thinking" });

  // Buffer for streaming token text before committing to history
  // This allows real-time streaming display without flooding history
  let streamingBuffer = "";
  // Flag to track if we've already shown an error frame from the server
  // Used to avoid double-displaying errors if stream fails after error
  let errorFrameShown = false;

  // Helper to flush the streaming buffer into persistent history
  // Called when stream ends or when we need to show a blocking UI element
  const appendStreamTail = (): void => {
    if (streamingBuffer.length > 0) {
      appendHistory({
        kind: "text",
        text: streamingBuffer,
        variant: "assistant",
      });
    }
    // Add empty system entry to create visual separation in history
    appendHistory({ kind: "text", text: "", variant: "system" });
  };

  try {
    await connection.sendTask({
      task,
      maxAgents,
      onToken: (token) => {
        // Clear initial thinking spinner once real token output begins
        setSpinner(null);
        // Append token to streaming buffer for real-time display
        streamingBuffer += token;
        // Update the streaming text display with accumulated buffer
        setStreamingText(streamingBuffer);
      },
      onFrame: async (taskFrame: TaskFrame) => {
        // Handle think frames - show reasoning if configured
        if (taskFrame.kind === "think") {
          // Only display think output if user has enabled it in config
          if (loadConfig().showThinkOutput) {
            // Format think block differently for advisor vs agent
            const thinkBody = taskFrame.advisor
              ? formatAdvisorThinkForDisplay(taskFrame.text)
              : formatAgentThinkForDisplay(taskFrame.text);

            appendHistory({
              kind: "think",
              text: thinkBody,
              advisor: taskFrame.advisor,
            });
          }
          // Handle status frames - update spinners and agent activity displays
        } else if (taskFrame.kind === "status") {
          // Determine next spinner state based on frame content
          const nextSpinnerState = spinnerForStatusFrame(taskFrame);
          if (nextSpinnerState !== undefined) {
            setSpinner(nextSpinnerState);
          }

          // Update advisor status display if this is an advisor status frame
          if (taskFrame.source === "advisor") {
            setAgentStatus({
              id: "advisor",
              label: "Advisor",
              icon: taskFrame.icon,
              message: taskFrame.message,
              stage: taskFrame.stage,
            });

            // Update agent boards if provided (shows agent assignments)
            if (taskFrame.agentBoards !== undefined) {
              setAgentBoards(taskFrame.agentBoards);
            }
            // Update agent activity for specific agent if activity field present
          } else if (taskFrame.activity) {
            // Don't show escalating activity (it's a transient state)
            if (taskFrame.activity.stage !== "escalating") {
              updateAgentActivity(taskFrame.source.agentId, taskFrame.activity);
            } else {
              // Clear activity display when escalating (no longer relevant)
              updateAgentActivity(taskFrame.source.agentId, null);
            }
            // Clear agent activity when agent is done
          } else if (taskFrame.stage === "done") {
            updateAgentActivity(taskFrame.source.agentId, null);
          }
          // Handle plan confirmation frames - pause execution for user approval
        } else if (taskFrame.kind === "confirm-plan") {
          // Clear spinner and streaming display to focus on plan review
          setSpinner(null);
          setStreamingText(null);

          // Flush current streaming token buffer into persistent history before showing plan prompt
          // This ensures the partial response is saved before blocking on approval
          if (streamingBuffer.length > 0) {
            appendHistory({
              kind: "text",
              text: streamingBuffer,
              variant: "assistant",
            });
            streamingBuffer = "";
          }

          // Display the plan in history for user review
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

          // Request user approval for the plan (blocks until user responds)
          const planDecision = (await requestApproval({
            type: "planReview",
            task: taskFrame.task,
            stepCount: taskFrame.steps.length,
            agentCount: taskFrame.agentCount,
            execution: taskFrame.execution,
            modeLabel: taskFrame.modeLabel,
          })) as PlanDecision;

          let planSteps = taskFrame.steps;

          // If user chose to edit the plan, prompt for edited steps
          if (planDecision === "edit") {
            const editedSteps = await requestPrompt({
              type: "planEdit",
              initial: taskFrame.steps,
            });

            // Use edited steps if valid array, otherwise fall back to original
            planSteps = Array.isArray(editedSteps)
              ? editedSteps
              : taskFrame.steps;

            // Confirm the plan update to user
            appendHistory({
              kind: "text",
              text: `✓ Plan updated (${planSteps.length} steps).`,
              variant: "success",
            });
          }

          // Send the user's decision (and potentially edited steps) back to server
          await connection.respondPlan(taskFrame.id, planDecision, planSteps);
          // Resume spinner to show agent is now executing the approved plan
          setSpinner({ active: true, label: "Agent", mode: "thinking" });
          // Handle error frames - display error message to user
        } else if (taskFrame.kind === "error") {
          errorFrameShown = true;
          appendHistory({
            kind: "text",
            text: taskFrame.message,
            variant: "error",
          });
        }
      },
    });
    // Flush any remaining streaming buffer after stream completes normally
    appendStreamTail();
  } catch (streamError) {
    // Only throw if we haven't already shown an error frame from the server
    // This prevents double-displaying errors when stream fails after error
    if (!errorFrameShown) {
      throw streamError;
    }
    // Flush buffer even on error to preserve partial output
    appendStreamTail();
  } finally {
    // Cleanup UI state regardless of success or failure
    setStreamingText(null);
    setSpinner(null);
    clearAgentStatuses();
    setBusy(false);
    setTaskActive(false);
  }
};
