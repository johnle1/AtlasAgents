/**
 * Task frames — the wire format for streaming server updates to the client.
 *
 * @remarks
 * This module defines the discriminated union types for all messages sent via
 * Server-Sent Events (SSE) from the server to the web/CLI client. Each frame
 * variant represents a different kind of update: token streaming, reasoning text,
 * plan confirmation prompts, status changes, progress (e.g., model pulls), errors,
 * and completion.
 *
 * The pipeline is:
 * 1. Server code creates a `TaskFrame` object
 * 2. {@link encodeFrame} serializes it to JSON and wraps in a Buffer
 * 3. SSE transport sends the Buffer as a line of data
 * 4. Client receives the raw bytes
 * 5. {@link decodeFrame} deserializes back to a `TaskFrame` (or null on error)
 * 6. Client UI renders based on the `kind` discriminant
 *
 * @example
 * ```ts
 * const frame1: TaskFrame = { kind: "token", text: "hello" };
 * const encoded = encodeFrame(frame1);
 * const decoded = decodeFrame(encoded); // back to TaskFrame
 *
 * const frame2: TaskFrame = {
 *   kind: "status",
 *   source: "agent",
 *   stage: "drafting",
 *   icon: "◌",
 *   message: "Working on the solution...",
 * };
 * ```
 */

/**
 * Progress metadata for long-running operations (e.g., downloading model files).
 *
 * @remarks
 * Used in `TaskFrame` to report incremental progress. Fields are optional because
 * progress events may represent different stages: a status message (status alone),
 * download progress (completed + total), or a final hash verification (digest).
 *
 * @example
 * ```ts
 * { status: "Downloading", completed: 256, total: 1024 }
 * { digest: "sha256:abc123..." } // completion confirmation
 * { error: "Network timeout" } // failure
 * ```
 */
export type PullProgress = {
  /** Current operation label (e.g., "Downloading", "Extracting"). */
  status?: string;
  /** Bytes downloaded/processed so far. */
  completed?: number;
  /** Total bytes expected. */
  total?: number;
  /** Error message if the operation failed. */
  error?: string;
  /** Content hash (e.g., file digest or model checksum). */
  digest?: string;
};

/**
 * A single plan (task or sub-task) to be executed by a subagent.
 *
 * @remarks
 * Subagents are organized as a DAG via the `dependsOn` field: a subagent can wait
 * for others to finish before running. The `id` is unique within a single agent
 * lifecycle and used for task correlation. The `label` and `steps` are
 * human-readable descriptions shown in plan-review dialogs.
 *
 * @example
 * ```ts
 * { id: 1, label: "Fetch API docs", steps: ["GET /docs"], dependsOn: [] }
 * { id: 2, label: "Implement", steps: ["Write code", "Test"], dependsOn: [1] }
 * ```
 */
export type SubagentPlan = {
  /** Unique identifier for this task within the agent's lifecycle. */
  id: number;
  /** Human-readable name of the task (shown in plan-review UI). */
  label: string;
  /** Ordered steps/sub-steps this task will perform. */
  steps: string[];
  /** IDs of tasks that must complete before this one can start. */
  dependsOn: number[];
};

/**
 * How multiple subagents executing a plan coordinate their execution.
 *
 * @remarks
 * - `"sequential"`: Run agents one at a time, in order.
 * - `"parallel"`: Run all agents concurrently.
 * - `"mixed"`: Some agents run sequentially, others in parallel (respects `dependsOn`).
 */
export type PlanExecution = "parallel" | "sequential" | "mixed";

/**
 * Identifies a subagent for status reporting.
 *
 * @remarks
 * When a subagent updates its status (enters a new stage), it includes this
 * source so the CLI/web UI can group updates by agent. Distinguished from the
 * main Agent (which just reports `source: "agent"` in status frames).
 *
 * @example
 * ```ts
 * { agentId: 2, agentLabel: "search-researcher" }
 * ```
 */
export type SubagentStatusSource = { agentId: number; agentLabel: string };

/**
 * Lifecycle stages for a subagent's work.
 *
 * @remarks
 * Progresses as a subagent moves through its reasoning, reads context, modifies
 * code, runs tests, etc. More granular than {@link AgentStage} to show detailed
 * progress in a subagent status display.
 *
 * - `"thinking"`: Reasoning about the task.
 * - `"reading"`: Reading files or context.
 * - `"writing"`: Modifying files.
 * - `"searching"`: Searching the codebase.
 * - `"running"`: Executing commands or tests.
 * - `"verifying"`: Checking results.
 * - `"escalating"`: Escalating to the parent Agent.
 * - `"retrying"`: Retrying a failed operation.
 * - `"waiting"`: Blocked (e.g., plan review, user input).
 * - `"done"`: Completed successfully or failed.
 */
