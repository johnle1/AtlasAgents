/**
 * <Summary>
 * What it does:
 *   Defines all type definitions for the Ink-based UI system.
 *
 * How it fits in the system:
 *   Provides the TypeScript type system for the entire UI layer. This includes history items,
 *   approval requests, prompts, spinner states, agent status, and static entries. These types
 *   ensure type safety across the UI components and proper data flow between the CLI and the UI.
 *
 * Dependencies:
 *   - frames — provides shared frame and stage types for consistency.
 *
 * Dependants:
 *   - All UI components — use these types for props and state.
 *   - AppContext — uses these types for context values.
 *   - uiBridge — uses these types for bridge communication.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Defines the variant types for text history items, controlling their display style.
 *
 * Used by:
 *   - HistoryItem — uses this for text items to determine styling.
 *
 * Produced by:
 *   - History rendering functions — create items with specific variants.
 * </Summary>
 */
export type HistoryVariant =
  | "user" /** User input messages (displayed with user styling) */
  | "assistant" /** AI assistant messages (displayed with assistant styling) */
  | "system" /** System-generated messages (displayed with system styling) */
  | "error" /** Error messages (displayed with error color) */
  | "success" /** Success messages (displayed with success color) */
  | "secondary"; /** Secondary information (displayed with muted styling) */

/**
 * <Summary>
 * What it does:
 *   Defines the shape of history items that appear in the terminal output.
 *
 * How it fits in the system:
 *   History items represent different types of content that can appear in the terminal:
 *   plain text, think blocks (advisor reasoning), plans, file diffs, and styled blocks.
 *   Each kind has its own structure and rendering logic.
 *
 * Used by:
 *   - StaticEntry — wraps history items for static display.
 *   - AppContext — manages the history state.
 *   - HistoryView — renders history items to the terminal.
 *
 * Produced by:
 *   - All UI bridge functions — create history items for display.
 * </Summary>
 */
export type HistoryItem =
  | {
      /** Identifies this as a simple text history item. */
      kind: "text";

      /** The text content to display. */
      text: string;

      /** The display variant (color/styling) for the text. */
      variant?: HistoryVariant;
    }
  | {
      /** Identifies this as a think block (advisor reasoning display). */
      kind: "think";

      /** The think block content to display. */
      text: string;

      /** Whether this think block is from the advisor (vs agent). */
      advisor?: boolean;
    }
  | {
      /** Identifies this as a plan display item (execution plan with steps). */
      kind: "plan";

      /** The user task description that this plan addresses. */
      task: string;

      /** Array of plan step descriptions. */
      steps: string[];

      /** Array of potential risks or concerns. */
      risks: string[];

      /** Array of agent assignments for the plan. */
      agents: AgentPlan[];

      /** Total number of agents assigned to the plan. */
      agentCount: number;

      /** The execution mode (sequential, parallel, etc.). */
      execution: PlanExecution;

      /** Display label for the execution mode (e.g., "sequential", "parallel"). */
      modeLabel: string | null;
    }
  | {
      /** Identifies this as a file diff display item. */
      kind: "diff";

      /** The file path that the diff applies to. */
      path: string;

      /** The rendered diff content with syntax highlighting. */
      body: string;
    }
  | {
      /** Identifies this as a styled block of text lines. */
      kind: "block";

      /** Array of styled text lines to display as a cohesive block. */
      lines: string[];
    };

/**
 * <Summary>
 * What it does:
 *   Defines the display modes for the status spinner.
 *
 * Used by:
 *   - SpinnerState — uses this to determine spinner appearance.
 *   - spinnerSync — creates spinner states with specific modes.
 *
 * Produced by:
 *   - Spinner creation functions — specify the mode when creating spinners.
 * </Summary>
 */
export type SpinnerMode =
  | "thinking" /** Thinking indicator (braille pattern for active processing) */
  | "working"; /** Working indicator (circle pulse for file operations) */

/**
 * <Summary>
 * What it does:
 *   Defines the state of the bottom-line status spinner.
 *
 * Used by:
 *   - StatusSpinner — uses this to render the spinner.
 *   - spinnerSync — creates and manages spinner states.
 *
 * Produced by:
 *   - spinnerSync — creates spinner states for different activities.
 * </Summary>
 */
export type SpinnerState = {
  /** Indicates whether the spinner is currently active and visible. */
  active: true;

  /** The label text to display next to the spinner (e.g., "Advisor", "Agent"). */
  label: string;

  /** The display mode determining the spinner's appearance (thinking vs working). */
  mode: SpinnerMode;
};

/**
 * <Summary>
 * What it does:
 *   Defines the possible user decisions for plan approval.
 *
 * Used by:
 *   - ApprovalRequest — uses this for plan review requests.
 *   - ApprovalResult — uses this for plan approval responses.
 *
 * Produced by:
 *   - User approval dialogs — return the user's decision.
 * </Summary>
 */
