/**
 * Task stream controller for connecting remote agent tasks to the Ink UI.
 *
 * @remarks
 * Orchestrates sending agent task inputs over the RSocket connection, handling incremental
 * streaming text updates, rendering intermediary agent think blocks, updating state boards,
 * and dispatching user interactive confirmation overlays.
 */

import type { Connection } from "../connection/index.js";
import type { TaskFrame } from "../types/frames.js";
import { loadConfig } from "../config/index.js";
import { formatAgentThinkForDisplay } from "../renderer.js";
import {
  formatModeNotice,
  parseTaskModifiers,
  type MaxSubagentsParam,
} from "../utils/taskModifiers.js";
import {
  appendHistory,
  clearSubagentStatuses,
  requestApproval,
  requestPrompt,
  setSubagentBoards,
  setSubagentStatus,
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
  const maxSubagents: MaxSubagentsParam = modifiers.maxSubagents;
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
  clearSubagentStatuses();
  // Show initial spinner indicating agent is thinking
  setSpinner({ active: true, label: "Agent", mode: "thinking" });

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

  // Shows reasoning output, only when the user has enabled it in config.
  const handleThinkFrame = (
    taskFrame: Extract<TaskFrame, { kind: "think" }>,
  ): void => {
    if (!loadConfig().showThinkOutput) {
      return;
    }
    const thinkBody = formatAgentThinkForDisplay(taskFrame.text);
    appendHistory({
      kind: "think",
      text: thinkBody,
      agent: taskFrame.agent,
    });
  };

  // Updates spinners and per-agent activity/board displays.
  const handleStatusFrame = (
    taskFrame: Extract<TaskFrame, { kind: "status" }>,
  ): void => {
    const nextSpinnerState = spinnerForStatusFrame(taskFrame);
    if (nextSpinnerState !== undefined) {
      setSpinner(nextSpinnerState);
    }

    if (taskFrame.source === "agent") {
      setSubagentStatus({
        id: "agent",
        label: "Agent",
        icon: taskFrame.icon,
        message: taskFrame.message,
        stage: taskFrame.stage,
      });
      if (taskFrame.subagentBoards !== undefined) {
        setSubagentBoards(taskFrame.subagentBoards);
      }
    } else if (taskFrame.activity) {
      // Don't show escalating activity (it's a transient state).
      if (taskFrame.activity.stage !== "escalating") {
        updateAgentActivity(taskFrame.source.agentId, taskFrame.activity);
      } else {
        updateAgentActivity(taskFrame.source.agentId, null);
      }
    } else if (taskFrame.stage === "done") {
      updateAgentActivity(taskFrame.source.agentId, null);
    }
  };

  // Pauses execution for user plan approval; resumes the agent spinner after.
  const handleConfirmPlanFrame = async (
    taskFrame: Extract<TaskFrame, { kind: "confirm-plan" }>,
  ): Promise<void> => {
    setSpinner(null);
    setStreamingText(null);

    // Flush current streaming token buffer into persistent history before
    // showing the plan prompt, so the partial response is saved before we
    // block on approval.
    if (streamingBuffer.length > 0) {
      appendHistory({
        kind: "text",
        text: streamingBuffer,
        variant: "assistant",
      });
      streamingBuffer = "";
    }

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

    const planDecision = (await requestApproval({
      type: "planReview",
      task: taskFrame.task,
      stepCount: taskFrame.steps.length,
      agentCount: taskFrame.agentCount,
      execution: taskFrame.execution,
      modeLabel: taskFrame.modeLabel,
    })) as PlanDecision;

    let planFeedback: string | undefined;

    // If user chose to give feedback, prompt for free-text feedback — the
    // agent re-plans from this; the user does not hand-edit steps.
    if (planDecision === "edit") {
      const feedbackResult = await requestPrompt({
        type: "planFeedback",
        initial: taskFrame.steps,
      });

      planFeedback = typeof feedbackResult === "string" ? feedbackResult : "";

      appendHistory({
        kind: "text",
        text: "✓ Feedback sent — agent is revising the plan…",
        variant: "success",
      });
    }

    await connection.respondPlan(taskFrame.id, planDecision, planFeedback);
    // Resume spinner to show agent is now executing the approved plan.
    setSpinner({ active: true, label: "Agent", mode: "thinking" });
  };

  const handleErrorFrame = (
    taskFrame: Extract<TaskFrame, { kind: "error" }>,
  ): void => {
    errorFrameShown = true;
    appendHistory({ kind: "text", text: taskFrame.message, variant: "error" });
  };

  try {
    await connection.sendTask({
      task,
      maxSubagents,
      onToken: (token) => {
        // Clear initial thinking spinner once real token output begins
        setSpinner(null);
        // Append token to streaming buffer for real-time display
        streamingBuffer += token;
        // Update the streaming text display with accumulated buffer
        setStreamingText(streamingBuffer);
      },
      onFrame: async (taskFrame: TaskFrame) => {
        if (taskFrame.kind === "think") {
          handleThinkFrame(taskFrame);
        } else if (taskFrame.kind === "status") {
          handleStatusFrame(taskFrame);
        } else if (taskFrame.kind === "confirm-plan") {
          await handleConfirmPlanFrame(taskFrame);
        } else if (taskFrame.kind === "error") {
          handleErrorFrame(taskFrame);
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
    clearSubagentStatuses();
    setBusy(false);
    setTaskActive(false);
  }
};
