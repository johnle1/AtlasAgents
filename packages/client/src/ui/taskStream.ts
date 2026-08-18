/**
 * Task stream controller for connecting remote agent tasks to the Ink UI.
 *
 * @remarks
 * Orchestrates sending agent task inputs over the RSocket connection, handling incremental
 * streaming text updates, rendering intermediary agent think blocks, updating state boards,
 * and dispatching user interactive confirmation overlays.
 */

import type { Connection } from "../connection/index.js";
import type { SubagentStatusSource, TaskFrame } from "../types/frames.js";
import { clampUsage } from "@atlasagents/shared";
import { loadConfig } from "../config/index.js";
import { formatAgentThinkForDisplay } from "../renderer.js";
import { thinkDisplayThreshold } from "./thinkDisplay.js";
import {
  formatModeNotice,
  parseTaskModifiers,
  type MaxSubagentsParam,
} from "../utils/taskModifiers.js";
import {
  appendHistory,
  appendLiveThink,
  clearSubagentStatuses,
  endLiveThink,
  requestApproval,
  requestPrompt,
  setActiveTaskCancel,
  setSubagentBoards,
  setSubagentStatus,
  setBusy,
  setSpinner,
  setStreamingText,
  setTaskActive,
  startLiveThink,
  updateAgentActivity,
  setContextUsage,
} from "./uiBridge.js";
import { notifyUser } from "./notify.js";
import { getApprovalMode } from "./bridge/allowlist.js";
import { spinnerForStatusFrame } from "./spinnerSync.js";
import type { PlanDecision } from "./types.js";

/**
 * Formats a subagent's display label for a live think block, matching the
 * "Agent {id} — {label}" convention used by {@link SubagentTaskBoard}.
 *
 * @param agent - `true` for the lead agent, which has no per-subagent label.
 * @param source - The subagent identity from the `think-start` frame.
 * @returns `null` for the lead agent (or if `source` is unexpectedly absent
 *   on a subagent stream); otherwise the formatted label.
 */
