/**
 * <Summary>
 * What it does:
 *   Public barrel for the connection module — re-exports the Connection class,
 *   wire-contract types, and frame types used by the rest of the client.
 *
 * How it fits in the system:
 *   Single import path (`connection/index.js`) for all server transport types
 *   and the Connection facade. Keeps internal split files private.
 * </Summary>
 */

// Re-export types
export type {
  CommandResponseEnvelope,
  CommandRequestPayload,
  ConnectionStatus,
  MemoryEntry,
  SkillPayload,
  StatusListener,
  TaskStreamPayload,
} from "./types.js";

// Re-export Connection class
export { Connection } from "./connection.js";

// Re-export types from frames that were originally exported from connection.ts
export type { PullProgress, TaskFrame } from "../frames.js";
