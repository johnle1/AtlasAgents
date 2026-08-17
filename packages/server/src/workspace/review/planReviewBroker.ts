/**
 * Broker for queuing and managing plan review requests from the server to the CLI.
 *
 * @remarks
 * PlanReviewBroker implements a queue-and-wait pattern for plan confirmation:
 *
 * 1. **Queueing:** Subagent submits a plan for review via {@link request}. The broker
 *    enqueues it and creates a Promise that resolves when the user responds.
 *
 * 2. **Sequential delivery:** Only one plan is shown to the user at a time. If multiple
 *    plans are queued, they're sent to the transport (CLI) one at a time.
 *
 * 3. **Timeout handling:** Each plan has a 5-minute timeout. If the user doesn't respond,
 *    the plan is auto-rejected with `{ decision: "skip" }` and the next plan is shown.
 *
 * 4. **Response correlation:** When the user responds, the transport sends back the
 *    plan ID and their decision. The broker looks up the corresponding Promise and
 *    resolves it, triggering the next plan in the queue.
 *
 * **Architecture:**
 * - Transport is injected (typically a WebSocket or stdio bridge to the CLI)
 * - Each plan gets a unique ID for request/response correlation
 * - Pending map tracks unresolved promises by ID
 * - Queue holds envelopes awaiting delivery
 * - Only one active plan at a time to avoid overwhelming the user
 *
 * **Use case:** When Subagent proposes a plan to execute tools, the server needs
 * user confirmation. This broker bridges the async gap between server-side async/await
 * and client-side RPC response delivery.
 *
 * @example
 * ```ts
 * const broker = new PlanReviewBroker({
 *   transport: cliTransport,
 *   timeoutMs: 300_000, // 5 minutes
 * });
 *
 * // Subagent requests plan review
 * const response = await broker.request({
 *   task: "Deploy to production",
 *   steps: ["Run tests", "Build", "Deploy"],
 *   risks: ["May take 30 minutes"],
 *   agents: [...],
 *   agentCount: 1,
 *   execution: {...},
 *   modeLabel: null,
 * });
 *
 * if (response.decision === "approve") {
 *   // User approved the plan, proceed with execution
 * } else {
 *   // User skipped/rejected, stop the task
 * }
 * ```
 *
 * @see {@link PlanReviewTransport} for the transport abstraction
 * @see {@link PlanReviewEnvelope} for the plan structure
 */

import { randomUUID } from "node:crypto";
import type { SubagentPlan, PlanExecution } from "@atlasagents/shared";
import type { PlanReviewResponse } from "../../orchestration/types.js";

/**
 * A plan review request envelope sent to the transport (CLI) for user confirmation.
 *
 * @remarks
 * This is the wire format for asking the user to approve or reject a plan.
 * Each envelope has a unique ID for request/response correlation.
 *
 * @example
 * ```ts
 * const envelope: PlanReviewEnvelope = {
 *   type: "confirm-plan",
 *   id: "550e8400-e29b-41d4-a716-446655440000",
 *   task: "Deploy API server",
 *   steps: ["Run tests", "Build Docker image", "Push to registry", "Update deployment"],
 *   risks: ["Downtime if rollback fails", "May take 30 minutes"],
 *   agents: [{ name: "deploy-agent", tools: [...] }],
 *   agentCount: 1,
 *   execution: { mode: "sequential", ... },
 *   modeLabel: "production",
 * };
 * ```
 */
export type PlanReviewEnvelope = {
  /** Fixed message type for routing ("confirm-plan"). */
  type: "confirm-plan";
  /** Unique ID for this request, used to correlate responses. */
  id: string;
  /** Human-readable task description shown to the user. */
  task: string;
  /** Ordered list of steps the plan will execute. */
  steps: string[];
  /** Identified risks or concerns with executing this plan. */
  risks: string[];
  /** Details of which agents will be involved and what they can do. */
  agents: SubagentPlan[];
  /** Total number of subagents involved in the plan. */
  agentCount: number;
  /** Execution strategy (sequential, parallel, etc.). */
  execution: PlanExecution;
  /** Optional label for the execution context (e.g., "production", "staging"). */
  modeLabel: string | null;
};

/**
 * Transport abstraction for sending plan review requests and receiving responses.
 *
 * @remarks
 * The broker delegates all I/O to the transport, keeping itself agnostic to the
 * underlying communication mechanism (WebSocket, stdio, HTTP, etc.).
 *
 * **Contract:**
 * - `send`: Called when the broker wants to show a plan to the user. Called one plan at a time.
 * - `onResponse`: Called by the transport when the user responds. The broker registers a handler,
 *   and the transport calls it when responses arrive. Should return an unsubscribe function.
 *
 * @example
 * ```ts
 * const transport: PlanReviewTransport = {
 *   send: (envelope) => {
 *     console.log(`Show plan to user: ${envelope.task}`);
 *     // Send to CLI via WebSocket or stdio
 *   },
 *   onResponse: (handler) => {
 *     // Register handler to be called when user responds
 *     rpc.on("plan_review_response", (id, response) => {
 *       handler(id, response);
 *     });
 *     // Return unsubscribe function
 *     return () => rpc.off("plan_review_response", handler);
 *   }
 * };
 * ```
 */
