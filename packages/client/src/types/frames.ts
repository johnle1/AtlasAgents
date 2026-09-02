/**
 * Task stream frames from the server.
 *
 * @remarks
 * This module re-exports shared type definitions from @atlasagents/shared that
 * define the structure of frames sent by the server during task execution. These
 * types are used throughout the client to decode and handle server responses.
 *
 * **Main types:**
 * - `TaskFrame` — Individual frames in the task execution stream
 * - `SubagentBoardSnapshot` — Current state of agent boards
 * - `SubagentPlan` — Plan information from the agent
 * - `PullProgress` — Progress updates for model pulling
 * - Other shared types for agent status and lifecycle
 *
 * Also includes client-specific types like `InstalledModel` for displaying
 * model information from the server.
 */

/**
 * Structure of an installed model on the server.
 *
 * @remarks
 * Alias of `@atlasagents/shared`'s `ModelSummary` — the same wire shape the
 * server's `OllamaModelSummary` aliases, since `models.list` round-trips it
 * as-is with no transformation.
 *
 * Used by:
 * - `Connection.fetchModelsDetailed` — returns objects of this shape
 * - `renderer.printInstalledModels` — displays model details to user
 *
 * @example
 * ```ts
 * const model: InstalledModel = {
 *   name: "gemma3:27b",
 *   size: 16000000000,
 *   details: {
 *     family: "Gemma",
 *     parameter_size: "27B",
 *     quantization_level: "Q4_K_M",
 *     format: "GGUF"
 *   }
 * };
 * ```
 */
export type { ModelSummary as InstalledModel } from "@atlasagents/shared";

// Re-export shared types from @atlasagents/shared for use in the client
export type {
  SubagentBoardSnapshot,
  SubagentPlan,
  SubagentStage,
  SubagentStatusSource,
  SubagentTaskSnapshot,
  AgentStage,
  PlanExecution,
  PlanStep,
  PlanStepStatus,
  PullProgress,
  QueuedTaskSnapshot,
  StatusIcon,
  TaskFrame,
  TaskLifecycleState,
} from "@atlasagents/shared";

// Re-export frame decoder function from @atlasagents/shared
export { decodeFrame } from "@atlasagents/shared";
