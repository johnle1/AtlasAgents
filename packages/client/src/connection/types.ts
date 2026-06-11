import {
  decodeFrame,
  type InstalledModel,
  type PullProgress,
  type TaskFrame,
} from "../frames.js";

export type { PullProgress, TaskFrame } from "../frames.js";
export type { InstalledModel } from "../frames.js";

/**
 * <Summary>
 * What it does:
 *   Represents one topic in the user's server-side preference store.
 *
 * Used by:
 *   - Connection.getMemory — returned in the array of memory entries.
 *   - renderer.printMemory — displays each entry to the user.
 *
 * Produced by:
 *   - Server /memory endpoint — fetched via requestResponse.
 * </Summary>
 */
export interface MemoryEntry {
  /** Topic name e.g. "coding-style" or "project-structure". */
  topic: string;

  /** Array of preference rules the server learned for this topic. */
  rules: string[];
}

/**
 * <Summary>
 * What it does:
 *   Represents one skill file to be synced to the server.
 *
 * Used by:
 *   - Connection.syncSkills — accepts an array of these in the request body.
 *   - skills.readAllSkills — produces an array of these from local .md files.
 *
 * Produced by:
 *   - skills.readAllSkills — reads ~/.agent-cli/skills/*.md into this shape.
 * </Summary>
 */
export interface SkillPayload {
  /** Skill file basename without extension e.g. "coding". */
  name: string;

  /** Full markdown content of the skill file. */
  content: string;
}

/**
 * <Summary>
 * What it does:
 *   Describes the four possible states of the RSocket TCP connection.
 *
 * Used by:
 *   - Connection — tracks its internal state and emits to listeners.
 *   - renderer.printConnectionStatus — maps each state to a display label.
 *   - index.ts — subscribes to print status changes in the CLI.
 *
 * Produced by:
 *   - Connection.emitStatus — sets the current value.
 * </Summary>
 */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/**
 * <Summary>
 * What it does:
 *   Callback signature for connection status change notifications.
 *
 * Used by:
 *   - Connection.onConnectionStatus — registers listeners of this type.
 *   - ConnectionStatusLine — renders status label updates in the Ink UI.
 *
 * Produced by:
 *   - Callers pass a function matching this signature to onConnectionStatus.
 * </Summary>
 */
export type StatusListener = (status: ConnectionStatus) => void;

/**
 * <Summary>
 * What it does:
 *   Describes the JSON envelope the server sends back for requestResponse commands.
 *
 * Used by:
 *   - Connection.sendCommand — parses the server response into this shape.
 *
 * Produced by:
 *   - Part 6 server — every command response uses this envelope.
 * </Summary>
 */
export type CommandResponseEnvelope = {
  /** Whether the command succeeded. */
  ok: boolean;

  /** Result payload on success, shape depends on command type. */
  data?: unknown;

  /** Human-readable error message on failure. */
  error?: string;
};

/**
 * <Summary>
 * What it does:
 *   Describes the JSON body sent as requestStream data for task execution.
 *
 * Used by:
 *   - Connection.sendTask — builds this object and serialises it to Buffer.
 *
 * Produced by:
 *   - Connection.sendTask — constructed from user input and config settings.
 * </Summary>
 */
export type TaskStreamPayload = {
  /** Discriminator so the server knows this is a task, not a command. */
  kind: "task";

  /** The user's task description. */
  text: string;

  /** Ollama model name for the advisor role e.g. "gemma3:27b". */
  advisorModel: string;

  /** Ollama model name for the agent role e.g. "gemma3:4b". */
  agentModel: string;

  /** Sampling temperature for advisor (0.0–1.0). */
  advisorTemp: number;

  /** Sampling temperature for agent (0.0–1.0). */
  agentTemp: number;
};

/**
 * <Summary>
 * What it does:
 *   Describes the JSON body sent as requestResponse data for non-task commands.
 *
 * Used by:
 *   - Connection.sendCommand — builds this envelope before sending.
 *
 * Produced by:
 *   - Connection.sendCommand — constructed from the type string and caller payload.
 * </Summary>
 */
export type CommandRequestPayload = {
  /** Discriminator so the server knows this is a command, not a task. */
  kind: "command";

  /** Route string e.g. "models.list", "memory.get", "skills.sync". */
  type: string;

  /** Arbitrary JSON payload specific to the command type. */
  payload: unknown;
};
