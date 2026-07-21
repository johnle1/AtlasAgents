/**
 * One-shot RSocket `requestResponse` helpers for non-streaming server commands.
 *
 * @remarks
 * Converts the callback-style RSocket API into Promises, wraps payloads in the
 * `{ kind: "command", type, payload }` envelope, and turns `ok: false`
 * responses into thrown `Error`s. Higher-level {@link Connection} methods call
 * these after ensuring a live socket and attaching auth metadata.
 */

import type { Payload, RSocket } from "@rsocket/core";
import type { InstalledModel } from "../frames.js";
import type {
  MemoryEntry,
  SkillPayload,
  CommandRequestPayload,
  CommandResponseEnvelope,
} from "./types.js";

/**
 * Sends one RSocket `requestResponse` and resolves with the raw response bytes.
 *
 * @remarks
 * RSocket may deliver the body across multiple `onNext` frames; chunks are
 * concatenated. Both `onNext(..., isComplete=true)` and `onComplete` finalize
 * the Promise — a settlement guard prevents double resolve/reject. Empty
 * payloads are treated as errors because every LoopyCode command returns JSON.
 *
 * @param rsocket - Live RSocket connection.
 * @param payload - Request `data` + `metadata` buffers.
 * @returns Concatenated response `data` bytes.
 * @throws {@link Error} When the peer sends an error frame, or the response
 *   body is missing / zero-length (`"Empty response from server"`).
 *
 * @example
 * ```ts
 * const responseBuffer = await requestResponseBuffer(rsocket, {
 *   data: Buffer.from(JSON.stringify({ kind: "command", type: "models.list", payload: {} })),
 *   metadata: authMetadata(config),
 * });
 * console.log(JSON.parse(responseBuffer.toString("utf-8")));
 * ```
 */
export const requestResponseBuffer = (
  rsocket: RSocket,
  payload: Payload,
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    let responseBuffer: Buffer | undefined;
    // RSocket can signal completion via onNext(isComplete) *and* onComplete;
    // only the first win should settle the Promise.
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      if (responseBuffer && responseBuffer.length > 0) {
        resolve(responseBuffer);
      } else {
        reject(new Error("Empty response from server"));
      }
    };

    rsocket.requestResponse(payload, {
      onNext: (response: Payload, isComplete: boolean) => {
        // Defensive concat: some peers fragment large JSON across frames.
        if (response.data && response.data.length > 0) {
          responseBuffer = responseBuffer
            ? Buffer.concat([responseBuffer, response.data])
            : response.data;
        }
        if (isComplete) done();
      },

      onComplete: () => done(),
      onError: (e: Error) => done(e),
      onExtension: () => {},
    });
  });
};

/**
 * Sends a typed command and returns the parsed `data` field on success.
 *
 * @remarks
 * Serializes {@link CommandRequestPayload}, awaits {@link requestResponseBuffer},
 * then JSON-parses {@link CommandResponseEnvelope}. Application failures
 * (`ok: false`) become thrown `Error`s using `error` or `"Command failed"`.
 *
 * @typeParam TResponse - Expected shape of `envelope.data` for this route.
 * @param rsocket - Live RSocket connection.
 * @param type - Route string such as `"models.list"` or `"memory.get"`.
 * @param payload - Command-specific JSON body (use `{}` when unused).
 * @param metadata - Auth metadata from {@link authMetadata}.
 * @returns `envelope.data` cast to `TResponse`.
 * @throws {@link Error} When `ok` is false, the body is empty, JSON is invalid,
 *   or the RSocket call fails.
 *
 * @example
 * ```ts
 * const data = await sendCommand<{ models: InstalledModel[] }>(
 *   rsocket,
 *   "models.list",
 *   {},
 *   authMetadata(config),
 * );
 * ```
 */
export async function sendCommand<TResponse>(
  rsocket: RSocket,
  type: string,
  payload: unknown,
  metadata: Buffer,
): Promise<TResponse> {
  const body: CommandRequestPayload = { kind: "command", type, payload };
  const dataBuf = Buffer.from(JSON.stringify(body), "utf-8");
  const responseBuf = await requestResponseBuffer(rsocket, {
    data: dataBuf,
    metadata,
  });
  const text = responseBuf.toString("utf-8");
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { ok?: unknown }).ok !== "boolean"
  ) {
    throw new Error("Malformed response envelope from server");
  }
  const env = parsed as CommandResponseEnvelope;
  if (!env.ok) {
    throw new Error(env.error ?? "Command failed");
  }
  return env.data as TResponse;
}

/**
 * Lists installed Ollama models with full metadata from the server.
 *
 * @remarks
 * Validates that `data.models` is an array and drops entries without a
 * non-empty `name` so UI lists never show blank rows from partial JSON.
 *
 * @param rsocket - Live RSocket connection.
 * @param metadata - Auth metadata Buffer.
 * @returns Filtered {@link InstalledModel} array.
 * @throws {@link Error} When the envelope is not ok, or `models` is not an array
 *   (`"Invalid models.list response"`).
 *
 * @example
 * ```ts
 * const models = await fetchModelsDetailed(rsocket, authMetadata(config));
 * for (const m of models) console.log(m.name, m.size);
 * ```
 */
export async function fetchModelsDetailed(
  rsocket: RSocket,
  metadata: Buffer,
): Promise<InstalledModel[]> {
  const data = await sendCommand<{ models: InstalledModel[] }>(
    rsocket,
    "models.list",
    {},
    metadata,
  );
  if (!Array.isArray(data.models)) {
    throw new Error("Invalid models.list response");
  }
  // Ignore malformed rows rather than failing the whole list for one bad entry.
  return data.models.filter(
    (m) => typeof m.name === "string" && m.name.length > 0,
  );
}

