/**
 * RSocket `requestStream` helpers for tasks and long-running server operations.
 *
 * @remarks
 * Implements credit-based backpressure (`STREAM_WINDOW`), sequential frame
 * handling (so async `onFrame` callbacks never race), and thin wrappers that
 * build JSON bodies for task execution, model pulls, and explore streams.
 * {@link Connection.sendTask} / {@link Connection.sendStream} call these after
 * waiting for a live socket.
 */

import type { Payload, RSocket } from "@rsocket/core";
import type { TaskApprovalMode, TaskStreamPayload } from "@loopycode/shared";
import type { TaskFrame } from "../types/frames.js";
import { decodeFrame } from "../types/frames.js";
import type { Config } from "../config/index.js";

/**
 * Initial / refill credit window for RSocket stream backpressure.
 *
 * @remarks
 * The client starts by requesting this many items. When remaining credit drops
 * below half the window, it requests another full window so the pipeline stays
 * fed without buffering unbounded frames in memory. `64` is a conventional
 * balance of throughput vs. peak buffered payloads for CLI UIs.
 *
 * @defaultValue `64`
 */
export const STREAM_WINDOW = 64;

/**
 * Handle for an in-flight RSocket requestStream.
 *
 * @remarks
 * `done` settles when the server completes, errors, or the caller invokes
 * {@link StreamHandle.cancel}. A user-initiated cancel resolves `done`
 * successfully — cancellation is not an error, so UI catch paths must not
 * print a phantom failure after "Task cancelled".
 */
export type StreamHandle = {
  /** Settles when the stream ends (success, error, or user cancel). */
  done: Promise<void>;
  /**
   * Sends RSocket CANCEL and resolves {@link StreamHandle.done} as success.
   * Safe to call more than once; later calls are no-ops.
   */
  cancel: () => void;
};

/**
 * Low-level `requestStream` with decode, callbacks, credit refill, and cancel.
 *
 * @remarks
 * - Decodes each payload via {@link decodeFrame}; unknown / empty payloads are skipped.
 * - Token frames optionally fan out to `onToken` **before** `onFrame` so the UI
 *   can paint streaming text without waiting on heavier frame handlers.
 * - Frames are serialized on a Promise chain: even if `onFrame` is async, later
 *   frames wait — preserving server order for task state machines.
 * - Stream end is signaled by `onNext(..., isComplete)` and/or `onComplete`;
 *   both wait for the frame chain to drain before resolving.
 * - {@link StreamHandle.cancel} sends RSocket CANCEL and resolves `done`
 *   without rejecting, so a cancelled task is not treated as a failure.
 *
 * @param rsocket - Live RSocket connection.
 * @param body - JSON-serializable request body (task / pull / explore).
 * @param metadata - Auth metadata Buffer.
 * @param onFrame - Invoked for every successfully decoded {@link TaskFrame}.
 * @param onToken - Optional incremental token text for streaming display.
 * @returns A {@link StreamHandle} whose `done` promise settles when the stream
 *   ends. Rejects `done` when RSocket reports `onError` (and the caller did
 *   not cancel) or an `onFrame` / decode path rejects.
 *
 * @example
 * ```ts
 * const { done, cancel } = streamRequest(
 *   rsocket,
 *   { kind: "explore" },
 *   authMetadata(config),
 *   async (frame) => {
 *     console.log(frame.kind);
 *   },
 * );
 * // later: cancel();
 * await done;
 * ```
 */
export const streamRequest = (
  rsocket: RSocket,
  body: Record<string, unknown>,
  metadata: Buffer,
  onFrame: (frame: TaskFrame) => void | Promise<void>,
  onToken?: (token: string) => void,
): StreamHandle => {
  const dataBuf = Buffer.from(JSON.stringify(body), "utf-8");
  const payload: Payload = {
    data: dataBuf,
    metadata,
  };

  let requesterCancel: (() => void) | undefined;

  const done = new Promise<void>((resolve, reject) => {
    let settled = false;
    // Local credit accounting mirrors what we last requested from the peer.
    let pendingBudget = STREAM_WINDOW;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    // Serialize frame handling so async onFrame work cannot reorder task events.
    let frameChain = Promise.resolve();

    const requester = rsocket.requestStream(payload, STREAM_WINDOW, {
      onError: (e: Error) => finish(e),

      onNext: (framePayload: Payload, isComplete: boolean) => {
        frameChain = frameChain
          .then(async () => {
            const frame = decodeFrame(framePayload.data ?? undefined);
            if (frame) {
              // Tokens first: UI can stream glyphs while heavier handlers run.
              if (frame.kind === "token" && onToken) {
                onToken(frame.text);
              }
              await onFrame(frame);
            }
          })
          .catch((err: unknown) =>
            finish(err instanceof Error ? err : new Error(String(err))),
          );

        pendingBudget--;

        // Refill when half consumed so the sender rarely stalls on credit=0.
        if (pendingBudget < STREAM_WINDOW / 2) {
          requester.request(STREAM_WINDOW);
          pendingBudget += STREAM_WINDOW;
        }

        if (isComplete) {
          // Drain in-flight handlers before resolving the outer Promise.
          void frameChain.then(() => finish());
        }
      },

      onComplete: () => {
        void frameChain.then(() => finish());
      },

      onExtension: () => {},
    });

    requesterCancel = () => {
      requester.cancel?.();
      finish();
    };
  });

  return {
    done,
    cancel: () => {
      requesterCancel?.();
    },
  };
};

