/**
 * Shared TypeScript contracts for the client ↔ server RSocket transport.
 *
 * @remarks
 * These types describe connection status callbacks, command request/response
 * envelopes, memory/skill payloads, and streaming task bodies. Import them
 * from `connection/index.js` (or this file) when wiring UI, CLI commands, or
 * tests against the {@link Connection} facade.
 *
 * Wire frames for individual stream items (`TaskFrame`, `PullProgress`) live in
 * `../frames.js` and are re-exported here for convenience.
 */

import type { RouteId } from "@loopycode/shared";

export type { PullProgress, TaskFrame } from "../types/frames.js";
export type { InstalledModel } from "../types/frames.js";
export type { RouteId, TaskStreamPayload } from "@loopycode/shared";

/**
 * One topic in the server-side user preference (“memory”) store.
 *
 * @remarks
 * Memory is learned preference text, not chat history. Each entry groups rules
 * under a topic key the agent/subagent can cite later (for example coding style
 * or project layout preferences).
 *
 * @example
 * ```ts
 * const entry: MemoryEntry = {
 *   topic: "coding-style",
 *   rules: ["Prefer named exports", "Avoid default exports in packages"],
 * };
 * ```
 */
export interface MemoryEntry {
  /**
   * Stable topic key shown in `/memory` UIs and passed to `memory.forget`.
   *
   * @remarks
   * Examples: `"coding-style"`, `"project-structure"`. Treat as opaque string —
   * exact match is required when forgetting a topic.
   */
  topic: string;

  /** Preference sentences associated with {@link topic}; order is display-only. */
  rules: string[];
}

/**
 * One local skill file to upload via `skills.sync`.
 *
 * @remarks
 * Skills are markdown instruction packs the server exposes to the agent and
 * subagent during task execution. `name` is the basename (no extension); `content`
 * is the full markdown body.
 *
 * @example
 * ```ts
 * const skill: SkillPayload = {
 *   name: "testing",
 *   content: "# Testing\nPrefer Vitest and table-driven cases.\n",
 * };
 * ```
 */
export interface SkillPayload {
  /**
   * Skill basename without extension (e.g. `"coding"` for `coding.md`).
   *
   * @remarks
   * Must be unique within a sync batch; the server keys skills by this name.
   */
  name: string;

  /** Full markdown body of the skill file. */
  content: string;
}

/**
 * Lifecycle state of the client’s single RSocket TCP session.
 *
 * @remarks
 * Typical progression: `Disconnected` → `Connecting` → `Connected`. After an
 * unexpected close (unless reconnect is suppressed), status becomes
 * `Reconnecting` until a successful handshake returns to `Connected`, or the
 * process gives up and stays `Disconnected`.
 *
 * - `Disconnected` — no live socket; auto-reconnect may still be scheduled.
 * - `Connecting` — first handshake in progress (manual `connect()` / startup).
 * - `Connected` — handshake done; health checks run while in this state.
 * - `Reconnecting` — waiting out backoff (or actively retrying) after a drop.
 *
 * @example
 * ```ts
 * const status: ConnectionStatus = "Connected";
 * ```
 */
export type ConnectionStatus =
  | "Disconnected"
  | "Connecting"
  | "Connected"
  | "Reconnecting";

/**
 * Listener invoked whenever {@link ConnectionStatus} changes.
 *
 * @remarks
 * Register via `Connection.onConnectionStatus`. The listener is called once
 * immediately with the **current** status so UIs can paint without waiting for
 * the next transition, then again on every distinct status change.
 *
 * @param status - New connection status after a transition (or the current one
 *   on first registration).
 *
 * @example
 * ```ts
 * const onStatus: StatusListener = (status) => {
 *   console.log("connection:", status);
 * };
 * ```
 */
export type StatusListener = (status: ConnectionStatus) => void;

/**
 * JSON envelope returned by the server for `requestResponse` commands.
 *
 * @remarks
 * Application success is signaled by `ok: true` with an optional `data`
 * payload (shape depends on the command route). Failures set `ok: false` and
 * populate `error`. Transport / parse errors may throw before this envelope
 * exists — callers of `sendCommand` convert `ok: false` into thrown `Error`s.
 *
 * @example
 * ```ts
 * const ok: CommandResponseEnvelope = { ok: true, data: { models: [] } };
 * const fail: CommandResponseEnvelope = { ok: false, error: "unauthorized" };
 * ```
 */
export type CommandResponseEnvelope = {
  /** `true` when the command handler succeeded; `false` for application errors. */
  ok: boolean;

  /**
   * Success payload. Present when `ok` is true; omitted or unused on failure.
   * Concrete type is command-specific (callers cast via generics on `sendCommand`).
   */
  data?: unknown;

  /** Human-readable failure reason when `ok` is false. */
  error?: string;
};

/**
 * JSON body sent on `requestResponse` for non-streaming commands.
 *
 * @remarks
 * Every command shares `kind: "command"` plus a route `type` (for example
 * `"models.list"`, `"memory.get"`, `"skills.sync"`). `payload` is
 * command-specific JSON; use `{}` when the route needs no body.
 *
 * @example
 * ```ts
 * const req: CommandRequestPayload = {
 *   kind: "command",
 *   type: "memory.forget",
 *   payload: { topic: "coding-style" },
 * };
 * ```
 */
export type CommandRequestPayload = {
  /** Discriminator so the server treats this as a command, not a task stream. */
  kind: "command";

  /**
   * Server route id, e.g. `"models.list"`, `"memory.get"`, `"plan.respond"`.
   *
   * @remarks
   * Typed against the same `RouteId` union the server validates with, so an
   * unknown route is caught at compile time rather than only failing with
   * `ok: false` at runtime.
   */
  type: RouteId;

  /** Command-specific JSON; may be an empty object. */
  payload: unknown;
};
