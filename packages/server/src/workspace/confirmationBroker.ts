/**
 * <Summary>
 * What it does:
 *   Queues confirmation envelopes (file diff or shell command), sends them through
 *   an injected transport one at a time, and resolves pending promises when the
 *   client responds or a timeout fires.
 *
 * How it fits in the system:
 *   WorkspaceManager and TerminalExecutor block on user approval before mutating
 *   files or spawning processes. RSocket wiring supplies ConfirmationTransport later.
 *
 * Dependencies:
 *   - node:crypto — request id entropy.
 *
 * Dependants:
 *   - WorkspaceManager.writeFile, TerminalExecutor.runWithConfirmation.
 * </Summary>
 */

import { randomUUID } from "node:crypto";

/**
 * <Summary>
 * What it does:
 *   Server-to-client confirmation payload for file writes or command execution.
 *
 * Used by:
 *   - ConfirmationTransport.send.
 * </Summary>
 */
export type ConfirmEnvelope =
  | { type: "confirm-file"; id: string; diff: string; path: string }
  | { type: "confirm-command"; id: string; command: string };

/**
 * <Summary>
 * What it does:
 *   Client-to-server answer matching a prior ConfirmEnvelope id.
 *
 * Used by:
 *   - ConfirmationBroker response handler.
 * </Summary>
 */
export type ConfirmResponse = {
  id: string;
  approved: boolean;
};

/**
 * <Summary>
 * What it does:
 *   Pluggable bridge for sending envelopes and receiving typed responses.
 *
 * Used by:
 *   - ConfirmationBroker constructor.
 *
 * Produced by:
 *   - createInMemoryTransport, future RSocket adapter.
 * </Summary>
 */
export interface ConfirmationTransport {
  send: (envelope: ConfirmEnvelope) => void;
  onResponse: (handler: (response: ConfirmResponse) => void) => () => void;
}

