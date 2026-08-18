/**
 * Task stream frame types and utilities.
 *
 * @remarks
 * Re-exports TaskFrame type and encoding/decoding utilities from @atlasagents/shared.
 * TaskFrame represents a single unit of output in a task execution stream
 * (tokens, progress, errors, or completion signals).
 */

export type { TaskFrame, SubagentStatusSource } from "@atlasagents/shared";
export { decodeFrame, encodeFrame } from "@atlasagents/shared";
