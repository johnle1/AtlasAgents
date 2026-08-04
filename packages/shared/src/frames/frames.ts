/**
 * Task frames — the wire format for streaming server updates to the client.
 */

export type PullProgress = {
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
  digest?: string;
};

export type SubagentPlan = {
  id: number;
  label: string;
  steps: string[];
  dependsOn: number[];
};

export type PlanExecution = "parallel" | "sequential" | "mixed";

export type SubagentStatusSource = { agentId: number; agentLabel: string };

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

export type AgentStage =
  | "understanding"
  | "reading-context"
  | "drafting"
  | "verifying"
  | "revising"
  | "ready"
  | "combining";

export type StatusIcon = "◌" | "✓" | "⚠";

export type QueuedTaskSnapshot = {
  id: number;
  text: string;
  blocked: boolean;
};

export type TaskLifecycleState =
  | "waiting"
  | "blocked"
  | "running"
  | "complete"
  | "failed";

export type SubagentTaskSnapshot = {
  id: number;
  text: string;
  state: TaskLifecycleState;
};

export type SubagentBoardSnapshot = {
  id: number;
  label: string;
  tasks: SubagentTaskSnapshot[];
};

export type TaskFrame =
  | { kind: "token"; text: string }
  | { kind: "think-start"; id: string; agent?: boolean; source?: SubagentStatusSource }
  | { kind: "think-delta"; id: string; text: string }
  | { kind: "think-end"; id: string; text?: string }
  | {
      kind: "confirm-plan";
      id: string;
      task: string;
      steps: string[];
      risks: string[];
      agents: SubagentPlan[];
      agentCount: number;
      execution: PlanExecution;
      modeLabel: string | null;
    }
  | {
      kind: "status";
      source: SubagentStatusSource | "agent";
      stage: SubagentStage | AgentStage;
      icon: StatusIcon;
      message: string;
      revision?: { current: number; max: number };
      queue?: QueuedTaskSnapshot[];
      subagentBoards?: SubagentBoardSnapshot[];
      activity?: { stage: SubagentStage; message: string };
    }
  | { kind: "progress"; data: PullProgress }
  | { kind: "error"; message: string }
  | { kind: "warning"; message: string }
  | { kind: "done" };

export const encodeFrame = (frame: TaskFrame): Buffer =>
  Buffer.from(JSON.stringify(frame), "utf-8");

export const decodeFrame = (data: Buffer | undefined): TaskFrame | null => {
  if (!data || data.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(data.toString("utf-8")) as TaskFrame;
    if (parsed && typeof parsed === "object" && "kind" in parsed) {
      return parsed;
    }
  } catch {
    const text = data.toString("utf-8");
    if (text.length > 0) {
      return { kind: "token", text };
    }
  }
  return null;
};