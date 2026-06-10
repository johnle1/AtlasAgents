import type { Payload, RSocket } from "@rsocket/core";
import { decodeFrame, type TaskFrame } from "../frames.js";
import type { Config } from "../config.js";
import { STREAM_WINDOW } from "./utils.js";

/**
 * @async
 * <Summary>
 * What it does:
 *   Responds to a pending confirmation request from the server, allowing the
 *   user to approve or reject an action requiring confirmation.
 *
 * How it does it (step by step):
 *   1. Sends a "confirm.respond" command via sendCommand with the confirmation ID.
 *   2. Includes the approved boolean flag to indicate user's decision.
 *   3. Server processes the response and proceeds or cancels the pending action.
 *
 * Parameters:
 *   @param {string} id — The unique confirmation ID from the server's request.
 *   @param {boolean} approved — True to approve the action, false to reject it.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server acknowledges the response.
 *
 * Dependencies:
 *   - Connection.sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - CommandHandler — calls this when user responds to a confirmation prompt.
 * </Summary>
 */
export type RespondConfirmationFn = (
  id: string,
  approved: boolean,
) => Promise<void>;

/**
 * @async
 * <Summary>
 * What it does:
 *   Responds to a pending plan request from the server, allowing the user to
 *   approve, skip, or edit the proposed execution plan.
 *
 * How it does it (step by step):
 *   1. Sends a "plan.respond" command via sendCommand with the plan ID.
 *   2. Includes the decision string: "implement", "skip", or "edit".
 *   3. If decision is "edit", includes the modified steps array.
 *   4. Server processes the response and proceeds with the chosen action.
 *
 * Parameters:
 *   @param {string} id — The unique plan ID from the server's request.
 *   @param {"implement" | "skip" | "edit"} decision — User's decision on the plan.
 *   @param {string[]} [steps] — Modified step descriptions (required when decision is "edit").
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server acknowledges the response.
 *
 * Dependencies:
 *   - Connection.sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - CommandHandler — calls this when user responds to a plan prompt.
 * </Summary>
 */
export type RespondPlanFn = (
  id: string,
  decision: "implement" | "skip" | "edit",
  steps?: string[],
) => Promise<void>;

/**
 * @async
 * <Summary>
 * What it does:
 *   Streams a task to the server via RSocket requestStream and invokes a
 *   callback for each token received, creating the ChatGPT-style streaming
 *   effect in the CLI.
 *
 * How it does it (step by step):
 *   1. Waits until the RSocket connection is live.
 *   2. Builds a TaskStreamPayload with the task text, model names, and temps.
 *   3. Serialises it to a UTF-8 JSON Buffer with password metadata.
 *   4. Calls rsocket.requestStream with an initial budget of STREAM_WINDOW (64).
 *   5. On each onNext: decodes the payload data as UTF-8, calls onToken with it.
 *   6. Tracks pendingBudget; when below half, requests another STREAM_WINDOW
 *      from the server (backpressure).
 *   7. When isComplete is true or onComplete fires, resolves the Promise.
 *   8. On onError, rejects the Promise.
 *
 * Parameters:
 *   @param {string} task — The user's task description to execute.
 *   @param {(token: string) => void} onToken — Callback invoked with each
 *     streamed token string for incremental display.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server finishes streaming.
 *
 * @throws {Error} — When the server returns an error frame or connection fails.
 *
 * Dependencies:
 *   - Connection.waitUntilConnected — ensures live socket.
 *   - Connection.requireSocket — returns the RSocket or throws.
 *   - Connection.authMetadata — builds the per-frame password metadata.
 *
 * Dependants:
 *   - index.ts rl.on('line') — calls this for plain text task input.
 * </Summary>
 */
export type SendTaskFn = (opts: {
  task: string;
  maxAgents?: 1 | 2 | "max" | number;
  onFrame: (frame: TaskFrame) => void | Promise<void>;
  onToken?: (token: string) => void;
}) => Promise<void>;

/**
 * @async
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
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server finishes streaming.
 *
 * Dependencies:
 *   - Connection.streamRequest — handles the RSocket requestStream logic.
 *
 * Dependants:
 *   - CommandHandler.handlePull — calls this to stream model pull progress.
 *   - CommandHandler.handleExplore — calls this to stream exploration results.
 * </Summary>
 */
export type SendStreamFn = (
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
) => Promise<void>;