export type SubagentStage =
  | "thinking"
  | "reading"
  | "writing"
  | "searching"
  | "running"
  | "verifying"
  | "escalating"
  | "retrying"
  | "waiting"
  | "done";

/**
 * Lifecycle stages for the main Agent's work.
 *
 * @remarks
 * Coarser-grained than {@link SubagentStage}; captures the Agent's higher-level
 * flow (understanding the task, reading context, drafting a solution, etc.).
 *
 * - `"understanding"`: Analyzing the user's request.
 * - `"reading-context"`: Loading relevant files and context.
 * - `"drafting"`: Producing an initial solution or plan.
 * - `"verifying"`: Checking the solution (tests, logic).
 * - `"revising"`: Refining based on feedback.
 * - `"ready"`: Solution is complete and ready.
 * - `"combining"`: Aggregating results from subagents.
 */
export type AgentStage =
  | "understanding"
  | "reading-context"
  | "drafting"
  | "verifying"
  | "revising"
  | "ready"
  | "combining";

/**
 * Visual status icon for CLI/terminal display.
 *
 * @remarks
 * - `"◌"` (hollow circle): in progress or waiting
 * - `"✓"` (checkmark): complete/success
 * - `"⚠"` (warning): caution/issue
 */
export type StatusIcon = "◌" | "✓" | "⚠";

/**
 * Snapshot of a task queued in a subagent's task board.
 *
 * @remarks
 * Used in status frames to show pending/running tasks. The `blocked` flag
 * indicates whether this task is waiting on dependencies to complete.
 */
export type QueuedTaskSnapshot = {
  /** Unique task ID. */
  id: number;
  /** Human-readable task description. */
  text: string;
  /** Whether this task is blocked on a prerequisite. */
  blocked: boolean;
};

/**
 * Task lifecycle state within a subagent's board.
 *
 * @remarks
 * Represents the current state of a task as it progresses:
 * - `"waiting"`: Queued but not yet running.
 * - `"blocked"`: Waiting on dependencies.
 * - `"running"`: Currently executing.
 * - `"complete"`: Finished successfully.
 * - `"failed"`: Execution failed.
 */
export type TaskLifecycleState =
  | "waiting"
  | "blocked"
  | "running"
  | "complete"
  | "failed";

/**
 * Snapshot of a single task in a subagent's task board.
 *
 * @remarks
 * A lightweight representation of task state, included in status frames to show
 * the subagent's current work queue and progress.
 */
export type SubagentTaskSnapshot = {
  /** Unique task ID. */
  id: number;
  /** Description of what the task does. */
  text: string;
  /** Current lifecycle state. */
  state: TaskLifecycleState;
};

/**
 * Snapshot of a subagent's entire task board.
 *
 * @remarks
 * Included in status frames to display what work the subagent has queued and
 * the state of each task (running, waiting, blocked, etc.). Allows the UI to
 * show a live task board per subagent.
 */
export type SubagentBoardSnapshot = {
  /** ID of the subagent this board belongs to. */
  id: number;
  /** Label/name of the subagent. */
  label: string;
  /** All tasks on this subagent's board with current state. */
  tasks: SubagentTaskSnapshot[];
};

/**
 * Discriminated union of all possible server-to-client frame types.
 *
 * @remarks
 * Each variant represents a different kind of update sent via SSE. The `kind`
 * field acts as the discriminant for TypeScript type narrowing. Variants:
 *
 * - `"token"`: Streaming text output (e.g., token-by-token model output).
 * - `"think"`: Internal reasoning (Claude's thinking, with optional agent flag).
 * - `"confirm-plan"`: User confirmation prompt for an execution plan.
 * - `"status"`: Status update from Agent or subagent (stage, progress, task queue).
 * - `"progress"`: Long-running operation progress (e.g., model downloads).
 * - `"error"`: An error occurred during execution.
 * - `"done"`: Task completed successfully.
 *
 * **Example frame sequence:**
 * ```
 * 1. { kind: "status", source: "agent", stage: "understanding", ... }
 * 2. { kind: "think", text: "Let me analyze this problem...", agent: true }
 * 3. { kind: "token", text: "The solution is " }
 * 4. { kind: "token", text: "to refactor " }
 * 5. { kind: "confirm-plan", id: "...", task: "...", ... }
 *    (client sends user response)
 * 6. { kind: "status", source: "agent", stage: "ready", ... }
 * 7. { kind: "done" }
 * ```
 */
