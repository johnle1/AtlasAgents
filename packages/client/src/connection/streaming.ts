import type { Payload, RSocket } from "@rsocket/core";
import type { TaskFrame } from "../frames.js";
import { decodeFrame } from "../frames.js";
import type { Config } from "../config.js";
import type { TaskStreamPayload } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Number of stream items requested at a time for RSocket backpressure control.
 *
 * Used by:
 *   - streamRequest — initial budget and refill threshold for requestStream.
 *
 * Produced by:
 *   - Module constant — fixed at 64 per RSocket best practice.
 * </Summary>
 */
export const STREAM_WINDOW = 64;

/**
 * <Summary>
 * What it does:
 *   Sends a streaming request to the server via RSocket requestStream and
 *   dispatches TaskFrames to callbacks with backpressure control.
 *
 * How it does it (step by step):
 *   1. Serialises the request body to a UTF-8 JSON Buffer.
 *   2. Builds the RSocket Payload with data and password metadata.
 *   3. Creates a Promise wrapper for async control.
 *   4. Initializes settlement guard to prevent double-resolution.
 *   5. Initializes backpressure budget to STREAM_WINDOW (64).
 *   6. Defines completion handler to safely finalize the promise.
 *   7. Initializes frame processing chain for sequential async callbacks.
 *   8. Calls rsocket.requestStream with initial budget of STREAM_WINDOW.
 *   9. In onError: finishes the promise with the error.
 *   10. In onNext: decodes frame, calls onToken if token frame, calls onFrame.
 *   11. Decrements budget; requests more when below half (backpressure).
 *   12. If isComplete on onNext: waits for frame chain, then completes.
 *   13. In onComplete: waits for frame chain to finish, then completes.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Record<string, unknown>} body — The request body to send as JSON.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *   @param {(frame: TaskFrame) => void | Promise<void>} onFrame — Callback
 *     invoked with each TaskFrame from the server.
 *   @param {(token: string) => void} [onToken] — Optional callback invoked
 *     with token text for incremental display.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server finishes streaming.
 *
 * Dependencies:
 *   - decodeFrame — parses payload data into TaskFrame objects.
 *
 * Dependants:
 *   - Connection.sendTask — calls this for task execution streaming.
 *   - Connection.sendStream — calls this for model pull and explore streaming.
 * </Summary>
 */
export async function streamRequest(
  rsocket: RSocket,
  body: Record<string, unknown>,
  metadata: Buffer,
  onFrame: (frame: TaskFrame) => void | Promise<void>,
  onToken?: (token: string) => void,
): Promise<void> {
  // ===== STEP 1: Serialize Request Body =====
  // Step 1a: Convert request body to JSON string
  // Step 1b: Encode as UTF-8 bytes for RSocket transmission
  const dataBuf = Buffer.from(JSON.stringify(body), "utf-8");

  // ===== STEP 2: Build Payload with Metadata =====
  // Step 2a: Create RSocket Payload with data and password metadata
  const payload: Payload = {
    data: dataBuf,
    metadata,
  };

  // ===== STEP 3: Wrap in Promise for Async Control =====
  // Step 3a: Return promise that resolves when stream completes or rejects on error
  await new Promise<void>((resolve, reject) => {
    // ===== STEP 3b: Initialize Settlement Guard =====
    // Prevent double-resolution from multiple callback firings
    let settled = false;

    // ===== STEP 3c: Initialize Backpressure Budget =====
    // Start with STREAM_WINDOW (64) items requested from server
    let pendingBudget = STREAM_WINDOW;

    // ===== STEP 3d: Define Completion Handler =====
    // Helper function to safely finalize the promise
    const finish = (err?: Error) => {
      // Skip if already settled
      if (settled) return;
      // Mark as settled to prevent double-resolution
      settled = true;
      // Reject if error provided, else resolve successfully
      if (err) reject(err);
      else resolve();
    };

    // ===== STEP 3e: Initialize Frame Processing Chain =====
    // Queue frames sequentially even if callbacks are async
    let frameChain = Promise.resolve();

    // ===== STEP 4: Call requestStream with Callbacks =====
    // Start the streaming request with initial budget of STREAM_WINDOW
    const requester = rsocket.requestStream(payload, STREAM_WINDOW, {
      // ===== STEP 4a: onError Handler =====
      // If server returns error, finish the promise with that error
      onError: (e: Error) => finish(e),

      // ===== STEP 4b: onNext Handler =====
      // Called for each streamed item
      onNext: (p: Payload, isComplete: boolean) => {
        // ===== STEP 4b-i: Queue Frame Processing =====
        // Chain callbacks sequentially to maintain order
        frameChain = frameChain
          .then(async () => {
            // ===== STEP 4b-ii: Decode Frame =====
            // Parse payload data buffer into TaskFrame object
            const frame = decodeFrame(p.data ?? undefined);

            // ===== STEP 4b-iii: Process Frame =====
            // If frame decoded successfully, process it
            if (frame) {
              // ===== STEP 4b-iv: Handle Token Callbacks =====
              // If this is a token frame and callback provided, call it
              if (frame.kind === "token" && onToken) {
                onToken(frame.text);
              }
              // ===== STEP 4b-v: Invoke Frame Callback =====
              // Call the main frame callback (may be async)
              await onFrame(frame);
            }
          })
          .catch((err: unknown) =>
            finish(err instanceof Error ? err : new Error(String(err))),
          );

        // ===== STEP 4b-vi: Decrement Budget =====
        // We consumed one item from the budget
        pendingBudget--;

        // ===== STEP 4b-vii: Manage Backpressure =====
        // If budget falls below half, request more items
        // This prevents the server from overwhelming us with data
        if (pendingBudget < STREAM_WINDOW / 2) {
          // Request another STREAM_WINDOW items
          requester.request(STREAM_WINDOW);
          // Update budget accounting
          pendingBudget += STREAM_WINDOW;
        }

        // ===== STEP 4b-viii: Handle Stream Completion =====
        // RSocket may signal end-of-stream via isComplete on the final onNext
        if (isComplete) {
          void frameChain.then(() => finish());
        }
      },

      // ===== STEP 4c: onComplete Handler =====
      // Called when stream ends successfully (with or without items)
      // Wait for any pending frame callbacks to finish, then complete
      onComplete: () => {
        void frameChain.then(() => finish());
      },

      // ===== STEP 4d: onExtension Handler =====
      // RSocket extension protocol; not used here
      onExtension: () => {},
    });
  });
}