/**
 * @async
 * <Summary>
 * What it does:
 *   Sends a streaming request to the server via RSocket requestStream and
 *   dispatches TaskFrames to callbacks with backpressure control.
 *
 * How it does it (step by step):
 *   1. Waits until the RSocket connection is live.
 *   2. Retrieves the live RSocket instance.
 *   3. Serialises the request body to a UTF-8 JSON Buffer.
 *   4. Builds the RSocket Payload with data and password metadata.
 *   5. Creates a Promise wrapper for async control.
 *   6. Initializes settlement guard to prevent double-resolution.
 *   7. Initializes backpressure budget to STREAM_WINDOW (64).
 *   8. Defines completion handler to safely finalize the promise.
 *   9. Initializes frame processing chain for sequential async callbacks.
 *   10. Calls rsocket.requestStream with initial budget of STREAM_WINDOW.
 *   11. In onError: finishes the promise with the error.
 *   12. In onNext: decodes frame, calls onToken if token frame, calls onFrame.
 *   13. Decrements budget; requests more when below half (backpressure).
 *   14. In onComplete: waits for frame chain to finish, then completes.
 *
 * Parameters:
 *   @param {Record<string, unknown>} body — The request body to send as JSON.
 *   @param {(frame: TaskFrame) => void | Promise<void>} onFrame — Callback
 *     invoked with each TaskFrame from the server.
 *   @param {(token: string) => void} [onToken] — Optional callback invoked
 *     with token text for incremental display.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server finishes streaming.
 *
 * Dependencies:
 *   - Connection.waitUntilConnected — ensures live socket.
 *   - Connection.requireSocket — returns the RSocket or throws.
 *   - Connection.authMetadata — builds the per-frame password metadata.
 *   - decodeFrame — parses payload data into TaskFrame objects.
 *
 * Dependants:
 *   - Connection.sendTask — calls this for task execution streaming.
 *   - Connection.sendStream — calls this for model pull and explore streaming.
 * </Summary>
 */
export type StreamRequestFn = (
  body: Record<string, unknown>,
  onFrame: (frame: TaskFrame) => void | Promise<void>,
  onToken?: (token: string) => void,
) => Promise<void>;

