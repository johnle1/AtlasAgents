/**
 * Task stream frames from the server (JSON per RSocket payload).
 *
 * This module re-exports shared type definitions from @loopycode/shared
 * that define the structure of frames sent by the server during task execution.
 * These types are used throughout the client to decode and handle server responses.
 *
 * The main types include:
 * - TaskFrame: Individual frames in the task execution stream
 * - AgentBoardSnapshot: Current state of agent boards
 * - AgentPlan: Plan information from the advisor
 * - PullProgress: Progress updates for model pulling
 * - And other shared types for agent status and lifecycle
 */

/**
 * <Summary>
 * What it does:
 *   Defines the structure of an installed model on the server.
 *
 * How it fits in the system:
 *   Used to display model information in the CLI when listing installed models.
 *
 * Used by:
 *   - Connection.fetchModelsDetailed — returns objects of this shape.
 *   - renderer.printInstalledModels — displays model details to user.
 *
 * Produced by:
 *   - Server /models endpoint — fetched via requestResponse command.
 * </Summary>
 */
export type InstalledModel = {
  /** Model name e.g. "gemma3:27b" or "llama3:8b". */
  name: string;

  /** Model size in bytes (optional, may not be available). */
  size?: number;

  /** Model digest/hash for verification (optional). */
  digest?: string;

  /** Last modification timestamp (optional ISO format). */
  modified_at?: string;

  /** Detailed model metadata (optional). */
  details?: {
    /** Model family e.g. "Gemma", "Llama". */
    family?: string;

    /** Parameter size e.g. "27B", "8B". */
    parameter_size?: string;

    /** Quantization level e.g. "Q4_K_M", "F16". */
    quantization_level?: string;

    /** Model format e.g. "GGUF", "Safetensors". */
    format?: string;
  };
};

// Re-export shared types from @loopycode/shared for use in the client
export type {
  AgentBoardSnapshot,
  AgentPlan,
  AgentStage,
  AgentStatusSource,
  AgentTaskSnapshot,
  AdvisorStage,
  PlanExecution,
  PullProgress,
  QueuedTaskSnapshot,
  StatusIcon,
  TaskFrame,
  TaskLifecycleState,
} from "@loopycode/shared";

// Re-export frame decoder function from @loopycode/shared
export { decodeFrame } from "@loopycode/shared";