export type TaskFrame =
  /** Streaming text output from the model or system. */
  | { kind: "token"; text: string }
  /** Internal reasoning or thinking text (optionally tagged as Agent's). */
  | { kind: "think"; text: string; agent?: boolean }
  /**
   * Plan review/confirmation prompt. User must approve or reject via the CLI.
   * Sent when the Agent proposes executing a plan.
   */
  | {
      kind: "confirm-plan";
      /** Unique ID for this plan review (used to correlate user response). */
      id: string;
      /** Human-readable task summary shown to the user. */
      task: string;
      /** Ordered list of steps the plan will execute. */
      steps: string[];
      /** Identified risks or concerns. */
      risks: string[];
      /** Subagent plans (details of which agents will run what). */
      agents: SubagentPlan[];
      /** Total number of subagents involved. */
      agentCount: number;
      /** Execution strategy (parallel/sequential/mixed). */
      execution: PlanExecution;
      /** Optional label (e.g., "production", "staging") for context. */
      modeLabel: string | null;
    }
  /**
   * Status update from Agent or subagent. Includes lifecycle stage, optional
   * progress metadata (revisions, queued tasks, subagent boards), and activity hints.
   */
  | {
      kind: "status";
      /** Source: the agent reporting ("agent" for main Agent, or a SubagentStatusSource). */
      source: SubagentStatusSource | "agent";
      /** Current stage in the agent's lifecycle. */
      stage: SubagentStage | AgentStage;
      /** Visual icon to display alongside the status. */
      icon: StatusIcon;
      /** Human-readable status message. */
      message: string;
      /** Revision progress (e.g., { current: 2, max: 3 } for revisions 2 of 3). */
      revision?: { current: number; max: number };
      /** Queued tasks awaiting execution. */
      queue?: QueuedTaskSnapshot[];
      /** Task boards for each subagent (showing per-agent task queues). */
      subagentBoards?: SubagentBoardSnapshot[];
      /** Current activity (optional stage/message hint for fine-grained progress). */
      activity?: { stage: SubagentStage; message: string };
    }
  /** Progress update for a long-running operation (e.g., downloading models). */
  | { kind: "progress"; data: PullProgress }
  /** An error occurred. Sent instead of continuing execution. */
  | { kind: "error"; message: string }
  /** Task completed. Final frame sent to indicate success and end of stream. */
  | { kind: "done" };

/**
 * Serializes a TaskFrame to UTF-8 JSON in a Buffer.
 *
 * @remarks
 * Used before sending over SSE. The frame is JSON-stringified and encoded as UTF-8
 * bytes, ready to be wrapped in the SSE `data:` line format.
 *
 * @param frame - The TaskFrame to serialize.
 * @returns Buffer containing the UTF-8 JSON representation.
 *
 * @example
 * ```ts
 * const frame: TaskFrame = { kind: "token", text: "hello" };
 * const buf = encodeFrame(frame);
 * // buf.toString("utf-8") === '{"kind":"token","text":"hello"}'
 * ```
 */
export const encodeFrame = (frame: TaskFrame): Buffer =>
  Buffer.from(JSON.stringify(frame), "utf-8");

/**
 * Deserializes a Buffer back into a TaskFrame.
 *
 * @remarks
 * **Graceful degradation:** If the buffer isn't valid JSON or doesn't contain a
 * recognizable frame shape, falls back to treating the raw text as a `"token"`.
 * This handles edge cases where:
 * - Partial frames or corrupted data arrive
 * - Non-frame data (e.g., debug output) is mixed into the stream
 * - Network errors truncate the JSON
 *
 * @param data - Buffer to deserialize (can be undefined or empty).
 * @returns Parsed TaskFrame, or null if the buffer is empty and can't be salvaged.
 *
 * @example
 * ```ts
 * const buf = Buffer.from('{"kind":"token","text":"hello"}', "utf-8");
 * decodeFrame(buf); // { kind: "token", text: "hello" }
 *
 * // Fallback: non-JSON text becomes a token
 * decodeFrame(Buffer.from("some text")); // { kind: "token", text: "some text" }
 *
 * decodeFrame(undefined); // null
 * decodeFrame(Buffer.alloc(0)); // null
 * ```
 */
export const decodeFrame = (data: Buffer | undefined): TaskFrame | null => {
  if (!data || data.length === 0) {
    return null;
  }
  try {
    // Try to parse as JSON first.
    const parsed = JSON.parse(data.toString("utf-8")) as TaskFrame;
    if (parsed && typeof parsed === "object" && "kind" in parsed) {
      return parsed;
    }
  } catch {
    // Fallback: if JSON parsing fails, treat raw text as a token (streaming mode).
    const text = data.toString("utf-8");
    if (text.length > 0) {
      return { kind: "token", text };
    }
  }
  return null;
};
