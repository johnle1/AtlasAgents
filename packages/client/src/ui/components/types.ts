/**
 * Prop contracts for components in `ui/components/`.
 *
 * @remarks
 * Centralizes the `Props` types that were previously declared inline in
 * each component file so they can be reused and reviewed in one place.
 */
import type { ConnectionStatus } from "../../connection/index.js";
import type {
  SubagentBoardState,
  SubagentStatusState,
  ApprovalRequest,
  PlanDecision,
  SpinnerState,
} from "../types.js";

/** Props for {@link SubagentStatusBox}; one status row per agent or subagent. */
export type SubagentStatusBoxProps = SubagentStatusState;

/** Props for {@link SubagentTaskBoard}. */
export type SubagentTaskBoardProps = {
  /** The board model representing an agent and its checklist of tasks. */
  board: SubagentBoardState;
};

/**
 * Layout configuration for a selectable item in {@link ApprovalMenu}.
 *
 * @typeparam T - The underlying decision type mapped to this menu option.
 */
export type ApprovalMenuOption<T> = {
  /** The text shown in the interactive CLI list. */
  label: string;
  /** The resolved choice value returned when this option is activated. */
  value: T;
  /** Optional theme color override for visual emphasis (e.g. green for positive actions). */
  color?: string;
};

/** Decision value accepted by {@link ApprovalMenu} options. */
export type ApprovalMenuValue = boolean | PlanDecision;

export type { ApprovalRequest };

/** Props for {@link Banner}. */
export type BannerProps = {
  /** The model identifier assigned to the orchestrating agent role. */
  agentModel: string;
  /** The model identifier assigned to background subagents. */
  subagentModel?: string;
  /** Semantic version string of the current LoopyCode CLI application bundle. */
  version: string;
};

/** Props for {@link ConnectionStatusLine}. */
export type ConnectionStatusLineProps = {
  /** The current telemetry state of the connection between the client and server. */
  status: ConnectionStatus;
};

/** Props for {@link StatusSpinner}. */
export type StatusSpinnerProps = {
  /** The current active execution task status of the background loader. */
  state: SpinnerState | null;
};
