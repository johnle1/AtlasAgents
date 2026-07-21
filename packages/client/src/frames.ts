/**
 * Task stream frames from the server.
 *
 * @remarks
 * This module re-exports shared type definitions from @loopycode/shared that
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
 * This type represents model information returned by the server's `/models`
 * endpoint. It includes basic metadata like name and size, plus optional
 * detailed information about the model's architecture, parameters, and format.
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
export type InstalledModel = {
  /** Model name e.g., "gemma3:27b" or "llama3:8b". */
  name: string;

  /** Model size in bytes (optional, may not be available). */
  size?: number;

  /** Model digest/hash for verification (optional). */
  digest?: string;

  /** Last modification timestamp (optional ISO format). */
  modified_at?: string;

  /** Detailed model metadata (optional). */
  details?: {
    /** Model family e.g., "Gemma", "Llama". */
    family?: string;

    /** Parameter size e.g., "27B", "8B". */
    parameter_size?: string;

    /** Quantization level e.g., "Q4_K_M", "F16". */
    quantization_level?: string;

    /** Model format e.g., "GGUF", "Safetensors". */
    format?: string;
  };
};

// Re-export shared types from @loopycode/shared for use in the client
export type {
  SubagentBoardSnapshot,
  SubagentPlan,
  SubagentStage,
  SubagentStatusSource,
  SubagentTaskSnapshot,
  AgentStage,
  PlanExecution,
  PullProgress,
  QueuedTaskSnapshot,
  StatusIcon,
  TaskFrame,
  TaskLifecycleState,
} from "@loopycode/shared";

// Re-export frame decoder function from @loopycode/shared
export { decodeFrame } from "@loopycode/shared";
