/**
 * Type definitions for the Ink terminal UI layer.
 *
 * @remarks
 * Covers history rendering, approval and prompt overlays, agent status
 * boards, and the props passed from {@link BootstrapApp} into {@link App}.
 * Server frame types from `frames.js` are reused where the UI mirrors
 * wire payloads directly.
 */
import type {
  AgentPlan,
  AgentStage,
  AdvisorStage,
  PlanExecution,
  StatusIcon,
  TaskLifecycleState,
} from "../frames.js";

/**
 * Display styling for plain-text history lines.
 */
export type HistoryVariant =
  | "user"
  | "assistant"
  | "system"
  | "error"
  | "success"
  | "secondary";

/**
 * One renderable item in the terminal scrollback.
 *
 * @remarks
 * Each `kind` maps to a dedicated renderer in {@link HistoryView}. New kinds
 * require a matching render branch and any bridge code that produces them.
 */
export type HistoryItem =
  | {
      kind: "text";
      /** Line body. */
      text: string;
      /** Color/styling bucket; defaults to neutral when omitted. */
      variant?: HistoryVariant;
    }
  | {
      kind: "think";
      /** Collapsible reasoning block content. */
      text: string;
      /** When `true`, styled as advisor output rather than agent output. */
      advisor?: boolean;
    }
  | {
      kind: "plan";
      /** User task the plan addresses. */
      task: string;
      /** Human-readable step descriptions. */
      steps: string[];
      /** Identified risks or open questions. */
      risks: string[];
      /** Per-agent assignments from the advisor. */
      agents: AgentPlan[];
      agentCount: number;
      execution: PlanExecution;
      /** Short label for the execution mode (e.g. `"sequential"`). */
      modeLabel: string | null;
    }
  | {
      kind: "diff";
      /** File path the diff applies to. */
      path: string;
      /** Pre-rendered diff body (syntax highlighting applied upstream). */
      body: string;
    }
  | {
      kind: "block";
      /** Multi-line styled block rendered as a unit. */
      lines: string[];
    };

/** Spinner animation bucket for the bottom status line. */
export type SpinnerMode = "thinking" | "working";

/**
 * Active bottom-line spinner shown while the advisor or an agent is working.
 *
 * @remarks
 * Only the `active: true` variant exists — absence of spinner state is
 * represented by `null` in context, not `active: false`.
 */
export type SpinnerState = {
  active: true;
  /** Label beside the spinner (e.g. `"Advisor"`, `"Agent 2"`). */
  label: string;
  mode: SpinnerMode;
};

/** User choice when reviewing an execution plan. */
export type PlanDecision = "implement" | "skip" | "edit";

/**
 * One agent or advisor status row in the status area.
 */
export type AgentStatusState = {
  id: number | "advisor";
  label: string;
  icon: StatusIcon;
  message: string;
  stage?: AgentStage | AdvisorStage;
};

/** A task waiting in the queue before assignment. */
export type PendingTaskState = {
  id: number;
  text: string;
  /** `true` when dependencies prevent execution. */
  blocked: boolean;
};

/** One task on an agent's board. */
export type AgentTaskState = {
  id: number;
  text: string;
  state: TaskLifecycleState;
};

/**
 * Snapshot of one agent's assigned tasks and current activity.
 */
export type AgentBoardState = {
  id: number;
  label: string;
  tasks: AgentTaskState[];
  activity?: { stage: AgentStage; message: string } | null;
};

/**
 * A blocking approval dialog shown before a sensitive operation proceeds.
 *
 * @remarks
 * Created by the task stream / bridge when the server needs user consent.
 * {@link ApprovalMenu} renders the request; the user's answer is an
 * {@link ApprovalResult} passed back to unblock the waiting RPC.
 */
export type ApprovalRequest =
  | {
      type: "keepUndo";
      /** Short label describing the file change (e.g. path or action). */
      contextLabel: string;
    }
  | {
      type: "runSkip";
      /** Shell command awaiting run/skip approval. */
      command: string;
    }
  | {
      type: "planReview";
      task: string;
      stepCount: number;
      agentCount: number;
      execution: PlanExecution;
      modeLabel: string | null;
    };

/**
 * Outcome of an {@link ApprovalRequest}.
 *
 * @remarks
 * Shape depends on request type: booleans for file/command approvals,
 * {@link PlanDecision} for simple plan reviews, or a plan object with
 * optional edited steps when the user chooses `"edit"`.
 */
export type ApprovalResult =
  | boolean
  | PlanDecision
  | {
      type: "plan";
      decision: PlanDecision;
      /** Final step lines (may differ from the original when edited). */
      planLines: string[];
    };

/**
 * A modal input request blocking the main prompt until answered.
 *
 * @remarks
 * Rendered by {@link PromptOverlay}. Each `type` drives a different
 * sub-form and expects a matching {@link PromptResult} shape on submit.
 */
export type PromptRequest =
  | {
      type: "line";
      prompt: string;
      /** When `true`, input is masked (passwords, secrets). */
      masked?: boolean;
    }
  | {
      type: "choice";
      prompt: string;
      /** Upper bound on selectable options (1-based index returned). */
      max: number;
    }
  | {
      type: "planEdit";
      /** Initial step lines loaded into the editor. */
      initial: string[];
    }
  | {
      type: "theme";
    };

/** Response payload for a resolved {@link PromptRequest}. */
export type PromptResult = string | number | string[] | void;

/**
 * One row in Ink's {@link Static} region (banner art or frozen history).
 *
 * @remarks
 * Banner lines stay fixed at the top; history entries accumulate below
 * and do not scroll with the live {@link HistoryView} stream.
 */
export type StaticEntry =
  | {
      kind: "banner";
      key: string;
      line: string;
    }
  | {
      kind: "history";
      key: string;
      item: HistoryItem;
    };

/**
 * Props injected into {@link App} after bootstrap completes.
 *
 * @remarks
 * Passed from {@link BootstrapApp} once the RSocket connection and
 * supporting services are ready. {@link AppProvider} copies these into
 * {@link AppContextValue} for hooks and child components.
 */
export type AppProps = {
  connection: import("../connection/index.js").Connection;
  commandHandler: import("../commands/index.js").CommandHandler;
  fileProxy: import("../localFileProxy.js").LocalFileProxy;
  /** One-shot system messages shown as history on startup. */
  initialHistoryLines: string[];
  onSaveHistory: (lines: string[]) => void;
  /** Prior session commands for arrow-key recall. */
  initialInputHistory: string[];
  /** Lets {@link App} register Ink's `exit` for slash `/exit` and Ctrl+C. */
  registerExit: (fn: () => void) => void;
  /** Shared ref updated whenever in-memory input history changes. */
  onInputHistoryRef: React.MutableRefObject<string[]>;
};