export type PlanDecision =
  | "implement" /** User chose to implement the plan as-is */
  | "skip" /** User chose to skip this plan */
  | "edit"; /** User chose to edit the plan before implementation */

/**
 * <Summary>
 * What it does:
 *   Defines the state of an agent status indicator.
 *
 * Used by:
 *   - AgentStatusView — renders agent status indicators.
 *   - uiBridge — manages agent status state.
 *
 * Produced by:
 *   - Status frame handlers — create agent status updates.
 * </Summary>
 */
export type AgentStatusState = {
  /** The unique identifier for the agent (number) or "advisor" for the advisor. */
  id: number | "advisor";

  /** The display label for the agent (e.g., "Agent 1", "Advisor"). */
  label: string;

  /** The icon representing the agent's current state (e.g., "◌", "✓", "⚠"). */
  icon: StatusIcon;

  /** The status message describing what the agent is doing. */
  message: string;

  /** The current processing stage of the agent (optional). */
  stage?: AgentStage | AdvisorStage;
};

/**
 * <Summary>
 * What it does:
 *   Defines the state of a pending task in the queue.
 *
 * Used by:
 *   - Queue display components — render pending task status.
 *
 * Produced by:
 *   - Task queue management — creates pending task state updates.
 * </Summary>
 */
export type PendingTaskState = {
  /** The unique identifier for the pending task. */
  id: number;

  /** The task description or name. */
  text: string;

  /** Whether the task is blocked (unable to execute due to dependencies). */
  blocked: boolean;
};

/**
 * <Summary>
 * What it does:
 *   Defines the state of an agent's task.
 *
 * Used by:
 *   - Agent display components — render agent task information.
 *   - Agent board components — display tasks within agent boards.
 *
 * Produced by:
 *   - Task execution system — creates task state updates.
 * </Summary>
 */
export type AgentTaskState = {
  /** The unique identifier for the task. */
  id: number;

  /** The task description or name. */
  text: string;

  /** The lifecycle state of the task (waiting, running, blocked, complete). */
  state: TaskLifecycleState;
};

/**
 * <Summary>
 * What it does:
 *   Defines the state of an agent's task board (collection of assigned tasks).
 *
 * Used by:
 *   - Agent board display components — render agent task boards.
 *   - Status frame handlers — update agent boards when assignments change.
 *
 * Produced by:
 *   - Status frame handlers — create agent board state updates.
 * </Summary>
 */
export type AgentBoardState = {
  /** The unique identifier for the agent. */
  id: number;

  /** The display label for the agent (e.g., "Agent 1"). */
  label: string;

  /** Array of tasks assigned to this agent. */
  tasks: AgentTaskState[];

  /** Current activity information (what the agent is currently doing). */
  activity?: { stage: AgentStage; message: string } | null;
};

/**
 * <Summary>
 * What it does:
 *   Defines the shape of user approval requests.
 *
 * How it fits in the system:
 *   When the CLI requires user approval (for plans, file operations, or commands), it creates
 *   an approval request of the appropriate type. The UI displays the request and collects the user's
 *   response, which is returned as an ApprovalResult.
 *
 * Used by:
 *   - ApprovalMenu — renders approval requests.
 *   - uiBridge — manages approval request state.
 *   - taskStream — creates approval requests for various operations.
 *
 * Produced by:
 *   - taskStream — creates approval requests for plans, files, and commands.
 * </Summary>
 */
export type ApprovalRequest =
  | {
      /** Identifies this as a file operation approval request. */
      type: "keepUndo";

      /** Context label describing what the operation does (e.g., "Apply changes to README.md"). */
      contextLabel: string;
    }
  | {
      /** Identifies this as a command execution approval request. */
      type: "runSkip";

      /** The shell command that requires approval. */
      command: string;
    }
  | {
      /** Identifies this as a plan review approval request. */
      type: "planReview";

      /** The user task that this plan addresses. */
      task: string;

      /** The number of steps in the plan. */
      stepCount: number;

      /** The number of agents assigned to the plan. */
      agentCount: number;

      /** The execution mode (sequential, parallel, etc.). */
      execution: PlanExecution;

      /** Display label for the execution mode. */
      modeLabel: string | null;
    };

/**
 * <Summary>
 * What it does:
 *   Defines the possible results of user approval requests.
 *
 * How it fits in the system:
 *   Different approval types return different result types. File and command approvals return
 *   boolean (approved/rejected), while plan approvals return a PlanDecision. Plan approvals can also
 *   include edited plan steps when the user chooses to edit.
 *
 * Used by:
 *   - taskStream — processes approval results to continue execution.
 *   - ApprovalMenu — returns user's approval decision.
 *
 * Produced by:
 *   - User approval dialogs — return the user's approval decision.
 * </Summary>
 */