type PendingEntry = {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export class ConfirmationBroker {
  private readonly transport: ConfirmationTransport;

  private readonly timeoutMs: number;

  private readonly pending = new Map<string, PendingEntry>();

  private readonly queue: ConfirmEnvelope[] = [];

  private active: ConfirmEnvelope | null = null;

  private readonly unsubscribe: () => void;

  /**
   * @param {{ transport: ConfirmationTransport; timeoutMs?: number }} deps — Transport and optional timeout (default 60s).
   */
  constructor(deps: { transport: ConfirmationTransport; timeoutMs?: number }) {
    this.transport = deps.transport;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.unsubscribe = deps.transport.onResponse((response) => {
      this.onResponse(response);
    });
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Queues a file-write confirmation with pre-formatted diff text and waits for approval.
   *
   * How it does it (step by step):
   *   1. Generate a unique request ID.
   *   2. Package the diff and path into a ConfirmEnvelope.
   *   3. Enqueue for delivery and wait for user response.
   *
   * Parameters:
   *   @param {string} formattedDiff — ANSI-colored body from DiffEngine.formatDiff.
   *   @param {string} filePath — Workspace-relative path.
   *
   * Returns:
   *   @returns {Promise<boolean>} — True when approved; false on decline or timeout.
   *
   * Dependants:
   *   - WorkspaceManager.writeFile.
   * </Summary>
   */
  request = (formattedDiff: string, filePath: string): Promise<boolean> => {
    // Step 1: Generate a unique request identifier
    // Used to match the response with this specific request
    const uniqueRequestId = randomUUID();

    // Step 2: Package the confirmation into an envelope
    // Type indicates this is a file confirmation (not a command confirmation)
    // Contains the formatted diff and file path for the user to review
    const confirmationEnvelope: ConfirmEnvelope = {
      type: "confirm-file",
      id: uniqueRequestId,
      diff: formattedDiff,
      path: filePath,
    };

    // Step 3: Enqueue the envelope and wait for user approval
    // Returns a promise that resolves when user approves/declines or timeout occurs
    return this.enqueue(confirmationEnvelope);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Queues a shell command confirmation and waits for approval.
   *
   * How it does it (step by step):
   *   1. Generate a unique request ID.
   *   2. Package the command into a ConfirmEnvelope.
   *   3. Enqueue for delivery and wait for user response.
   *
   * Parameters:
   *   @param {string} command — Full command string to show the user.
   *
   * Returns:
   *   @returns {Promise<boolean>} — True when approved; false on decline or timeout.
   *
   * Dependants:
   *   - TerminalExecutor.runWithConfirmation.
   * </Summary>
   */
  requestCommand = (command: string): Promise<boolean> => {
    // Step 1: Generate a unique request identifier
    // Used to match the response with this specific command request
    const uniqueRequestId = randomUUID();

    // Step 2: Package the confirmation into an envelope
    // Type indicates this is a command confirmation (not a file confirmation)
    // Contains the full command string for the user to review
    const confirmationEnvelope: ConfirmEnvelope = {
      type: "confirm-command",
      id: uniqueRequestId,
      command,
    };

    // Step 3: Enqueue the envelope and wait for user approval
    // Returns a promise that resolves when user approves/declines or timeout occurs
    return this.enqueue(confirmationEnvelope);
  };

  /**
   * <Summary>
   * What it does:
   *   Tears down listeners, clears timers, and rejects outstanding waits with false.
   *
   * How it does it (step by step):
   *   1. Unsubscribe from transport response events.
   *   2. Cancel all pending timeout timers.
   *   3. Reject all outstanding promises with false.
   *   4. Clear queue and reset state.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void.
   *
   * Dependants:
   *   - Server shutdown or session end.
   * </Summary>
   */
  dispose = (): void => {
    // Step 1: Unsubscribe from transport response events
    // Prevents any new responses from being processed after disposal
    this.unsubscribe();

    // Step 2-3: Iterate over all pending requests and clean them up
    // For each pending request: cancel timeout and reject with false (declined)
    // This ensures all waiters are notified when broker is shut down
    for (const [, pendingRequestEntry] of this.pending) {
      clearTimeout(pendingRequestEntry.timer);
      pendingRequestEntry.resolve(false);
    }

    // Step 4: Clear all internal state
    // pending: map of id → promise entry
    // queue: array of envelopes waiting to be sent
    // active: currently in-flight envelope
    this.pending.clear();
    this.queue.length = 0;
    this.active = null;
  };

  /**
   * <Summary>
   * What it does:
   *   Registers a pending promise, enqueues the envelope, and starts delivery when idle.
   *
   * How it does it (step by step):
   *   1. Create a timeout that will reject after timeoutMs expires.
   *   2. Store the promise resolver and timeout in pending map.
   *   3. Add envelope to the delivery queue.
   *   4. Attempt to flush (send) the envelope if no active confirmation in flight.
   *
   * Parameters:
   *   @param {ConfirmEnvelope} envelope — Next confirmation to deliver.
   *
   * Returns:
   *   @returns {Promise<boolean>} — User choice or false on timeout.
   *
   * Dependants:
   *   - request, requestCommand.
   * </Summary>
   */
  private enqueue = (envelope: ConfirmEnvelope): Promise<boolean> => {
    return new Promise((promiseResolver) => {
      // Step 1: Set up timeout handler
      // If no response within timeoutMs, treat as declined (false)
      // Keeps requests from hanging indefinitely if client is unresponsive
      const timeoutTimerId = setTimeout(() => {
        this.onTimeout(envelope.id);
      }, this.timeoutMs);

      // Step 2: Register this request in pending map
      // Key: unique request ID (from envelope)
      // Value: promise resolver (to complete promise) + timeout timer (for cleanup)
      this.pending.set(envelope.id, {
        resolve: promiseResolver,
        timer: timeoutTimerId,
      });

      // Step 3: Add envelope to delivery queue
      // Queue implements FIFO (first in, first out) ordering
      // Ensures confirmations are sent in order they were requested
      this.queue.push(envelope);

      // Step 4: Try to send the next envelope
      // Only sends if no confirmation is currently in-flight (active is null)
      // Ensures one-at-a-time delivery (queue processing)
      this.flush();
    });
  };

  /**
   * <Summary>
   * What it does:
   *   Sends the next queued envelope when no active confirmation is in flight.
   *
   * How it does it (step by step):
   *   1. Check if a confirmation is currently being processed.
   *   2. If yes, return early (wait for response before sending next).
   *   3. If no, pop the next envelope from the queue.
   *   4. If queue is empty, return (nothing to send).
   *   5. Mark envelope as active and send through transport.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void.
   *
   * Dependants:
   *   - enqueue, onResponse, onTimeout.
   * </Summary>
   */
  private flush = (): void => {
    // Step 1-2: Check if a confirmation is already in-flight
    // If active is not null, we're waiting for a response from the client
    // Don't send another confirmation until this one completes
    if (this.active !== null) {
      return;
    }

    // Step 3: Pop the next envelope from the queue (FIFO)
    // queue.shift() removes and returns the first element
    const nextEnvelope = this.queue.shift();

    // Step 4: Guard against empty queue
    // If queue is empty, nothing to send; return and wait for enqueue() call
    if (!nextEnvelope) {
      return;
    }

    // Step 5: Mark envelope as active and send it
    // Setting active prevents new sends until response/timeout
    // transport.send() passes envelope to the client (over RSocket or in-memory)
    this.active = nextEnvelope;
    this.transport.send(nextEnvelope);
  };

  /**
   * <Summary>
   * What it does:
   *   Resolves a pending request from the client and advances the queue.
   *
   * How it does it (step by step):
   *   1. Look up the pending request by response ID.
   *   2. If not found, return (orphan response, ignore).
   *   3. Cancel the timeout timer.
   *   4. Resolve the promise with the user's choice (approved/declined).
   *   5. Mark this envelope as no longer active.
   *   6. Attempt to send the next queued envelope.
   *
   * Parameters:
   *   @param {ConfirmResponse} response — Client answer.
   *
   * Returns:
   *   void.
   *
   * Dependants:
   *   - transport.onResponse subscription.
   * </Summary>
   */
  private onResponse = (response: ConfirmResponse): void => {
    // Step 1: Look up the pending request entry by response ID
    // pending map stores id → { resolve, timer }
    const pendingRequestEntry = this.pending.get(response.id);

    // Step 2: Guard against orphan responses
    // If ID not found, response arrived for unknown request (shouldn't happen)
    // Return early to avoid errors
    if (!pendingRequestEntry) {
      return;
    }

    // Step 3: Cancel the timeout timer
    // The user responded, so timeout is no longer needed
    clearTimeout(pendingRequestEntry.timer);

    // Step 4: Remove entry from pending and resolve the waiter
    // pending.delete removes the entry from the map
    // entry.resolve(boolean) completes the original promise with the user's choice
    this.pending.delete(response.id);
    pendingRequestEntry.resolve(response.approved);

    // Step 5: Clear the active confirmation
    // Check if this response matches the currently active envelope
    // If yes, set active to null to allow next envelope to be sent
    if (this.active?.id === response.id) {
      this.active = null;
    }

    // Step 6: Attempt to send the next envelope in queue
    // flush() checks if active is null and queue has items
    // If true, pops next envelope and sends it
    this.flush();
  };

  /**
   * <Summary>
   * What it does:
   *   Marks a request declined after timeout and continues the queue.
   *
   * How it does it (step by step):
   *   1. Look up the pending request by ID.
   *   2. If not found, return (orphan timeout, ignore).
   *   3. Cancel the timer (already fired, but for cleanliness).
   *   4. Resolve the promise with false (no response = declined).
   *   5. Mark this envelope as no longer active.
   *   6. Attempt to send the next queued envelope.
   *
   * Parameters:
   *   @param {string} id — Request id that expired.
   *
   * Returns:
   *   void.
   *
   * Dependants:
   *   - enqueue timer.
   * </Summary>
   */
  private onTimeout = (id: string): void => {
    // Step 1: Look up the pending request entry by ID
    // pending map stores id → { resolve, timer }
    const pendingRequestEntry = this.pending.get(id);

    // Step 2: Guard against orphan timeouts
    // If ID not found, timeout fired for unknown request (shouldn't happen)
    // Return early to avoid errors
    if (!pendingRequestEntry) {
      return;
    }

    // Step 3: Cancel the timer
    // Timer already fired (callback is executing now), but clear it anyway for cleanup
    clearTimeout(pendingRequestEntry.timer);

    // Step 4: Remove entry from pending and resolve with false
    // pending.delete removes the entry from the map
    // entry.resolve(false) completes the promise with false (timeout = no approval)
    this.pending.delete(id);
    pendingRequestEntry.resolve(false);

    // Step 5: Clear the active confirmation
    // Check if this timeout matches the currently active envelope
    // If yes, set active to null to allow next envelope to be sent
    if (this.active?.id === id) {
      this.active = null;
    }

    // Step 6: Attempt to send the next envelope in queue
    // flush() checks if active is null and queue has items
    // If true, pops next envelope and sends it
    this.flush();
  };
}

/**
 * <Summary>
 * What it does:
 *   In-memory ConfirmationTransport for tests and local tooling without RSocket.
 *
 * Returns:
 *   @returns {{ transport: ConfirmationTransport; respond: (id: string, approved: boolean) => void; lastSent: ConfirmEnvelope | null }} — Transport, manual responder, and last envelope from send (null until first send).
 *
 * Dependants:
 *   - Unit-style checks, dev scripts.
 * </Summary>
 */
export const createInMemoryTransport = (): {
  transport: ConfirmationTransport;
  respond: (id: string, approved: boolean) => void;
  lastSent: ConfirmEnvelope | null;
} => {
  // Step 1: Initialize response handler and state
  // handler: callback function to invoke when respond() is called
  // state: object to track the most recently sent envelope
  let responseHandler: ((response: ConfirmResponse) => void) | null = null;
  const transportState = { lastSent: null as ConfirmEnvelope | null };

  // Step 2: Create the in-memory transport implementation
  // send(): stores the envelope in state (simulates transport to client)
  // onResponse(): registers handler and returns unsubscribe function
  const inMemoryTransport: ConfirmationTransport = {
    // Step 2a: Send method stores envelope for later inspection
    // Used in tests to verify what was sent
    send: (envelope) => {
      transportState.lastSent = envelope;
    },

    // Step 2b: OnResponse method registers/unregisters response handler
    // h: handler function to call when respond() is invoked
    // Returns unsubscribe function that clears the handler
    onResponse: (responseHandlerCallback) => {
      responseHandler = responseHandlerCallback;
      return () => {
        responseHandler = null;
      };
    },
  };

  // Step 3: Create manual respond function for test usage
  // Simulates client sending a response by invoking the registered handler
  const manualRespond = (requestId: string, userApproved: boolean): void => {
    responseHandler?.({ id: requestId, approved: userApproved });
  };

  // Step 4: Return transport, responder, and state inspector
  // Users can manually call respond() to simulate client responses
  // Users can check lastSent to verify what broker tried to send
  return {
    transport: inMemoryTransport,
    respond: manualRespond,
    get lastSent(): ConfirmEnvelope | null {
      return transportState.lastSent;
    },
  };
};
