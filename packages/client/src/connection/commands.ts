import type { Payload, RSocket } from "@rsocket/core";
import type { InstalledModel } from "../frames.js";
import type {
  MemoryEntry,
  SkillPayload,
  CommandRequestPayload,
  CommandResponseEnvelope,
} from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Wraps RSocket's callback-based requestResponse into a Promise that
 *   resolves with the raw response Buffer.
 *
 * How it does it (step by step):
 *   1. Creates a Promise and a settled guard to prevent double resolution.
 *   2. Calls rsocket.requestResponse with the given payload.
 *   3. In onNext: stores response.data in a local buffer variable.
 *   4. When isComplete fires (via onNext or onComplete): if buffer has bytes,
 *      resolves with it; otherwise rejects with "Empty response".
 *   5. In onError: rejects the Promise with the error.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Payload} payload — The request payload with data and metadata.
 *
 * Returns:
 *   @returns {Promise<Buffer>} — The raw response bytes from the server.
 *
 * @throws {Error} — When the server returns an error frame or an empty response.
 *
 * Dependencies:
 *   - RSocket.requestResponse — the underlying RSocket API.
 *
 * Dependants:
 *   - sendCommand — uses this to get raw bytes before JSON parsing.
 * </Summary>
 */
export function requestResponseBuffer(
  rsocket: RSocket,
  payload: Payload,
): Promise<Buffer> {
  // ===== STEP 1: Create Promise Wrapper =====
  // Wrap RSocket's callback-based API into a Promise for async/await use
  return new Promise((resolve, reject) => {
    // ===== STEP 2: Initialize State =====
    // Step 2a: Buffer to accumulate response data (undefined until received)
    let buf: Buffer | undefined;

    // Step 2b: Settlement guard to prevent double-resolution
    let settled = false;

    // ===== STEP 3: Define Done Callback =====
    // Helper function to finalize promise with error or success
    const done = (err?: Error) => {
      // Step 3a: Skip if already settled
      if (settled) return;

      // Step 3b: Mark as settled to prevent multiple resolutions
      settled = true;

      // Step 3c: If error provided, reject the promise
      if (err) {
        reject(err);
        return;
      }

      // Step 3d: Check if buffer has data
      if (buf && buf.length > 0) {
        // Step 3e: Success: resolve with the response buffer
        resolve(buf);
      } else {
        // Step 3f: Failure: empty response is an error condition
        reject(new Error("Empty response from server"));
      }
    };

    // ===== STEP 4: Send RSocket Request with Callbacks =====
    // Call requestResponse with the payload and subscriber callbacks
    rsocket.requestResponse(payload, {
      // ===== STEP 4a: onNext Handler =====
      // Called when response data arrives (may be called multiple times for streaming)
      onNext: (response: Payload, isComplete: boolean) => {
        // Step 4a-i: Check if response contains data
        if (response.data && response.data.length > 0) {
          // Step 4a-ii: Accumulate response chunks (defensive for multi-frame replies)
          buf = buf
            ? Buffer.concat([buf, response.data])
            : response.data;
        }
        // Step 4a-iii: RSocket delivers the final frame via onNext with isComplete
        if (isComplete) done();
      },

      // ===== STEP 4b: onComplete Handler =====
      // Called when response stream completes successfully (no data received)
      onComplete: () => done(),

      // ===== STEP 4c: onError Handler =====
      // Called when an error occurs on the RSocket connection
      onError: (e: Error) => done(e),

      // ===== STEP 4d: onExtension Handler =====
      // Called for RSocket extension protocol events; not used here
      onExtension: () => {},
    });
  });
}

/**
 * <Summary>
 * What it does:
 *   Sends a command envelope via RSocket requestResponse and returns the
 *   parsed response data, throwing on application-level errors.
 *
 * How it does it (step by step):
 *   1. Builds a CommandRequestPayload with kind "command", the type string,
 *      and the caller's payload.
 *   2. Serialises it to a UTF-8 JSON Buffer.
 *   3. Sends via requestResponseBuffer with password metadata attached.
 *   4. Parses the response Buffer as JSON into a CommandResponseEnvelope.
 *   5. If env.ok is false, throws an Error with env.error message.
 *   6. Returns env.data cast to the caller's expected response type.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {string} type — Command route string e.g. "models.list", "memory.get".
 *   @param {unknown} payload — JSON-serialisable payload specific to the command.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *
 * Returns:
 *   @returns {Promise<TResponse>} — The parsed data field from the server response.
 *
 * @throws {Error} — When the server returns ok: false or the connection fails.
 *
 * Dependencies:
 *   - requestResponseBuffer — wraps requestResponse as a Promise.
 *
 * Dependants:
 *   - fetchModels — sends "models.list".
 *   - syncSkills — sends "skills.sync".
 *   - getMemory — sends "memory.get".
 *   - forgetMemory — sends "memory.forget".
 *   - clearMemory — sends "memory.clear".
 *   - respondConfirmation — sends "confirm.respond".
 *   - respondPlan — sends "plan.respond".
 * </Summary>
 */