export interface PlanReviewTransport {
  /**
   * Sends a plan review envelope to the user for confirmation.
   * Called one at a time by the broker; never overlaps.
   */
  send: (envelope: PlanReviewEnvelope) => void;
  /**
   * Registers a response handler to be called when the user responds.
   * Returns an unsubscribe function.
   */
  onResponse: (
    handler: (id: string, response: PlanReviewResponse) => void,
  ) => () => void;
}

/**
 * Internal entry for a pending plan review request.
 *
 * @remarks
 * Tracks the Promise resolver and timeout handle for each in-flight request,
 * allowing the broker to resolve or timeout the request when appropriate.
 */
type PendingEntry = {
  /** Resolves the Promise returned by {@link request}. */
  resolve: (response: PlanReviewResponse) => void;
  /** Timeout handle; cleared when the response arrives or timeout fires. */
  timer: ReturnType<typeof setTimeout>;
};

/** Default timeout for plan reviews: 5 minutes. Users have this long to approve/reject. */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Queue-and-wait broker for plan review requests.
 *
 * @remarks
 * PlanReviewBroker coordinates between Subagent (which needs confirmation) and
 * the CLI transport (which displays plans to the user). It implements a queue
 * pattern to ensure only one plan is shown at a time and automatically times out
 * if the user doesn't respond.
 *
 * **State machine:**
 * - Empty queue + no active → idle
 * - Plan queued but not sent yet → queue has entries, active is null
 * - Plan sent and waiting for response → queue may have more, active is set, promise pending
 * - Response arrived → active becomes null, next plan sent if queued
 *
 * **Timeouts:**
 * - Each plan gets its own timeout timer
 * - If user doesn't respond within timeoutMs, plan auto-resolves with `{ decision: "skip" }`
 * - Timeout doesn't block other plans; queue continues processing
 *
 * @example
 * ```ts
 * const broker = new PlanReviewBroker({ transport, timeoutMs: 300_000 });
 *
 * // Two plans queued (Subagent proposes both rapidly)
 * const plan1 = broker.request({...}); // Enqueued, sent immediately
 * const plan2 = broker.request({...}); // Enqueued, waits for plan1 response
 *
 * // User responds to plan1 after 2 minutes
 * // plan1 resolves, plan2 is sent, user has 5 minutes for plan2
 * const response1 = await plan1; // { decision: "approve" }
 * const response2 = await plan2; // resolves when user responds or after 5 min timeout
 * ```
 */
export class PlanReviewBroker {
  /** The transport layer (CLI, WebSocket, etc.) for sending and receiving. */
  private readonly transport: PlanReviewTransport;
  /** How long to wait for a user response before auto-rejecting. */
  private readonly timeoutMs: number;
  /** Map of pending requests: ID → { resolve, timer }. Used to correlate responses. */
  private readonly pending = new Map<string, PendingEntry>();
  /** Queue of plans waiting to be sent to the user. */
  private readonly queue: PlanReviewEnvelope[] = [];
  /** Currently active plan (sent to user, awaiting response), or null if idle. */
  private active: PlanReviewEnvelope | null = null;
  /** Function to unsubscribe from transport responses on dispose. */
  private readonly unsubscribe: () => void;

  /**
   * Creates a new PlanReviewBroker.
   *
   * @param deps - Dependencies:
   *   - `transport`: The transport layer for sending plans and receiving responses
   *   - `timeoutMs`: Optional timeout per plan (default 5 minutes)
   *
   * @remarks
   * The broker immediately registers a response handler with the transport.
   * This handler is stored in `unsubscribe` and cleaned up when {@link dispose} is called.
   *
   * @example
   * ```ts
   * const broker = new PlanReviewBroker({
   *   transport: cliTransport,
   *   timeoutMs: 300_000, // 5 minutes
   * });
   * ```
   */
  constructor(
    readonly deps: { transport: PlanReviewTransport; timeoutMs?: number },
  ) {
    // Store the transport and timeout settings.
    this.transport = deps.transport;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Register the response handler with the transport and save the unsubscribe function.
    this.unsubscribe = deps.transport.onResponse((id, response) => {
      this.onResponse(id, response);
    });
  }

  /**
   * Submits a plan for user review and returns a Promise that resolves with the decision.
   *
   * @remarks
   * This is the public API for Subagent to request plan confirmation. The broker:
   * 1. Generates a unique ID for this request
   * 2. Wraps the plan in an envelope
   * 3. Enqueues it
   * 4. Returns a Promise that resolves when the user responds or timeout fires
   *
   * Multiple calls can happen in quick succession; the broker queues them and
   * sends one at a time to the user.
   *
   * @param plan - The plan data (everything except type and id)
   * @returns A Promise that resolves when the user responds or the timeout fires
   *
   * @example
   * ```ts
   * const response = await broker.request({
   *   task: "Deploy to staging",
   *   steps: ["Build", "Test", "Deploy"],
   *   risks: [],
   *   agents: [...],
   *   agentCount: 1,
   *   execution: {...},
   *   modeLabel: "staging",
   * });
   *
   * if (response.decision === "approve") {
   *   // Proceed with plan execution
   * }
   * ```
   */
  request = (
    plan: Omit<PlanReviewEnvelope, "type" | "id">,
  ): Promise<PlanReviewResponse> => {
    // Create a complete envelope with a unique ID.
    const envelope: PlanReviewEnvelope = {
      type: "confirm-plan",
      id: randomUUID(),
      ...plan,
    };
    return this.enqueue(envelope);
  };

