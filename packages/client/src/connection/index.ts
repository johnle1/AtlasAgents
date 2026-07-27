/**
 * Public barrel for the client RSocket connection module.
 *
 * @remarks
 * Prefer importing from this file rather than deep paths so internal splits
 * (`lifecycle`, `commands`, `streaming`, …) can move without breaking callers.
 *
 * Typical surface:
 * - {@link Connection} — single TCP session facade (connect, commands, streams)
 * - Status / payload types — {@link ConnectionStatus}, {@link StatusListener},
 *   {@link CommandRequestPayload}, {@link SkillPayload}, …
 * - Stream/frame aliases — {@link TaskFrame}, {@link PullProgress}
 *
 * @example
 * ```ts
 * import { Connection } from "./connection/index.js";
 * import type { ConnectionStatus } from "./connection/index.js";
 *
 * const connection = new Connection(config);
 * connection.setFileProxy(fileProxy);
 * connection.onConnectionStatus((status: ConnectionStatus) => {
 *   console.log(status);
 * });
 * await connection.connect();
 * ```
 */

export type {
  CommandResponseEnvelope,
  CommandRequestPayload,
  ConnectionStatus,
  MemoryEntry,
  SkillPayload,
  StatusListener,
  TaskStreamPayload,
} from "./types.js";

export { Connection } from "./connection.js";

export type { PullProgress, TaskFrame } from "../types/frames.js";