export async function sendCommand<TResponse>(
  rsocket: RSocket,
  type: string,
  payload: unknown,
  metadata: Buffer,
): Promise<TResponse> {
  // ===== STEP 1: Build Command Request Envelope =====
  // Step 1a: Create body with kind="command", the route type, and payload
  // Step 1b: This envelope tells the server what operation to execute
  const body: CommandRequestPayload = { kind: "command", type, payload };

  // ===== STEP 2: Serialize Request to Buffer =====
  // Step 2a: Convert envelope to JSON string
  // Step 2b: Encode as UTF-8 bytes for RSocket transmission
  const dataBuf = Buffer.from(JSON.stringify(body), "utf-8");

  // ===== STEP 3: Send via RSocket =====
  // Step 3a: Call requestResponseBuffer with the data and password metadata
  // Step 3b: Returns the raw response buffer or throws on error/timeout
  const responseBuf = await requestResponseBuffer(rsocket, {
    data: dataBuf,
    metadata,
  });

  // ===== STEP 4: Deserialize Response =====
  // Step 4a: Decode response buffer from UTF-8 bytes to string
  const text = responseBuf.toString("utf-8");

  // Step 4b: Parse JSON string to CommandResponseEnvelope object
  const env = JSON.parse(text) as CommandResponseEnvelope;

  // ===== STEP 5: Check Operation Success =====
  // Step 5a: Check the ok flag to determine if command succeeded
  if (!env.ok) {
    // Step 5b: If ok=false, throw error with message from server or generic message
    throw new Error(env.error ?? "Command failed");
  }

  // ===== STEP 6: Return Result Data =====
  // Step 6a: Extract and cast data field to the caller's expected type
  return env.data as TResponse;
}

/**
 * <Summary>
 * What it does:
 *   Fetches the list of available Ollama models from the server so users
 *   can pick one for advisor or agent roles.
 *
 * How it does it (step by step):
 *   1. Sends a "models.list" command via sendCommand with empty payload.
 *   2. Validates that the response contains a models array.
 *   3. Returns the array of model name strings.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *
 * Returns:
 *   @returns {Promise<InstalledModel[]>} — Array of model metadata.
 *
 * @throws {Error} — When the server returns an invalid response shape.
 *
 * Dependencies:
 *   - sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - fetchModels — calls this to get the full model metadata.
 *   - listModels — deprecated alias that delegates here.
 * </Summary>
 */
export async function fetchModelsDetailed(
  rsocket: RSocket,
  metadata: Buffer,
): Promise<InstalledModel[]> {
  // ===== STEP 1: Send Models.List Command =====
  // Step 1a: Call sendCommand with "models.list" route and empty payload
  // Step 1b: Returns response with { models: InstalledModel[] }
  const data = await sendCommand<{ models: InstalledModel[] }>(
    rsocket,
    "models.list",
    {},
    metadata,
  );

  // ===== STEP 2: Validate Response Shape =====
  // Step 2a: Check if response contains a models array
  // Step 2b: Throw if response shape is invalid
  if (!Array.isArray(data.models)) {
    throw new Error("Invalid models.list response");
  }

  // ===== STEP 3: Filter Valid Models =====
  // Step 3a: Return only models with non-empty name strings
  // Step 3b: Filters out any malformed entries
  return data.models.filter(
    (m) => typeof m.name === "string" && m.name.length > 0,
  );
}

/**
 * <Summary>
 * What it does:
 *   Fetches the list of available Ollama model names from the server so users
 *   can pick one for advisor or agent roles.
 *
 * How it does it (step by step):
 *   1. Calls fetchModelsDetailed to get the full model metadata.
 *   2. Maps the array of InstalledModel objects to just their name strings.
 *   3. Returns the simplified array of model name strings.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *
 * Returns:
 *   @returns {Promise<string[]>} — Array of model names e.g. ["gemma3:4b", "gemma3:27b"].
 *
 * Dependencies:
 *   - fetchModelsDetailed — fetches the full model metadata.
 *
 * Dependants:
 *   - listModels — deprecated alias that delegates here.
 * </Summary>
 */
export async function fetchModels(
  rsocket: RSocket,
  metadata: Buffer,
): Promise<string[]> {
  // ===== STEP 1: Fetch Detailed Models =====
  // Step 1a: Get array of InstalledModel objects with name and metadata
  const models = await fetchModelsDetailed(rsocket, metadata);
  // ===== STEP 2: Extract Model Names =====
  // Step 2a: Map to just the name strings for the UI
  // Step 2b: Returns simplified array e.g. ["gemma3:4b", "gemma3:27b"]
  return models.map((m) => m.name);
}

/**
 * <Summary>
 * What it does:
 *   Uploads all local skill files to the server so they are available to
 *   the advisor and agent during task execution.
 *
 * How it does it (step by step):
 *   1. Sends a "skills.sync" command via sendCommand with the skills array.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *   @param {SkillPayload[]} skills — Array of skill objects with name and content.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - CommandHandler.handleSkills (sync subcommand) — calls this after reading local files.
 * </Summary>
 */
