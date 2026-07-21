/**
 * Task stream frame types and utilities.
 *
 * @remarks
 * Re-exports TaskFrame type and encoding/decoding utilities from @loopycode/shared.
 * TaskFrame represents a single unit of output in a task execution stream
 * (tokens, progress, errors, or completion signals).
 */

export type { TaskFrame } from "@loopycode/shared";
export { decodeFrame, encodeFrame } from "@loopycode/shared";
