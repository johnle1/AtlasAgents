/**
 * Handler for RSocket requestStream frames (long-running work).
 */

import type {
  Cancellable,
  OnExtensionSubscriber,
  Payload,
  Requestable,
} from "@rsocket/core";

import type { Router } from "../../../routing/router.js";
import { isStreamKind } from "../../../routing/types.js";
import { isOrchestratorErrorReported } from "../../../orchestration/taskErrors.js";
import { encodeFrame, type TaskFrame } from "../../../transport/frames.js";
import type {
  AuthMiddleware,
  RequestStreamSink,
  SessionRecord,
} from "../types.js";
import { parsePasswordFromMetadata } from "../types.js";
import { noopStreamSubscriber } from "./utils.js";

/**
 * Creates a handler for a single requestStream frame.
 *
 * @remarks
 * This handler authenticates the frame, parses the JSON envelope, registers
 * an AbortController for cleanup, routes the stream to the Router, and manages
 * the frame emission lifecycle (onNext, onComplete, onError).
 *
 * @param auth - Authentication middleware
 * @param router - Request router
 * @param requesterId - Session id
 * @param record - Session record tracking AbortControllers
 * @param payload - The incoming frame
 * @param responderStream - Sink for streamed frames
 * @returns A stream handle with cancel capability
 */
export const createRequestStreamHandler =
  (auth: AuthMiddleware, router: Router) =>
  (
    requesterId: string,
    record: SessionRecord,
    payload: Payload,
    responderStream: RequestStreamSink,
  ): Requestable & Cancellable & OnExtensionSubscriber => {
    const incoming = parsePasswordFromMetadata(payload.metadata);
    const userId = auth.validate(incoming);
    if (userId === null) {
      responderStream.onError(new Error("Unauthorized"));
      return noopStreamSubscriber();
    }

    let parsed: {
      kind?: string;
      text?: string;
      name?: string;
      maxSubagents?: unknown;
      subagentModel?: string;
      subsubagentModel?: string;
      agentTemp?: number;
      subagentTemp?: number;
      debug?: boolean;
    };
    try {
      const parsedBody: unknown = JSON.parse(
        payload.data?.toString("utf-8") ?? "{}",
      );
      if (typeof parsedBody !== "object" || parsedBody === null) {
        responderStream.onError(new Error("Expected a JSON object body"));
        return noopStreamSubscriber();
      }
      parsed = parsedBody as typeof parsed;
    } catch {
      responderStream.onError(new Error("Invalid stream JSON"));
      return noopStreamSubscriber();
    }

    const streamKind = parsed.kind;
    if (typeof streamKind !== "string" || !isStreamKind(streamKind)) {
      responderStream.onError(
        new Error('Expected kind "task", "models.pull", or "explore"'),
      );
      return noopStreamSubscriber();
    }

    const abortController = new AbortController();
    record.abortControllers.add(abortController);

    const session = { userId, requesterId };
    // `false` = non-terminal frame: emit as many as needed, then signal the end
    // separately via onComplete/onError once the handler settles.
    const emit = (frame: TaskFrame): void => {
      responderStream.onNext({ data: encodeFrame(frame) }, false);
    };

    // Each stream kind expects a different payload shape. Optional fields are
    // narrowed to `undefined` when absent or the wrong type so the router only
    // ever sees valid overrides rather than raw client input.
    const streamPayload =
      streamKind === "models.pull"
        ? { name: String(parsed.name ?? "") }
        : streamKind === "explore"
          ? {}
          : {
              text: String(parsed.text ?? ""),
              maxSubagents: parsed.maxSubagents,
              subagentModel:
                typeof parsed.subagentModel === "string"
                  ? parsed.subagentModel
                  : undefined,
              subsubagentModel:
                typeof parsed.subsubagentModel === "string"
                  ? parsed.subsubagentModel
                  : undefined,
              agentTemp:
                typeof parsed.agentTemp === "number"
                  ? parsed.agentTemp
                  : undefined,
              subagentTemp:
                typeof parsed.subagentTemp === "number"
                  ? parsed.subagentTemp
                  : undefined,
              debug: parsed.debug === true ? true : undefined,
            };

    void (async () => {
      try {
        await router.routeStream(
          session,
          streamKind,
          streamPayload,
          emit,
          abortController.signal,
        );
        responderStream.onComplete();
      } catch (err) {
        // The orchestrator formats and emits its own rich error frames. Only
        // emit a fallback error frame here when it has NOT already done so, to
        // avoid showing the user two error messages for one failure.
        if (!isOrchestratorErrorReported(err)) {
          const message = err instanceof Error ? err.message : String(err);
          emit({ kind: "error", message });
        }
        responderStream.onError(
          err instanceof Error ? err : new Error(String(err)),
        );
      } finally {
        // Always release the controller so the set doesn't grow unbounded,
        // whether the stream completed, errored, or was aborted.
        record.abortControllers.delete(abortController);
      }
    })();

    return {
      request: () => {},
      cancel: () => {
        abortController.abort();
      },
      onExtension: () => {},
    } as Requestable & Cancellable & OnExtensionSubscriber;
  };