/**
 * Lists installed Ollama model **names** only.
 *
 * @remarks
 * Thin wrapper over {@link fetchModelsDetailed} for dropdown / selection UIs
 * that do not need size or other metadata.
 *
 * @param rsocket - Live RSocket connection.
 * @param metadata - Auth metadata Buffer.
 * @returns Model name strings, e.g. `["gemma3:4b", "gemma3:27b"]`.
 * @throws {@link Error} Propagates errors from {@link fetchModelsDetailed}.
 *
 * @example
 * ```ts
 * const names = await fetchModels(rsocket, authMetadata(config));
 * ```
 */
export async function fetchModels(
  rsocket: RSocket,
  metadata: Buffer,
): Promise<string[]> {
  const models = await fetchModelsDetailed(rsocket, metadata);
  return models.map((m) => m.name);
}

/**
 * Uploads local skill markdown files to the server.
 *
 * @remarks
 * Replaces (or merges, per server policy) the skill set available to agent
 * and agent for subsequent tasks. Does not return skill contents back.
 *
 * @param rsocket - Live RSocket connection.
 * @param metadata - Auth metadata Buffer.
 * @param skills - Files to sync; each needs `name` + markdown `content`.
 * @throws {@link Error} When the command fails (`ok: false` or transport error).
 *
 * @example
 * ```ts
 * await syncSkills(rsocket, authMetadata(config), [
 *   { name: "coding", content: "# Style\nUse named exports.\n" },
 * ]);
 * ```
 */
export async function syncSkills(
  rsocket: RSocket,
  metadata: Buffer,
  skills: SkillPayload[],
): Promise<void> {
  await sendCommand(rsocket, "skills.sync", { skills }, metadata);
}

/**
 * Loads all memory preference entries from the server.
 *
 * @remarks
 * Returns `[]` when the server omits `entries` or the store is empty so callers
 * can render an empty state without null checks.
 *
 * @param rsocket - Live RSocket connection.
 * @param metadata - Auth metadata Buffer.
 * @returns Memory topics and their rules.
 * @throws {@link Error} When the command fails.
 *
 * @example
 * ```ts
 * const memory = await getMemory(rsocket, authMetadata(config));
 * for (const entry of memory) {
 *   console.log(entry.topic, entry.rules);
 * }
 * ```
 */
export async function getMemory(
  rsocket: RSocket,
  metadata: Buffer,
): Promise<MemoryEntry[]> {
  const data = await sendCommand<{ entries: MemoryEntry[] }>(
    rsocket,
    "memory.get",
    {},
    metadata,
  );
  return data.entries ?? [];
}

/**
 * Deletes all rules for one memory topic.
 *
 * @remarks
 * Other topics are left untouched. Topic matching is exact-string on the
 * server — use the same `topic` returned by {@link getMemory}.
 *
 * @param rsocket - Live RSocket connection.
 * @param metadata - Auth metadata Buffer.
 * @param topic - Topic key to forget, e.g. `"coding-style"`.
 * @throws {@link Error} When the command fails.
 *
 * @example
 * ```ts
 * await forgetMemory(rsocket, authMetadata(config), "coding-style");
 * ```
 */
export async function forgetMemory(
  rsocket: RSocket,
  metadata: Buffer,
  topic: string,
): Promise<void> {
  await sendCommand(rsocket, "memory.forget", { topic }, metadata);
}

/**
 * Deletes **all** memory entries for the session/user on the server.
 *
 * @remarks
 * Irreversible from the client’s perspective — preferences must be re-learned
 * after this call. Prefer {@link forgetMemory} when only one topic is wrong.
 *
 * @param rsocket - Live RSocket connection.
 * @param metadata - Auth metadata Buffer.
 * @throws {@link Error} When the command fails.
 *
 * @example
 * ```ts
 * await clearMemory(rsocket, authMetadata(config));
 * ```
 */
export async function clearMemory(
  rsocket: RSocket,
  metadata: Buffer,
): Promise<void> {
  await sendCommand(rsocket, "memory.clear", {}, metadata);
}

/**
 * Answers a pending plan-review request from the server.
 *
 * @remarks
 * While a task streams, the server may pause for plan approval. Send
 * `"implement"` to proceed, `"skip"` to reject, or `"edit"` with free-text
 * `feedback` — the agent re-plans using that feedback rather than having its
 * plan rewritten by hand. The `id` must match the plan frame the UI received.
 *
 * @param rsocket - Live RSocket connection.
 * @param metadata - Auth metadata Buffer.
 * @param id - Plan correlator from the server’s plan request frame.
 * @param decision - `"implement"` | `"skip"` | `"edit"` (server may accept synonyms).
 * @param feedback - Free-text feedback for `"edit"`; ignored otherwise.
 * @throws {@link Error} When the command fails or the plan id is unknown.
 *
 * @example
 * ```ts
 * await respondPlan(rsocket, authMetadata(config), planId, "implement");
 * await respondPlan(
 *   rsocket,
 *   authMetadata(config),
 *   planId,
 *   "edit",
 *   "Add error handling for the upload step",
 * );
 * ```
 */
export async function respondPlan(
  rsocket: RSocket,
  metadata: Buffer,
  id: string,
  decision: string,
  feedback?: string,
): Promise<void> {
  await sendCommand(
    rsocket,
    "plan.respond",
    { id, decision, feedback },
    metadata,
  );
}