export class StreamingMethods {
  constructor(
    private getConfig: () => Config,
    private waitUntilConnected: () => Promise<void>,
    private requireSocket: () => RSocket,
    private authMetadata: () => Buffer,
    private sendCommand: <T>(type: string, payload: unknown) => Promise<T>,
  ) {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams a task to the server via RSocket requestStream and invokes a
   *   callback for each token received, creating the ChatGPT-style streaming
   *   effect in the CLI.
   *
   * How it does it (step by step):
   *   1. Builds a TaskStreamPayload with the task text, model names, and temps.
   *   2. Calls streamRequest with the payload and callbacks.
   *
   * Parameters:
   *   @param {Object} opts — Task options.
   *     @param {string} opts.task — The user's task description.
   *     @param {number} [opts.maxAgents] — Maximum number of agents to use.
   *     @param {(frame: TaskFrame) => void | Promise<void>} opts.onFrame — Callback for frames.
   *     @param {(token: string) => void} [opts.onToken] — Optional callback for tokens.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server finishes streaming.
   *
   * @throws {Error} — When the server returns an error frame or connection fails.
   *
   * Dependencies:
   *   - Connection.streamRequest — handles the RSocket requestStream logic.
   *
   * Dependants:
   *   - index.ts rl.on('line') — calls this for plain text task input.
   * </Summary>
   */
  sendTask: SendTaskFn = async (opts) => {
    const { loadConfig } = await import("../config.js");

    // ===== STEP 1: Build Task Payload =====
    // Step 1a: Create TaskStreamPayload with task text and model config
    // Step 1b: Include advisor and agent model names and temperature settings
    // Step 1c: Temperatures control output creativity (0.0=deterministic, 1.0=random)
    await this.streamRequest(
      {
        kind: "task",
        text: opts.task,
        maxAgents: opts.maxAgents ?? loadConfig().agentCap,
        advisorModel: this.getConfig().advisorModel,
        agentModel: this.getConfig().agentModel,
        advisorTemp: this.getConfig().advisorTemp,
        agentTemp: this.getConfig().agentTemp,
      },
      opts.onFrame,
      opts.onToken,
    );
  };

  /**
   * @async
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
   *     @param {Object} opts.payload — Operation-specific data.
   *     @param {(frame: TaskFrame) => void | Promise<void>} opts.onFrame — Callback.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server finishes streaming.
   *
   * Dependencies:
   *   - Connection.streamRequest — handles the RSocket requestStream logic.
   *
   * Dependants:
   *   - CommandHandler.handlePull — calls this to stream model pull progress.
   *   - CommandHandler.handleExplore — calls this to stream exploration results.
   * </Summary>
   */
  sendStream: SendStreamFn = async (opts) => {
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
    await this.streamRequest(body, opts.onFrame);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Responds to a pending confirmation request from the server, allowing the
   *   user to approve or reject an action requiring confirmation.
   *
   * How it does it (step by step):
   *   1. Sends a "confirm.respond" command via sendCommand with the confirmation ID.
   *   2. Includes the approved boolean flag to indicate user's decision.
   *   3. Server processes the response and proceeds or cancels the pending action.
   *
   * Parameters:
   *   @param {string} id — The unique confirmation ID from the server's request.
   *   @param {boolean} approved — True to approve the action, false to reject it.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server acknowledges the response.
   *
   * Dependencies:
   *   - Connection.sendCommand — sends the requestResponse.
   *
   * Dependants:
   *   - CommandHandler — calls this when user responds to a confirmation prompt.
   * </Summary>
   */
  respondConfirmation: RespondConfirmationFn = async (id, approved) => {
    // ===== STEP 1: Send Confirmation Response =====
    // Step 1a: Send "confirm.respond" command with the confirmation ID and approval flag
    // Step 1b: Server uses this to proceed or cancel pending user confirmations
    await this.sendCommand("confirm.respond", { id, approved });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Responds to a pending plan request from the server, allowing the user to
   *   approve, skip, or edit the proposed execution plan.
   *
   * How it does it (step by step):
   *   1. Sends a "plan.respond" command via sendCommand with the plan ID.
   *   2. Includes the decision string: "implement", "skip", or "edit".
   *   3. If decision is "edit", includes the modified steps array.
   *   4. Server processes the response and proceeds with the chosen action.
   *
   * Parameters:
   *   @param {string} id — The unique plan ID from the server's request.
   *   @param {"implement" | "skip" | "edit"} decision — User's decision on the plan.
   *   @param {string[]} [steps] — Modified step descriptions (required when decision is "edit").
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server acknowledges the response.
   *
   * Dependencies:
   *   - Connection.sendCommand — sends the requestResponse.
   *
   * Dependants:
   *   - CommandHandler — calls this when user responds to a plan prompt.
   * </Summary>
   */
  respondPlan: RespondPlanFn = async (id, decision, steps) => {
    // ===== STEP 1: Send Plan Response =====
    // Step 1a: Send "plan.respond" command with the plan ID, decision, and optional steps
    // Step 1b: Server uses this to proceed with the chosen action on the plan
    await this.sendCommand("plan.respond", { id, decision, steps });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Sends a streaming request to the server via RSocket requestStream and
   *   dispatches TaskFrames to callbacks with backpressure control.
   *
   * How it does it (step by step):
   *   1. Waits until the RSocket connection is live.
   *   2. Retrieves the live RSocket instance.
   *   3. Serialises the request body to a UTF-8 JSON Buffer.
   *   4. Builds the RSocket Payload with data and password metadata.
   *   5. Creates a Promise wrapper for async control.
   *   6. Initializes settlement guard to prevent double-resolution.
   *   7. Initializes backpressure budget to STREAM_WINDOW (64).
   *   8. Defines completion handler to safely finalize the promise.
   *   9. Initializes frame processing chain for sequential async callbacks.
   *   10. Calls rsocket.requestStream with initial budget of STREAM_WINDOW.
   *   11. In onError: finishes the promise with the error.
   *   12. In onNext: decodes frame, calls onToken if token frame, calls onFrame.
   *   13. Decrements budget; requests more when below half (backpressure).
   *   14. In onComplete: waits for frame chain to finish, then completes.
   *
   * Parameters:
   *   @param {Record<string, unknown>} body — The request body to send as JSON.
   *   @param {(frame: TaskFrame) => void | Promise<void>} onFrame — Callback
   *     invoked with each TaskFrame from the server.
   *   @param {(token: string) => void} [onToken] — Optional callback invoked
   *     with token text for incremental display.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server finishes streaming.
   *
   * Dependencies:
   *   - Connection.waitUntilConnected — ensures live socket.
   *   - Connection.requireSocket — returns the RSocket or throws.
   *   - Connection.authMetadata — builds the per-frame password metadata.
   *   - decodeFrame — parses payload data into TaskFrame objects.
   *
   * Dependants:
   *   - Connection.sendTask — calls this for task execution streaming.
   *   - Connection.sendStream — calls this for model pull and explore streaming.
   * </Summary>
   */
  streamRequest: StreamRequestFn = async (
    body,
    onFrame,
    onToken,
  ): Promise<void> => {
    // ===== STEP 1: Wait for Connection =====
    // Step 1a: Block until RSocket is live, retrying if needed
    await this.waitUntilConnected();

    // ===== STEP 2: Retrieve Live RSocket =====
    // Step 2a: Get the RSocket instance; throws if null
    const rsocket = this.requireSocket();

    // ===== STEP 3: Serialize Request Body =====
    // Step 3a: Convert request body to JSON string
    // Step 3b: Encode as UTF-8 bytes for RSocket transmission
    const dataBuf = Buffer.from(JSON.stringify(body), "utf-8");

    // ===== STEP 4: Build Payload with Metadata =====
    // Step 4a: Create RSocket Payload with data and password metadata
    const payload: Payload = {
      data: dataBuf,
      metadata: this.authMetadata(),
    };

    // ===== STEP 5: Wrap in Promise for Async Control =====
    // Step 5a: Return promise that resolves when stream completes or rejects on error
    await new Promise<void>((resolve, reject) => {
      // ===== STEP 5b: Initialize Settlement Guard =====
      // Prevent double-resolution from multiple callback firings
      let settled = false;

      // ===== STEP 5c: Initialize Backpressure Budget =====
      // Start with STREAM_WINDOW (64) items requested from server
      let pendingBudget = STREAM_WINDOW;

      // ===== STEP 5d: Define Completion Handler =====
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

      // ===== STEP 5e: Initialize Frame Processing Chain =====
      // Queue frames sequentially even if callbacks are async
      let frameChain = Promise.resolve();

      // ===== STEP 6: Call requestStream with Callbacks =====
      // Start the streaming request with initial budget of STREAM_WINDOW
      const requester = rsocket.requestStream(payload, STREAM_WINDOW, {
        // ===== STEP 6a: onError Handler =====
        // If server returns error, finish the promise with that error
        onError: (e: Error) => finish(e),

        // ===== STEP 6b: onNext Handler =====
        // Called for each streamed item
        onNext: (p: Payload, isComplete: boolean) => {
          // ===== STEP 6b-i: Queue Frame Processing =====
          // Chain callbacks sequentially to maintain order
          frameChain = frameChain.then(async () => {
            // ===== STEP 6b-ii: Decode Frame =====
            // Parse payload data buffer into TaskFrame object
            const frame = decodeFrame(p.data ?? undefined);

            // ===== STEP 6b-iii: Process Frame =====
            // If frame decoded successfully, process it
            if (frame) {
              // ===== STEP 6b-iv: Handle Token Callbacks =====
              // If this is a token frame and callback provided, call it
              if (frame.kind === "token" && onToken) {
                onToken(frame.text);
              }
              // ===== STEP 6b-v: Invoke Frame Callback =====
              // Call the main frame callback (may be async)
              await onFrame(frame);
            }
          });

          // ===== STEP 6b-vi: Decrement Budget =====
          // We consumed one item from the budget
          pendingBudget--;

          // ===== STEP 6b-vii: Manage Backpressure =====
          // If budget falls below half, request more items
          // This prevents the server from overwhelming us with data
          if (pendingBudget < STREAM_WINDOW / 2) {
            // Request another STREAM_WINDOW items
            requester.request(STREAM_WINDOW);
            // Update budget accounting
            pendingBudget += STREAM_WINDOW;
          }

          // ===== STEP 6b-viii: Check Stream Completion =====
          // isComplete flag indicates this is the last item
          if (isComplete) {
            // Wait for frame chain to finish processing, then complete
            void frameChain.then(() => finish());
          }
        },

        // ===== STEP 6c: onComplete Handler =====
        // Called when stream ends successfully (with or without items)
        onComplete: () => {
          // Wait for any pending frame callbacks to finish
          void frameChain.then(() => finish());
        },

        // ===== STEP 6d: onExtension Handler =====
        // RSocket extension protocol; not used here
        onExtension: () => {},
      });
    });
  };
}