  /**
   * Disposes the broker and resolves all pending requests.
   *
   * @remarks
   * Call this when the server is shutting down or the session ends. This:
   * 1. Unsubscribes from the transport (stops receiving responses)
   * 2. Clears all timeouts to prevent memory leaks
   * 3. Resolves all pending requests with `{ decision: "skip" }` (reject the plans)
   * 4. Clears the queue
   *
   * After calling dispose, the broker should not be used again.
   *
   * @example
   * ```ts
   * process.on("SIGTERM", () => {
   *   broker.dispose(); // Clean up gracefully
   *   process.exit(0);
   * });
   * ```
   */
  dispose = (): void => {
    // Stop receiving responses from the transport.
    this.unsubscribe();
    // Resolve all pending requests with "skip" and clear their timeouts.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: "skip" });
    }
    // Clear all pending tracking and queues.
    this.pending.clear();
    this.queue.length = 0;
    this.active = null;
  };

  /**
   * Enqueues a plan and returns a Promise for its resolution.
   *
   * @remarks
   * Internal method that:
   * 1. Creates a timeout timer for the plan
   * 2. Tracks the promise resolve function
   * 3. Adds the envelope to the queue
   * 4. Calls flush to send if nothing is active
   *
   * The Promise is stored in the pending map so it can be resolved when
   * the response arrives or the timeout fires.
   *
   * @param envelope - The complete plan envelope
   * @returns A Promise that resolves with the user's decision
   */
  private enqueue = (
    envelope: PlanReviewEnvelope,
  ): Promise<PlanReviewResponse> =>
    new Promise((resolve) => {
      // Create a timeout timer for this specific plan.
      const timer = setTimeout(() => {
        this.onTimeout(envelope.id);
      }, this.timeoutMs);
      // Track the resolve function and timer by plan ID.
      this.pending.set(envelope.id, { resolve, timer });
      // Add to the queue.
      this.queue.push(envelope);
      // Attempt to send the next plan if nothing is active.
      this.flush();
    });

  /**
   * Sends the next queued plan to the user (if nothing is currently active).
   *
   * @remarks
   * This is the core queue-draining logic. Only sends if:
   * 1. No plan is currently active (waiting for user response)
   * 2. There are plans in the queue
   *
   * Called after each response/timeout to process the next plan in line.
   */
  private flush = (): void => {
    // If a plan is already active, don't send another one.
    if (this.active !== null) {
      return;
    }
    // Get the next plan from the queue.
    const next = this.queue.shift();
    // If no plans are queued, we're done (idle).
    if (!next) {
      return;
    }
    // Mark this plan as active and send it.
    this.active = next;
    this.transport.send(next);
  };

  /**
   * Settles a pending plan with a final response, whether from the user or a timeout.
   *
   * @remarks
   * Shared by {@link onResponse} and {@link onTimeout} — both resolve a pending entry
   * and advance the queue the same way, differing only in *what* they resolve with
   * (the user's actual decision vs. a synthesized "skip"). Centralizing this avoids
   * the two call sites drifting out of sync (e.g. one clearing `active` and the other
   * forgetting to).
   *
   * @param id - The plan ID to settle.
   * @param response - The decision to resolve the pending Promise with.
   */
  private settle = (id: string, response: PlanReviewResponse): void => {
    // Look up the pending request.
    const entry = this.pending.get(id);
    // If not found, ignore (already settled, or an unknown/stale ID).
    if (!entry) {
      return;
    }
    // Cancel the timeout — either it already fired (timeout path) or is no longer needed
    // (response path). clearTimeout on an already-fired timer is a safe no-op.
    clearTimeout(entry.timer);
    // Remove from pending and resolve the Promise with the final decision.
    this.pending.delete(id);
    entry.resolve(response);
    // If this was the active plan, clear it so flush() can send the next one.
    if (this.active?.id === id) {
      this.active = null;
    }
    // Process the next queued plan.
    this.flush();
  };

  /**
   * Handles a response from the transport (user confirmed or rejected).
   *
   * @param id - The plan ID (from the response envelope)
   * @param response - The user's decision (approve/skip/etc.)
   */
  private onResponse = (id: string, response: PlanReviewResponse): void => {
    this.settle(id, response);
  };

  /**
   * Handles a timeout for a plan (user didn't respond in time).
   *
   * @remarks
   * Treated as an implicit "skip" — timing out doesn't stop the queue; the next
   * queued plan is still sent.
   *
   * @param id - The plan ID that timed out
   */
  private onTimeout = (id: string): void => {
    this.settle(id, { decision: "skip" });
  };
}