const formatThinkLabel = (
  agent: boolean,
  source: SubagentStatusSource | undefined,
): string | null => {
  if (agent || !source) {
    return null;
  }
  return source.agentLabel.length > 0
    ? `Agent ${source.agentId} — ${source.agentLabel}`
    : `Agent ${source.agentId}`;
};

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

  // Tracks each open think stream by its wire id: `text` is everything
  // received so far (the source of truth for what gets committed),
  // `pending` is the slice not yet painted to the live view — a client-side
  // repaint coalescer independent of the server's own wire-economy
  // coalescing (see thinkDisplay.ts). `committedLength` is how much of `text`
  // has already been written to scrollback by a force-commit, so a stream
  // that keeps running after one is continued rather than duplicated. Only
  // populated when showThinkOutput is on: gating once at think-start means
  // later deltas for a suppressed stream are a plain missing-entry no-op.
  const thinkStreams = new Map<
    string,
    {
      agent: boolean;
      label: string | null;
      text: string;
      pending: string;
      committedLength: number;
    }
  >();

  // Pushes any buffered-but-unpainted text for one stream into the live view.
  const paintThinkStream = (id: string): void => {
    const entry = thinkStreams.get(id);
    if (!entry || entry.pending.length === 0) {
      return;
    }
    appendLiveThink(id, entry.pending);
    entry.pending = "";
  };

  // Removes a stream from the live view and commits its text to scrollback.
  // `finalText` (from a think-end frame) takes precedence when present;
  // otherwise falls back to everything accumulated locally — covering both
  // a clean close and a stream force-closed by commitLiveThinks below.
  // Anything a previous force-commit already wrote is sliced off, so a
  // stream committed more than once reads as a continuation, not a repeat.
  const commitThinkStream = (
    id: string,
    entry: { agent: boolean; text: string; committedLength: number },
    finalText?: string,
  ): void => {
    endLiveThink(id);
    // With a prefix already committed, continue from the locally-accumulated
    // text: `committedLength` indexes into that, and the server's `finalText`
    // is the cleaned whole block (fences stripped, tags removed), so slicing
    // it by that offset would cut in the wrong place. `finalText` still wins
    // whenever nothing has been committed yet, which is the normal close.
    const uncommitted =
      entry.committedLength > 0
        ? entry.text.slice(entry.committedLength)
        : (finalText ?? entry.text);
    if (uncommitted.length === 0) {
      return;
    }
    appendHistory({
      kind: "think",
      text: formatAgentThinkForDisplay(uncommitted),
      agent: entry.agent,
    });
  };

  // Commits every still-open think stream immediately. Called wherever a
  // stream might otherwise be abandoned mid-flight — a blocking plan-review
  // prompt, an error frame, or the stream ending without a matching
  // think-end (e.g. a connection-level throw) — so partial reasoning is
  // preserved in scrollback rather than silently dropped, the same way
  // streamingBuffer's partial assistant text is preserved on those paths.
  //
  // Entries are marked committed rather than dropped. The server has no idea
  // the client force-closed anything and keeps sending deltas for the same
  // id; clearing the map made every one of them a missing-entry no-op and
  // discarded the authoritative `finalText` from think-end, so a subagent
  // still reasoning during a plan-review prompt lost everything after the
  // prompt appeared.
  const commitLiveThinks = (): void => {
    for (const [id, entry] of thinkStreams) {
      commitThinkStream(id, entry);
      entry.committedLength = (entry.text ?? "").length;
      entry.pending = "";
    }
  };

  // Helper to commit the streaming buffer into persistent history
  // Called when stream ends or when we need to show a blocking UI element
  const appendStreamTail = (): void => {
    // Commit any still-open think streams first so reasoning reads above the
    // final answer text, in the order it actually happened.
    commitLiveThinks();
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

  // Opens a live think stream. Gates on showThinkOutput once, here — deltas
  // and the end signal for a suppressed stream then find no map entry and
  // silently no-op, so the gate only needs checking in one place.
  const handleThinkStartFrame = (
    taskFrame: Extract<TaskFrame, { kind: "think-start" }>,
  ): void => {
    if (!loadConfig().showThinkOutput) {
      return;
    }
    const agent = taskFrame.agent === true;
    const label = formatThinkLabel(agent, taskFrame.source);
    thinkStreams.set(taskFrame.id, {
      agent,
      label,
      text: "",
      pending: "",
      committedLength: 0,
    });
    startLiveThink(taskFrame.id, agent, label);
  };

  // Appends one slice of newly-arrived think text, repainting the live view
  // only once enough has accumulated (a newline, or the width-derived
  // threshold) — the client-side half of coalescing; the server already did
  // its own wire-economy coalescing before this frame was ever sent.
  const handleThinkDeltaFrame = (
    taskFrame: Extract<TaskFrame, { kind: "think-delta" }>,
  ): void => {
    const entry = thinkStreams.get(taskFrame.id);
    if (!entry) {
      return;
    }
    // A force-commit ended this stream's live block but the server kept
    // streaming; reopen one so the continuation is visible while it arrives.
    if (
      entry.committedLength > 0 &&
      entry.text.length === entry.committedLength
    ) {
      startLiveThink(taskFrame.id, entry.agent, entry.label);
    }
    entry.text += taskFrame.text;
    entry.pending += taskFrame.text;
    if (
      entry.pending.includes("\n") ||
      entry.pending.length >= thinkDisplayThreshold()
    ) {
      paintThinkStream(taskFrame.id);
    }
  };

  // Closes a think stream: removes it from the live view and commits the
  // completed block to scrollback.
  const handleThinkEndFrame = (
    taskFrame: Extract<TaskFrame, { kind: "think-end" }>,
  ): void => {
    const entry = thinkStreams.get(taskFrame.id);
    if (!entry) {
      return;
    }
    thinkStreams.delete(taskFrame.id);
    commitThinkStream(taskFrame.id, entry, taskFrame.text);
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

    // Commit any open think streams before the approval prompt blocks the
    // frame queue — otherwise another agent's reasoning would sit under a
    // half-rendered live block for as long as the user takes to decide.
    commitLiveThinks();

    // Commit current streaming token buffer into persistent history before
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
    // Commit any open think streams first so the user sees what the agent
    // was reasoning about right before the error, instead of losing it.
    commitLiveThinks();
    appendHistory({ kind: "text", text: taskFrame.message, variant: "error" });
  };

  const handleWarningFrame = (
    taskFrame: Extract<TaskFrame, { kind: "warning" }>,
  ): void => {
    // Unlike handleErrorFrame, this does NOT set errorFrameShown — a
    // placement warning (e.g. a model spilled to CPU) doesn't mean the task
    // failed, just that it may be slower than expected.
    appendHistory({
      kind: "text",
      text: taskFrame.message,
      variant: "warning",
    });
  };

  let cancelledByUser = false;
  let completedSuccessfully = false;

  try {
    const { done, cancel } = await connection.sendTask({
      task,
      maxSubagents,
      approvalMode: getApprovalMode(),
      onToken: (token) => {
        // Clear initial thinking spinner once real token output begins
        setSpinner(null);
        // Append token to streaming buffer for real-time display
        streamingBuffer += token;
        // Update the streaming text display with accumulated buffer
        setStreamingText(streamingBuffer);
      },
      onFrame: async (taskFrame: TaskFrame) => {
        if (taskFrame.kind === "think-start") {
          handleThinkStartFrame(taskFrame);
        } else if (taskFrame.kind === "think-delta") {
          handleThinkDeltaFrame(taskFrame);
        } else if (taskFrame.kind === "think-end") {
          handleThinkEndFrame(taskFrame);
        } else if (taskFrame.kind === "status") {
          handleStatusFrame(taskFrame);
        } else if (taskFrame.kind === "confirm-plan") {
          await handleConfirmPlanFrame(taskFrame);
        } else if (taskFrame.kind === "error") {
          handleErrorFrame(taskFrame);
        } else if (taskFrame.kind === "warning") {
          handleWarningFrame(taskFrame);
        } else if (taskFrame.kind === "usage") {
          const clamped = clampUsage(
            taskFrame.usedTokens,
            taskFrame.contextWindow,
          );
          if (clamped) {
            setContextUsage(clamped);
          }
        }
      },
    });
    setActiveTaskCancel(() => {
      cancelledByUser = true;
      cancel();
    });
    await done;
    // Commit any remaining streaming buffer after stream completes normally
    appendStreamTail();
    if (cancelledByUser) {
      appendHistory({
        kind: "text",
        text: "Task cancelled by user",
        variant: "warning",
      });
    } else if (!errorFrameShown) {
      completedSuccessfully = true;
    }
  } catch (streamError) {
    // Only throw if we haven't already shown an error frame from the server
    // This prevents double-displaying errors when stream fails after error
    if (!errorFrameShown) {
      throw streamError;
    }
    // Commit buffer even on error to preserve partial output
    appendStreamTail();
  } finally {
    setActiveTaskCancel(null);
    if (completedSuccessfully) {
      notifyUser("Task complete");
    }
    // Cleanup UI state regardless of success or failure
    setStreamingText(null);
    // Safety net: commits any think stream still open at this point (e.g. a
    // connection-level throw with no error frame, so appendStreamTail's own
    // commit above never ran). A no-op otherwise, since every stream that
    // closed normally already removed itself from the map.
    commitLiveThinks();
    setSpinner(null);
    clearSubagentStatuses();
    setBusy(false);
    setTaskActive(false);
  }
};