/**
 * Streams a user task using config models, temperatures, and agent cap.
 *
 * @remarks
 * Builds the task request body (`kind: "task"`) from `config`, overriding
 * `maxSubagents` when the caller passes an explicit value (otherwise
 * `config.subagentCap`). Delegates protocol work to {@link streamRequest}.
 *
 * @param task - User-facing task description.
 * @param config - Provides models, temps, and default `subagentCap`.
 * @param metadata - Auth metadata Buffer.
 * @param rsocket - Live RSocket connection.
 * @param onFrame - Receives each decoded task frame.
 * @param onToken - Optional streaming token sink for the CLI.
 * @param maxSubagents - Optional concurrency hint (`1`, `2`, `"max"`, or a number).
 * @returns A {@link StreamHandle} for the task stream.
 * @throws {@link Error} Propagates stream / handler failures from {@link streamRequest}.
 *
 * @example
 * ```ts
 * const { done, cancel } = sendTask(
 *   "Fix the flaky reconnect test",
 *   config,
 *   authMetadata(config),
 *   rsocket,
 *   (frame) => console.log(frame.kind),
 *   (token) => process.stdout.write(token),
 *   2,
 * );
 * await done;
 * ```
 */
export const sendTask = (
  task: string,
  config: Config,
  metadata: Buffer,
  rsocket: RSocket,
  onFrame: (frame: TaskFrame) => void | Promise<void>,
  onToken?: (token: string) => void,
  maxSubagents?: 1 | 2 | "max" | number,
  approvalMode?: TaskApprovalMode,
): StreamHandle => {
  const body: TaskStreamPayload = {
    kind: "task",
    text: task,
    maxSubagents: maxSubagents ?? config.subagentCap,
    subagentModel: config.subagentModel,
    subsubagentModel: config.subsubagentModel,
    agentProvider: config.agentProvider,
    subagentProvider: config.subagentProvider,
    agentTemp: config.agentTemp,
    subagentTemp: config.subagentTemp,
    approvalMode,
  };

  return streamRequest(rsocket, body, metadata, onFrame, onToken);
};

/**
 * Streams a long-running server operation (model pull or explore).
 *
 * @remarks
 * Discriminated `opts.kind` selects the JSON body shape. Model pulls send
 * `{ kind: "models.pull", name }`; explore sends `{ kind: "explore" }`. Progress
 * and results arrive as {@link TaskFrame}s on `opts.onFrame`.
 *
 * @param opts - Operation kind, payload, and frame callback.
 * @param metadata - Auth metadata Buffer.
 * @param rsocket - Live RSocket connection.
 * @returns A {@link StreamHandle} for the operation stream.
 * @throws {@link Error} Propagates stream / handler failures from {@link streamRequest}.
 *
 * @example
 * ```ts
 * const { done } = sendStream(
 *   {
 *     kind: "models.pull",
 *     payload: { name: "gemma3:27b" },
 *     onFrame: (frame) => console.log(frame),
 *   },
 *   authMetadata(config),
 *   rsocket,
 * );
 * await done;
 * ```
 */
export const sendStream = (
  opts:
    | {
        kind: "models.pull";
        payload: { name: string };
        onFrame: (frame: TaskFrame) => void | Promise<void>;
      }
    | {
        kind: "explore";
        payload?: Record<string, never>;
        onFrame: (frame: TaskFrame) => void | Promise<void>;
      },
  metadata: Buffer,
  rsocket: RSocket,
): StreamHandle => {
  // Flatten pull payload so the server sees `name` at the top level of the body.
  const body =
    opts.kind === "models.pull"
      ? { kind: opts.kind, name: opts.payload.name }
      : { kind: "explore" };

  return streamRequest(rsocket, body, metadata, opts.onFrame);
};