export async function syncSkills(
  rsocket: RSocket,
  metadata: Buffer,
  skills: SkillPayload[],
): Promise<void> {
  await sendCommand(rsocket, "skills.sync", { skills }, metadata);
}

/**
 * <Summary>
 * What it does:
 *   Fetches all stored memory entries from the server's preference store
 *   so users can review what the system has learned about their preferences.
 *
 * How it does it (step by step):
 *   1. Sends a "memory.get" command via sendCommand with empty payload.
 *   2. Extracts the entries array from the response (defaults to empty).
 *   3. Returns the array of MemoryEntry objects.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *
 * Returns:
 *   @returns {Promise<MemoryEntry[]>} — Array of topics with their rules.
 *
 * Dependencies:
 *   - sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - CommandHandler.handleMemory (show subcommand) — calls this to display memory.
 * </Summary>
 */
export async function getMemory(
  rsocket: RSocket,
  metadata: Buffer,
): Promise<MemoryEntry[]> {
  // ===== STEP 1: Send Memory.Get Command =====
  // Step 1a: Call sendCommand with "memory.get" route and empty payload
  // Step 1b: Returns response with { entries: MemoryEntry[] }
  const data = await sendCommand<{ entries: MemoryEntry[] }>(
    rsocket,
    "memory.get",
    {},
    metadata,
  );
  // ===== STEP 2: Extract Entries with Default =====
  // Step 2a: Return entries array, defaulting to empty if not present
  // Step 2b: Handles case where server has no stored memory entries yet
  return data.entries ?? [];
}

/**
 * <Summary>
 * What it does:
 *   Deletes all rules for a specific topic from the server's memory store.
 *
 * How it does it (step by step):
 *   1. Sends a "memory.forget" command via sendCommand with the topic name.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *   @param {string} topic — Topic name to forget e.g. "coding-style".
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - CommandHandler.handleMemory (forget subcommand) — calls this after user confirms.
 * </Summary>
 */
export async function forgetMemory(
  rsocket: RSocket,
  metadata: Buffer,
  topic: string,
): Promise<void> {
  // ===== STEP 1: Send Memory.Forget Command =====
  // Step 1a: Call sendCommand with "memory.forget" route and topic name
  // Step 1b: Server deletes all rules for this topic from the preference store
  await sendCommand(rsocket, "memory.forget", { topic }, metadata);
}

/**
 * <Summary>
 * What it does:
 *   Wipes all memory entries from the server's preference store for this user.
 *
 * How it does it (step by step):
 *   1. Sends a "memory.clear" command via sendCommand with empty payload.
 *
 * Parameters:
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - CommandHandler.handleMemory (clear subcommand) — calls this after user confirms.
 * </Summary>
 */
export async function clearMemory(
  rsocket: RSocket,
  metadata: Buffer,
): Promise<void> {
  // ===== STEP 1: Send Memory.Clear Command =====
  // Step 1a: Call sendCommand with "memory.clear" route and empty payload
  // Step 1b: Server wipes ALL memory entries for this user session
  await sendCommand(rsocket, "memory.clear", {}, metadata);
}

/**
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
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *   @param {string} id — The unique confirmation ID from the server's request.
 *   @param {boolean} approved — True to approve the action, false to reject it.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server acknowledges the response.
 *
 * Dependencies:
 *   - sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - CommandHandler — calls this when user responds to a confirmation prompt.
 * </Summary>
 */
export async function respondConfirmation(
  rsocket: RSocket,
  metadata: Buffer,
  id: string,
  approved: boolean,
): Promise<void> {
  // ===== STEP 1: Send Confirmation Response =====
  // Step 1a: Send "confirm.respond" command with the confirmation ID and approval flag
  // Step 1b: Server uses this to proceed or cancel pending user confirmations
  await sendCommand(rsocket, "confirm.respond", { id, approved }, metadata);
}

/**
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
 *   @param {RSocket} rsocket — The live RSocket connection instance.
 *   @param {Buffer} metadata — The auth metadata Buffer.
 *   @param {string} id — The unique plan ID from the server's request.
 *   @param {string} decision — One of "implement", "skip", or "edit".
 *   @param {unknown[]} [steps] — Optional array of modified plan steps (for "edit" decision).
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the server acknowledges the response.
 *
 * Dependencies:
 *   - sendCommand — sends the requestResponse.
 *
 * Dependants:
 *   - CommandHandler — calls this when user responds to a plan prompt.
 * </Summary>
 */
export async function respondPlan(
  rsocket: RSocket,
  metadata: Buffer,
  id: string,
  decision: string,
  steps?: unknown[],
): Promise<void> {
  // ===== STEP 1: Send Plan Response =====
  // Step 1a: Send "plan.respond" command with the plan ID, decision, and optional steps
  // Step 1b: Server uses this to proceed with the chosen action on the plan
  await sendCommand(rsocket, "plan.respond", { id, decision, steps }, metadata);
}
