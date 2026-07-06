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
import { formatAdvisorThinkForDisplay, formatAgentThinkForDisplay } from "../renderer.js";
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
  const modifiers = parseTaskModifiers(rawTask);
  const task = modifiers.clean;
  const maxAgents: MaxAgentsParam = modifiers.maxAgents;
  const modeNotice = formatModeNotice(modifiers);

  appendHistory({ kind: "text", text: `\n> ${task}`, variant: "user" });

  if (modeNotice) {
    appendHistory({ kind: "text", text: modeNotice, variant: "secondary" });
  }

  setTaskActive(true);
  setBusy(true);
  clearAgentStatuses();
  setSpinner({ active: true, label: "Advisor", mode: "thinking" });

  let streamingBuffer = "";

  try {
    await connection.sendTask({
      task,
      maxAgents,
      onToken: (token) => {
        // Clear initial thinking spinner once real token output begins
        setSpinner(null);
        streamingBuffer += token;
        setStreamingText(streamingBuffer);
      },
      onFrame: async (taskFrame: TaskFrame) => {
        if (taskFrame.kind === "think") {
          if (loadConfig().showThinkOutput) {
            const thinkBody = taskFrame.advisor
              ? formatAdvisorThinkForDisplay(taskFrame.text)
              : formatAgentThinkForDisplay(taskFrame.text);

            appendHistory({
              kind: "think",
              text: thinkBody,
              advisor: taskFrame.advisor,
            });
          }
        }
        else if (taskFrame.kind === "status") {
          const nextSpinnerState = spinnerForStatusFrame(taskFrame);
          if (nextSpinnerState !== undefined) {
            setSpinner(nextSpinnerState);
          }

          if (taskFrame.source === "advisor") {
            setAgentStatus({
              id: "advisor",
              label: "Advisor",
              icon: taskFrame.icon,
              message: taskFrame.message,
              stage: taskFrame.stage,
            });

            if (taskFrame.agentBoards !== undefined) {
              setAgentBoards(taskFrame.agentBoards);
            }
          }
          else if (taskFrame.activity) {
            updateAgentActivity(taskFrame.source.agentId, taskFrame.activity);
          }
          else if (taskFrame.stage === "done") {
            updateAgentActivity(taskFrame.source.agentId, null);
          }
        }
        else if (taskFrame.kind === "confirm-plan") {
          setSpinner(null);
          setStreamingText(null);

          // Flush current streaming token buffer into persistent history before showing plan prompt
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

          let planSteps = taskFrame.steps;

          if (planDecision === "edit") {
            const editedSteps = await requestPrompt({
              type: "planEdit",
              initial: taskFrame.steps,
            });

            planSteps = Array.isArray(editedSteps)
              ? editedSteps
              : taskFrame.steps;

            appendHistory({
              kind: "text",
              text: `✓ Plan updated (${planSteps.length} steps).`,
              variant: "success",
            });
          }

          await connection.respondPlan(taskFrame.id, planDecision, planSteps);
          setSpinner({ active: true, label: "Agent", mode: "thinking" });
        }
        else if (taskFrame.kind === "error") {
          appendHistory({
            kind: "text",
            text: taskFrame.message,
            variant: "error",
          });
        }
      },
    });

    if (streamingBuffer.length > 0) {
      appendHistory({
        kind: "text",
        text: streamingBuffer,
        variant: "assistant",
      });
    }

    appendHistory({ kind: "text", text: "", variant: "system" });
  } finally {
    setStreamingText(null);
    setSpinner(null);
    clearAgentStatuses();
    setBusy(false);
    setTaskActive(false);
  }
};