/**
 * <Summary>
 * What it does:
 *   Streams a task to the server via RSocket requestStream and invokes a
 *   callback for each token received, creating the ChatGPT-style streaming
 *   effect in the CLI.
 *
 * How it does it (step by step):
 *   1. Builds a TaskStreamPayload with the task text, model names, and temps.
 *   2. Calls streamRequest with the constructed body.
 *
 * Parameters:
 *   @param {string} task — The user's task description to execute.
 *   @param {Config} config — The configuration object with model settings.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {(frame: TaskFrame) => void | Promise<void>} onFrame — Callback
 *     invoked with each TaskFrame from the server.
 *   @param {(token: string) => void} [onToken] — Optional callback invoked
 *     with token text for incremental display.
 *   @param {number} [maxAgents] — Optional max agents setting.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server finishes streaming.
 *
 * Dependencies:
 *   - streamRequest — handles the RSocket requestStream logic.
 *
 * Dependants:
 *   - index.ts rl.on('line') — calls this for plain text task input.
 * </Summary>
 */
export async function sendTask(
  task: string,
  config: Config,
  metadata: Buffer,
  rsocket: RSocket,
  onFrame: (frame: TaskFrame) => void | Promise<void>,
  onToken?: (token: string) => void,
  maxAgents?: 1 | 2 | "max" | number,
): Promise<void> {
  // ===== STEP 1: Build Task Payload =====
  // Step 1a: Create TaskStreamPayload with task text and model config
  // Step 1b: Include advisor and agent model names and temperature settings
  // Step 1c: Temperatures control output creativity (0.0=deterministic, 1.0=random)
  await streamRequest(
    rsocket,
    {
      kind: "task",
      text: task,
      maxAgents: maxAgents ?? config.agentCap,
      advisorModel: config.advisorModel,
      agentModel: config.agentModel,
      advisorTemp: config.advisorTemp,
      agentTemp: config.agentTemp,
    },
    metadata,
    onFrame,
    onToken,
  );
}

/**
 * <Summary>
 * What it does:
 *   Streams long-running server operations (like model pulls) and dispatches
 *   JSON TaskFrames to a callback for real-time progress display.
 *
 * How it does it (step by step):
 *   1. Checks the kind field to determine the operation type.
 *   2. For "models.pull": builds body with kind and model name from payload.
 *   3. For "explore": builds body with kind only (no payload needed).
 *   4. Calls streamRequest with the constructed body and onFrame callback.
 *   5. streamRequest handles the RSocket streaming and backpressure.
 *
 * Parameters:
 *   @param {Object} opts — Operation-specific options.
 *     @param {string} opts.kind — Either "models.pull" or "explore".
 *     @param {Object} opts.payload — Operation-specific data (e.g., { name: string }).
 *     @param {(frame: TaskFrame) => void | Promise<void>} opts.onFrame — Callback
 *       invoked with each TaskFrame from the server.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server finishes streaming.
 *
 * Dependencies:
 *   - streamRequest — handles the RSocket requestStream logic.
 *
 * Dependants:
 *   - CommandHandler.handlePull — calls this to stream model pull progress.
 *   - CommandHandler.handleExplore — calls this to stream exploration results.
 * </Summary>
 */
export async function sendStream(
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
): Promise<void> {
  // ===== STEP 1: Build Request Body =====
  // Step 1a: Check operation kind and build appropriate request body
  // Step 1b: For "models.pull", include the model name from payload
  // Step 1c: For "explore", just include the kind (no payload needed)
  const body =
    opts.kind === "models.pull"
      ? { kind: opts.kind, name: opts.payload.name }
      : { kind: "explore" };

  // ===== STEP 2: Delegate to Stream Request =====
  // Step 2a: Call streamRequest to handle the RSocket streaming logic
  // Step 2b: Pass the constructed body and the frame callback
  await streamRequest(rsocket, body, metadata, opts.onFrame);
}