export type ApprovalResult =
  | boolean /** Boolean approval result for file/command requests (true = approved) */
  | PlanDecision /** Plan decision for plan reviews (implement/skip/edit) */
  | {
      /** Indicates this is a plan result with potentially edited steps. */
      type: "plan";

      /** The user's decision about the plan. */
      decision: PlanDecision;

      /** The plan steps (possibly edited by the user if decision was "edit"). */
      planLines: string[];
    };

/**
 * <Summary>
 * What it does:
 *   Defines the shape of user input prompt requests.
 *
 * How it fits in the system:
 *   When the CLI needs user input (for passwords, file paths, choices, or plan editing), it creates
 *   a prompt request of the appropriate type. The UI displays the prompt and collects the user's
 *   response, which is returned as a PromptResult.
 *
 * Used by:
 *   - PromptOverlay — renders prompt requests.
 *   - uiBridge — manages prompt request state.
 *   - promptPort — uses these types for prompt operations.
 *
 * Produced by:
 *   - taskStream — creates prompt requests for plan editing.
 *   - Command handlers — create prompt requests for various inputs.
 * </Summary>
 */
export type PromptRequest =
  | {
      /** Identifies this as a line/text input prompt request. */
      type: "line";

      /** The question or prompt text to display to the user. */
      prompt: string;

      /** Whether the input should be masked (for passwords and sensitive data). */
      masked?: boolean;
    }
  | {
      /** Identifies this as a choice selection prompt request. */
      type: "choice";

      /** The question or prompt text to display to the user. */
      prompt: string;

      /** The maximum number of choices available. */
      max: number;
    }
  | {
      /** Identifies this as a plan editing prompt request. */
      type: "planEdit";

      /** The initial plan steps to display for editing. */
      initial: string[];
    }
  | {
      /** Identifies this as a theme selection prompt request. */
      type: "theme";
    };

/**
 * <Summary>
 * What it does:
 *   Defines the possible results of user prompt responses.
 *
 * Used by:
 *   - promptPort — returns prompt results of this type.
 *   - taskStream — processes prompt results for plan editing.
 *
 * Produced by:
 *   - User prompt dialogs — return the user's input.
 * </Summary>
 */
export type PromptResult =
  | string /** Text input result (from line prompts) */
  | number /** Number input result (from choice prompts) */
  | string[] /** Array input result (from plan editing) */
  | void; /** No result (from theme selection and similar actions) */

/**
 * <Summary>
 * What it does:
 *   Entry types for the Static component in the Ink UI.
 *
 * How it fits in the system:
 *   Used to render either banner lines (ASCII art) or history items in the static output area.
 *   The Static component in Ink displays fixed-position content that doesn't scroll with the rest
 *   of the UI. This includes the application banner and all accumulated history.
 *
 * Dependencies:
 *   - HistoryItem — wraps history items for static display.
 *
 * Used by:
 *   - AppContext — creates static entries from banner and history.
 *   - AppContent — renders static entries using the Static component.
 *
 * Produced by:
 *   - AppContext — combines banner and history into static entries.
 * </Summary>
 */
export type StaticEntry =
  | {
      /** Identifies this as a banner entry (ASCII art application header). */
      kind: "banner";

      /** Unique key for React rendering. */
      key: string;

      /** The banner line text to display. */
      line: string;
    }
  | {
      /** Identifies this as a history entry (accumulated terminal output). */
      kind: "history";

      /** Unique key for React rendering. */
      key: string;

      /** The history item to display (text, think block, plan, diff, or block). */
      item: HistoryItem;
    };

/**
 * <Summary>
 * What it does:
 *   Props for the main App component.
 *
 * How it fits in the system:
 *   Contains all the dependencies and configuration needed for the CLI application. These are
 *   injected at the application entry point and passed down through the component hierarchy via
 *   the AppContext.
 *
 * Dependencies:
 *   - Connection — provides RSocket communication with the server.
 *   - CommandHandler — provides CLI command processing.
 *   - LocalFileProxy — provides file system operations.
 *
 * Used by:
 *   - App — receives these props at application startup.
 *   - AppContext — uses these props for application functionality.
 *   - AppProvider — passes these to context consumers.
 *
 * Produced by:
 *   - Application entry point — creates and passes these props.
 * </Summary>
 */
export type AppProps = {
  /** The RSocket connection for server communication. */
  connection: import("../connection/index.js").Connection;

  /** The command handler for processing slash commands. */
  commandHandler: import("../commands/index.js").CommandHandler;

  /** The file proxy for local file system operations. */
  fileProxy: import("../localFileProxy.js").LocalFileProxy;

  /** Initial history lines to restore from previous sessions. */
  initialHistoryLines: string[];

  /** Callback to save history before application exit. */
  onSaveHistory: (lines: string[]) => void;

  /** Initial input command history for command navigation. */
  initialInputHistory: string[];

  /** Function to register the application exit handler. */
  registerExit: (fn: () => void) => void;

  /** Mutable ref to access input history from external code. */
  onInputHistoryRef: React.MutableRefObject<string[]>;
};
